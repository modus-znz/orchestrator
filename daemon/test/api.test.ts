import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'f'.repeat(64);

let home: string;
let base: string;
let Store: typeof import('../src/store/index.js').Store;
let EventBus: typeof import('../src/bus.js').EventBus;
let ChildRunner: typeof import('../src/runner/child.js').ChildRunner;
let Scheduler: typeof import('../src/scheduler/index.js').Scheduler;
let Courier: typeof import('../src/courier/index.js').Courier;
let RegistryWatcher: typeof import('../src/registry/watcher.js').RegistryWatcher;
let ApiServer: typeof import('../src/api/index.js').ApiServer;

let store: InstanceType<typeof Store>;
let bus: InstanceType<typeof EventBus>;
let api: InstanceType<typeof ApiServer>;
let scheduler: InstanceType<typeof Scheduler>;

/** A stand-in for the CLI that emits one result line and exits. */
function fakeClaude(): string {
  const path = join(home, 'fake-claude.sh');
  writeFileSync(
    path,
    `#!/bin/sh\necho '{"type":"result","subtype":"success","is_error":false,` +
      `"total_cost_usd":0.01,"result":"SENT","permission_denials":[]}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const post = (path: string, body: unknown): Promise<Response> =>
  call(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * Response bodies are asserted field by field. Typing them structurally would
 * restate the API's shape in a second place that then drifts away from the
 * first, and a test that agrees with a stale type is worse than no type.
 */
// reason: test-only assertion surface, deliberately untyped
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orch-scratch-api-'));
  process.env['ORCHESTRATOR_HOME'] = home;
  ({ Store } = await import('../src/store/index.js'));
  ({ EventBus } = await import('../src/bus.js'));
  ({ ChildRunner } = await import('../src/runner/child.js'));
  ({ Scheduler } = await import('../src/scheduler/index.js'));
  ({ Courier } = await import('../src/courier/index.js'));
  ({ RegistryWatcher } = await import('../src/registry/watcher.js'));
  ({ ApiServer } = await import('../src/api/index.js'));

  store = new Store(join(home, 'orchestrator.db'));
  bus = new EventBus(store);
  const bin = fakeClaude();
  const runner = new ChildRunner(bus, { claudeBin: bin });
  scheduler = new Scheduler(store, bus, runner);
  const courier = new Courier(bus, { claudeBin: bin });
  const watcher = new RegistryWatcher(store, bus, { dir: join(home, 'no-sessions') });
  api = new ApiServer({ store, bus, scheduler, courier, watcher }, { token: TOKEN, daemonCwd: home });
  base = `http://127.0.0.1:${await api.listen(0)}`;
});

afterEach(async () => {
  await api.close();
  // Submitting a job starts a child; letting the store close under a child
  // still running is the daemon's shutdown bug, not a test's, and shutdown
  // drains first for exactly this reason.
  await scheduler.drain();
  store.close();
  Store.destroyScratch(home);
  rmSync(home, { recursive: true, force: true });
});

describe('authentication', () => {
  it('refuses an unauthenticated request even on loopback', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } });
    expect(res.status).toBe(401);
  });

  it('answers an authenticated request', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });
});

describe('routing', () => {
  it('404s an unknown path', async () => {
    expect((await call('/api/nope')).status).toBe(404);
  });

  it('405s a known path with the wrong verb', async () => {
    // Not a 404: telling the caller "no such thing" about a thing that exists
    // sends them debugging the wrong end.
    expect((await post('/api/health', {})).status).toBe(405);
  });

  it('never leaks the token check behind routing', async () => {
    // Auth runs before the router, so an unknown path is still a 401 without
    // a token — otherwise the 404/401 split maps the API to an anonymous caller.
    expect((await fetch(`${base}/api/nope`)).status).toBe(401);
  });
});

describe('POST /api/jobs', () => {
  it('queues a job and reports it', async () => {
    const res = await post('/api/jobs', { prompt: 'do the thing', cwd: home });
    expect(res.status).toBe(201);
    const { jobs } = await json(res);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe('do the thing');
    expect(jobs[0].steerable).toBe(false);
  });

  it('requires a prompt', async () => {
    const res = await post('/api/jobs', { cwd: home });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('prompt is required');
  });

  it('rejects a cwd that does not exist rather than failing at spawn', async () => {
    const res = await post('/api/jobs', { prompt: 'x', cwd: join(home, 'nowhere') });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('not an existing directory');
  });

  it('rejects an unknown model', async () => {
    expect((await post('/api/jobs', { prompt: 'x', cwd: home, model: 'gpt' })).status).toBe(400);
  });

  it('refuses bypassPermissions while the gate is closed', async () => {
    const res = await post('/api/jobs', { prompt: 'x', cwd: home, permissionMode: 'bypassPermissions' });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toContain('ORCHESTRATOR_ALLOW_BYPASS');
  });

  it('allows bypassPermissions once the operator opened the gate on the box', async () => {
    store.putSettings({ allowBypassPermissions: true });
    const res = await post('/api/jobs', { prompt: 'x', cwd: home, permissionMode: 'bypassPermissions' });
    expect(res.status).toBe(201);
  });

  it('rejects a dependency cycle as the caller error it is, not a 500', async () => {
    const res = await post('/api/jobs', {
      jobs: [
        { name: 'a', prompt: 'a', cwd: home, dependsOn: ['b'] },
        { name: 'b', prompt: 'b', cwd: home, dependsOn: ['a'] },
      ],
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('cycle');
  });

  it('takes defaults from live settings, not from constants', async () => {
    store.putSettings({ defaultModel: 'opus', defaultBudgetUsd: 9 });
    const { jobs } = await json(await post('/api/jobs', { prompt: 'x', cwd: home }));
    expect(jobs[0].model).toBe('opus');
    expect(jobs[0].budgetUsd).toBe(9);
  });
});

describe('job lookup and cancel', () => {
  it('404s an unknown job on every job route', async () => {
    expect((await call('/api/jobs/nope')).status).toBe(404);
    expect((await call('/api/jobs/nope/events')).status).toBe(404);
    expect((await post('/api/jobs/nope/cancel', {})).status).toBe(404);
  });

  it('409s a cancel of a job that already finished', async () => {
    const { jobs } = await json(await post('/api/jobs', { prompt: 'x', cwd: home }));
    const id = jobs[0].id;
    store.putJob({ ...store.getJob(id)!, status: 'succeeded' });
    const res = await post(`/api/jobs/${id}/cancel`, {});
    expect(res.status).toBe(409);
  });
});

describe('settings', () => {
  it('returns the merged settings', async () => {
    const { settings } = await json(await call('/api/settings'));
    expect(settings.maxConcurrency).toBe(3);
  });

  it('applies a valid patch', async () => {
    const res = await call('/api/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 7 }) });
    expect(res.status).toBe(200);
    expect((await json(res)).settings.maxConcurrency).toBe(7);
  });

  it('rejects an unknown key instead of silently ignoring it', async () => {
    const res = await call('/api/settings', { method: 'PUT', body: JSON.stringify({ maxConcurency: 7 }) });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range value', async () => {
    const res = await call('/api/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 0 }) });
    expect(res.status).toBe(400);
  });

  it('refuses to open the bypass gate through the API it guards', async () => {
    const res = await call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ allowBypassPermissions: true }),
    });
    expect(res.status).toBe(403);
    expect(store.getSettings().allowBypassPermissions).toBe(false);
  });

  it('records the change in the audit trail', async () => {
    await call('/api/settings', { method: 'PUT', body: JSON.stringify({ maxConcurrency: 5 }) });
    const events = store.eventsSince(0);
    expect(events.some((e) => (e.payload as { kind?: string }).kind === 'settings.updated')).toBe(true);
  });
});

describe('steer', () => {
  const live = (over: Record<string, unknown> = {}): void => {
    store.putSession({
      sessionId: 's1', kind: 'observed', jobId: null, pid: 1, name: 'ghost-71',
      cwd: home, alive: true, procStart: '111', status: 'idle',
      firstSeenAt: '', lastSeenAt: '', ...over,
    } as Parameters<typeof store.putSession>[0]);
  };

  it('refuses a session nobody allowlisted', async () => {
    live();
    const res = await post('/api/sessions/s1/steer', { text: 'rebase please' });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toContain('not_allowlisted');
  });

  it('refuses an unknown session', async () => {
    expect((await post('/api/sessions/ghost/steer', { text: 'hi' })).status).toBe(403);
  });

  it('refuses an allowlisted session that has no peer name to address', async () => {
    // Permission and addressability are different questions, and finding out
    // the second one costs $0.04 if you only ask the first.
    store.putSettings({ steerAllowlist: ['s1'] });
    live({ name: null });
    const res = await post('/api/sessions/s1/steer', { text: 'hi' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('no peer name');
  });

  it('delivers to an allowlisted session and logs the steer', async () => {
    store.putSettings({ steerAllowlist: ['s1'] });
    live();
    const res = await post('/api/sessions/s1/steer', { text: 'focus on the failing test' });
    expect(res.status).toBe(200);
    expect((await json(res)).delivered).toBe(true);
    expect(store.eventsSince(0).some((e) => e.type === 'steer.sent')).toBe(true);
  });

  it('counts delivered steers against the rate limit', async () => {
    store.putSettings({ steerAllowlist: ['s1'], steerRateLimitPerHour: 1 });
    live();
    expect((await post('/api/sessions/s1/steer', { text: 'one' })).status).toBe(200);
    const second = await post('/api/sessions/s1/steer', { text: 'two' });
    expect(second.status).toBe(403);
    expect((await json(second)).error).toContain('rate_limited');
  });
});

describe('attach', () => {
  it('404s a session that was never seen', async () => {
    expect((await post('/api/sessions/nope/attach', {})).status).toBe(404);
  });

  it('409s when the operator has turned terminals off', async () => {
    store.putSettings({ terminal: 'none' });
    store.putSession({
      sessionId: 's1', kind: 'observed', jobId: null, pid: 1, name: 'ghost-71',
      cwd: home, alive: true, procStart: '111', status: 'idle', firstSeenAt: '', lastSeenAt: '',
    });
    const res = await post('/api/sessions/s1/attach', {});
    expect(res.status).toBe(409);
  });
});

describe('stats', () => {
  it('404s an unknown stat', async () => {
    expect((await call('/api/stats/vibes')).status).toBe(404);
  });

  it('reports cost per bucket and per model', async () => {
    bus.publish({
      jobId: 'j1', sessionId: 's1', ts: '2026-09-05T10:00:00.000Z', source: 'child',
      type: 'cost.turn', payload: { model: 'haiku', usd: 0.02, inputTokens: 10, outputTokens: 5 },
    });
    const body = await json(await call('/api/stats/cost?bucket=day'));
    expect(body.bucket).toBe('day');
    expect(body.series[0]).toMatchObject({ bucket: '2026-09-05', usd: 0.02 });
    expect(body.byModel[0]).toMatchObject({ model: 'haiku', turns: 1 });
  });

  it('labels concurrency as what it actually measures', async () => {
    const body = await json(await call('/api/stats/concurrency'));
    expect(body.measure).toBe('distinct_active_sessions_per_bucket');
  });
});

describe('GET /api/stream', () => {
  /** Reads SSE frames until `want` of them arrive, then closes the socket. */
  const collect = (path: string, want: number, headers: Record<string, string> = {}): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const frames: string[] = [];
      const req = httpGet(
        `${base}${path}`,
        { headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let i: number;
            while ((i = buffer.indexOf('\n\n')) !== -1) {
              frames.push(buffer.slice(0, i));
              buffer = buffer.slice(i + 2);
              if (frames.length >= want) {
                req.destroy();
                resolve(frames);
                return;
              }
            }
          });
          res.on('error', () => resolve(frames));
        },
      );
      req.on('error', (e) => (frames.length >= want ? resolve(frames) : reject(e)));
      setTimeout(() => reject(new Error(`only ${frames.length} frames`)), 4000).unref();
    });

  const emit = (n: number): void => {
    for (let i = 0; i < n; i++) {
      bus.publish({
        jobId: null, sessionId: 's1', ts: new Date().toISOString(),
        source: 'registry', type: 'raw', payload: { n: i },
      });
    }
  };

  it('streams live events with a resumable id', async () => {
    const pending = collect('/api/stream', 1);
    // The subscription is established synchronously inside the handler, but the
    // request has to reach it first.
    setTimeout(() => emit(1), 100);
    const [frame] = await pending;
    expect(frame).toMatch(/^id: \d+\ndata: /);
    expect(JSON.parse(frame!.split('\ndata: ')[1]!).type).toBe('raw');
  });

  it('replays from Last-Event-ID rather than from the beginning', async () => {
    emit(3);
    const frames = await collect('/api/stream', 2, { 'last-event-id': '1' });
    const ids = frames.map((f) => Number(/^id: (\d+)/.exec(f)![1]));
    expect(ids).toEqual([2, 3]);
  });

  it('gives a fresh client the live tail, not the whole history', async () => {
    emit(3);
    const pending = collect('/api/stream', 1);
    setTimeout(() => emit(1), 100);
    const [frame] = await pending;
    // Id 4, not id 1: an opening dashboard wants what is happening now.
    expect(Number(/^id: (\d+)/.exec(frame!)![1])).toBe(4);
  });

  it('honours an explicit from=0 as a request for everything', async () => {
    emit(2);
    const frames = await collect('/api/stream?from=0', 2);
    expect(frames.map((f) => Number(/^id: (\d+)/.exec(f)![1]))).toEqual([1, 2]);
  });

  it('requires a token like every other route', async () => {
    await expect(collect('/api/stream', 1, { authorization: 'Bearer nope' })).rejects.toThrow(/status 401/);
  });
});
