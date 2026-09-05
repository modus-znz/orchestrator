import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcTable } from '../src/registry/proc.js';
import type { JobRecord, SessionRecord } from '../src/types.js';

let home: string;
let Store: typeof import('../src/store/index.js').Store;
let EventBus: typeof import('../src/bus.js').EventBus;
let reconcile: typeof import('../src/reconcile.js').reconcile;

let store: InstanceType<typeof Store>;
let bus: InstanceType<typeof EventBus>;

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'j1', name: 'j1', prompt: 'p', cwd: '/tmp', model: 'haiku', budgetUsd: 1,
  timeoutMs: 1000, permissionMode: 'default', dependsOn: [], steerable: false,
  status: 'running', sessionId: 's1', createdAt: '', startedAt: '', finishedAt: null,
  costUsd: 0, numTurns: 0, exitCode: null, error: null, cliVersion: null, ...over,
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 's1', kind: 'managed', jobId: 'j1', pid: 4242, name: 'w', cwd: '/tmp',
  alive: true, procStart: '99999', status: null, firstSeenAt: '', lastSeenAt: '', ...over,
});

const proc = (table: Record<number, string | null>): ProcTable => ({
  startTime: (pid: number) => table[pid] ?? null,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orch-rec-'));
  process.env['ORCHESTRATOR_HOME'] = home;
  ({ Store } = await import('../src/store/index.js'));
  ({ EventBus } = await import('../src/bus.js'));
  ({ reconcile } = await import('../src/reconcile.js'));
  store = new Store(join(home, 'orchestrator.db'));
  bus = new EventBus(store);
});
afterEach(() => {
  store.close();
  Store.destroyScratch(home);
  rmSync(home, { recursive: true, force: true });
});

describe('startup reconciliation', () => {
  it('fails a running job whose child died with the daemon', () => {
    store.putJob(job());
    store.putSession(session());
    const report = reconcile(store, bus, { proc: proc({}) });

    expect(report).toMatchObject({ vanished: ['j1'], orphaned: [] });
    expect(store.getJob('j1')?.status).toBe('failed');
    expect(store.getJob('j1')?.error).toContain('did not outlive');
  });

  it('frees the concurrency slot, which is the whole point', () => {
    // Three stale rows at the default concurrency of 3 is a daemon that
    // restarts and then never schedules anything again.
    for (const id of ['a', 'b', 'c']) store.putJob(job({ id, sessionId: null }));
    reconcile(store, bus, { proc: proc({}) });
    expect(store.listJobs('running')).toHaveLength(0);
  });

  it('terminates a child that outlived the daemon, because nothing can read it any more', () => {
    store.putJob(job());
    store.putSession(session());
    const killed: Array<[number, string]> = [];
    const report = reconcile(store, bus, {
      proc: proc({ 4242: '99999' }),
      kill: (pid, sig) => killed.push([pid, sig]),
    });

    expect(report.orphaned).toEqual(['j1']);
    expect(killed).toEqual([[4242, 'SIGTERM']]);
    expect(store.getJob('j1')?.error).toContain('terminated on restart');
  });

  it('treats a recycled pid as gone, not as a live child (F18)', () => {
    // Same pid, different process: killing it would kill a stranger.
    store.putJob(job());
    store.putSession(session());
    const killed: number[] = [];
    const report = reconcile(store, bus, {
      proc: proc({ 4242: '70000' }),
      kill: (pid) => killed.push(pid),
    });

    expect(report.vanished).toEqual(['j1']);
    expect(killed).toEqual([]);
  });

  it('publishes a job.failed carrying why, so the UI can explain the gap', () => {
    store.putJob(job());
    store.putSession(session());
    const seen: Array<{ type: string; payload: unknown }> = [];
    bus.subscribe((e) => seen.push({ type: e.type, payload: e.payload }));
    reconcile(store, bus, { proc: proc({}) });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('job.failed');
    expect(seen[0]?.payload).toMatchObject({ reason: 'reconcile', orphaned: false });
  });

  it('leaves queued and blocked work alone', () => {
    store.putJob(job({ id: 'q', status: 'queued', sessionId: null }));
    store.putJob(job({ id: 'b', status: 'blocked', sessionId: null }));
    reconcile(store, bus, { proc: proc({}) });
    expect(store.getJob('q')?.status).toBe('queued');
    expect(store.getJob('b')?.status).toBe('blocked');
  });

  it('marks dead managed sessions gone but does not touch observed ones', () => {
    store.putSession(session({ sessionId: 'dead', jobId: null }));
    store.putSession(session({ sessionId: 'obs', kind: 'observed', jobId: null, pid: 777 }));
    reconcile(store, bus, { proc: proc({}) });

    expect(store.getSession('dead')?.alive).toBe(false);
    expect(store.getSession('obs')?.alive).toBe(true);
  });
});
