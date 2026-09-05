/**
 * The daemon's wire shapes.
 *
 * Deliberately a copy of `daemon/src/types.ts` rather than an import: the UI
 * builds standalone and must not need the daemon's `dist/` to typecheck, and a
 * project reference across the workspace would make `npm run build -w ui` fail
 * on a clean checkout for a reason no one would enjoy diagnosing. The cost is
 * that these must be kept in step; the fields are asserted by the daemon's own
 * tests, so a drift shows up as a runtime `undefined`, not a silent wrong number.
 */

export type JobStatus =
  | 'queued' | 'blocked' | 'running'
  | 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded';

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export type FleetKind = 'managed' | 'observed';
export type SessionStatus = 'shell' | 'idle' | 'busy';

export type EventType =
  | 'job.queued' | 'job.started' | 'job.finished' | 'job.failed'
  | 'job.cancelled' | 'job.budget_exceeded'
  | 'msg.assistant' | 'msg.user' | 'tool.use' | 'tool.result' | 'cost.turn'
  | 'session.registered' | 'session.gone' | 'session.state'
  | 'steer.sent' | 'steer.failed' | 'rate.limit' | 'raw';

export interface StoredEvent {
  readonly id: number;
  readonly jobId: string | null;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: string;
  readonly source: 'child' | 'registry' | 'harness' | 'api';
  readonly type: EventType;
  readonly payload: unknown;
}

export interface JobRecord {
  readonly id: string;
  readonly name?: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: ModelTier;
  readonly budgetUsd: number;
  readonly timeoutMs: number;
  readonly permissionMode: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly dependsOn: readonly string[];
  readonly steerable: boolean;
  readonly status: JobStatus;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly cliVersion: string | null;
}

export interface HarnessState {
  readonly state: string;
  readonly detail: string | null;
  readonly tempo: string | null;
  readonly inFlightTasks: number | null;
  readonly inFlightQueued: number | null;
  readonly fanCount: number | null;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly kind: FleetKind;
  readonly jobId: string | null;
  readonly pid: number | null;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly alive: boolean;
  readonly procStart: string | null;
  readonly status: SessionStatus | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly harness?: HarnessState;
}

export interface Settings {
  readonly maxConcurrency: number;
  readonly defaultModel: ModelTier;
  readonly defaultBudgetUsd: number;
  readonly defaultTimeoutMs: number;
  readonly defaultPermissionMode: PermissionMode;
  readonly retryLimit: number;
  readonly terminal: 'ghostty' | 'konsole' | 'auto' | 'none';
  readonly steerAllowlist: readonly string[];
  readonly steerRateLimitPerHour: number;
  readonly redactPatterns: readonly string[];
  readonly allowBypassPermissions: boolean;
}

export interface Health {
  readonly ok: boolean;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly running: number;
  readonly sseClients: number;
  readonly latestEventId: number;
}

export interface FleetResponse {
  readonly sessions: readonly SessionRecord[];
  readonly managed: number;
  readonly observed: number;
}

export interface CostStats {
  readonly bucket: 'hour' | 'day';
  readonly series: ReadonlyArray<{ bucket: string; usd: number; inputTokens: number; outputTokens: number }>;
  readonly byModel: ReadonlyArray<{ model: string; usd: number; turns: number }>;
}
export interface ConcurrencyStats {
  readonly bucket: 'hour' | 'day';
  readonly measure: string;
  readonly series: ReadonlyArray<{ bucket: string; sessions: number; jobs: number }>;
}
export interface QueueStats {
  readonly bucket: 'hour' | 'day';
  readonly series: ReadonlyArray<{ bucket: string; waiting: number; running: number }>;
}
export interface ToolStats {
  readonly tools: ReadonlyArray<{ tool: string; uses: number }>;
}
export interface FailureStats {
  readonly byStatus: ReadonlyArray<{ status: string; count: number }>;
  readonly recent: ReadonlyArray<{ id: string; name: string; error: string | null; finishedAt: string | null }>;
}
