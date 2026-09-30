import { homedir } from 'node:os';
import { join } from 'node:path';

/** Overridable so tests never touch the real ~/.claude tree. */
export function orchestratorHome(): string {
  return process.env['ORCHESTRATOR_HOME'] ?? join(homedir(), '.claude', 'orchestrator');
}

export const paths = {
  get home(): string {
    return orchestratorHome();
  },
  get db(): string {
    return join(orchestratorHome(), 'orchestrator.db');
  },
  /** Crash-truth logs for jobs we spawned. */
  get jobLogs(): string {
    return join(orchestratorHome(), 'jobs');
  },
  /** Crash-truth logs for sessions we only observe (no jobId). */
  get sessionLogs(): string {
    return join(orchestratorHome(), 'sessions');
  },
  get token(): string {
    return join(orchestratorHome(), 'token');
  },
  get redactList(): string {
    return join(orchestratorHome(), 'redact.txt');
  },
  /** First-party harness state we read but never write (spec §4.1, sources B/C). */
  get harnessSessions(): string {
    return process.env['CLAUDE_SESSIONS_DIR'] ?? join(homedir(), '.claude', 'sessions');
  },
  get harnessJobs(): string {
    return process.env['CLAUDE_JOBS_DIR'] ?? join(homedir(), '.claude', 'jobs');
  },
} as const;
