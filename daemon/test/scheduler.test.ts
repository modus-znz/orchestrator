import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobRecord, JobSpec } from '../src/types.js';
import type { RunHandle, RunOutcome } from '../src/runner/child.js';

let home: string;
let mod: typeof import('../src/scheduler/index.js');
let Store: typeof import('../src/store/index.js').Store;
let EventBus: typeof import('../src/bus.js').EventBus;

/** A runner that never spawns anything; tests resolve jobs by hand. */
class FakeRunner {
  readonly started: string[] = [];
  readonly #settle = new Map<string, (o: RunOutcome) => void>();

  start(job: JobRecord): RunHandle {
    this.started.push(job.name ?? job.id);
    const sessionId = `sess-${job.id}`;
    const done = new Promise<RunOutcome>((resolve) => this.#settle.set(job.id, resolve));
    return { jobId: job.id, sessionId, done, cancel: () => this.finish(job.id, 'cancelled') };
  }

  async finish(jobId: string, status: RunOutcome['status'] = 'succeeded'): Promise<void> {
    this.#settle.get(jobId)?.({ status, exitCode: 0, costUsd: 0.01, sessionId: `sess-${jobId}`, error: null, numTurns: 2 });
    this.#settle.delete(jobId);
    await new Promise((r) => setImmediate(r));
  }
}

const spec = (name: string, dependsOn: string[] = []): JobSpec & { name: string } => ({
  name, prompt: `do ${name}`, cwd: '/tmp', model: 'haiku', budgetUsd: 1,
  timeoutMs: 60_000, permissionMode: 'default', dependsOn, steerable: false,
});

describe('Scheduler', () => {
  let store: InstanceType<typeof Store>;
  let runner: FakeRunner;
  let bus: InstanceType<typeof EventBus>;
  let sched: InstanceType<typeof mod.Scheduler>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'orch-scratch-'));
    process.env['ORCHESTRATOR_HOME'] = home;
    ({ Store } = await import('../src/store/index.js'));
    ({ EventBus } = await import('../src/bus.js'));
    mod = await import('../src/scheduler/index.js');
    store = new Store(join(home, 'orchestrator.db'));
    runner = new FakeRunner();
    bus = new EventBus(store);
    sched = new mod.Scheduler(store, bus, runner as never);
  });
  afterEach(() => { store.close(); Store.destroyScratch(home); });

  it('refuses a cyclic batch at submit time rather than hanging later', () => {
    expect(() => sched.submit([spec('a', ['b']), spec('b', ['a'])])).toThrow(mod.DependencyCycleError);
    // Nothing is persisted from a rejected batch.
    expect(store.listJobs()).toHaveLength(0);
  });

  it('refuses a dependency that names nothing', () => {
    expect(() => sched.submit([spec('a', ['ghost'])])).toThrow(mod.UnknownDependencyError);
  });

  it('resolves sibling names in a batch to real ids', () => {
    const [a, b] = sched.submit([spec('a'), spec('b', ['a'])]);
    expect(b?.dependsOn).toEqual([a?.id]);
  });

  it('honours the concurrency limit', () => {
    store.putSettings({ maxConcurrency: 2 });
    sched.submit([spec('a'), spec('b'), spec('c')]);
    expect(runner.started).toEqual(['a', 'b']);
    expect(sched.runningCount).toBe(2);
  });

  it('starts a dependent only once its dependency succeeds', async () => {
    const [a] = sched.submit([spec('a'), spec('b', ['a'])]);
    expect(runner.started).toEqual(['a']);
    expect(store.listJobs().find((j) => j.name === 'b')?.status).toBe('blocked');
    await runner.finish(a!.id, 'succeeded');
    expect(runner.started).toEqual(['a', 'b']);
  });

  it('cancels a dependent when its dependency fails, instead of blocking forever', async () => {
    const [a] = sched.submit([spec('a'), spec('b', ['a'])]);
    await runner.finish(a!.id, 'failed');
    const b = store.listJobs().find((j) => j.name === 'b');
    expect(b?.status).toBe('cancelled');
    expect(b?.error).toContain('ended as failed');
    expect(runner.started).toEqual(['a']);
  });

  it('frees a slot when a job finishes', async () => {
    store.putSettings({ maxConcurrency: 1 });
    const [a] = sched.submit([spec('a'), spec('b')]);
    expect(runner.started).toEqual(['a']);
    await runner.finish(a!.id, 'succeeded');
    expect(runner.started).toEqual(['a', 'b']);
  });

  it('records the authoritative outcome on the job row', async () => {
    const [a] = sched.submit([spec('a')]);
    await runner.finish(a!.id, 'succeeded');
    const got = store.getJob(a!.id);
    expect(got?.status).toBe('succeeded');
    expect(got?.costUsd).toBeCloseTo(0.01);
    expect(got?.sessionId).toBe(`sess-${a!.id}`);
  });

  it('cancels a queued job that never started', () => {
    store.putSettings({ maxConcurrency: 1 });
    const [, b] = sched.submit([spec('a'), spec('b')]);
    expect(sched.cancel(b!.id)).toBe(true);
    expect(store.getJob(b!.id)?.status).toBe('cancelled');
  });

  // The provenance of a run — which claude binary produced it — is only knowable
  // from the child's init message, which lands well after the spawn. It used to
  // be projected onto the job row by replay alone, so a row read from a daemon
  // that had not restarted always said null. These two assertions are the same
  // question asked of the live path and of the rebuilt one, and they must agree.
  describe('job.started projection', () => {
    const started = (jobId: string, sessionId: string) =>
      bus.publish({
        jobId, sessionId, ts: new Date().toISOString(), source: 'child',
        type: 'job.started', payload: { cliVersion: '2.1.261', model: 'haiku' },
      });

    it('records the cli version on the live path, not only after a rebuild', () => {
      const [job] = sched.submit([spec('a')]);
      sched.tick();
      const id = job!.id;
      expect(store.getJob(id)?.cliVersion).toBeNull(); // Not knowable yet.

      started(id, `sess-${id}`);
      expect(store.getJob(id)?.cliVersion).toBe('2.1.261');
    });

    it('agrees with what a rebuild from the log reconstructs', () => {
      const [job] = sched.submit([spec('a')]);
      sched.tick();
      const id = job!.id;
      started(id, `sess-${id}`);
      const live = store.getJob(id);

      store.rebuildFromLogs();
      const rebuilt = store.getJob(id);
      // The literal, not `live?.cliVersion` — comparing the two sides would
      // pass just as happily if the projection broke on *both* and left both
      // null, which is the exact bug this test exists to catch.
      expect(live?.cliVersion).toBe('2.1.261');
      expect(rebuilt?.cliVersion).toBe('2.1.261');

      // startedAt is deliberately NOT equal across the two. The spawn is
      // earlier and truer than the init message, so the live row keeps it
      // while a rebuild has only the event and falls back to its ts. What is
      // guaranteed is the ordering, and that neither side lost the field;
      // asserting equality would pass only while both land in one millisecond.
      expect(live?.startedAt).toBeTruthy();
      expect(rebuilt?.startedAt).toBeTruthy();
      expect(rebuilt!.startedAt! >= live!.startedAt!).toBe(true);
      expect(rebuilt?.status).toBe(live?.status);
    });
});

describe('job ids', () => {
  it('sort in mint order even when a whole batch lands in one millisecond', async () => {
    const { newJobId } = await import('../src/scheduler/ids.js');
    const now = 1_788_600_000_000;
    const ids = Array.from({ length: 50 }, () => newJobId(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
  });

});
