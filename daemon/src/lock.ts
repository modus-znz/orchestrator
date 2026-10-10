import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A single-daemon lock over one ORCHESTRATOR_HOME.
 *
 * Two daemons on the same home is not a slow configuration, it is a wrong one:
 * both schedulers read the same `queued` rows and both start them, so a job
 * runs twice and is billed twice; both reconcile at boot, so each settles jobs
 * the other still holds a live process for; and both replay the JSONL logs into
 * the same projection. SQLite's WAL keeps the file intact through all of it,
 * which is exactly why the damage is silent — there is no corruption to notice,
 * only work done twice.
 *
 * The lock is a file whose existence is the lock and whose contents are the pid
 * of the holder. `wx` makes the create atomic, so the race between two daemons
 * starting together is decided by the filesystem rather than by timing.
 */
export interface DaemonLock {
  readonly path: string;
  readonly release: () => void;
}

/** Whether a pid belongs to a process that still exists. Signal 0 performs the
 *  permission and existence checks without delivering anything. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to somebody else — still alive, and
    // still a reason not to start a second daemon.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the lock, or throw explaining who holds it.
 *
 * A lock left behind by a daemon that was killed rather than stopped is
 * reclaimed: the pid in it is checked, and a dead one makes the file garbage
 * rather than a lock. That check is the difference between surviving a `kill
 * -9` and requiring an operator to delete a file they have never heard of
 * before the daemon will start again.
 */
export function acquireLock(path: string, pid = process.pid): DaemonLock {
  mkdirSync(dirname(path), { recursive: true });
  // Two attempts, not a loop: the only reason the first can fail recoverably is
  // a stale file, and once that is cleared the second either wins the create or
  // loses it to a live daemon. A third attempt could only be answering a
  // process that is starting and dying in a tight loop, which is a different
  // problem and not one to spin on.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { path, release: () => rmSync(path, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (alive(holder)) {
        throw new Error(
          `another orchestrator daemon (pid ${holder}) already owns this home. ` +
            `Stop it first, or set ORCHESTRATOR_HOME to a different directory. ` +
            `If you are certain no daemon is running, delete ${path}.`,
        );
      }
      // Left by a daemon that was killed rather than stopped.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not acquire ${path}: lost the race twice`);
}
