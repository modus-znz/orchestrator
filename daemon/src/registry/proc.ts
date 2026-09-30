import { readFileSync } from 'node:fs';

/**
 * The bits of `/proc` the watcher needs, behind an interface so the watcher is
 * testable without spawning real processes (and so a non-Linux host degrades
 * to "no observed sessions" instead of throwing).
 */
export interface ProcTable {
  /** Field 22 of `/proc/<pid>/stat` — clock ticks since boot, fixed for the
   *  life of the process. Null when the pid is gone. */
  startTime(pid: number): string | null;
}

export const linuxProc: ProcTable = {
  startTime(pid: number): string | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field is parenthesised and may itself contain spaces and
      // parentheses, so fields are counted from the LAST ')' — splitting the
      // whole line on whitespace misreads any process named e.g. "(foo bar)".
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // stat fields are 1-based and field 3 is the first after comm, so
      // field 22 sits at index 22 - 3 = 19 of `rest`.
      return rest[19] ?? null;
    } catch {
      return null;
    }
  },
};
