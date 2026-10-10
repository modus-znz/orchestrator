import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LearningStore, LEARNING_SCHEMA_VERSION } from '../src/learning/store.js';
import { toolHealth, denials, tokenEconomics, skillDemand, exportToolEvents } from '../src/learning/queries.js';
import type { OrchestratorEvent, EventType } from '../src/types.js';

let dir: string;
let store: LearningStore;
let n = 0;

/** Payload shapes here are copied from live `jobs/*\/events.jsonl`, not invented —
 *  a test that agrees with a guess proves only that the guess is consistent. */
function ev(type: EventType, payload: unknown, over: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    jobId: 'job-1',
    sessionId: 'sess-1',
    seq: n++,
    ts: '2026-09-06T10:00:00Z',
    source: 'child',
    type,
    payload,
    ...over,
  };
}

const use = (id: string, name: string, input: unknown, over: Partial<OrchestratorEvent> = {}) =>
  ev('tool.use', { id, name, input, parentToolUseId: null }, over);

const result = (id: string, isError: boolean, over: Partial<OrchestratorEvent> = {}) =>
  ev('tool.result', { toolUseId: id, isError, content: 'x' }, over);

beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), 'orc-learning-'));
  store = new LearningStore(join(dir, 'learning.db'));
});

afterEach(() => {
  if (!store.closed) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LearningStore — ingest', () => {
  it('records a tool call with its classification, never its argument', () => {
    store.ingest(use('t1', 'Read', { file_path: '/home/ghost/Desktop/hash.env' }));
    const row = store.db.prepare('SELECT * FROM tool_calls').get() as Record<string, unknown>;
    expect(row['tool_name']).toBe('Read');
    expect(row['arg_class']).toBe('.env');
    expect(JSON.stringify(row)).not.toContain('hash.env');
  });

  it('is idempotent on (session_id, seq), which is what makes backfill free', () => {
    const e = use('t1', 'Bash', { command: 'git status' });
    store.ingest(e);
    store.ingest(e);
    store.ingest(e);
    expect(store.status().toolCalls).toBe(1);
  });

  it('joins a result onto its call by toolUseId', () => {
    store.ingest(use('t1', 'Bash', { command: 'npm test' }));
    store.ingest(result('t1', true));
    const [row] = toolHealth(store.db);
    expect(row?.toolName).toBe('Bash');
    expect(row?.argClass).toBe('npm test');
    expect(row?.errors).toBe(1);
    expect(row?.ok).toBe(0);
  });

  it('counts a call with no outcome yet as pending, not as a success', () => {
    store.ingest(use('t1', 'Bash', { command: 'sleep 30' }));
    const [row] = toolHealth(store.db);
    expect(row?.pending).toBe(1);
    expect(row?.ok).toBe(0);
    expect(row?.errors).toBe(0);
  });
});

describe('LearningStore — denials', () => {
  const denied = (id: string, reason = 'Path is outside allowed working directories') =>
    ev('raw', {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Read',
      tool_use_id: id,
      decision_reason_type: 'workingDir',
      decision_reason: reason,
    });

  it('classifies a denial apart from an error, because they have different fixes', () => {
    store.ingest(use('t1', 'Read', { file_path: '/etc/hosts' }));
    store.ingest(denied('t1'));
    const [row] = toolHealth(store.db);
    expect(row?.denied).toBe(1);
    expect(row?.errors).toBe(0);
  });

  // The harness emits both: it refuses the tool AND the model still sees a
  // result block. Averaging them would report a denial as an ordinary error and
  // send the operator to fix code when the fix is a config line.
  it('lets a denial win over a result that arrives for the same call', () => {
    store.ingest(use('t1', 'Read', { file_path: '/etc/hosts' }));
    store.ingest(result('t1', true));
    store.ingest(denied('t1'));
    expect(toolHealth(store.db)[0]?.denied).toBe(1);
    expect(toolHealth(store.db)[0]?.errors).toBe(0);
  });

  it('does not let a later plain result overwrite a denial', () => {
    store.ingest(use('t1', 'Read', { file_path: '/etc/hosts' }));
    store.ingest(denied('t1'));
    store.ingest(result('t1', false));
    expect(toolHealth(store.db)[0]?.denied).toBe(1);
  });

  it('turns a denial into a recommendation rather than a bare count', () => {
    store.ingest(use('t1', 'Read', { file_path: '/etc/hosts' }));
    store.ingest(denied('t1'));
    const [row] = denials(store.db);
    expect(row?.denials).toBe(1);
    expect(row?.reasonType).toBe('workingDir');
    expect(row?.recommendation).toMatch(/allowedTools|working directory/);
  });

  it('redacts and clips the one free-text column', () => {
    store.ingest(use('t1', 'Read', { file_path: '/etc/hosts' }));
    store.ingest(denied('t1', `refused: SESSION_SECRET='hunter2hunter2' ${'x'.repeat(400)}`));
    const stored = String(denials(store.db)[0]?.sampleReason);
    expect(stored).not.toContain('hunter2hunter2');
    expect(stored.length).toBeLessThanOrEqual(200);
  });
});

describe('LearningStore — token economics', () => {
  // Verbatim payload shape from a live cost.turn event.
  const turn = (over: Record<string, unknown> = {}) =>
    ev('cost.turn', {
      messageId: 'msg_1',
      model: 'haiku',
      wireModel: 'claude-haiku-4-5-20251001',
      usd: 0.0304,
      estimated: true,
      inputTokens: 10,
      outputTokens: 4,
      cacheCreationTokens: 23173,
      cacheReadTokens: 14098,
      ...over,
    });

  it('keeps the cache columns the orchestrator.db costs projection discards', () => {
    store.ingest(turn());
    const [row] = tokenEconomics(store.db, 'model');
    expect(row?.cacheCreation).toBe(23173);
    expect(row?.cacheRead).toBe(14098);
  });

  it('computes cache-hit ratio over everything the model had to be shown', () => {
    store.ingest(turn());
    // 14098 / (14098 + 23173 + 10)
    expect(tokenEconomics(store.db, 'model')[0]?.cacheHitRatio).toBeCloseTo(0.3781, 3);
  });

  it('marks estimated turns so a dashboard never presents one as billed truth', () => {
    store.ingest(turn());
    store.ingest(turn({ estimated: false }));
    expect(tokenEconomics(store.db, 'model')[0]?.estimatedTurns).toBe(1);
    expect(tokenEconomics(store.db, 'model')[0]?.turns).toBe(2);
  });

  it('groups by job as well as by model', () => {
    store.ingest(turn());
    store.ingest(turn());
    expect(tokenEconomics(store.db, 'job')[0]?.key).toBe('job-1');
  });
});

describe('LearningStore — skill demand', () => {
  it('counts skills by name and attributes their errors', () => {
    store.ingest(use('s1', 'Skill', { skill: 'superpowers:brainstorming' }));
    store.ingest(result('s1', false));
    store.ingest(use('s2', 'Skill', { skill: 'superpowers:brainstorming' }));
    store.ingest(result('s2', true));
    store.ingest(use('s3', 'Skill', { skill: 'claude-router' }));
    const rows = skillDemand(store.db);
    expect(rows[0]).toMatchObject({ skill: 'superpowers:brainstorming', invocations: 2, errors: 1 });
    expect(rows.map((r) => r.skill)).toContain('claude-router');
  });
});

describe('LearningStore — latency', () => {
  it('derives duration from the two timestamps rather than storing it', () => {
    store.ingest(use('t1', 'Bash', { command: 'sleep 1' }, { ts: '2026-09-06T10:00:00.000Z' }));
    store.ingest(result('t1', false, { ts: '2026-09-06T10:00:01.250Z' }));
    const [row] = toolHealth(store.db);
    // Whole milliseconds. unixepoch(…,'subsec') arrives as a REAL, so without a
    // ROUND this is 1250.0032782554626 and every latency the dashboard shows
    // carries a tail of float noise.
    expect(row?.p50Ms).toBe(1250);
    expect(Number.isInteger(row?.p50Ms)).toBe(true);
  });

  it('ignores a result that predates its call instead of reporting negative time', () => {
    store.ingest(use('t1', 'Bash', { command: 'x' }, { ts: '2026-09-06T10:00:05.000Z' }));
    store.ingest(result('t1', false, { ts: '2026-09-06T10:00:01.000Z' }));
    expect(toolHealth(store.db)[0]?.p50Ms).toBeNull();
  });

  // arg_class is null for tools that classify to nothing; a `=` join here would
  // silently drop exactly those rows out of the latency numbers.
  it('reports latency for a tool whose arg_class is null', () => {
    store.ingest(use('t1', 'Grep', { pattern: 'x' }, { ts: '2026-09-06T10:00:00.000Z' }));
    store.ingest(result('t1', false, { ts: '2026-09-06T10:00:00.500Z' }));
    const [row] = toolHealth(store.db);
    expect(row?.argClass).toBeNull();
    expect(row?.p50Ms).toBe(500);
  });
});

describe('LearningStore — windowing and export', () => {
  beforeEach(() => {
    store.ingest(use('t1', 'Bash', { command: 'git status' }, { ts: '2026-09-01T00:00:00Z' }));
    store.ingest(use('t2', 'Bash', { command: 'git status' }, { ts: '2026-09-06T00:00:00Z', jobId: 'job-2' }));
  });

  it('filters by time window', () => {
    expect(toolHealth(store.db, { since: '2026-09-05T00:00:00Z' })[0]?.calls).toBe(1);
    expect(toolHealth(store.db)[0]?.calls).toBe(2);
  });

  it('filters by job', () => {
    expect(toolHealth(store.db, { jobId: 'job-2' })[0]?.calls).toBe(1);
  });

  it('pages the export seam by keyset so a collector can resume', () => {
    const first = exportToolEvents(store.db, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = exportToolEvents(store.db, { limit: 1, cursor: first.nextCursor as string });
    expect(second.rows[0]?.jobId).toBe('job-2');
    expect(second.rows[0]?.seq).not.toBe(first.rows[0]?.seq);
  });
});

describe('LearningStore — durability', () => {
  it('survives reopening and keeps its rows, unlike the rebuilt projection', () => {
    store.ingest(use('t1', 'Bash', { command: 'git status' }));
    store.close();
    store = new LearningStore(join(dir, 'learning.db'));
    expect(store.status().toolCalls).toBe(1);
    expect(store.status().schemaVersion).toBe(LEARNING_SCHEMA_VERSION);
  });

  it('leaves a store from a newer binary alone rather than migrating it backwards', () => {
    store.close();
    const raw = new DatabaseSync(join(dir, 'learning.db'));
    raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();
    store = new LearningStore(join(dir, 'learning.db'));
    expect(store.status().schemaVersion).toBe(99);
  });

  it('opens to null rather than throwing when the file is not a database', () => {
    const bad = join(dir, 'not-a-db.db');
    writeFileSync(bad, 'this is not sqlite');
    expect(LearningStore.open(bad)).toBeNull();
  });

  it('counts the WAL in dbBytes, which is where the rows actually are', () => {
    for (let i = 0; i < 200; i++) store.ingest(use(`t${i}`, 'Bash', { command: 'ls' }));
    // Without the WAL the main file is still 4096 bytes here, and an operator
    // watching disk growth would be told the store is empty.
    expect(store.status().dbBytes).toBeGreaterThan(8192);
  });

  it('counts a drop so a dashboard can tell "no failures" from "ingest broken"', () => {
    store.recordDrop(new Error('disk full'));
    expect(store.status().drops).toBe(1);
    expect(store.status().lastError).toContain('disk full');
  });
});

describe('job_costs (migration 1)', () => {
  const rows = (sql: string): Record<string, unknown>[] => {
    const db = new DatabaseSync(join(dir, 'learning.db'));
    try {
      return db.prepare(sql).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };

  it('records the provider figure and marks it settled', () => {
    store.ingest(ev('cost.turn', { model: 'opus', usd: 0.9, input: 10, output: 5 }));
    store.ingest(
      ev('job.finished', { costUsd: 0.61, numTurns: 3, durationMs: 4200, exitCode: 0, error: null }),
    );
    const [row] = rows('SELECT * FROM job_costs');
    // 0.61 is deliberately lower than the 0.9 of turn estimates above: a
    // regression that fell back to summing turns would otherwise pass here by
    // coincidence, which is the whole failure this table exists to expose.
    expect(row?.['usd']).toBe(0.61);
    expect(row?.['estimated']).toBe(0);
    expect(row?.['status']).toBe('finished');
    expect(row?.['num_turns']).toBe(3);
  });

  it('falls back to the turn sum when the CLI never reported a total', () => {
    store.ingest(ev('cost.turn', { model: 'opus', usd: 0.25 }));
    store.ingest(ev('cost.turn', { model: 'opus', usd: 0.5 }));
    store.ingest(ev('job.failed', { costUsd: null, exitCode: 1, error: 'boom' }));
    const [row] = rows('SELECT * FROM job_costs');
    expect(row?.['usd']).toBeCloseTo(0.75);
    expect(row?.['estimated']).toBe(1);
    expect(row?.['error']).toBe('boom');
  });

  it('uses the spend that triggered a budget kill, since no total ever arrives', () => {
    store.ingest(ev('job.budget_exceeded', { budgetUsd: 2, estimatedUsd: 2.4, estimated: true }));
    const [row] = rows('SELECT * FROM job_costs');
    expect(row?.['usd']).toBe(2.4);
    expect(row?.['estimated']).toBe(1);
    expect(row?.['status']).toBe('budget_exceeded');
  });

  it('lets a settled figure replace an estimate but never the reverse', () => {
    store.ingest(ev('job.failed', { costUsd: null, exitCode: 1, error: 'first' }));
    store.ingest(ev('job.finished', { costUsd: 1.25, numTurns: 2, exitCode: 0 }));
    expect(rows('SELECT * FROM job_costs')[0]?.['usd']).toBe(1.25);
    // Replaying the log re-presents both events; the billed figure has to
    // survive that, or every restart would walk the number backwards.
    store.ingest(ev('job.failed', { costUsd: null, exitCode: 1, error: 'again' }, { seq: 900 }));
    const [row] = rows('SELECT * FROM job_costs');
    expect(row?.['usd']).toBe(1.25);
    expect(row?.['estimated']).toBe(0);
  });

  it('measures price-table drift against what was actually billed', () => {
    store.ingest(ev('cost.turn', { model: 'opus', usd: 0.5 }));
    store.ingest(ev('job.finished', { costUsd: 1, numTurns: 1, exitCode: 0 }));
    const [row] = rows('SELECT * FROM v_price_drift');
    // Half the real cost: the table reads low, so the budget kill fires late.
    expect(row?.['ratio']).toBe(0.5);
  });

  it('ignores a terminal event for a session it only observes', () => {
    store.ingest(ev('job.finished', { costUsd: 1, exitCode: 0 }, { jobId: null }));
    expect(rows('SELECT * FROM job_costs')).toHaveLength(0);
  });
});

describe('migrations', () => {
  it('carries an existing v1 store forward without dropping its rows', () => {
    // The durability contract in one test: a store written by the previous
    // binary must gain the new table and keep everything it already held.
    const path = join(dir, 'v1.db');
    const old = new LearningStore(path);
    old.ingest(ev('tool.use', { id: 't1', name: 'Bash', input: { command: 'ls' } }));
    old.close();
    // Rewind the recorded version so the next open replays migration 1 only.
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    db.exec('DROP VIEW IF EXISTS v_price_drift; DROP TABLE IF EXISTS job_costs');
    db.close();

    const migrated = new LearningStore(path);
    expect(migrated.status().schemaVersion).toBe(LEARNING_SCHEMA_VERSION);
    migrated.ingest(ev('job.finished', { costUsd: 2, exitCode: 0 }, { seq: 500 }));
    migrated.close();

    const after = new DatabaseSync(path);
    expect((after.prepare('SELECT COUNT(*) AS c FROM tool_calls').get() as { c: number }).c).toBe(1);
    expect((after.prepare('SELECT COUNT(*) AS c FROM job_costs').get() as { c: number }).c).toBe(1);
    after.close();
  });

  it('leaves a store written by a newer binary alone', () => {
    const path = join(dir, 'future.db');
    new LearningStore(path).close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    // Migrating backwards is the one thing an additive-only store must never
    // attempt: this binary does not know what the newer one added.
    expect(new LearningStore(path).status().schemaVersion).toBe(99);
  });
});
