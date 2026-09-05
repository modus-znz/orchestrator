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
