import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EventBus } from '../bus.js';
import type { Courier } from '../courier/index.js';
import { evaluateSteer } from '../courier/policy.js';
import type { RegistryWatcher } from '../registry/watcher.js';
import type { Scheduler } from '../scheduler/index.js';
import { DependencyCycleError, UnknownDependencyError } from '../scheduler/index.js';
import type { Bucket, Store } from '../store/index.js';
import { openTerminal, resolveTerminal } from '../terminal.js';
import type { JobStatus } from '../types.js';
import { loadOrMintToken, verifyBearer } from './auth.js';
import { HttpError, Router, badRequest, conflict, forbidden, notFound, readJson, sendJson } from './http.js';
import { serveStatic, uiDir } from './static.js';
import { SseHub } from './sse.js';
import { parseJobSpecs, parseSettingsPatch } from './validate.js';

export interface ApiOptions {
  readonly port?: number;
  /** Loopback, always. Not an option — see §11 and the comment on listen(). */
  readonly token?: string;
  readonly daemonCwd?: string;
}

export interface ApiDeps {
  readonly store: Store;
  readonly bus: EventBus;
  readonly scheduler: Scheduler;
  readonly courier: Courier;
  readonly watcher: RegistryWatcher;
}

const HOUR_MS = 60 * 60 * 1000;
const asBucket = (v: string | null): Bucket => (v === 'day' ? 'day' : 'hour');

/**
 * The REST + SSE surface (§5.1).
 *
 * Every route is authenticated, including on loopback, because loopback is not
 * a trust boundary on a developer box: any process running as this user can
 * reach 127.0.0.1, and this API spawns Claude sessions with the operator's
 * credentials and permissions.
 */
export class ApiServer {
  readonly #deps: ApiDeps;
  readonly #router = new Router();
  readonly #sse: SseHub;
  readonly #token: string;
  readonly #daemonCwd: string;
  readonly #startedAt = Date.now();
  #server: Server | null = null;

  constructor(deps: ApiDeps, opts: ApiOptions = {}) {
    this.#deps = deps;
    this.#sse = new SseHub(deps.bus, deps.store);
    this.#token = opts.token ?? loadOrMintToken();
    this.#daemonCwd = opts.daemonCwd ?? process.cwd();
    this.#routes();
  }

  get sseClientCount(): number {
    return this.#sse.clientCount;
  }

  #routes(): void {
    const { store, scheduler, courier, watcher } = this.#deps;
    const r = this.#router;

    r.add('GET', '/api/health', ({ res }) => {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - this.#startedAt,
        running: scheduler.runningCount,
        sseClients: this.#sse.clientCount,
        latestEventId: store.latestEventId(),
      });
    });

    r.add('GET', '/api/fleet', ({ res }) => {
      // A forced sweep, so a dashboard opened seconds after a session started
      // shows it now rather than at the next tick. Cheap: a directory read.
      watcher.scan();
      const sessions = store.listSessions();
      sendJson(res, 200, {
        sessions,
        managed: sessions.filter((s) => s.kind === 'managed' && s.alive).length,
        observed: sessions.filter((s) => s.kind === 'observed' && s.alive).length,
      });
    });

    r.add('GET', '/api/jobs', ({ res, query }) => {
      const status = query.get('status');
      const since = query.get('since');
      let jobs = store.listJobs(status ? (status as JobStatus) : undefined);
      if (since) jobs = jobs.filter((j) => j.createdAt >= since);
      sendJson(res, 200, { jobs });
    });

    r.add('POST', '/api/jobs', async ({ req, res }) => {
      const specs = parseJobSpecs(await readJson(req), store.getSettings(), this.#daemonCwd);
      let jobs;
      try {
        jobs = scheduler.submit(specs);
      } catch (err) {
        // A cycle or a dangling dependency is the caller's mistake, not a
        // daemon fault; 400 with the offending names beats a 500.
        if (err instanceof DependencyCycleError || err instanceof UnknownDependencyError) {
          throw badRequest(err.message);
        }
        throw err;
      }
      scheduler.tick();
      sendJson(res, 201, { jobs });
    });

    r.add('GET', '/api/jobs/:id', ({ res, params }) => {
      const job = store.getJob(params['id'] ?? '');
      if (!job) throw notFound(`no such job: ${params['id']}`);
      sendJson(res, 200, { job });
    });

    r.add('GET', '/api/jobs/:id/events', ({ res, params, query }) => {
      const id = params['id'] ?? '';
      if (!store.getJob(id)) throw notFound(`no such job: ${id}`);
      const from = Number(query.get('from') ?? 0);
      sendJson(res, 200, {
        events: store.eventsForJob(id, Number.isFinite(from) ? from : 0),
      });
    });

    r.add('POST', '/api/jobs/:id/cancel', async ({ req, res, params }) => {
      const id = params['id'] ?? '';
      if (!store.getJob(id)) throw notFound(`no such job: ${id}`);
      const body = (await readJson(req)) as { reason?: unknown };
      const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'cancelled by operator';
      if (!scheduler.cancel(id, reason)) throw conflict(`job ${id} has already finished`);
      sendJson(res, 200, { cancelled: true, job: store.getJob(id) });
    });

    r.add('POST', '/api/sessions/:sessionId/steer', async ({ req, res, params }) => {
      const sessionId = params['sessionId'] ?? '';
      const body = (await readJson(req)) as { text?: unknown };
      const text = typeof body.text === 'string' ? body.text : '';
      const session = store.getSession(sessionId);
      const job = session?.jobId ? store.getJob(session.jobId) : null;

      const decision = evaluateSteer(text, {
        settings: store.getSettings(),
        job,
        session,
        recentSteers: store.recentSteerTimes(sessionId, new Date(Date.now() - HOUR_MS).toISOString()),
        now: Date.now(),
      });
      if (!decision.allowed) throw forbidden(`${decision.code}: ${decision.reason}`);

      // Permission and addressability are different questions. The policy
      // answered the first; a session with no peer name yet has passed it and
      // still cannot be reached, and paying $0.04 to find that out is worse
      // than saying so here.
      if (!session?.name) throw conflict(`session ${sessionId} has no peer name to address`);

      // Awaited on purpose: a steer takes seconds and either landed or did not.
      // Returning 202 would hand the operator an optimistic maybe about an
      // instruction sent to an agent with tool access.
      const result = await courier.deliver({ sessionId, peerName: session.name, message: text });
      sendJson(res, result.delivered ? 200 : 502, result);
    });

    r.add('POST', '/api/sessions/:sessionId/attach', ({ res, params }) => {
      const sessionId = params['sessionId'] ?? '';
      const session = store.getSession(sessionId);
      if (!session) throw notFound(`no such session: ${sessionId}`);
      if (!session.alive) throw conflict(`session ${sessionId} is no longer running`);
      const term = resolveTerminal(store.getSettings().terminal);
      if (!term) throw conflict('no terminal available; set settings.terminal to ghostty or konsole');
      sendJson(res, 200, { terminal: term, pid: openTerminal(term, { sessionId, cwd: session.cwd }) });
    });

    r.add('GET', '/api/stats/:kind', ({ res, params, query }) => {
      const bucket = asBucket(query.get('bucket'));
      switch (params['kind']) {
        case 'cost':
          return sendJson(res, 200, { bucket, series: store.costSeries(bucket), byModel: store.costByModel() });
        case 'concurrency':
          // Named for what it measures, not for what a reader might assume:
          // distinct sessions active per bucket, not instantaneous parallelism.
          return sendJson(res, 200, { bucket, measure: 'distinct_active_sessions_per_bucket', series: store.concurrencySeries(bucket) });
        case 'queue':
          return sendJson(res, 200, { bucket, series: store.queueDepthSeries(bucket) });
        case 'tools':
          return sendJson(res, 200, { tools: store.toolUsage() });
        case 'failures':
          return sendJson(res, 200, store.failureStats());
        default:
          throw notFound(`no such stat: ${params['kind']}`);
      }
    });

    r.add('GET', '/api/settings', ({ res }) => sendJson(res, 200, { settings: store.getSettings() }));

    r.add('PUT', '/api/settings', async ({ req, res }) => {
      const patch = parseSettingsPatch(await readJson(req));
      const settings = store.putSettings(patch);
      // Settings changes are fleet-affecting and belong in the audit trail as
      // much as a steer does — maxConcurrency and the steer allowlist above all.
      this.#deps.bus.publish({
        jobId: null,
        sessionId: 'orchestrator',
        ts: new Date().toISOString(),
        source: 'api',
        type: 'raw',
        payload: { kind: 'settings.updated', patch },
      });
      scheduler.tick();
      sendJson(res, 200, { settings });
    });

    r.add('GET', '/api/stream', (ctx) => this.#sse.handle(ctx));
  }

  async listen(port = 4317): Promise<number> {
    const server = createServer((req, res) => void this.#dispatch(req, res));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 is hard-coded rather than configurable. Making the bind
      // address a setting is how a loopback service becomes an internet-facing
      // one by accident; remote access is Tailscale's job, and a separate
      // decision (§11).
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // The UI's own assets are served unauthenticated, and only they: a
      // bundle is public information, and the alternative — a token in the
      // asset URLs — puts the credential in the browser's history and in
      // every log that records a request line. The token still gates
      // `/api/*`, so an unauthenticated caller gets the shell of an app and
      // no data whatsoever.
      if (!url.pathname.startsWith('/api/')) {
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, `${method} not allowed on ${url.pathname}`);
        if (serveStatic(uiDir(), url.pathname, res, method)) return;
        throw notFound('the web UI is not built; run `npm run build -w ui`');
      }

      if (!verifyBearer(req.headers.authorization, this.#token)) {
        throw new HttpError(401, 'missing or invalid bearer token');
      }
      const match = this.#router.match(req.method ?? 'GET', url.pathname);
      if (!match) throw notFound(`no route for ${req.method} ${url.pathname}`);
      await match.handler({ req, res, params: match.params, query: url.searchParams });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'internal error';
      if (res.headersSent) {
        // Already streaming (SSE, or a partially written body): there is no
        // status left to send, so end the response rather than corrupting it.
        res.end();
        return;
      }
      sendJson(res, status, { error: message });
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // SSE clients hold sockets open indefinitely, which is exactly what they
    // are for and exactly what stops close() from ever resolving on its own.
    server.closeAllConnections?.();
  }
}
