/**
 * The event model. Every ingest source (§4.1 of the design spec) normalises
 * into `OrchestratorEvent` before it touches the bus, the store, or the API.
 *
 * Identity rule (§4): `sessionId` is the primary key for anything
 * session-shaped. `jobId` is orchestrator-assigned and is null for sessions we
 * observe but did not spawn. A job maps to one *or more* sessionIds over its
 * life, because --resume and --fork-session mint new ones.
 */

export type JobStatus =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

export type EventSource = 'child' | 'registry' | 'harness';

export type EventType =
  | 'job.queued'
  | 'job.started'
  | 'job.finished'
  | 'job.failed'
  | 'job.cancelled'
  | 'job.budget_exceeded'
  | 'msg.assistant'
  | 'msg.user'
  | 'tool.use'
  | 'tool.result'
  | 'cost.turn'
  | 'session.registered'
  | 'session.gone'
  | 'session.state'
  | 'steer.sent'
  | 'steer.failed'
  | 'rate.limit'
  | 'raw';

export interface OrchestratorEvent {
  /** null for observed-only sessions (§4.1). */
  readonly jobId: string | null;
  readonly sessionId: string;
  /** Monotonic per sessionId, assigned by the bus on ingest — not by the
   *  source, because registry files carry no sequence of their own. */
  readonly seq: number;
  readonly ts: string;
  readonly source: EventSource;
  readonly type: EventType;
  readonly payload: unknown;
}

/** An event before the bus has stamped it with a sequence number. */
export type UnsequencedEvent = Omit<OrchestratorEvent, 'seq'>;

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

export interface JobSpec {
  /** Caller-supplied label; falls back to a truncated prompt. */
  readonly name?: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: ModelTier;
  /** Hard ceiling in USD, checked after every cost.turn (§11). */
  readonly budgetUsd: number;
  readonly timeoutMs: number;
  readonly permissionMode: PermissionMode;
  readonly allowedTools?: readonly string[];
  /** jobIds that must reach 'succeeded' before this one may start. */
  readonly dependsOn: readonly string[];
  /** Steering is opt-in and off by default (§6). */
  readonly steerable: boolean;
}

export interface JobRecord extends JobSpec {
  readonly id: string;
  readonly status: JobStatus;
  /** The session currently backing this job; changes on resume/fork. */
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly exitCode: number | null;
  readonly error: string | null;
  /** CLI version recorded per job, so a stream-json shape change is
   *  attributable later (§14). */
  readonly cliVersion: string | null;
}

/**
 * A row in the fleet view. `managed` sessions come from source A and carry full
 * detail; `observed` sessions come from source B and carry name, cwd and
 * liveness only. The distinction is rendered, never papered over (§4.1).
 */
export type FleetKind = 'managed' | 'observed';

export interface SessionRecord {
  readonly sessionId: string;
  readonly kind: FleetKind;
  readonly jobId: string | null;
  readonly pid: number | null;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly alive: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Source C enrichment — present only for daemon-backed sessions (F6/F7).
   *  Absent means "unknown", and must never render as a blank value. */
  readonly harness?: HarnessState;
}

export interface HarnessState {
  readonly state: string;
  readonly detail: string | null;
  readonly tempo: string | null;
  readonly inFlightTasks: number | null;
  readonly inFlightQueued: number | null;
  readonly fanCount: number | null;
}

export interface Settings {
  readonly maxConcurrency: number;
  readonly defaultModel: ModelTier;
  readonly defaultBudgetUsd: number;
  readonly defaultTimeoutMs: number;
  readonly defaultPermissionMode: PermissionMode;
  readonly retryLimit: number;
  readonly terminal: 'ghostty' | 'konsole' | 'auto' | 'none';
  /** Session names allowed to receive steers. Empty means none (§6). */
  readonly steerAllowlist: readonly string[];
  /** Max steers per session per hour; couriers cost real money (§14). */
  readonly steerRateLimitPerHour: number;
  readonly redactPatterns: readonly string[];
}

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrency: 3,
  defaultModel: 'sonnet',
  defaultBudgetUsd: 2,
  defaultTimeoutMs: 30 * 60 * 1000,
  defaultPermissionMode: 'default',
  retryLimit: 0,
  terminal: 'auto',
  steerAllowlist: [],
  steerRateLimitPerHour: 20,
  redactPatterns: [],
};
