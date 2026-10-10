import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v ?? 0);
const nnum = (v: unknown): number | null => (v == null ? null : Number(v));
const nstr = (v: unknown): string | null => (v == null ? null : String(v));

/** A hard ceiling on any single response, so a query can never be the thing
 *  that makes the dashboard slow. */
const MAX_ROWS = 500;
const clamp = (n: number | undefined, fallback: number): number =>
  Math.min(MAX_ROWS, Math.max(1, Number.isFinite(n) && n ? (n as number) : fallback));

export interface Window {
  readonly since?: string | undefined;
  readonly jobId?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The filter both halves of a windowed query share.
 *
 * The views in the schema are the stable, documented shapes, but a view cannot
 * accept a time window — so the API's queries are parameterised equivalents
 * built from this fragment rather than selects over the views. Same SQL shape,
 * same meaning, one place to keep them honest.
 */
function scope(w: Window): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  if (w.since) {
    parts.push('ts >= ?');
    args.push(w.since);
  }
  if (w.jobId) {
    parts.push('job_id = ?');
    args.push(w.jobId);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

/**
 * Percentiles, computed in SQL rather than pulled into JS.
 *
 * `(n + 1) / 2` and `(n * 95 + 99) / 100` are integer division, which is exactly
 * the ceiling behaviour wanted: at n = 1 both land on the only sample, at
 * n = 20 p95 lands on the 19th. `unixepoch(…, 'subsec')` is used rather than
 * `julianday` because the latter arrives via a float and reports 1250.0033 ms
 * where the truth is 1250.
 */
const LATENCY_CTE = `
  r AS (
    SELECT tool_name, arg_class, ms,
           ROW_NUMBER() OVER (PARTITION BY tool_name, arg_class ORDER BY ms) AS rn,
           COUNT(ms)   OVER (PARTITION BY tool_name, arg_class)              AS n
      FROM j
     WHERE ms IS NOT NULL
  ),
  lat AS (
    SELECT tool_name, arg_class, n AS samples,
           MAX(CASE WHEN rn = (n + 1) / 2         THEN ms END) AS p50_ms,
           MAX(CASE WHEN rn = (n * 95 + 99) / 100 THEN ms END) AS p95_ms
      FROM r
     GROUP BY tool_name, arg_class, n
  )`;

export interface ToolHealthRow {
  readonly toolName: string;
  readonly argClass: string | null;
  readonly calls: number;
  readonly ok: number;
  readonly errors: number;
  readonly denied: number;
  readonly pending: number;
  readonly bySubagent: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly lastTs: string | null;
}

export function toolHealth(db: DatabaseSync, w: Window = {}): ToolHealthRow[] {
  const s = scope(w);
  const sql = `
    -- MATERIALIZED is load-bearing here, and only here. \`j\` is consumed twice
    -- below (once by the latency CTE, once by health), so SQLite's default of
    -- inlining a CTE at every use re-runs this scan — and an inlined scan
    -- cannot use ix_calls_ts, which makes the cost track the store's lifetime
    -- size instead of the window. Measured on a million rows over a 7-day
    -- window: 2,804 ms inlined vs 270 ms materialized, identical result set.
    -- denials() and skillDemand() below read \`c\` exactly once, so inlining is
    -- the right plan there and they are deliberately left alone.
    WITH c AS MATERIALIZED (SELECT * FROM tool_calls ${s.sql}),
    j AS (
      SELECT c.tool_name, c.arg_class, c.ts, c.parent_tool_use_id, o.outcome,
             CASE WHEN o.ts >= c.ts
                  THEN ROUND((unixepoch(o.ts, 'subsec') - unixepoch(c.ts, 'subsec')) * 1000)
             END AS ms
        FROM c LEFT JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
    ),
    ${LATENCY_CTE},
    health AS (
      SELECT tool_name, arg_class,
             COUNT(*)                                                  AS calls,
             SUM(CASE WHEN outcome = 'ok'     THEN 1 ELSE 0 END)        AS ok,
             SUM(CASE WHEN outcome = 'error'  THEN 1 ELSE 0 END)        AS errors,
             SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END)        AS denied,
             SUM(CASE WHEN outcome IS NULL    THEN 1 ELSE 0 END)        AS pending,
             SUM(CASE WHEN parent_tool_use_id IS NOT NULL THEN 1 ELSE 0 END) AS by_subagent,
             MAX(ts) AS last_ts
        FROM j GROUP BY tool_name, arg_class
    )
    SELECT h.*, l.p50_ms, l.p95_ms
      FROM health h
      -- IS rather than = : arg_class is null for tools that classify to
      -- nothing, and null = null would drop exactly those rows from latency.
      LEFT JOIN lat l ON l.tool_name = h.tool_name AND l.arg_class IS h.arg_class
     ORDER BY h.calls DESC, h.tool_name ASC
     LIMIT ?`;

  return (db.prepare(sql).all(...s.args, clamp(w.limit, 200)) as Row[]).map((r) => ({
    toolName: String(r['tool_name']),
    argClass: nstr(r['arg_class']),
    calls: num(r['calls']),
    ok: num(r['ok']),
    errors: num(r['errors']),
    denied: num(r['denied']),
    pending: num(r['pending']),
    bySubagent: num(r['by_subagent']),
    p50Ms: nnum(r['p50_ms']),
    p95Ms: nnum(r['p95_ms']),
    lastTs: nstr(r['last_ts']),
  }));
}

export interface DenialRow {
  readonly reasonType: string | null;
  readonly toolName: string;
  readonly argClass: string | null;
  readonly denials: number;
  readonly sampleReason: string | null;
  readonly lastTs: string | null;
  /** What to actually do about it — see `recommend`. */
  readonly recommendation: string;
}

/**
 * A denial is only half a finding; the other half is the fix.
 *
 * Deliberately generic about *which* path was refused: the learning store never
 * holds one (spec §11), so the recommendation names the setting to change and
 * points at the event stream — which does carry the detail, redacted at ingest —
 * for the specific value. Naming a real fix beats storing a path we promised
 * not to keep.
 */
function recommend(reasonType: string | null, tool: string): string {
  switch (reasonType) {
    case 'workingDir':
      return `${tool} was refused for reading or writing outside the job's working directory. Give the job a cwd that covers the path, or add the directory to its allowedTools — the job's event stream shows which path was refused.`;
    case 'permissionMode':
      return `${tool} needs a permission mode this job does not have. Raise the job's permissionMode, or pre-approve ${tool} in allowedTools.`;
    case 'tool':
      return `${tool} is not in this job's allowedTools. Add it there if the job genuinely needs it.`;
    default:
      return `${tool} was refused by the harness. Check the job's allowedTools and permissionMode; its event stream carries the harness's own reason.`;
  }
}

export function denials(db: DatabaseSync, w: Window = {}): DenialRow[] {
  const s = scope(w);
  const sql = `
    WITH c AS (SELECT * FROM tool_calls ${s.sql})
    SELECT o.deny_reason_type, c.tool_name, c.arg_class,
           COUNT(*)           AS denials,
           MIN(o.deny_reason) AS sample_reason,
           MAX(o.ts)          AS last_ts
      FROM tool_outcomes o
      JOIN c ON c.tool_use_id = o.tool_use_id
     WHERE o.outcome = 'denied'
     GROUP BY o.deny_reason_type, c.tool_name, c.arg_class
     ORDER BY denials DESC
     LIMIT ?`;

  return (db.prepare(sql).all(...s.args, clamp(w.limit, 100)) as Row[]).map((r) => {
    const reasonType = nstr(r['deny_reason_type']);
    const toolName = String(r['tool_name']);
    return {
      reasonType,
      toolName,
      argClass: nstr(r['arg_class']),
      denials: num(r['denials']),
      sampleReason: nstr(r['sample_reason']),
      lastTs: nstr(r['last_ts']),
      recommendation: recommend(reasonType, toolName),
    };
  });
}

export interface TokenRow {
  readonly key: string;
  readonly turns: number;
  readonly usd: number;
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  readonly cacheHitRatio: number | null;
  readonly estimatedTurns: number;
  readonly lastTs: string | null;
}

/**
 * Cache-hit ratio is the headline: reads over everything that had to be
 * presented to the model. A ratio that collapses means the prompt prefix is
 * being destabilised between turns, which is both the most expensive thing a
 * job can do and one of the more fixable.
 */
export function tokenEconomics(
  db: DatabaseSync,
  groupBy: 'job' | 'model',
  w: Window = {},
): TokenRow[] {
  const s = scope(w);
  const col = groupBy === 'model' ? 'model' : "COALESCE(job_id, '(observed)')";
  const sql = `
    SELECT ${col} AS key,
           COUNT(*)            AS turns,
           SUM(usd)            AS usd,
           SUM(input)          AS input,
           SUM(output)         AS output,
           SUM(cache_creation) AS cache_creation,
           SUM(cache_read)     AS cache_read,
           SUM(estimated)      AS estimated_turns,
           CASE WHEN SUM(cache_read + cache_creation + input) > 0
                THEN CAST(SUM(cache_read) AS REAL) / SUM(cache_read + cache_creation + input)
                ELSE NULL END  AS cache_hit_ratio,
           MAX(ts)             AS last_ts
      FROM turn_costs ${s.sql}
     GROUP BY ${col}
     ORDER BY usd DESC
     LIMIT ?`;

  return (db.prepare(sql).all(...s.args, clamp(w.limit, 200)) as Row[]).map((r) => ({
    key: String(r['key']),
    turns: num(r['turns']),
    usd: num(r['usd']),
    input: num(r['input']),
    output: num(r['output']),
    cacheCreation: num(r['cache_creation']),
    cacheRead: num(r['cache_read']),
    cacheHitRatio: nnum(r['cache_hit_ratio']),
    estimatedTurns: num(r['estimated_turns']),
    lastTs: nstr(r['last_ts']),
  }));
}

export interface SkillRow {
  readonly skill: string;
  readonly invocations: number;
  readonly errors: number;
  readonly jobs: number;
  readonly lastTs: string | null;
}

export function skillDemand(db: DatabaseSync, w: Window = {}): SkillRow[] {
  const s = scope(w);
  const sql = `
    WITH c AS (SELECT * FROM tool_calls ${s.sql})
    SELECT c.arg_class AS skill,
           COUNT(*)                                             AS invocations,
           SUM(CASE WHEN o.outcome = 'error' THEN 1 ELSE 0 END) AS errors,
           COUNT(DISTINCT c.job_id)                             AS jobs,
           MAX(c.ts)                                            AS last_ts
      FROM c LEFT JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
     WHERE c.tool_name = 'Skill' AND c.arg_class IS NOT NULL
     GROUP BY c.arg_class
     ORDER BY invocations DESC
     LIMIT ?`;

  return (db.prepare(sql).all(...s.args, clamp(w.limit, 200)) as Row[]).map((r) => ({
    skill: String(r['skill']),
    invocations: num(r['invocations']),
    errors: num(r['errors']),
    jobs: num(r['jobs']),
    lastTs: nstr(r['last_ts']),
  }));
}

export interface ToolEventRow {
  readonly ts: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly jobId: string | null;
  readonly toolName: string;
  readonly argClass: string | null;
  readonly skill: string | null;
  readonly outcome: string | null;
  readonly bySubagent: boolean;
}

/**
 * The `claude-metrics` seam.
 *
 * That system's demand-side data was to come from mining ~800 MB of transcripts.
 * For jobs the orchestrator runs, the same facts already exist here in
 * structured form, so this endpoint hands them over directly. `(sessionId, seq)`
 * is the dedupe key, standing in for the message uuid a transcript miner would
 * have used — it is unique per event and stable across replays.
 *
 * Deliberately no coupling in this direction: nothing here knows that Postgres
 * or Grafana exist, and Phase H does not wait on them.
 */
export function exportToolEvents(
  db: DatabaseSync,
  w: Window & { cursor?: string | undefined } = {},
): { rows: ToolEventRow[]; nextCursor: string | null } {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (w.since) {
    parts.push('c.ts >= ?');
    args.push(w.since);
  }
  if (w.cursor) {
    // Keyset pagination on the same composite the table is keyed by, so a
    // collector can resume exactly where it stopped without re-reading.
    const [ts, sid, seq] = w.cursor.split('|');
    parts.push('(c.ts, c.session_id, c.seq) > (?, ?, ?)');
    args.push(String(ts), String(sid), Number(seq));
  }
  const limit = clamp(w.limit, 500);
  const sql = `
    SELECT c.ts, c.session_id, c.seq, c.job_id, c.tool_name, c.arg_class,
           c.parent_tool_use_id, o.outcome
      FROM tool_calls c
      LEFT JOIN tool_outcomes o ON o.tool_use_id = c.tool_use_id
     ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''}
     ORDER BY c.ts, c.session_id, c.seq
     LIMIT ?`;

  const rows = (db.prepare(sql).all(...args, limit) as Row[]).map((r) => ({
    ts: String(r['ts']),
    sessionId: String(r['session_id']),
    seq: num(r['seq']),
    jobId: nstr(r['job_id']),
    toolName: String(r['tool_name']),
    argClass: nstr(r['arg_class']),
    skill: r['tool_name'] === 'Skill' ? nstr(r['arg_class']) : null,
    outcome: nstr(r['outcome']),
    bySubagent: r['parent_tool_use_id'] != null,
  }));

  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor:
      rows.length === limit && last ? `${last.ts}|${last.sessionId}|${last.seq}` : null,
  };
}
