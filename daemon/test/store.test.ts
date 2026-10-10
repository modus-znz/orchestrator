import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobRecord, OrchestratorEvent } from '../src/types.js';

let home: string;
let Store: typeof import('../src/store/index.js').Store;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), 'orch-scratch-'));
  process.env['ORCHESTRATOR_HOME'] = home;
  // Imported after the env var is set, so paths.* resolves into the scratch dir.
  ({ Store } = await import('../src/store/index.js'));
  return new Store(join(home, 'orchestrator.db'));
}

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1', name: 'demo', prompt: 'say hi', cwd: '/tmp', model: 'haiku',
  budgetUsd: 1, timeoutMs: 60_000, permissionMode: 'default', dependsOn: [],
  steerable: false, status: 'queued', sessionId: null,
  createdAt: '2026-09-05T00:00:00.000Z', startedAt: null, finishedAt: null,
  costUsd: 0, numTurns: 0, exitCode: null, error: null, cliVersion: null,
  ...over,
});

const ev = (over: Partial<OrchestratorEvent> = {}): OrchestratorEvent => ({
  jobId: 'job-1', sessionId: 'sess-a', seq: 0, ts: '2026-09-05T00:00:01.000Z',
  source: 'child', type: 'msg.assistant', payload: { text: 'hi' }, ...over,
});

describe('Store', () => {
  let store: InstanceType<typeof Store>;
  beforeEach(async () => { store = await freshStore(); });
  afterEach(() => { store.close(); Store.destroyScratch(home); });

  it('round-trips a job', () => {
    store.putJob(job());
    const got = store.getJob('job-1');
    expect(got?.prompt).toBe('say hi');
    expect(got?.steerable).toBe(false);
    expect(got?.dependsOn).toEqual([]);
  });

  it('hands out monotonic per-session sequence numbers', () => {
    expect(store.nextSeq('sess-a')).toBe(0);
    expect(store.nextSeq('sess-a')).toBe(1);
    expect(store.nextSeq('sess-b')).toBe(0);
  });

  it('projects cost.turn events into the costs table', () => {
    store.appendEvent(ev({ seq: 0, type: 'cost.turn', payload: { model: 'haiku', usd: 0.04, inputTokens: 10, outputTokens: 3 } }));
    const events = store.eventsForJob('job-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cost.turn');
  });

  it('rebuilds jobs and events from the append-only log after losing the DB', () => {
    const spec = job();
    store.appendEvent(ev({ seq: 0, type: 'job.queued', payload: { job: spec } }));
    store.appendEvent(ev({ seq: 1, type: 'job.started', payload: { cliVersion: '2.1.261' } }));
    store.appendEvent(ev({ seq: 2, type: 'cost.turn', payload: { model: 'haiku', usd: 0.04 } }));
    store.appendEvent(ev({ seq: 3, type: 'cost.turn', payload: { model: 'haiku', usd: 0.01 } }));
    store.appendEvent(ev({ seq: 4, type: 'job.finished', payload: { exitCode: 0 } }));
    store.close();

    // Simulate the DB being lost entirely; the JSONL is all that survives.
    const rebuilt = new Store(join(home, 'rebuilt.db'));
    const result = rebuilt.rebuildFromLogs();
    expect(result.events).toBe(5);
    expect(result.jobs).toBe(1);

    const got = rebuilt.getJob('job-1');
    expect(got?.status).toBe('succeeded');
    expect(got?.cliVersion).toBe('2.1.261');
    expect(got?.costUsd).toBeCloseTo(0.05);
    expect(got?.numTurns).toBe(2);
    // Sequence numbering resumes past the log rather than restarting.
    expect(rebuilt.nextSeq('sess-a')).toBe(5);
    rebuilt.close();
    // close() is idempotent, so afterEach closing it again is safe.
    store = rebuilt;
  });

  it('prefers the settled cost in the terminal event over the sum of its estimates', () => {
    // The turn estimates come from DEFAULT_PRICES, which is a table we maintain
    // by hand and which drifts every time Anthropic reprices. total_cost_usd
    // is what was actually billed. A rebuild that re-summed the estimates would
    // silently rewrite months of reconciled history to whatever the price table
    // happened to say on the day of the rebuild.
    store.appendEvent(ev({ seq: 0, type: 'job.queued', payload: { job: job() } }));
    store.appendEvent(ev({ seq: 1, type: 'cost.turn', payload: { model: 'opus', usd: 0.9 } }));
    store.appendEvent(ev({ seq: 2, type: 'cost.turn', payload: { model: 'opus', usd: 0.9 } }));
    store.appendEvent(ev({ seq: 3, type: 'job.finished', payload: { exitCode: 0, costUsd: 0.61, estimated: false } }));
    store.close();

    const rebuilt = new Store(join(home, 'rebuilt-cost.db'));
    rebuilt.rebuildFromLogs();
    expect(rebuilt.getJob('job-1')?.costUsd).toBeCloseTo(0.61);
    // numTurns still comes from the turn events — the CLI reports a total, not a count.
    expect(rebuilt.getJob('job-1')?.numTurns).toBe(2);
    rebuilt.close();
    store = rebuilt;
  });

  it('assigns a fleet-wide event id that orders sessions against each other', () => {
    // The point of the id: seq 0 in two different sessions says nothing about
    // which happened first, and an SSE client needs exactly that.
    const a = store.appendEvent(ev({ sessionId: 'sess-a', seq: 0 }));
    const b = store.appendEvent(ev({ sessionId: 'sess-b', seq: 0 }));
    expect(b).toBeGreaterThan(a);
    expect(store.latestEventId()).toBe(b);
  });

  it('returns the existing id when an event is replayed, not a fresh one', () => {
    const first = store.appendEvent(ev({ sessionId: 'sess-a', seq: 0 }));
    const again = store.appendEvent(ev({ sessionId: 'sess-a', seq: 0 }));
    expect(again).toBe(first);
  });

  it('reads events after a cursor, bounded by a limit', () => {
    for (let i = 0; i < 5; i++) store.appendEvent(ev({ sessionId: 'sess-a', seq: i }));
    const after = store.eventsSince(2);
    expect(after.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(store.eventsSince(0, 2)).toHaveLength(2);
  });

  it('reports 0 as the latest id before anything has happened', () => {
    expect(store.latestEventId()).toBe(0);
  });

  it('merges stored settings over defaults', () => {
    expect(store.getSettings().maxConcurrency).toBe(3);
    const next = store.putSettings({ maxConcurrency: 8, defaultModel: 'opus' });
    expect(next.maxConcurrency).toBe(8);
    expect(next.defaultModel).toBe('opus');
    expect(next.retryLimit).toBe(0);
  });

  it('marks vanished sessions dead', () => {
    const now = '2026-09-05T00:00:00.000Z';
    const base = { kind: 'observed', jobId: null, cwd: '/', alive: true, procStart: '111', status: 'idle', firstSeenAt: now, lastSeenAt: now } as const;
    store.putSession({ ...base, sessionId: 's1', pid: 1, name: 'a' });
    store.putSession({ ...base, sessionId: 's2', pid: 2, name: 'b' });
    // A managed session the sweep cannot see must survive it (§4.1).
    store.putSession({ ...base, kind: 'managed', sessionId: 's3', pid: 3, name: null, jobId: 'job-1' });
    expect(store.markSessionsGone('observed', ['s1'])).toEqual(['s2']);
    expect(store.getSession('s3')?.alive).toBe(true);
    expect(store.listSessions().find((s) => s.sessionId === 's2')?.alive).toBe(false);
  });
});

describe('queueDepthSeries', () => {
  // `now` is pinned in every case below. The bucket domain runs to the present
  // so that a queue still backed up this minute has a bucket to be drawn in,
  // which makes an unpinned test quietly time-dependent: it would pass today
  // and enumerate a year of empty hours next spring.
  const NOW = '2026-09-05T14:00:00.000Z';

  it('counts a job as waiting in the hours between queueing and starting', async () => {
    // The defect this guards: counting `job.queued` events instead of spans
    // reports depth 0 for exactly the hours a job sat in the queue, because a
    // waiting job emits nothing while it waits.
    const store = await freshStore();
    store.putJob(job({
      id: 'slow', status: 'succeeded',
      createdAt: '2026-09-05T09:00:00.000Z',
      startedAt: '2026-09-05T12:00:00.000Z',
      finishedAt: '2026-09-05T13:00:00.000Z',
    }));
    const by = new Map(store.queueDepthSeries('hour', NOW).map((r) => [r.bucket, r]));
    expect(by.get('2026-09-05T09')?.waiting).toBe(1);
    expect(by.get('2026-09-05T12')?.waiting).toBe(0);
    expect(by.get('2026-09-05T12')?.running).toBe(1);
    expect(by.get('2026-09-05T13')?.running).toBe(0);
    store.close();
  });

  it('emits the quiet hours in between, where the backlog is worst', async () => {
    // 10 and 11 saw no transition at all, so a domain collected from the
    // timestamps that exist skipped them — and the chart drew a straight line
    // from 09 to 12 across the three hours this job spent waiting.
    const store = await freshStore();
    store.putJob(job({
      id: 'slow', status: 'succeeded',
      createdAt: '2026-09-05T09:00:00.000Z',
      startedAt: '2026-09-05T12:00:00.000Z',
      finishedAt: '2026-09-05T13:00:00.000Z',
    }));
    const rows = store.queueDepthSeries('hour', NOW);
    expect(rows.map((r) => r.bucket)).toEqual([
      '2026-09-05T09', '2026-09-05T10', '2026-09-05T11',
      '2026-09-05T12', '2026-09-05T13', '2026-09-05T14',
    ]);
    expect(rows.filter((r) => r.waiting === 1).map((r) => r.bucket)).toEqual([
      '2026-09-05T09', '2026-09-05T10', '2026-09-05T11',
    ]);
    store.close();
  });

  it('runs the domain to now, so a queue that never moved is still drawn', async () => {
    // Nothing has started or finished, so the last transition IS the creation.
    // Without a domain that reaches the present, a queue three deep and stuck
    // renders as a single bucket hours ago and then nothing.
    const store = await freshStore();
    for (const id of ['a', 'b', 'c']) {
      store.putJob(job({ id, createdAt: '2026-09-05T11:00:00.000Z' }));
    }
    const rows = store.queueDepthSeries('hour', NOW);
    expect(rows.map((r) => r.bucket)).toEqual([
      '2026-09-05T11', '2026-09-05T12', '2026-09-05T13', '2026-09-05T14',
    ]);
    expect(rows.every((r) => r.waiting === 3)).toBe(true);
    store.close();
  });

  it('stops counting a job that was cancelled while still queued', async () => {
    const store = await freshStore();
    store.putJob(job({
      id: 'killed', status: 'cancelled',
      createdAt: '2026-09-05T09:00:00.000Z',
      startedAt: null,
      finishedAt: '2026-09-05T10:00:00.000Z',
    }));
    store.putJob(job({ id: 'later', createdAt: '2026-09-05T11:00:00.000Z', startedAt: '2026-09-05T11:30:00.000Z' }));
    const by = new Map(store.queueDepthSeries('hour', NOW).map((r) => [r.bucket, r]));
    expect(by.get('2026-09-05T09')?.waiting).toBe(1);
    // Without the finished_at arm this stays 1 forever, and the chart shows a
    // queue that never drains.
    expect(by.get('2026-09-05T11')?.waiting).toBe(0);
    store.close();
  });

  it('buckets by day when asked', async () => {
    const store = await freshStore();
    store.putJob(job({ id: 'd', createdAt: '2026-09-05T09:00:00.000Z', startedAt: '2026-09-06T09:00:00.000Z' }));
    const rows = store.queueDepthSeries('day', '2026-09-06T12:00:00.000Z');
    expect(rows.map((r) => r.bucket)).toEqual(['2026-09-05', '2026-09-06']);
    expect(rows[0]?.waiting).toBe(1);
    store.close();
  });

  it('caps an ancient row to a recent window instead of enumerating six years', async () => {
    // One job from 2020 would otherwise ask SQLite for every hour since — tens
    // of thousands of rows, all of them zero, to draw one chart. The window is
    // clamped at its START so the buckets kept are the recent ones; a cap that
    // simply stopped the walk would have kept 2020 and dropped today.
    const store = await freshStore();
    store.putJob(job({ id: 'ancient', createdAt: '2020-01-01T00:00:00.000Z', startedAt: '2020-01-01T01:00:00.000Z', finishedAt: '2020-01-01T02:00:00.000Z' }));
    store.putJob(job({ id: 'recent', createdAt: '2026-09-05T13:00:00.000Z' }));
    const rows = store.queueDepthSeries('hour', NOW);
    expect(rows.length).toBeLessThanOrEqual(2001);
    expect(rows.at(-1)?.bucket).toBe('2026-09-05T14');
    expect(rows.at(-1)?.waiting).toBe(1);
    // 2020 is far outside the window, so it is not drawn at all.
    expect(rows.some((r) => r.bucket.startsWith('2020'))).toBe(false);
    store.close();
  });

  it('returns nothing at all when no job has ever been submitted', async () => {
    // The generated domain starts at MIN(created_at), which is NULL on an empty
    // table — the recursion must produce zero rows rather than one null bucket.
    const store = await freshStore();
    expect(store.queueDepthSeries('hour', NOW)).toEqual([]);
    store.close();
  });
});


describe('courier spend', () => {
  it('records what a steer cost, tagged apart from the job it steered', async () => {
    const store = await freshStore();
    store.appendEvent(ev({ type: 'cost.turn', payload: { model: 'haiku', usd: 0.4, inputTokens: 10, outputTokens: 2 } }));
    store.appendEvent(
      ev({
        seq: 1,
        jobId: null,
        type: 'steer.sent',
        source: 'api',
        payload: { peerName: 'peer-1', message: 'stop', costUsd: 0.05, model: 'haiku', error: null },
      }),
    );

    const byModel = store.costByModel();
    // Two slices, not one: a steer that billed under 'haiku' would silently
    // inflate the tier the job itself ran on, and the two are different kinds
    // of spend an operator makes different decisions about.
    expect(byModel.find((m) => m.model === 'haiku')?.usd).toBeCloseTo(0.4);
    expect(byModel.find((m) => m.model === 'courier:haiku')?.usd).toBeCloseTo(0.05);
    // It still counts toward the total, because it is real money.
    expect(store.costSeries('hour').reduce((a, b) => a + b.usd, 0)).toBeCloseTo(0.45);
    store.close();
  });

  it('does not open a zero-cost row for a steer that never billed', async () => {
    const store = await freshStore();
    store.appendEvent(
      ev({
        jobId: null,
        type: 'steer.failed',
        source: 'api',
        payload: { peerName: 'peer-1', message: 'stop', costUsd: 0, model: 'haiku', error: 'no such peer' },
      }),
    );
    expect(store.costByModel()).toHaveLength(0);
    store.close();
  });
});
