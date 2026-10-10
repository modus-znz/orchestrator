import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestratorEvent } from '../types.js';
import { classifyArg } from './classify.js';
import { redactString } from '../redact.js';

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? '');
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

const asRecord = (v: unknown): Row => (v !== null && typeof v === 'object' ? (v as Row) : {});

/**
 * The learning store's schema version.
 *
 * Unlike the projection next door, a bump here does NOT drop and rebuild —
 * see MIGRATIONS. This store is durable, so every version step must be able to
 * carry the existing rows forward.
 */
export const LEARNING_SCHEMA_VERSION = 2;

/**
 * Migrations, applied in order from whatever version is on disk.
 *
 * The rule, and it is not negotiable: **additive only**. A migration may add a
 * table, add an index, or `ALTER TABLE ADD COLUMN` with a default. It may never
 * drop or rename, because unlike `orchestrator.db` there is no log to rebuild
 * this store from — that is the entire reason it exists as a separate file.
 *
 * Index 0 takes a fresh database to version 1.
 */
const MIGRATIONS: readonly string[] = [
  `
  -- One row per tool.use. (session_id, seq) is the idempotency contract: it is
  -- the same uniqueness the events table enforces, so a replay, a crash
  -- recovery and a full projection rebuild all re-present identical keys and
  -- all of them no-op against INSERT OR IGNORE.
  CREATE TABLE IF NOT EXISTS tool_calls (
    session_id          TEXT    NOT NULL,
    seq                 INTEGER NOT NULL,
    job_id              TEXT,
    ts                  TEXT    NOT NULL,
    tool_use_id         TEXT,
    -- Non-null means a subagent did this work, not the main session.
    parent_tool_use_id  TEXT,
    tool_name           TEXT    NOT NULL,
    -- A bounded classification, never the argument itself (see classify.ts).
    arg_class           TEXT,
    PRIMARY KEY (session_id, seq)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS ix_calls_use  ON tool_calls (tool_use_id);
  CREATE INDEX IF NOT EXISTS ix_calls_ts   ON tool_calls (ts);
  CREATE INDEX IF NOT EXISTS ix_calls_job  ON tool_calls (job_id);
  CREATE INDEX IF NOT EXISTS ix_calls_name ON tool_calls (tool_name, arg_class);

  -- One row per tool.result OR permission_denied. Kept apart from tool_calls
  -- rather than updated into it: the two arrive as separate events, and as two
  -- append-only facts their arrival order stops mattering. An outcome whose
  -- call is missing then stays visible as a countable anomaly instead of
  -- silently racing an UPDATE.
  CREATE TABLE IF NOT EXISTS tool_outcomes (
    tool_use_id       TEXT PRIMARY KEY,
    ts                TEXT NOT NULL,
    -- The three outcomes are a closed set we author ourselves in #ingest, so a
    -- CHECK here catches a typo at the write rather than as a row that silently
    -- counts toward nothing. Deliberately NOT applied to deny_reason_type
    -- below: that enum belongs to the harness and may grow without warning, and
    -- recommend() already has a default branch for a type it does not know.
    outcome           TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied')),
    -- Denials only. The reason TYPE (e.g. 'workingDir') is a bounded enum from
    -- the harness; the free-text reason is kept because it is the harness's own
    -- explanation, not user content.
    deny_reason_type  TEXT,
    deny_reason       TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS ix_outcomes_kind ON tool_outcomes (outcome);
  CREATE INDEX IF NOT EXISTS ix_outcomes_ts   ON tool_outcomes (ts);

  -- One row per cost.turn. cache_creation and cache_read are the two columns
  -- the orchestrator.db costs projection discards, and they are the most
  -- useful token-optimisation signal the system produces.
  CREATE TABLE IF NOT EXISTS turn_costs (
    session_id      TEXT    NOT NULL,
    seq             INTEGER NOT NULL,
    job_id          TEXT,
    ts              TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    wire_model      TEXT,
    usd             REAL    NOT NULL DEFAULT 0,
    estimated       INTEGER NOT NULL DEFAULT 0,
    input           INTEGER NOT NULL DEFAULT 0,
    output          INTEGER NOT NULL DEFAULT 0,
    cache_creation  INTEGER NOT NULL DEFAULT 0,
    cache_read      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, seq)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS ix_costs_ts    ON turn_costs (ts);
  CREATE INDEX IF NOT EXISTS ix_costs_job   ON turn_costs (job_id);
  CREATE INDEX IF NOT EXISTS ix_costs_model ON turn_costs (model);

  -- The CLI emits thinking_tokens as a running estimate, so the high-water mark
  -- is the meaningful figure. Labelled an estimate everywhere it is shown.
  CREATE TABLE IF NOT EXISTS session_thinking (
    session_id           TEXT PRIMARY KEY,
    job_id               TEXT,
    max_thinking_tokens  INTEGER NOT NULL DEFAULT 0,
    updated_at           TEXT NOT NULL
  ) STRICT;

  -- Where ingest got to, per session, so a restart resumes instead of rescanning.
  CREATE TABLE IF NOT EXISTS watermark (
    session_id  TEXT PRIMARY KEY,
    last_seq    INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT;

  -- Also created by #migrate() before this runs, because the version it holds
  -- is what decides which migrations to apply. Kept here so the file documents
  -- its own schema; the IF NOT EXISTS makes it a no-op in practice. Both
  -- definitions must stay identical, STRICT included.
  CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  ) STRICT;

  -- ---------------------------------------------------------------------
  -- Views. These are the stable, documented shapes: they are what an operator
  -- gets from the sqlite3 CLI, and what the claude-metrics export seam
  -- reads. The API's own queries are parameterised equivalents, because a view
  -- cannot take a time window as an argument.
  -- ---------------------------------------------------------------------

  -- Failures are split two ways on purpose. A denial means the CONFIGURATION is
  -- wrong and is fixed once in settings; an error means the code or the request
  -- is wrong and is fixed in the job. Averaged into one "failure rate" they
  -- produce a number that recommends nothing.
  CREATE VIEW IF NOT EXISTS v_tool_health AS
    SELECT c.tool_name,
           c.arg_class,
           COUNT(*)                                                  AS calls,
           SUM(CASE WHEN o.outcome = 'ok'     THEN 1 ELSE 0 END)     AS ok,
           SUM(CASE WHEN o.outcome = 'error'  THEN 1 ELSE 0 END)     AS errors,
           SUM(CASE WHEN o.outcome = 'denied' THEN 1 ELSE 0 END)     AS denied,
           SUM(CASE WHEN o.outcome IS NULL    THEN 1 ELSE 0 END)     AS pending,
           SUM(CASE WHEN c.parent_tool_use_id IS NOT NULL THEN 1 ELSE 0 END) AS by_subagent,
           MIN(c.ts) AS first_ts,
           MAX(c.ts) AS last_ts
      FROM tool_calls c
      LEFT JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
     GROUP BY c.tool_name, c.arg_class;

  -- Duration is derived, never stored: it is the gap between the two facts.
  -- Storing it would force one append-only row to wait for the other, which is
  -- the coupling the split above exists to avoid.
  CREATE VIEW IF NOT EXISTS v_tool_latency AS
    -- No MATERIALIZED hint here, deliberately, even though toolHealth() in
    -- queries.ts needs one on the same shape. There the CTE feeds two consumers
    -- and inlining costs an index seek; here d and r are each read exactly once
    -- and there is no time filter to preserve, so the hint would only force a
    -- temp b-tree the planner did not ask for.
    WITH d AS (
      SELECT c.tool_name,
             c.arg_class,
             ROUND((unixepoch(o.ts, 'subsec') - unixepoch(c.ts, 'subsec')) * 1000) AS ms
        FROM tool_calls c
        JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
       WHERE c.tool_use_id IS NOT NULL
         AND o.ts >= c.ts
    ), r AS (
      SELECT tool_name, arg_class, ms,
             ROW_NUMBER() OVER (PARTITION BY tool_name, arg_class ORDER BY ms) AS rn,
             COUNT(*)    OVER (PARTITION BY tool_name, arg_class)              AS n
        FROM d
    )
    SELECT tool_name,
           arg_class,
           n AS samples,
           MAX(CASE WHEN rn = (n + 1) / 2         THEN ms END) AS p50_ms,
           MAX(CASE WHEN rn = (n * 95 + 99) / 100 THEN ms END) AS p95_ms,
           MAX(ms)                                             AS max_ms
      FROM r
     GROUP BY tool_name, arg_class, n;

  CREATE VIEW IF NOT EXISTS v_denials AS
    SELECT o.deny_reason_type,
           c.tool_name,
           c.arg_class,
           COUNT(*)          AS denials,
           MIN(o.deny_reason) AS sample_reason,
           MAX(o.ts)          AS last_ts
      FROM tool_outcomes o
      JOIN tool_calls c ON c.tool_use_id = o.tool_use_id
     WHERE o.outcome = 'denied'
     GROUP BY o.deny_reason_type, c.tool_name, c.arg_class;

  -- cache_hit_ratio is the headline number: a job whose ratio collapses is a
  -- job whose prompt prefix is being destabilised, and that is fixable.
  CREATE VIEW IF NOT EXISTS v_token_economics AS
    SELECT job_id,
           model,
           COUNT(*)              AS turns,
           SUM(usd)              AS usd,
           SUM(input)            AS input,
           SUM(output)           AS output,
           SUM(cache_creation)   AS cache_creation,
           SUM(cache_read)       AS cache_read,
           SUM(estimated)        AS estimated_turns,
           CASE WHEN SUM(cache_read + cache_creation + input) > 0
                THEN CAST(SUM(cache_read) AS REAL)
                     / SUM(cache_read + cache_creation + input)
                ELSE NULL END    AS cache_hit_ratio,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts
      FROM turn_costs
     GROUP BY job_id, model;

  -- The demand-side counts claude-metrics wants, captured at source rather than
  -- mined back out of transcripts.
  CREATE VIEW IF NOT EXISTS v_skill_demand AS
    SELECT c.arg_class AS skill,
           COUNT(*)                                              AS invocations,
           SUM(CASE WHEN o.outcome = 'error' THEN 1 ELSE 0 END)  AS errors,
           COUNT(DISTINCT c.job_id)                              AS jobs,
           MIN(c.ts) AS first_ts,
           MAX(c.ts) AS last_ts
      FROM tool_calls c
      LEFT JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
     WHERE c.tool_name = 'Skill' AND c.arg_class IS NOT NULL
     GROUP BY c.arg_class;
  `,

  // ---- migration 1: what a job actually cost -----------------------------
  //
  // turn_costs holds estimates and nothing else. Every row in it is our own
  // price table multiplied by a token count, so the sum over a job is only as
  // good as that table was on the day it ran. The figure the provider actually
  // billed arrives exactly once, in the terminal event, and until now it was
  // read by the projection and then thrown away — leaving the learning store
  // unable to answer "what did this cost", only "what did we guess".
  //
  // Additive, as every migration here must be: this store is durable and there
  // is no rebuild to fall back on.
  `
  CREATE TABLE IF NOT EXISTS job_costs (
    job_id      TEXT PRIMARY KEY,
    session_id  TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    ts          TEXT    NOT NULL,
    status      TEXT    NOT NULL
                CHECK (status IN ('finished', 'failed', 'cancelled', 'budget_exceeded')),
    usd         REAL    NOT NULL DEFAULT 0,
    -- 1 when usd is our own estimate rather than the provider's figure. The
    -- distinction is the entire point of the table; collapsing it would make
    -- every downstream number quietly unfalsifiable.
    estimated   INTEGER NOT NULL DEFAULT 0,
    num_turns   INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    exit_code   INTEGER,
    error       TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS ix_job_costs_ts     ON job_costs (ts);
  CREATE INDEX IF NOT EXISTS ix_job_costs_status ON job_costs (status);

  -- How wrong the price table is, measured rather than argued about.
  --
  -- Restricted to jobs whose cost was settled by the provider, because those
  -- are the only ones where both numbers exist independently. ratio below 1
  -- means we are under-estimating — which matters operationally and not just
  -- cosmetically, since the same estimate drives the mid-run budget kill: a
  -- table that reads low lets a job run past its budget before anything fires.
  -- Above 1 means jobs are being killed earlier than their budget really
  -- warrants. Either way the fix is prices.json, and this is the view that
  -- says by how much.
  CREATE VIEW IF NOT EXISTS v_price_drift AS
    SELECT j.job_id,
           t.model,
           j.usd                              AS billed_usd,
           SUM(t.usd)                         AS estimated_usd,
           CASE WHEN j.usd > 0
                THEN SUM(t.usd) / j.usd
                ELSE NULL END                  AS ratio,
           COUNT(*)                           AS turns,
           j.ts                               AS ts
      FROM job_costs j
      JOIN turn_costs t ON t.job_id = j.job_id
     WHERE j.estimated = 0
     GROUP BY j.job_id, t.model;
  `,
];

export interface LearningStatus {
  /** The version actually on disk — which is not necessarily this binary's.
   *  Reporting the constant here would hide a newer store from the operator,
   *  and a version mismatch is the one thing status exists to make visible. */
  readonly schemaVersion: number;
  /** What this binary would write. Equal to schemaVersion in the normal case. */
  readonly binarySchemaVersion: number;
  readonly toolCalls: number;
  readonly toolOutcomes: number;
  readonly turnCosts: number;
  readonly sessions: number;
  /** Ingest failures swallowed so they could not reach the operational path. */
  readonly drops: number;
  readonly lastError: string | null;
  readonly dbBytes: number;
  readonly path: string;
}

/**
 * The durable learning store.
 *
 * Deliberately a *different file* from `orchestrator.db`. That projection is
 * dropped and rebuilt from JSONL whenever its schema version moves, which is
 * safe there because the logs are authoritative. Learning data cannot accept
 * that contract for two reasons: JSONL retention today is an observed absence
 * of pruning rather than a guarantee (the `jobs/` directory grows without
 * bound, so rotation is a question of when), and analytic rollups over months
 * of history should not contend with the daemon's hot ingest path on the same
 * WAL.
 */
export class LearningStore {
  readonly #db: DatabaseSync;
  readonly #path: string;
  #drops = 0;
  #lastError: string | null = null;
  #closed = false;

  /**
   * Compiled statements, memoised by their SQL.
   *
   * Ingest runs four or five writes per event on the daemon's hot path, and
   * `Store.rebuildFromLogs()` replays the entire JSONL history through that
   * path inside the Store constructor — which is to say, at daemon boot. A
   * fresh `prepare()` per write means recompiling the same handful of
   * statements once per event forever, and the log directory is designed to
   * grow without bound. Compiling each one once is the whole fix.
   */
  readonly #stmts = new Map<string, StatementSync>();

  /**
   * Highest seq already folded in, per session — the watermark table loaded
   * into memory once at open. See `#seen()` for why it is worth keeping.
   */
  readonly #marks = new Map<string, number>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#path = dbPath;
    this.#db = new DatabaseSync(dbPath);
    // Order matters, and not in the obvious way. auto_vacuum can only be moved
    // off 'none' while the database is still empty, and switching journal_mode
    // to WAL writes the header — which counts as no longer empty. Set this
    // AFTER the WAL line and the pragma silently reports back 0 with no error,
    // which is exactly how it was caught. Without it a retention delete returns
    // its pages to the freelist and never to the filesystem, and this store is
    // built to accumulate for months.
    this.#db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.#db.exec('PRAGMA journal_mode = WAL');
    // A second daemon on the same home would otherwise get SQLITE_BUSY thrown
    // straight out of a synchronous call rather than waiting its turn.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#migrate();
    for (const r of this.#db.prepare('SELECT session_id, last_seq FROM watermark').all() as Row[]) {
      this.#marks.set(str(r['session_id']), num(r['last_seq']));
    }
  }

  /** A statement, compiled on first use and reused thereafter. */
  #prep(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Open a learning store, or return null if it cannot be opened.
   *
   * The constructor is allowed to throw — a corrupt file, a read-only home, a
   * disk with nothing left on it. None of those are reasons for the daemon to
   * refuse to start, because learning is an observer and the orchestrator's
   * real job does not depend on it. The failure is reported through
   * /api/learning/status rather than through a crash.
   */
  static open(dbPath: string): LearningStore | null {
    try {
      return new LearningStore(dbPath);
    } catch {
      return null;
    }
  }

  /** Exposed for the read layer, which owns its own parameterised SQL. */
  get db(): DatabaseSync {
    return this.#db;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | Row
      | undefined;
    const from = row ? num(row['value']) : 0;

    // Additive-only, applied in order. A version ahead of this binary is left
    // alone rather than "migrated" backwards: an older daemon must not rewrite
    // a newer store, and every column here is nullable or defaulted, so reading
    // a newer store with older code degrades to ignoring columns it lacks.
    if (from >= LEARNING_SCHEMA_VERSION) return;
    for (const step of MIGRATIONS.slice(from)) this.#db.exec(step);
    this.#prep("INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(LEARNING_SCHEMA_VERSION));
  }

  /**
   * Fold one event into the learning tables.
   *
   * Every write is `INSERT OR IGNORE` on a key the event itself carries, so
   * this is safe to call any number of times with the same event — which is
   * what makes backfill free: `Store.rebuildFromLogs()` replays the whole JSONL
   * history through the same call site, and none of it double-counts.
   *
   * Throwing is the caller's problem to contain, and `Store.appendEvent` does
   * exactly that. Learning is an observer; it must never be able to take down
   * the thing it observes.
   */
  ingest(event: OrchestratorEvent): void {
    if (this.#seen(event)) return;
    const p = asRecord(event.payload);

    switch (event.type) {
      case 'tool.use':
        this.#insertCall(event, p);
        break;
      case 'tool.result':
        this.#insertOutcome(
          str(p['toolUseId']),
          event.ts,
          p['isError'] === true ? 'error' : 'ok',
          null,
          null,
        );
        break;
      case 'cost.turn':
        this.#insertCost(event, p);
        break;
      case 'job.finished':
      case 'job.failed':
      case 'job.cancelled':
      case 'job.budget_exceeded':
        this.#insertJobCost(event, p, event.type.slice('job.'.length));
        break;
      case 'raw':
        this.#ingestRaw(event, p);
        break;
      default:
        return;
    }
    this.#mark(event);
  }

  #insertCall(event: OrchestratorEvent, p: Row): void {
    const name = str(p['name']);
    if (!name) return;
    this.#prep(
        `INSERT OR IGNORE INTO tool_calls
           (session_id, seq, job_id, ts, tool_use_id, parent_tool_use_id, tool_name, arg_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,).run(
        event.sessionId,
        event.seq,
        event.jobId,
        event.ts,
        nstr(p['id']),
        nstr(p['parentToolUseId']),
        name,
        classifyArg(name, p['input']),
      );
  }

  #insertOutcome(
    toolUseId: string,
    ts: string,
    outcome: 'ok' | 'error' | 'denied',
    reasonType: string | null,
    reason: string | null,
  ): void {
    if (!toolUseId) return;
    // A denial and a result can both arrive for the same call — the harness
    // refuses the tool and the model still sees a result block. The denial is
    // the more specific fact and the one that names a fix, so it wins.
    this.#prep(
        `INSERT INTO tool_outcomes (tool_use_id, ts, outcome, deny_reason_type, deny_reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tool_use_id) DO UPDATE SET
           outcome          = excluded.outcome,
           ts               = excluded.ts,
           deny_reason_type = excluded.deny_reason_type,
           deny_reason      = excluded.deny_reason
         WHERE excluded.outcome = 'denied' AND tool_outcomes.outcome != 'denied'`,).run(toolUseId, ts, outcome, reasonType, reason);
  }

  /**
   * One row per job, written when the job reaches a terminal event.
   *
   * Three sources for the money, in descending order of how much they can be
   * trusted, which is also the order they are tried:
   *
   *  1. `costUsd` on a result event — the provider's own total_cost_usd. This
   *     is the only figure here that is not our arithmetic.
   *  2. `estimatedUsd` on a budget_exceeded event — a job killed mid-run never
   *     produces (1), and the number that triggered the kill is the honest
   *     record of what it had spent.
   *  3. The sum over turn_costs, for a job that died before the CLI said
   *     anything at all.
   *
   * Only (1) sets estimated = 0, and the conflict clause is written so that a
   * settled row can replace an estimated one but never the other way round. A
   * job can legitimately present twice — the child announces its own outcome
   * and the runner has a closing event for when it does not — and every replay
   * of the log re-presents both. Downgrading a billed figure back to a guess on
   * the second pass is the specific bug this avoids.
   */
  #insertJobCost(event: OrchestratorEvent, p: Row, status: string): void {
    const jobId = event.jobId;
    // Sessions we merely observe have no job to attribute a cost to.
    if (!jobId) return;
    const billed = typeof p['costUsd'] === 'number' ? p['costUsd'] : null;
    const atKill = typeof p['estimatedUsd'] === 'number' ? p['estimatedUsd'] : null;
    const int = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
    this.#prep(
      `INSERT INTO job_costs
         (job_id, session_id, seq, ts, status, usd, estimated,
          num_turns, duration_ms, exit_code, error)
       VALUES (?, ?, ?, ?, ?,
               COALESCE(?, (SELECT SUM(usd) FROM turn_costs WHERE job_id = ?), 0),
               ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         ts          = excluded.ts,
         status      = excluded.status,
         usd         = excluded.usd,
         estimated   = excluded.estimated,
         num_turns   = MAX(job_costs.num_turns, excluded.num_turns),
         duration_ms = COALESCE(excluded.duration_ms, job_costs.duration_ms),
         exit_code   = COALESCE(excluded.exit_code, job_costs.exit_code),
         error       = COALESCE(excluded.error, job_costs.error)
       WHERE job_costs.estimated = 1 AND excluded.estimated = 0`,
    ).run(
      jobId,
      event.sessionId,
      event.seq,
      event.ts,
      status,
      billed ?? atKill,
      jobId,
      billed === null ? 1 : 0,
      int(p['numTurns']) ?? 0,
      int(p['durationMs']),
      int(p['exitCode']),
      nstr(p['error']),
    );
  }

  #insertCost(event: OrchestratorEvent, p: Row): void {
    this.#prep(
        `INSERT OR IGNORE INTO turn_costs
           (session_id, seq, job_id, ts, model, wire_model, usd, estimated,
            input, output, cache_creation, cache_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,).run(
        event.sessionId,
        event.seq,
        event.jobId,
        event.ts,
        str(p['model'] ?? 'unknown'),
        nstr(p['wireModel']),
        num(p['usd']),
        p['estimated'] === true ? 1 : 0,
        num(p['inputTokens']),
        num(p['outputTokens']),
        num(p['cacheCreationTokens']),
        num(p['cacheReadTokens']),
      );
  }

  /** `raw` is not a coverage gap — it carries two signals worth keeping. */
  /**
   * The one free-text column in the store, and the only place the no-content
   * rule needs an explicit caveat.
   *
   * `decision_reason` is written by the harness, not by a user, and in practice
   * it is close to a fixed set ("Path is outside allowed working directories").
   * But it is not a bounded enum: one observed variant quotes the command it
   * refused. So it is passed through the project's own redaction and clipped,
   * rather than stored verbatim — the alternative was dropping the single most
   * actionable field a denial carries, which would have made the panel say
   * "something was denied" and nothing more.
   */
  static #reason(v: unknown): string | null {
    if (v == null) return null;
    return redactString(String(v)).slice(0, 200);
  }

  #ingestRaw(event: OrchestratorEvent, p: Row): void {
    switch (str(p['subtype'])) {
      case 'permission_denied':
        this.#insertOutcome(
          str(p['tool_use_id']),
          event.ts,
          'denied',
          nstr(p['decision_reason_type']),
          LearningStore.#reason(p['decision_reason']),
        );
        return;
      case 'thinking_tokens':
        this.#prep(
            `INSERT INTO session_thinking (session_id, job_id, max_thinking_tokens, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               max_thinking_tokens = MAX(session_thinking.max_thinking_tokens, excluded.max_thinking_tokens),
               updated_at          = excluded.updated_at`,).run(event.sessionId, event.jobId, num(p['estimated_tokens']), event.ts);
        return;
      default:
        return;
    }
  }

  /**
   * Whether this event has already been folded in — the watermark doing the job
   * its schema comment promises.
   *
   * `INSERT OR IGNORE` already makes re-ingest *correct*, so this is purely
   * about cost, and the cost is real: `Store.rebuildFromLogs()` replays the
   * whole JSONL history at every daemon boot, and without this check each
   * replayed event pays for four or five statement executions to write rows
   * that are already there. With it, a replayed session costs one integer
   * comparison per event.
   *
   * Safe because the watermark advances only *after* a successful ingest, and a
   * session's JSONL replays in ascending seq: anything at or below the mark was
   * already written, and a crash between the write and the mark simply replays
   * one event into an INSERT OR IGNORE that no-ops.
   */
  #seen(event: OrchestratorEvent): boolean {
    const last = this.#marks.get(event.sessionId);
    return last !== undefined && event.seq <= last;
  }

  #mark(event: OrchestratorEvent): void {
    this.#marks.set(event.sessionId, Math.max(this.#marks.get(event.sessionId) ?? -1, event.seq));
    this.#prep(
        `INSERT INTO watermark (session_id, last_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seq   = MAX(watermark.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,).run(event.sessionId, event.seq, event.ts);
  }

  /** Counted so an operator can tell "no failures" apart from "ingest broken" —
   *  a distinction a dashboard must never blur. */
  recordDrop(err: unknown): void {
    this.#drops++;
    this.#lastError = err instanceof Error ? err.message : String(err);
  }

  status(): LearningStatus {
    const count = (t: string): number =>
      num((this.#db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row)['n']);
    // The WAL counts. In journal_mode = WAL a store holding thousands of rows
    // reports 4096 bytes until something checkpoints it, which would tell an
    // operator watching disk growth exactly the wrong thing.
    let dbBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        dbBytes += statSync(this.#path + suffix).size;
      } catch {
        /* absent or unreadable; contributing nothing is the honest answer */
      }
    }
    const v = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | Row
      | undefined;

    return {
      schemaVersion: v ? num(v['value']) : 0,
      binarySchemaVersion: LEARNING_SCHEMA_VERSION,
      toolCalls: count('tool_calls'),
      toolOutcomes: count('tool_outcomes'),
      turnCosts: count('turn_costs'),
      sessions: count('watermark'),
      drops: this.#drops,
      lastError: this.#lastError,
      dbBytes,
      path: this.#path,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
