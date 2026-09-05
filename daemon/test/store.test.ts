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

  it('merges stored settings over defaults', () => {
    expect(store.getSettings().maxConcurrency).toBe(3);
    const next = store.putSettings({ maxConcurrency: 8, defaultModel: 'opus' });
    expect(next.maxConcurrency).toBe(8);
    expect(next.defaultModel).toBe('opus');
    expect(next.retryLimit).toBe(0);
  });

  it('marks vanished sessions dead', () => {
    const now = '2026-09-05T00:00:00.000Z';
    store.putSession({ sessionId: 's1', kind: 'observed', jobId: null, pid: 1, name: 'a', cwd: '/', alive: true, firstSeenAt: now, lastSeenAt: now });
    store.putSession({ sessionId: 's2', kind: 'observed', jobId: null, pid: 2, name: 'b', cwd: '/', alive: true, firstSeenAt: now, lastSeenAt: now });
    expect(store.markSessionsGone(['s1'])).toEqual(['s2']);
    expect(store.listSessions().find((s) => s.sessionId === 's2')?.alive).toBe(false);
  });
});
