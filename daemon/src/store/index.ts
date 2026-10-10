import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../paths.js';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';
import { JsonlLog } from './jsonl.js';
import { LearningStore } from '../learning/store.js';
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

/** Roughly 83 days of hourly buckets, or five and a half years of daily ones. */
const MAX_BUCKETS = 2000;

/** Both ends of the generated span are rendered through this before they are
 *  compared, because a lexicographic MAX over '2026-09-05T00:00:00Z' and
 *  SQLite's own '2026-09-05 00:00:00' would order them by the separator. */
const ISO = '%Y-%m-%dT%H:%M:%SZ';

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
  /** Null when the learning store could not be opened. Ingest is an observer:
   *  it must never be the reason an event fails to record. */
  readonly #learning: LearningStore | null;
  #closed = false;

  constructor(dbPath: string = paths.db, log: JsonlLog = new JsonlLog()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#log = log;
    // Derived from the projection's own path, not from paths.*, so a test
    // pointed at a scratch db keeps its learning store in the same scratch
    // directory. This derivation is the only place the file is named.
    this.#learning = LearningStore.open(join(dirname(dbPath), 'learning.db'));
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
    } else {
      this.#db.exec(SCHEMA);
    }
    // Unconditional, not just on a version bump. appendEvent() writes the log
    // first and the projection second (see its note), so any kill between the
    // two leaves the projection short by however many events were in flight —
    // and nothing about the schema version reflects that, so the old
    // rebuild-on-mismatch path would carry the hole forward indefinitely.
    //
    // A cheaper check was tried and rejected: comparing each log's last `seq`
    // against MAX(seq) per session cannot see a hole in the middle of a
    // session, which is precisely the shape a crash leaves behind. There is no
    // partial answer here that is worth having.
    //
    // Affordable because rebuildFromLogs() truncates and replays in one pass,
    // readAll() streams line by line rather than buffering, and the learning
    // store's #seen() reduces a replayed event to one integer comparison. It
    // is also what makes learning backfill free: a store that was down, or a
    // classifier that got smarter, catches up on the next start with no
    // separate migration to run.
    this.rebuildFromLogs();
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

  /** The learning store, or null when it could not be opened. The API checks
   *  for null and reports the store as unavailable rather than 500ing. */
  get learning(): LearningStore | null {
    return this.#learning;
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

    // The learning store hangs off this one call site and inherits everything
    // from it: live ingest, crash replay, and rebuildFromLogs() backfill all
    // funnel through appendEvent. Wrapped because a learning-store fault is
    // never worth losing an event over — the drop is counted and surfaced in
    // /api/learning/status instead of thrown.
    try {
      this.#learning?.ingest(event);
    } catch (e) {
      this.#learning?.recordDrop(e);
    }

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
    // A steer spawns a real child and that child bills real money, but it
    // emits no cost.turn — so every dollar the courier spent used to be
    // missing from the cost chart and from every total derived off it. On a
    // fleet being actively steered that is not a rounding error.
    //
    // Recorded under a `courier:` model label rather than the bare tier: the
    // column is the chart's legend, so tagging it keeps steer spend visible as
    // its own slice instead of quietly inflating the model whose name it
    // shares. job_id stays null because a steer addresses a session, not a job.
    // Failed steers count too — a child that spawned and then failed still
    // billed for the tokens it read.
    if (event.type === 'steer.sent' || event.type === 'steer.failed') {
      const p = (event.payload ?? {}) as Row;
      const usd = num(p['costUsd']);
      if (usd > 0) {
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO costs (session_id, seq, job_id, ts, model, usd, input_tokens, output_tokens)
             VALUES (?, ?, NULL, ?, ?, ?, 0, 0)`,
          )
          .run(event.sessionId, event.seq, event.ts, `courier:${str(p['model'] ?? 'unknown')}`, usd);
      }
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
   * Ordered by the fleet-wide `id`, never by `seq`, because a job's events do
   * not share one seq namespace. Every job has at least two: `job.queued` is
   * published before a session exists and so carries the job id as its
   * sessionId, and the child's own events then start their own numbering at
   * zero. A job that was resumed or forked adds one namespace per session.
   *
   * `fromSeq` therefore filters within an already-ordered set rather than
   * ordering it. It is sound as a cursor only because the job-id namespace
   * holds the leading event (and the trailing one, for a job cancelled before
   * it ever started) — both callers pass 0 today.
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
   *
   * The bucket domain is generated, not collected. Deriving it from the
   * timestamps that exist — the obvious thing, and what this did — yields a row
   * only for buckets where some job *transitioned*, so a queue that sat sixteen
   * deep from 09:00 to 12:00 without a single start produced rows at 09 and 12
   * and nothing between, and the chart drew a straight line across the exact
   * hours the backlog was worst. The domain also has to run to `now` rather
   * than to the last transition, or a queue that is still backed up this minute
   * ends at whenever it last moved.
   *
   * Capped at MAX_BUCKETS so one ancient row cannot ask SQLite to enumerate
   * every hour since. The cap moves the *start* of the window rather than
   * stopping the walk early: the recursion runs forward, so truncating it
   * would keep the oldest buckets and drop today's — precisely backwards for
   * a dashboard, which is read from the right-hand edge.
   */
  queueDepthSeries(
    bucket: Bucket = 'hour',
    now: string = new Date().toISOString(),
  ): Array<{ bucket: string; waiting: number; running: number }> {
    const created = bucketOf(bucket, 'j.created_at');
    const started = bucketOf(bucket, 'j.started_at');
    const finished = bucketOf(bucket, 'j.finished_at');
    // Must render exactly what bucketOf's substr() produces, or the generated
    // domain and the per-job comparisons would be different alphabets.
    const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H';
    const step = bucket === 'day' ? '+1 day' : '+1 hour';
    const unit = bucket === 'day' ? 'days' : 'hours';
    const rows = this.#db
      .prepare(
        `WITH RECURSIVE
           span(lo, hi) AS (
             SELECT MAX(strftime('${ISO}', MIN(created_at)),
                        strftime('${ISO}', datetime(?, '-${MAX_BUCKETS} ${unit}'))),
                    MAX(COALESCE(MAX(finished_at), ''), COALESCE(MAX(started_at), ''),
                        MAX(created_at), ?)
               FROM jobs
           ),
           b(bucket, t, n) AS (
             SELECT strftime('${fmt}', lo), lo, 0 FROM span WHERE lo IS NOT NULL
             UNION ALL
             SELECT strftime('${fmt}', datetime(t, '${step}')), datetime(t, '${step}'), n + 1
               FROM b, span
              WHERE n < ${MAX_BUCKETS}
                AND strftime('${fmt}', datetime(t, '${step}')) <= strftime('${fmt}', span.hi)
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
      .all(now, now) as Row[];
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
        // costUsd comes from the terminal payload when the CLI reported one:
        // child.ts prefers total_cost_usd over its own running estimate, so
        // that figure is what the provider actually billed. Summing cost.turn
        // above is only the fallback for a job that never produced a result
        // message — without this line every rebuild would quietly overwrite a
        // reconciled cost with a stale-priced guess, and the guess is only as
        // good as DEFAULT_PRICES was on the day the job ran.
        const settled = nnum(p['costUsd']);
        jobs.set(job.id, {
          ...job,
          status,
          finishedAt: e.ts,
          exitCode: nnum(p['exitCode']),
          error: nstr(p['error']),
          ...(settled === null ? {} : { costUsd: settled }),
        });
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
    this.#learning?.close();
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
