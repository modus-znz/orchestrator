import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, list, num, str, type Parsed } from './args.js';
import { api, stream, NotRunningError } from './client.js';
import { age, bold, dim, table, truncate, usd } from './format.js';
import { baseUrl, ensureHome, orchestratorHome, pidPath, port } from './paths.js';

/** Mirrors of the daemon's wire types. Only the fields the CLI renders. */
interface Job {
  readonly id: string;
  readonly name?: string;
  readonly status: string;
  readonly model: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly createdAt: string;
  readonly error: string | null;
  readonly steerable: boolean;
}
interface Session {
  readonly sessionId: string;
  readonly kind: string;
  readonly jobId: string | null;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly alive: boolean;
  readonly status: string | null;
  readonly lastSeenAt: string;
}
interface StoredEvent {
  readonly id: number;
  readonly jobId: string | null;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload: unknown;
}

const out = (s: string): void => void process.stdout.write(`${s}\n`);

/* ------------------------------------------------------------------ jobs */

export async function run(p: Parsed): Promise<void> {
  const prompt = p.positional.join(' ').trim();
  if (!prompt) throw new Error('orc run needs a prompt');
  const spec = {
    prompt,
    ...(str(p.flags, 'name') === undefined ? {} : { name: str(p.flags, 'name') }),
    ...(str(p.flags, 'model') === undefined ? {} : { model: str(p.flags, 'model') }),
    // Relative to where the operator is standing, not where the daemon is.
    cwd: resolve(str(p.flags, 'cwd') ?? process.cwd()),
    ...(num(p.flags, 'budget') === undefined ? {} : { budgetUsd: num(p.flags, 'budget') }),
    ...(num(p.flags, 'timeout') === undefined ? {} : { timeoutMs: num(p.flags, 'timeout') }),
    ...(str(p.flags, 'permission-mode') === undefined
      ? {}
      : { permissionMode: str(p.flags, 'permission-mode') }),
    dependsOn: list(p.flags, 'depends-on'),
    steerable: bool(p.flags, 'steerable'),
  };
  const { jobs } = await api<{ jobs: Job[] }>('POST', '/api/jobs', { jobs: [spec] });
  for (const job of jobs) out(`${bold(job.id)}  ${job.status}  ${job.model}  ${dim(job.cwd)}`);
}

export async function batch(p: Parsed): Promise<void> {
  const file = p.positional[0];
  if (!file) throw new Error('orc batch needs a JSON file');
  const parsed: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));
  // Accept both a bare array and the wire envelope, because a file written by
  // hand and a file saved from the API should both just work.
  const body = Array.isArray(parsed) ? { jobs: parsed } : parsed;
  const { jobs } = await api<{ jobs: Job[] }>('POST', '/api/jobs', body);
  out(`submitted ${jobs.length} job(s)`);
  for (const job of jobs) out(`  ${bold(job.id)}  ${job.status}  ${truncate(job.name ?? '', 40)}`);
}

export async function ps(p: Parsed): Promise<void> {
  const status = str(p.flags, 'status');
  const { jobs } = await api<{ jobs: Job[] }>(
    'GET',
    `/api/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`,
  );
  // Default to what is happening now; --all is for the history.
  const live = new Set(['queued', 'blocked', 'running']);
  const shown = bool(p.flags, 'all') || status ? jobs : jobs.filter((j) => live.has(j.status));
  if (shown.length === 0) {
    out(dim(bool(p.flags, 'all') ? 'no jobs' : 'nothing running — try --all'));
    return;
  }
  out(
    table(
      ['JOB', 'STATUS', 'MODEL', 'COST', 'TURNS', 'AGE', 'NAME'],
      shown.map((j) => [
        j.id,
        j.status,
        j.model,
        usd(j.costUsd),
        String(j.numTurns),
        age(j.createdAt),
        truncate(j.name ?? '', 40),
      ]),
    ),
  );
}

export async function cancel(p: Parsed): Promise<void> {
  const id = p.positional[0];
  if (!id) throw new Error('orc cancel needs a job id');
  const reason = str(p.flags, 'reason');
  await api('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
  out(`cancelled ${id}`);
}

/* ----------------------------------------------------------------- logs */

function render(e: StoredEvent): string {
  const time = e.ts.slice(11, 19);
  const body = ((): string => {
    const p = e.payload;
    if (p === null || typeof p !== 'object') return '';
    const r = p as Record<string, unknown>;
    if (typeof r['text'] === 'string') return r['text'];
    if (typeof r['tool'] === 'string') return String(r['tool']);
    if (typeof r['error'] === 'string') return String(r['error']);
    if (typeof r['costUsd'] === 'number') return usd(r['costUsd']);
    return JSON.stringify(p);
  })();
  return `${dim(time)} ${e.type.padEnd(18)} ${truncate(body.replace(/\s+/g, ' '), 140)}`;
}

export async function logs(p: Parsed): Promise<void> {
  const id = p.positional[0];
  if (!id) throw new Error('orc logs needs a job id');

  const { events } = await api<{ events: StoredEvent[] }>(
    'GET',
    `/api/jobs/${encodeURIComponent(id)}/events`,
  );
  for (const e of events) out(render(e));
  if (!bool(p.flags, 'follow')) return;

  // Seed from the highest fleet-wide id already printed, NOT from a seq. A job
  // that resumes or forks continues under a fresh sessionId whose seq restarts
  // at zero, so a seq cursor would skip the new session's whole opening.
  let cursor = events.reduce((max, e) => Math.max(max, e.id), 0);
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  try {
    for await (const frame of stream(cursor, controller.signal)) {
      if (frame.name === 'gap') {
        out(dim('… history truncated by the daemon; some events were skipped'));
        continue;
      }
      const e = frame.data as StoredEvent;
      if (e.jobId !== id) continue;
      cursor = frame.id;
      out(render(e));
      if (e.type === 'job.finished' || e.type === 'job.failed' || e.type === 'job.cancelled') return;
    }
  } catch (err) {
    // Ctrl-C is how you leave a follow, not a failure worth a stack trace.
    if (controller.signal.aborted) return;
    throw err;
  }
}

/* ------------------------------------------------------------ fleet/steer */

export async function fleet(): Promise<void> {
  const { sessions, managed, observed } = await api<{
    sessions: Session[];
    managed: number;
    observed: number;
  }>('GET', '/api/fleet');
  const live = sessions.filter((s) => s.alive);
  if (live.length === 0) {
    out(dim('no live sessions'));
    return;
  }
  out(
    table(
      ['SESSION', 'KIND', 'NAME', 'STATE', 'JOB', 'SEEN', 'CWD'],
      live.map((s) => [
        s.sessionId.slice(0, 8),
        s.kind,
        s.name ?? dim('-'),
        s.status ?? '-',
        s.jobId ?? '-',
        age(s.lastSeenAt),
        truncate(s.cwd ?? '-', 44),
      ]),
    ),
  );
  out(dim(`\n${managed} managed, ${observed} observed`));
}

/**
 * Both steer and attach are keyed by sessionId, but an operator addresses a
 * session by whatever they can see. So we resolve, in order:
 *
 *   1. a full uuid — already a sessionId, taken as-is;
 *   2. a session **name** or **short-id prefix** — the two things `orc fleet`
 *      and `orc allow --list` actually print, resolved against the live fleet;
 *   3. failing both, a **job id** — the original behaviour, for managed jobs
 *      the operator thinks of by job rather than session.
 *
 * Without step 2, copying the 8-char id the tool just showed you earns a "no
 * such job" 404 — which is exactly the trap this closes.
 */
async function sessionFor(target: string): Promise<string> {
  // A full uuid (8-4-4-…) is already a sessionId; skip the round-trip.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(target)) return target;

  const { sessions } = await api<{ sessions: Session[] }>('GET', '/api/fleet');
  const hits = sessions.filter(
    (s) => s.sessionId === target || s.sessionId.startsWith(target) || s.name === target,
  );
  const ids = [...new Set(hits.map((s) => s.sessionId))];
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) {
    throw new Error(`"${target}" matches ${ids.length} sessions — use the full sessionId`);
  }

  // No session matched; it is a job id (or nothing).
  const { job } = await api<{ job: Job }>('GET', `/api/jobs/${encodeURIComponent(target)}`);
  if (!job.sessionId) throw new Error(`job ${target} has no session yet (status: ${job.status})`);
  return job.sessionId;
}

export async function steer(p: Parsed): Promise<void> {
  const [target, ...rest] = p.positional;
  if (!target) throw new Error('orc steer needs a job or session and a message');
  const text = rest.join(' ').trim();
  if (!text) throw new Error('orc steer needs a message');

  const sessionId = await sessionFor(target);

  // Steering an *observed* session injects text into a live interactive session
  // that a human — or its own agent — is currently driving. Redirecting a
  // managed job in flight is the whole point of steer; interrupting a busy
  // interactive session the daemon did not start is a different, louder act, so
  // it must be deliberate. --force is the deliberate.
  if (!bool(p.flags, 'force')) {
    const { sessions } = await api<{ sessions: Session[] }>('GET', '/api/fleet');
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (s && s.kind === 'observed' && s.status === 'busy') {
      throw new Error(
        `session ${sessionId.slice(0, 8)} (${s.name ?? 'unnamed'}) is observed and busy — ` +
          'steering it now injects text into work already in progress. ' +
          'Re-run with --force if you mean to interrupt it.',
      );
    }
  }

  const result = await api<{ delivered: boolean; costUsd: number; error: string | null }>(
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
    { text },
  );
  // The cost is printed either way: a courier that failed still billed.
  out(`${result.delivered ? 'delivered' : 'NOT delivered'}  ${dim(usd(result.costUsd))}`);
  if (result.error) out(dim(result.error));
}

/* ------------------------------------------------------------- allowlist */

/**
 * Resolve an operator's argument to a sessionId. A uuid passes straight
 * through; a name is looked up against the live fleet.
 *
 * We store the id, never the name — deliberately. Peer names are *derived*, not
 * assigned (F19): they change across a restart and can come to point at a
 * different session entirely. An allowlist of names is therefore an allowlist
 * whose meaning drifts, so the moment a name is given we pin it to the id it
 * denotes right now.
 */
async function resolveToSessionId(target: string, sessions: readonly Session[]): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(target)) return target;
  const matches = sessions.filter((s) => s.alive && s.name === target);
  if (matches.length === 0) {
    throw new Error(`no live session named "${target}" — pass a sessionId, or check \`orc fleet\``);
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.sessionId.slice(0, 8)).join(', ');
    throw new Error(`"${target}" names ${matches.length} live sessions (${ids}); names are not unique — pass the sessionId`);
  }
  return matches[0]!.sessionId;
}

/**
 * Manage the daemon's steer allowlist — the only gate on steering an observed
 * session. `orc allow <id|name>` adds, `--remove <id|name>` revokes, `--list`
 * shows the current set and prunes entries that name no live session.
 *
 * The allowlist is a single settings key holding an array, and PUT replaces a
 * key wholesale, so every mutation here is read-modify-write against the live
 * value rather than a blind overwrite.
 */
export async function allow(p: Parsed): Promise<void> {
  const { settings } = await api<{ settings: { steerAllowlist: string[] } }>('GET', '/api/settings');
  const current = settings.steerAllowlist;
  const inFleet = async (): Promise<Session[]> =>
    (await api<{ sessions: Session[] }>('GET', '/api/fleet')).sessions;

  // --list: show the allowlist and prune anything that no longer names a live
  // session. A stale id is harmless (it just fails `session_gone` on use), but a
  // list that quietly accretes dead ids stops being something you can read.
  if (bool(p.flags, 'list')) {
    const sessions = await inFleet();
    const liveIds = new Set(sessions.filter((s) => s.alive).map((s) => s.sessionId));
    const liveNames = new Set(
      sessions.filter((s) => s.alive).map((s) => s.name).filter((n): n is string => n !== null),
    );
    const kept = current.filter((e) => liveIds.has(e) || liveNames.has(e));
    const dropped = current.filter((e) => !kept.includes(e));
    if (dropped.length) await api('PUT', '/api/settings', { steerAllowlist: kept });

    if (kept.length === 0) {
      out(dim('allowlist is empty — nothing observed can be steered'));
    } else {
      for (const e of kept) {
        const s = sessions.find((x) => x.sessionId === e || x.name === e);
        const label = e.length >= 36 ? e.slice(0, 8) : e;
        out(`${bold(label)}  ${s ? `${s.name ?? dim('-')}  ${s.status ?? '-'}` : dim('(not live)')}`);
      }
    }
    if (dropped.length) out(dim(`pruned ${dropped.length} dead entr${dropped.length === 1 ? 'y' : 'ies'}`));
    return;
  }

  // --remove <id|name>: drop by what is stored, falling back to name→id so you
  // can remove by the name you added even though we stored the id.
  const remove = str(p.flags, 'remove');
  if (remove !== undefined) {
    let next = current.filter((e) => e !== remove);
    if (next.length === current.length && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(remove)) {
      try {
        const id = await resolveToSessionId(remove, await inFleet());
        next = current.filter((e) => e !== id);
      } catch {
        // Name no longer resolves; nothing to remove by that route.
      }
    }
    if (next.length === current.length) {
      out(dim(`"${remove}" was not in the allowlist`));
      return;
    }
    await api('PUT', '/api/settings', { steerAllowlist: next });
    out(`removed ${remove}`);
    return;
  }

  // Bare positional: add.
  const target = p.positional[0];
  if (!target) {
    throw new Error('orc allow needs a sessionId or name (or --list, or --remove <id|name>)');
  }
  const sessions = await inFleet();
  const id = await resolveToSessionId(target, sessions);
  if (current.includes(id)) {
    out(dim(`${id.slice(0, 8)} is already allowed`));
    return;
  }
  await api('PUT', '/api/settings', { steerAllowlist: [...current, id] });
  const s = sessions.find((x) => x.sessionId === id);
  out(`allowed ${bold(id.slice(0, 8))}${s?.name ? `  (${s.name})` : ''} — steerable now`);
}

export async function attach(p: Parsed): Promise<void> {
  const target = p.positional[0];
  if (!target) throw new Error('orc attach needs a job or session');
  const sessionId = await sessionFor(target);
  const terminal = str(p.flags, 'terminal');
  const res = await api<{ terminal: string; pid: number }>(
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/attach`,
    terminal ? { terminal } : {},
  );
  out(`opened ${res.terminal} (pid ${res.pid}) on session ${sessionId.slice(0, 8)}`);
  // Say the quiet part: from here a human is driving.
  out(dim('the orchestrator keeps observing this session but will not steer it'));
}

/* ---------------------------------------------------------------- daemon */

/** `dist/`, because the daemon cannot run from source: its `.js` specifiers do
 *  not resolve to `.ts` files under plain Node, and its parameter properties
 *  are not erasable syntax, so type-stripping cannot bridge the gap either. */
function daemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // cli/dist -> cli -> repo root
  return resolve(here, '..', '..', 'daemon', 'dist', 'index.js');
}

async function health(): Promise<{ ok: boolean; pid: number; running: number } | null> {
  try {
    return await api<{ ok: boolean; pid: number; running: number }>('GET', '/api/health');
  } catch (err) {
    if (err instanceof NotRunningError) return null;
    throw err;
  }
}

export async function daemon(p: Parsed): Promise<void> {
  const action = p.positional[0] ?? 'status';

  if (action === 'status') {
    const h = await health();
    out(h ? `running  pid ${h.pid}  ${h.running} job(s)  ${baseUrl()}` : dim('not running'));
    return;
  }

  if (action === 'start') {
    if (await health()) {
      out(dim('already running'));
      return;
    }
    const entry = daemonEntry();
    if (!existsSync(entry)) {
      throw new Error(`daemon is not built (${entry} missing) — run \`npm run build -w @orchestrator/daemon\``);
    }
    ensureHome();

    // Detached with its output on a file: a daemon whose stdout is the
    // launching terminal dies with that terminal, which is not a daemon.
    const logFile = join(orchestratorHome(), 'daemon.log');
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ORCHESTRATOR_PORT: String(port()) },
    });
    child.unref();
    if (child.pid !== undefined) writeFileSync(pidPath(), `${child.pid}\n`);

    // Confirm it is actually serving before claiming success — a process that
    // started and then died on a port clash is not a running daemon.
    for (let i = 0; i < 40; i++) {
      const h = await health();
      if (h) {
        out(`started  pid ${h.pid}  ${baseUrl()}`);
        out(dim(`logs: ${logFile}`));
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`daemon did not come up within 4s — see ${logFile}`);
  }

  if (action === 'stop') {
    const h = await health();
    if (!h) {
      out(dim('not running'));
      return;
    }
    // SIGTERM, not SIGKILL: the daemon's handler drains in-flight jobs and
    // settles their rows. Killing it hard is what reconciliation exists to
    // clean up, and cleaning up is worse than shutting down properly.
    process.kill(h.pid, 'SIGTERM');
    for (let i = 0; i < 100; i++) {
      if (!(await health())) {
        out(`stopped  pid ${h.pid}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    out(`daemon ${h.pid} is still shutting down (it drains running jobs first)`);
    return;
  }

  throw new Error(`unknown: orc daemon ${action} (expected start, stop or status)`);
}

/**
 * Open the dashboard with the token already attached.
 *
 * The token travels in the URL **fragment**, not the query string: browsers
 * never put a fragment in the request line, so it reaches no access log, no
 * `Referer` header, and no proxy we might one day put in front of the daemon.
 * The page reads it once, stores it, and strips it from the address bar.
 */
export async function ui(p: Parsed): Promise<void> {
  if (!(await health())) {
    throw new NotRunningError(`the daemon is not running — start it with \`orc daemon start\``);
  }
  const url = `${baseUrl()}/#token=${readToken()}`;
  if (bool(p.flags, 'print')) {
    // Printing beats opening when there is no browser to open into — over ssh,
    // or inside a session whose DISPLAY belongs to someone else.
    out(url);
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    out(`could not launch ${opener}; open this yourself:`);
    out(url);
  });
  child.unref();
  out(dim(`opening ${baseUrl()}`));
}

function readToken(): string {
  try {
    return readFileSync(join(orchestratorHome(), 'token'), 'utf8').trim();
  } catch {
    throw new NotRunningError(`no token at ${join(orchestratorHome(), 'token')}`);
  }
}
