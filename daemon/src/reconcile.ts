import type { EventBus } from './bus.js';
import { linuxProc, type ProcTable } from './registry/proc.js';
import type { Store } from './store/index.js';

export interface ReconcileOptions {
  readonly proc?: ProcTable;
  readonly now?: () => Date;
  /** Injectable so a test can assert we kill without killing anything. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ReconcileReport {
  /** Jobs whose child was already gone: the daemon died, and so did they. */
  readonly vanished: string[];
  /** Jobs whose child outlived us and was still running — and still billing. */
  readonly orphaned: string[];
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    // The group, not the pid: a Claude Code child spawns children of its own
    // and only a group signal reaches them (F17).
    process.kill(-pid, signal);
  } catch {
    // Gone between the liveness check and here, which is the outcome we wanted.
  }
}

/**
 * Settle jobs left `running` by a daemon that did not shut down cleanly.
 *
 * `stop()` drains, but SIGKILL, a panic and an OOM all skip it, and the rows
 * they leave behind are worse than untidy: the scheduler counts `running`
 * against `maxConcurrency`, so three stale rows at the default concurrency of
 * three mean the restarted daemon schedules nothing, forever, with no error to
 * explain why.
 *
 * The pid decides which of two situations this is, and the two want opposite
 * things. A pid that is gone (or recycled — `procStart` is what tells those
 * apart, F18) leaves nothing to do but record that the job died with us. A pid
 * that is *still alive* is a child we can no longer read: its stdout pipe died
 * with the daemon that owned it, so no cost event will ever arrive, no budget
 * will ever be enforced, and nothing will notice when it finishes. It is
 * spending real money inside the operator's repository with no supervisor. We
 * kill it. An agent nobody can observe or stop is not an asset worth keeping,
 * and leaving it running is the more destructive of the two options.
 */
export function reconcile(store: Store, bus: EventBus, opts: ReconcileOptions = {}): ReconcileReport {
  const proc = opts.proc ?? linuxProc;
  const kill = opts.kill ?? defaultKill;
  const ts = (opts.now ?? ((): Date => new Date()))().toISOString();
  const vanished: string[] = [];
  const orphaned: string[] = [];

  for (const job of store.listJobs('running')) {
    const session = job.sessionId === null ? null : store.getSession(job.sessionId);
    const pid = session?.pid ?? null;
    const alive =
      pid !== null &&
      session?.procStart != null &&
      proc.startTime(pid) === session.procStart;

    if (alive && pid !== null) {
      kill(pid, 'SIGTERM');
      orphaned.push(job.id);
    } else {
      vanished.push(job.id);
    }

    const error = alive
      ? 'orphaned by an unclean daemon shutdown; the child outlived the daemon and was terminated on restart'
      : 'lost to an unclean daemon shutdown; the child did not outlive the daemon';
    store.putJob({ ...job, status: 'failed', error, finishedAt: ts });
    bus.publish({
      jobId: job.id,
      sessionId: job.sessionId ?? job.id,
      ts,
      source: 'api',
      type: 'job.failed',
      payload: { error, reason: 'reconcile', orphaned: alive },
    });
  }

  // The fleet view carries the same staleness: a managed row is only live if
  // its pid still is. Observed rows are the watcher's to settle on its sweep.
  const stillAlive: string[] = [];
  for (const s of store.listSessions()) {
    if (s.kind !== 'managed' || s.pid === null || s.procStart === null) continue;
    if (proc.startTime(s.pid) === s.procStart) stillAlive.push(s.sessionId);
  }
  store.markSessionsGone('managed', stillAlive);

  return { vanished, orphaned };
}
