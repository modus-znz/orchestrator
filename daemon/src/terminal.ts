import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Settings } from './types.js';

export type TerminalChoice = 'ghostty' | 'konsole';
const CANDIDATES: readonly TerminalChoice[] = ['ghostty', 'konsole'];

const onPath = (bin: string): boolean =>
  (process.env['PATH'] ?? '').split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Which terminal to open, or null for "don't".
 *
 * `auto` picks the first candidate actually installed rather than a compiled-in
 * favourite, and `none` is honoured absolutely — an operator who turned attach
 * off did not mean "unless you find something".
 */
export function resolveTerminal(
  pref: Settings['terminal'],
  has: (bin: string) => boolean = onPath,
): TerminalChoice | null {
  if (pref === 'none') return null;
  if (pref === 'auto') return CANDIDATES.find(has) ?? null;
  return has(pref) ? pref : null;
}

export interface AttachTarget {
  readonly sessionId: string;
  readonly cwd: string | null;
}

/**
 * The command that opens a terminal attached to an existing session.
 *
 * `--resume <sessionId>` rather than a fresh session: the point of attach is to
 * see the conversation that is already running, and a new session in the same
 * directory would look almost identical while sharing none of its history.
 */
export function buildAttachCommand(
  term: TerminalChoice,
  target: AttachTarget,
): { bin: string; args: string[] } {
  const inner = ['claude', '--resume', target.sessionId];
  if (term === 'konsole') {
    // konsole's --workdir must precede -e, and everything after -e is the
    // command; there is no shell in between to expand anything.
    const args = target.cwd ? ['--workdir', target.cwd, '-e', ...inner] : ['-e', ...inner];
    return { bin: 'konsole', args };
  }
  return {
    bin: 'ghostty',
    args: [...(target.cwd ? [`--working-directory=${target.cwd}`] : []), '-e', ...inner],
  };
}

/**
 * Open the terminal and forget about it.
 *
 * Detached and unref'd because this window belongs to the operator, not to the
 * daemon: restarting orchestratord must not close the terminal someone is
 * typing in, and the daemon must not be held open by one either.
 */
export function openTerminal(term: TerminalChoice, target: AttachTarget): number | null {
  const { bin, args } = buildAttachCommand(term, target);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid ?? null;
}
