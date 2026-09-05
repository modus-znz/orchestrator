import type { EventBus } from '../bus.js';
import type { ChildRunner, RunHandle } from '../runner/child.js';
import type { Store } from '../store/index.js';
import type { JobRecord, JobSpec, JobStatus } from '../types.js';
import { newJobId } from './ids.js';

export class DependencyCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`dependency cycle: ${cycle.join(' -> ')}`);
    this.name = 'DependencyCycleError';
  }
}

export class UnknownDependencyError extends Error {
  constructor(readonly jobName: string, readonly dependency: string) {
    super(`job "${jobName}" depends on unknown job "${dependency}"`);
    this.name = 'UnknownDependencyError';
  }
}

export interface SubmitSpec extends JobSpec {
  /** Within a batch, `dependsOn` may name a sibling by this label instead of
   *  by an id that does not exist yet. */
  readonly name?: string;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
]);

/**
 * Concurrency limit plus a dependency DAG.
 *
 * Cycles are rejected at submit time and the whole batch refused. Detecting
 * them later, at run time, would mean a set of jobs that simply never start
 * and no clear reason why — the failure would look like a hang.
 */
export class Scheduler {
  readonly #store: Store;
  readonly #bus: EventBus;
  readonly #runner: ChildRunner;
  readonly #handles = new Map<string, RunHandle>();
  #draining = false;

  constructor(store: Store, bus: EventBus, runner: ChildRunner) {
    this.#store = store;
    this.#bus = bus;
    this.#runner = runner;
  }

  get runningCount(): number {
    return this.#handles.size;
  }

  submit(specs: readonly SubmitSpec[]): JobRecord[] {
    const now = new Date().toISOString();
    const byName = new Map<string, string>();
    const jobs: JobRecord[] = specs.map((spec) => {
      const id = newJobId();
      if (spec.name) byName.set(spec.name, id);
      return {
        ...spec,
        id,
        status: 'queued' as JobStatus,
        sessionId: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        costUsd: 0,
        numTurns: 0,
        exitCode: null,
        error: null,
        cliVersion: null,
      };
    });

    // Resolve sibling-name references into ids, and reject anything unknown
    // now rather than letting it silently block forever.
    const resolved = jobs.map((job, i) => {
      const deps = (specs[i]?.dependsOn ?? []).map((d) => {
        const asName = byName.get(d);
        if (asName) return asName;
        if (this.#store.getJob(d)) return d;
        throw new UnknownDependencyError(job.name ?? job.id, d);
      });
      return { ...job, dependsOn: deps };
    });

    this.#assertAcyclic(resolved);
    for (const job of resolved) this.#store.putJob(job);
    this.tick();
    return resolved;
  }

  /** Kahn's algorithm over the batch plus any already-stored dependencies. */
  #assertAcyclic(batch: readonly JobRecord[]): void {
    const nodes = new Map<string, readonly string[]>();
    for (const job of batch) nodes.set(job.id, job.dependsOn);
    const indegree = new Map<string, number>();
    for (const [id, deps] of nodes) {
      indegree.set(id, deps.filter((d) => nodes.has(d)).length);
    }
    const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    let seen = 0;
    while (queue.length) {
      const id = queue.shift()!;
      seen++;
      for (const [other, deps] of nodes) {
        if (!deps.includes(id)) continue;
        const next = (indegree.get(other) ?? 0) - 1;
        indegree.set(other, next);
        if (next === 0) queue.push(other);
      }
    }
    if (seen !== nodes.size) {
      const stuck = [...indegree].filter(([, n]) => n > 0).map(([id]) => id);
      throw new DependencyCycleError(stuck);
    }
  }

  /** Start whatever is runnable, up to the concurrency limit. Idempotent. */
  tick(): void {
    if (this.#draining) return;
    const settings = this.#store.getSettings();
    const pending = this.#store
      .listJobs()
      .filter((j) => j.status === 'queued' || j.status === 'blocked')
      // FIFO. A batch shares one createdAt, so id is the tie-break that
      // actually orders it — ids are minted in sortable sequence for exactly
      // this reason (see scheduler/ids.ts).
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

    for (const job of pending) {
      const deps = job.dependsOn.map((d) => this.#store.getJob(d));
      const failed = deps.find((d) => d && TERMINAL.has(d.status) && d.status !== 'succeeded');
      if (failed) {
        this.#finish(job, 'cancelled', `dependency ${failed.id} ended as ${failed.status}`);
        continue;
      }
      const unmet = deps.some((d) => !d || d.status !== 'succeeded');
      if (unmet) {
        if (job.status !== 'blocked') this.#store.putJob({ ...job, status: 'blocked' });
        continue;
      }
      if (this.#handles.size >= settings.maxConcurrency) return;
      this.#start(job);
    }
  }

  #start(job: JobRecord): void {
    const handle = this.#runner.start(job);
    this.#handles.set(job.id, handle);
    this.#store.putJob({ ...job, status: 'running', startedAt: new Date().toISOString(), sessionId: handle.sessionId });

    void handle.done.then((outcome) => {
      this.#handles.delete(job.id);
      const current = this.#store.getJob(job.id) ?? job;
      this.#store.putJob({
        ...current,
        status: outcome.status,
        sessionId: outcome.sessionId,
        finishedAt: new Date().toISOString(),
        costUsd: outcome.costUsd,
        exitCode: outcome.exitCode,
        error: outcome.error,
      });
      // A finishing job frees a slot and may unblock dependents.
      this.tick();
    });
  }

  #finish(job: JobRecord, status: JobStatus, error: string): void {
    this.#store.putJob({ ...job, status, error, finishedAt: new Date().toISOString() });
    this.#bus.publish({
      jobId: job.id,
      sessionId: job.sessionId ?? job.id,
      ts: new Date().toISOString(),
      source: 'child',
      type: status === 'cancelled' ? 'job.cancelled' : 'job.failed',
      payload: { error, reason: 'scheduler' },
    });
  }

  cancel(jobId: string, reason = 'cancelled by operator'): boolean {
    const handle = this.#handles.get(jobId);
    if (handle) {
      handle.cancel(reason);
      return true;
    }
    const job = this.#store.getJob(jobId);
    if (!job || TERMINAL.has(job.status)) return false;
    this.#finish(job, 'cancelled', reason);
    return true;
  }

  /** Stop starting new work and cancel what is in flight. */
  async drain(): Promise<void> {
    this.#draining = true;
    const inFlight = [...this.#handles.values()];
    for (const h of inFlight) h.cancel('daemon shutting down');
    await Promise.allSettled(inFlight.map((h) => h.done));
  }
}
