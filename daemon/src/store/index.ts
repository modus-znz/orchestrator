import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths.js';
import { SCHEMA } from './schema.js';
import { JsonlLog } from './jsonl.js';
import {
  DEFAULT_SETTINGS,
  type HarnessState,
  type JobRecord,
  type JobStatus,
  type OrchestratorEvent,
  type SessionRecord,
  type Settings,
} from '../types.js';

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? '');
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const nnum = (v: unknown): number | null => (v == null ? null : Number(v));

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
    this.#db.exec(SCHEMA);
    this.#log = log;
    for (const r of this.#db.prepare('SELECT session_id, MAX(seq) AS m FROM events GROUP BY session_id').all() as Row[]) {
      this.#seq.set(str(r['session_id']), num(r['m']) + 1);
    }
  }

  nextSeq(sessionId: string): number {
    const next = this.#seq.get(sessionId) ?? 0;
    this.#seq.set(sessionId, next + 1);
    return next;
  }

  /** Writes JSONL first, then SQLite. If the process dies between the two the
   *  log is still authoritative and rebuild() closes the gap. */
  appendEvent(event: OrchestratorEvent, { toLog = true } = {}): void {
    if (toLog) this.#log.append(event);
    this.#db
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

  eventsForJob(jobId: string, fromSeq = 0): OrchestratorEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM events WHERE job_id = ? AND seq >= ? ORDER BY seq')
      .all(jobId, fromSeq) as Row[];
    return rows.map((r) => ({
      jobId: nstr(r['job_id']),
      sessionId: str(r['session_id']),
      seq: num(r['seq']),
      ts: str(r['ts']),
      source: str(r['source']) as OrchestratorEvent['source'],
      type: str(r['type']) as OrchestratorEvent['type'],
      payload: JSON.parse(str(r['payload'] ?? 'null')),
    }));
  }

  // ---- sessions ---------------------------------------------------------

  putSession(s: SessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (session_id, kind, job_id, pid, name, cwd, alive, first_seen_at, last_seen_at, harness)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           kind=excluded.kind, job_id=excluded.job_id, pid=excluded.pid,
           name=excluded.name, cwd=excluded.cwd, alive=excluded.alive,
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

  markSessionsGone(aliveIds: readonly string[]): string[] {
    const rows = this.#db.prepare('SELECT session_id FROM sessions WHERE alive = 1').all() as Row[];
    const gone = rows.map((r) => str(r['session_id'])).filter((id) => !aliveIds.includes(id));
    for (const id of gone) {
      this.#db.prepare('UPDATE sessions SET alive = 0 WHERE session_id = ?').run(id);
    }
    return gone;
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
        jobs.set(job.id, { ...job, status: 'running', startedAt: e.ts, sessionId: e.sessionId, cliVersion: nstr(p['cliVersion']) });
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
