import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, fsyncSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';
import type { OrchestratorEvent } from '../types.js';

/** Events after which we force the write to disk. These are the ones whose
 *  loss would misreport an outcome, so they are worth the fsync. */
const TERMINAL_TYPES = new Set([
  'job.started',
  'job.finished',
  'job.failed',
  'job.cancelled',
  'job.budget_exceeded',
]);

/**
 * Append-only event log — the crash-truth tier (spec §4.3). SQLite is a
 * queryable projection of this, and is rebuildable from it. File descriptors
 * are cached because a job emits thousands of events and reopening per line
 * would dominate the cost.
 */
export class JsonlLog {
  readonly #fds = new Map<string, number>();

  /** Managed jobs log under their jobId; observed sessions under sessionId,
   *  because they have no job (spec §4.1). */
  static dirFor(event: Pick<OrchestratorEvent, 'jobId' | 'sessionId'>): string {
    return event.jobId
      ? join(paths.jobLogs, event.jobId)
      : join(paths.sessionLogs, event.sessionId);
  }

  append(event: OrchestratorEvent): void {
    const dir = JsonlLog.dirFor(event);
    let fd = this.#fds.get(dir);
    if (fd === undefined) {
      mkdirSync(dir, { recursive: true });
      fd = openSync(join(dir, 'events.jsonl'), 'a');
      this.#fds.set(dir, fd);
    }
    writeSync(fd, `${JSON.stringify(event)}\n`);
    if (TERMINAL_TYPES.has(event.type)) fsyncSync(fd);
  }

  close(): void {
    for (const fd of this.#fds.values()) {
      try {
        fsyncSync(fd);
        closeSync(fd);
      } catch {
        // Closing is best-effort; a failure here must not mask the real error.
      }
    }
    this.#fds.clear();
  }

  /** Read every logged event, ordered by (sessionId, seq), for rebuild. */
  static *readAll(): Generator<OrchestratorEvent> {
    for (const root of [paths.jobLogs, paths.sessionLogs]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(root, entry.name, 'events.jsonl');
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line) as OrchestratorEvent;
          } catch {
            // A torn final line after a hard kill is expected. Skip it rather
            // than abandoning an otherwise good log.
          }
        }
      }
    }
  }
}
