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
    this.#settle.get(jobId)?.({ status, exitCode: 0, costUsd: 0.01, sessionId: `sess-${jobId}`, error: null });
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
  let sched: InstanceType<typeof mod.Scheduler>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'orch-scratch-'));
    process.env['ORCHESTRATOR_HOME'] = home;
    ({ Store } = await import('../src/store/index.js'));
    ({ EventBus } = await import('../src/bus.js'));
    mod = await import('../src/scheduler/index.js');
    store = new Store(join(home, 'orchestrator.db'));
    runner = new FakeRunner();
    sched = new mod.Scheduler(store, new EventBus(store), runner as never);
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
