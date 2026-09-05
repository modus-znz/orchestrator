import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths.js';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';
import { JsonlLog } from './jsonl.js';
import {
  DEFAULT_SETTINGS,
  type FleetKind,
  type HarnessState,
  type JobRecord,
  type JobStatus,
  type OrchestratorEvent,
  type SessionRecord,
  type StoredEvent,
  type Settings,
} from '../types.js';

type Row = Record<string, unknown>;

export type Bucket = 'hour' | 'day';

/** Timestamps are stored as ISO-8601, so a prefix IS the bucket — no date
 *  parsing, no timezone to get wrong, and it sorts lexicographically. */
/** Truncate an ISO timestamp column to its hour or day prefix. */
const bucketOf = (b: Bucket, col: string): string => `substr(${col}, 1, ${b === 'day' ? 10 : 13})`;
const bucketExpr = (b: Bucket): string => bucketOf(b, 'ts');

const str = (v: unknown): string => String(v ?? '');
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const nnum = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * The `job.started` projection, shared by the live scheduler and by replay.
 *
 * It exists as one function because it had two implementations and they drifted:
 * replay read `cliVersion` off the event payload, the live path never did, and so
 * every job that had not survived a restart reported a null CLI version — the one
 * field that says which binary actually produced the run.
 *
 * `startedAt` prefers a time already on the row: the scheduler records the spawn,
 * which is earlier and truer than the child's init message, while replay has only
 * the event and falls through to its timestamp.
 */
export function applyJobStarted(job: JobRecord, ts: string, sessionId: string, payload: Row): JobRecord {
  return {
    ...job,
    status: 'running',
    startedAt: job.startedAt ?? ts,
    sessionId,
    cliVersion: nstr(payload['cliVersion']),
  };
}

function rowToJob(r: Row): JobRecord {
  const tools = nstr(r['allowed_tools']);
  return {
    id: str(r['id']),
    name: str(r['name'] ?? ''),
    prompt: str(r['prompt']),
    cwd: str(r['cwd']),
    model: str(r['model']) as JobRecord['model'],
    budgetUsd: num(r['budget_usd']),
    timeoutMs: num(r['timeout_ms']),
    permissionMode: str(r['permission_mode']) as JobRecord['permissionMode'],
    ...(tools ? { allowedTools: JSON.parse(tools) as string[] } : {}),
    dependsOn: JSON.parse(str(r['depends_on'] ?? '[]')) as string[],
    steerable: num(r['steerable']) === 1,
    status: str(r['status']) as JobStatus,
    sessionId: nstr(r['session_id']),
    createdAt: str(r['created_at']),
    startedAt: nstr(r['started_at']),
    finishedAt: nstr(r['finished_at']),
    costUsd: num(r['cost_usd']),
    numTurns: num(r['num_turns']),
    exitCode: nnum(r['exit_code']),
    error: nstr(r['error']),
    cliVersion: nstr(r['cli_version']),
  };
}

function rowToEvent(r: Row): StoredEvent {
  return {
    id: num(r['id']),
    jobId: nstr(r['job_id']),
    sessionId: str(r['session_id']),
    seq: num(r['seq']),
    ts: str(r['ts']),
    source: str(r['source']) as OrchestratorEvent['source'],
    type: str(r['type']) as OrchestratorEvent['type'],
    payload: JSON.parse(str(r['payload'] ?? 'null')),
  };
}

function rowToSession(r: Row): SessionRecord {
  const harness = nstr(r['harness']);
  return {
    sessionId: str(r['session_id']),
    kind: str(r['kind']) as SessionRecord['kind'],
    jobId: nstr(r['job_id']),
    pid: nnum(r['pid']),
    name: nstr(r['name']),
    cwd: nstr(r['cwd']),
    alive: num(r['alive']) === 1,
    procStart: nstr(r['proc_start']),
    status: nstr(r['status']) as SessionRecord['status'],
    firstSeenAt: str(r['first_seen_at']),
    lastSeenAt: str(r['last_seen_at']),
    ...(harness ? { harness: JSON.parse(harness) as HarnessState } : {}),
  };
}

export class Store {
  readonly #db: DatabaseSync;
  readonly #log: JsonlLog;
  /** Next seq per sessionId. The bus asks the store, so numbering survives a
   *  daemon restart mid-session instead of restarting at zero. */
  readonly #seq = new Map<string, number>();
  #closed = false;

  constructor(dbPath: string = paths.db, log: JsonlLog = new JsonlLog()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#log = log;
    // A projection is only worth having if it matches the code reading it.
    // `CREATE TABLE IF NOT EXISTS` would happily leave a previous shape in
    // place, so a version mismatch drops and rebuilds instead of migrating —
    // cheap, because the JSONL logs are the actual truth (spec §4.3).
    const found = num((this.#db.prepare('PRAGMA user_version').get() as Row)['user_version']);
    if (found !== SCHEMA_VERSION) {
      this.#db.exec(
        'DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS costs;' +
          ' DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS jobs;',
      );
      this.#db.exec(SCHEMA);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      // A no-op on a fresh install, where there are no logs to read.
      this.rebuildFromLogs();
    } else {
      this.#db.exec(SCHEMA);
    }
    for (const r of this.#db.prepare('SELECT session_id, MAX(seq) AS m FROM events GROUP BY session_id').all() as Row[]) {
      this.#seq.set(str(r['session_id']), num(r['m']) + 1);
    }
  }

  /** Whether close() has run. The bus consults this: a child can settle after
   *  shutdown has closed the store, and crashing on the way out is a poor way
   *  to report that there was nowhere left to write. */
  get closed(): boolean {
    return this.#closed;
  }

  nextSeq(sessionId: string): number {
    const next = this.#seq.get(sessionId) ?? 0;
    this.#seq.set(sessionId, next + 1);
    return next;
  }

  /**
   * Writes JSONL first, then SQLite. If the process dies between the two the
   * log is still authoritative and rebuild() closes the gap.
   *
   * Returns the fleet-wide `id` the projection assigned. The JSONL record
   * deliberately does not carry it: the id is a property of the projection,
   * reassigned deterministically on every rebuild, and writing it to the log
   * would make the log claim an ordering it does not own.
   */
  appendEvent(event: OrchestratorEvent, { toLog = true } = {}): number {
    if (toLog) this.#log.append(event);
    const inserted = this.#db
      .prepare(
        `INSERT OR IGNORE INTO events (session_id, seq, job_id, ts, source, type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.seq,
        event.jobId,
        event.ts,
        event.source,
        event.type,
        JSON.stringify(event.payload ?? null),
      );

    if (event.type === 'cost.turn') {
      const p = (event.payload ?? {}) as Row;
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO costs (session_id, seq, job_id, ts, model, usd, input_tokens, output_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.sessionId,
          event.seq,
          event.jobId,
          event.ts,
          str(p['model'] ?? 'unknown'),
          num(p['usd']),
          num(p['inputTokens']),
          num(p['outputTokens']),
        );
    }
    // A replayed event hits the UNIQUE(session_id, seq) constraint and inserts
    // nothing; report the id it already has rather than a misleading 0.
    if (inserted.changes === 0) {
      const existing = this.#db
        .prepare('SELECT id FROM events WHERE session_id = ? AND seq = ?')
        .get(event.sessionId, event.seq) as Row | undefined;
      return existing ? num(existing['id']) : 0;
    }
    return Number(inserted.lastInsertRowid);
  }

  // ---- jobs -------------------------------------------------------------

  putJob(job: JobRecord): void {
    this.#db
      .prepare(
        `INSERT INTO jobs (id, name, prompt, cwd, model, budget_usd, timeout_ms,
           permission_mode, allowed_tools, depends_on, steerable, status, session_id,
           created_at, started_at, finished_at, cost_usd, num_turns, exit_code, error, cli_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, session_id=excluded.session_id,
           started_at=excluded.started_at, finished_at=excluded.finished_at,
           cost_usd=excluded.cost_usd, num_turns=excluded.num_turns,
           exit_code=excluded.exit_code, error=excluded.error,
           cli_version=excluded.cli_version`,
      )
      .run(
        job.id,
        job.name ?? null,
        job.prompt,
        job.cwd,
        job.model,
        job.budgetUsd,
        job.timeoutMs,
        job.permissionMode,
        job.allowedTools ? JSON.stringify(job.allowedTools) : null,
        JSON.stringify(job.dependsOn),
        job.steerable ? 1 : 0,
        job.status,
        job.sessionId,
        job.createdAt,
        job.startedAt,
        job.finishedAt,
        job.costUsd,
        job.numTurns,
        job.exitCode,
        job.error,
        job.cliVersion,
      );
  }

  getJob(id: string): JobRecord | null {
    const r = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  listJobs(status?: JobStatus): JobRecord[] {
    const rows = (
      status
        ? this.#db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC').all(status)
        : this.#db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
    ) as Row[];
    return rows.map(rowToJob);
  }

  /**
   * A job's transcript from `fromSeq` onward.
   *
   * `seq` is the right cursor here and only here: a job's events all belong to
   * one session at a time. A job that was resumed or forked spans more than one
   * sessionId, each with its own `seq` restarting at zero — so the rows are
   * ordered by the fleet-wide `id`, and `fromSeq` filters within them rather
   * than ordering them.
   */
  eventsForJob(jobId: string, fromSeq = 0): StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE job_id = ? AND seq >= ? ORDER BY id')
      .all(jobId, fromSeq) as Row[];
    return rows.map(rowToEvent);
  }

  /**
   * Events after a fleet-wide cursor, for SSE resume via `Last-Event-ID`.
   *
   * Bounded by `limit` because a client that has been away for a day must not
   * be able to make the daemon materialise its entire history in one buffer;
   * the caller pages by feeding back the last id it received.
   */
  eventsSince(afterId: number, limit = 500): StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?')
      .all(afterId, limit) as Row[];
    return rows.map(rowToEvent);
  }

  /** The newest fleet-wide event id, or 0 when nothing has happened yet. */
  latestEventId(): number {
    const r = this.#db.prepare('SELECT MAX(id) AS m FROM events').get() as Row;
    return num(r['m']);
  }

  // ---- sessions ---------------------------------------------------------

  putSession(s: SessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (session_id, kind, job_id, pid, name, cwd, alive,
                               proc_start, status, first_seen_at, last_seen_at, harness)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           kind=excluded.kind, job_id=excluded.job_id, pid=excluded.pid,
           name=excluded.name, cwd=excluded.cwd, alive=excluded.alive,
           proc_start=excluded.proc_start, status=excluded.status,
           last_seen_at=excluded.last_seen_at, harness=excluded.harness`,
      )
      .run(
        s.sessionId,
        s.kind,
        s.jobId,
        s.pid,
        s.name,
        s.cwd,
        s.alive ? 1 : 0,
        s.procStart ?? null,
        s.status ?? null,
        s.firstSeenAt,
        s.lastSeenAt,
        s.harness ? JSON.stringify(s.harness) : null,
      );
  }

  listSessions(): SessionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions ORDER BY alive DESC, last_seen_at DESC')
      .all() as Row[];
    return rows.map(rowToSession);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Retire the live sessions of one kind that `aliveIds` no longer mentions.
   *
   * The kind filter is not decoration. Each source sees only its own sessions:
   * the registry watcher enumerates observed ones, the runner tracks managed
   * ones. An unscoped sweep would read "no managed sessions in this list" as
   * "every managed session died" and empty the fleet view on the first tick.
   */
  markSessionsGone(kind: FleetKind, aliveIds: readonly string[]): string[] {
    const rows = this.#db
      .prepare('SELECT session_id FROM sessions WHERE alive = 1 AND kind = ?')
      .all(kind) as Row[];
    const gone = rows.map((r) => str(r['session_id'])).filter((id) => !aliveIds.includes(id));
    for (const id of gone) {
      this.#db.prepare('UPDATE sessions SET alive = 0 WHERE session_id = ?').run(id);
    }
    return gone;
  }

  /**
   * When this session was last steered, as epoch millis, newest first.
   *
   * Failed deliveries count. The rate limit exists because couriers cost real
   * money (§14) and a courier that failed spent it just the same — a limit that
   * only counted successes would be uncapped in exactly the situation where
   * something is going wrong.
   */
  recentSteerTimes(sessionId: string, sinceIso: string): number[] {
    const rows = this.#db
      .prepare(
        `SELECT ts FROM events
          WHERE session_id = ? AND ts >= ? AND type IN ('steer.sent', 'steer.failed')
          ORDER BY id DESC`,
      )
      .all(sessionId, sinceIso) as Row[];
    return rows.map((r) => Date.parse(str(r['ts']))).filter((t) => Number.isFinite(t));
  }

  // ---- stats ------------------------------------------------------------

  /** Spend per time bucket, for the cost chart. */
  costSeries(bucket: Bucket = 'hour'): Array<{ bucket: string; usd: number; inputTokens: number; outputTokens: number }> {
    const rows = this.#db
      .prepare(
        `SELECT ${bucketExpr(bucket)} AS b, SUM(usd) AS usd,
                SUM(input_tokens) AS inp, SUM(output_tokens) AS outp
           FROM costs GROUP BY b ORDER BY b`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      bucket: str(r['b']),
      usd: num(r['usd']),
      inputTokens: num(r['inp']),
      outputTokens: num(r['outp']),
    }));
  }

  costByModel(): Array<{ model: string; usd: number; turns: number }> {
    const rows = this.#db
      .prepare('SELECT model, SUM(usd) AS usd, COUNT(*) AS n FROM costs GROUP BY model ORDER BY usd DESC')
      .all() as Row[];
    return rows.map((r) => ({ model: str(r['model']), usd: num(r['usd']), turns: num(r['n']) }));
  }

  /**
   * Distinct sessions active per bucket.
   *
   * Deliberately not "instantaneous concurrency", which the event log cannot
   * answer without reconstructing every session's lifetime. This is the honest
   * measure the data supports, and the chart is labelled as such rather than
   * implying a precision that is not there.
   */
  concurrencySeries(bucket: Bucket = 'hour'): Array<{ bucket: string; sessions: number; jobs: number }> {
    const rows = this.#db
      .prepare(
        `SELECT ${bucketExpr(bucket)} AS b, COUNT(DISTINCT session_id) AS s,
                COUNT(DISTINCT job_id) AS j
           FROM events GROUP BY b ORDER BY b`,
      )
      .all() as Row[];
    return rows.map((r) => ({ bucket: str(r['b']), sessions: num(r['s']), jobs: num(r['j']) }));
  }

  /**
   * How many jobs were waiting, and how many were running, in each bucket.
   *
   * Queue depth is a property of an *interval*, not of an event: a job that
   * queued at 09:00 and started at 11:00 was waiting at 10:00 even though it
   * emitted nothing then. So this is a span query over `jobs`, not a count of
   * `job.queued` events — counting the events would report zero for exactly
   * the hours the queue was deepest.
   *
   * A job cancelled while still queued stops being counted at the bucket it
   * finished in, which is why the waiting arm tests `finished_at` too.
   */
  queueDepthSeries(bucket: Bucket = 'hour'): Array<{ bucket: string; waiting: number; running: number }> {
    const created = bucketOf(bucket, 'j.created_at');
    const started = bucketOf(bucket, 'j.started_at');
    const finished = bucketOf(bucket, 'j.finished_at');
    const rows = this.#db
      .prepare(
        `WITH b(bucket) AS (
           SELECT DISTINCT ${bucketOf(bucket, 'created_at')} FROM jobs
           UNION SELECT DISTINCT ${bucketOf(bucket, 'started_at')} FROM jobs WHERE started_at IS NOT NULL
           UNION SELECT DISTINCT ${bucketOf(bucket, 'finished_at')} FROM jobs WHERE finished_at IS NOT NULL
         )
         SELECT b.bucket AS bkt,
                SUM(CASE WHEN ${created} <= b.bucket
                          AND (j.started_at IS NULL OR ${started} > b.bucket)
                          AND (j.finished_at IS NULL OR ${finished} > b.bucket)
                         THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN j.started_at IS NOT NULL AND ${started} <= b.bucket
                          AND (j.finished_at IS NULL OR ${finished} > b.bucket)
                         THEN 1 ELSE 0 END) AS running
           FROM b LEFT JOIN jobs j
          GROUP BY b.bucket ORDER BY b.bucket`,
      )
      .all() as Row[];
    return rows.map((r) => ({ bucket: str(r['bkt']), waiting: num(r['waiting']), running: num(r['running']) }));
  }

  /** Which tools the fleet actually reaches for. */
  toolUsage(limit = 25): Array<{ tool: string; uses: number }> {
    const rows = this.#db
      .prepare(
        `SELECT COALESCE(json_extract(payload, '$.name'), 'unknown') AS tool, COUNT(*) AS n
           FROM events WHERE type = 'tool.use'
          GROUP BY tool ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ tool: str(r['tool']), uses: num(r['n']) }));
  }

  /** Terminal job outcomes, plus the errors behind the failures. */
  failureStats(limit = 20): { byStatus: Array<{ status: string; count: number }>; recent: Array<{ id: string; name: string; error: string | null; finishedAt: string | null }> } {
    const byStatus = (
      this.#db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Row[]
    ).map((r) => ({ status: str(r['status']), count: num(r['n']) }));
    const recent = (
      this.#db
        .prepare(
          `SELECT id, name, error, finished_at FROM jobs
            WHERE status IN ('failed', 'budget_exceeded', 'cancelled')
            ORDER BY finished_at DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((r) => ({
      id: str(r['id']),
      name: str(r['name'] ?? ''),
      error: nstr(r['error']),
      finishedAt: nstr(r['finished_at']),
    }));
    return { byStatus, recent };
  }

  // ---- settings ---------------------------------------------------------

  getSettings(): Settings {
    const rows = this.#db.prepare('SELECT key, value FROM settings').all() as Row[];
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[str(r['key'])] = JSON.parse(str(r['value']));
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  }

  putSettings(patch: Partial<Settings>): Settings {
    const stmt = this.#db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
    return this.getSettings();
  }

  // ---- recovery ---------------------------------------------------------

  /**
   * Rebuild the queryable tables from the append-only logs. Job rows are
   * reconstructed because `job.queued` carries the full spec and the later
   * job.* events carry the deltas — so the DB never holds anything the log
   * does not.
   */
  rebuildFromLogs(): { events: number; jobs: number } {
    this.#db.exec('DELETE FROM events; DELETE FROM costs; DELETE FROM jobs; DELETE FROM sessions;');
    this.#seq.clear();
    const jobs = new Map<string, JobRecord>();
    let events = 0;

    for (const e of JsonlLog.readAll()) {
      this.appendEvent(e, { toLog: false });
      events++;
      this.#seq.set(e.sessionId, Math.max(this.#seq.get(e.sessionId) ?? 0, e.seq + 1));

      const p = (e.payload ?? {}) as Row;
      if (e.type === 'job.queued' && e.jobId) {
        jobs.set(e.jobId, p['job'] as JobRecord);
      }
      const job = e.jobId ? jobs.get(e.jobId) : undefined;
      if (!job) continue;
      if (e.type === 'job.started') {
        jobs.set(job.id, applyJobStarted(job, e.ts, e.sessionId, p));
      } else if (e.type === 'cost.turn') {
        jobs.set(job.id, { ...job, costUsd: job.costUsd + num(p['usd']), numTurns: job.numTurns + 1 });
      } else if (e.type === 'job.finished' || e.type === 'job.failed' || e.type === 'job.cancelled' || e.type === 'job.budget_exceeded') {
        const status: JobStatus =
          e.type === 'job.finished' ? 'succeeded'
          : e.type === 'job.failed' ? 'failed'
          : e.type === 'job.cancelled' ? 'cancelled'
          : 'budget_exceeded';
        jobs.set(job.id, { ...job, status, finishedAt: e.ts, exitCode: nnum(p['exitCode']), error: nstr(p['error']) });
      }
    }

    for (const job of jobs.values()) this.putJob(job);
    return { events, jobs: jobs.size };
  }

  /** Idempotent: shutdown paths can race (signal handler + normal exit) and a
   *  second close must not throw over the top of the real shutdown reason. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#log.close();
    this.#db.close();
  }

  /** Test helper: wipe a scratch home. Refuses to touch a non-scratch path. */
  static destroyScratch(home: string): void {
    if (!home.includes('scratch') && !home.includes('tmp')) {
      throw new Error(`refusing to destroy non-scratch home: ${home}`);
    }
    rmSync(home, { recursive: true, force: true });
  }
}
