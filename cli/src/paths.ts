import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Deliberately a copy of the daemon's resolution rather than an import.
 *
 * The CLI must honour `ORCHESTRATOR_HOME` identically or it reads the wrong
 * token and gets a 401 that looks like a permissions bug. Six lines duplicated
 * is cheaper than making the CLI depend on the daemon's build output — the two
 * are separately buildable on purpose, and `orc` must work when `dist/` for the
 * daemon has never been built.
 */
export function orchestratorHome(): string {
  return process.env['ORCHESTRATOR_HOME'] ?? join(homedir(), '.claude', 'orchestrator');
}

export const DEFAULT_PORT = 4317;

export function port(): number {
  const raw = Number(process.env['ORCHESTRATOR_PORT'] ?? DEFAULT_PORT);
  return Number.isFinite(raw) ? raw : DEFAULT_PORT;
}

export const tokenPath = (): string => join(orchestratorHome(), 'token');
export const pidPath = (): string => join(orchestratorHome(), 'daemon.pid');
export const baseUrl = (): string => `http://127.0.0.1:${port()}`;

/**
 * Create the state directory if this machine has never run the daemon.
 *
 * `orc daemon start` opens the log fd and writes the pid file *before* the
 * spawn, but the daemon is what normally creates the directory holding them —
 * so on a first run the command failed with an ENOENT naming the state
 * directory, which reads like a corrupt install rather than a fresh one.
 *
 * 0700 because the bearer token lives here. `recursive` makes it idempotent,
 * and deliberately does NOT re-chmod a directory that already exists: the
 * daemon refuses to start on a loose token file, and silently widening or
 * narrowing an operator's own permissions behind their back is worse than
 * saying so.
 */
export function ensureHome(): string {
  const home = orchestratorHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
