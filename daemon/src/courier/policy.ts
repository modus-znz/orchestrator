import type { JobRecord, SessionRecord, Settings } from '../types.js';

export type SteerRefusal =
  | 'empty_message'
  | 'message_too_long'
  | 'unknown_target'
  | 'session_gone'
  | 'not_steerable'
  | 'not_allowlisted'
  | 'rate_limited';

export type SteerDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: SteerRefusal; readonly reason: string };

export interface SteerContext {
  readonly settings: Settings;
  /** The managed job behind the target, when there is one. */
  readonly job: JobRecord | null;
  readonly session: SessionRecord | null;
  /** Epoch-ms timestamps of prior steers to this same target. */
  readonly recentSteers: readonly number[];
  readonly now: number;
}

/** A courier prompt is a relayed instruction, not an essay. */
export const MAX_STEER_CHARS = 4_000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Decides whether one steer may be sent. Pure, so the refusal rules are
 * testable without spawning anything — and so that adding a courier can never
 * quietly become a way to bypass them.
 *
 * Every gate is a conjunction and every default is closed: an empty allowlist
 * refuses everything (§6 rule 1), and a job must opt in per-job *as well as*
 * appear in the operator's allowlist. One of the two being permissive is not
 * enough, because they protect against different mistakes — a careless job
 * spec versus a careless global setting.
 */
export function evaluateSteer(message: string, ctx: SteerContext): SteerDecision {
  const refuse = (code: SteerRefusal, reason: string): SteerDecision =>
    ({ allowed: false, code, reason });

  if (!message.trim()) return refuse('empty_message', 'steer message is empty');
  if (message.length > MAX_STEER_CHARS) {
    return refuse('message_too_long', `steer message exceeds ${MAX_STEER_CHARS} characters`);
  }
  if (!ctx.session) return refuse('unknown_target', 'no such session');
  if (!ctx.session.alive) return refuse('session_gone', 'target session is no longer live');

  // A managed job must have opted in. An observed session has no job record to
  // opt in, so the allowlist below is its only gate — deliberately, since we
  // did not spawn it and cannot know what it is doing.
  if (ctx.job && !ctx.job.steerable) {
    return refuse('not_steerable', `job ${ctx.job.id} was not submitted as steerable`);
  }

  const name = ctx.session.name;
  if (!name || !ctx.settings.steerAllowlist.includes(name)) {
    return refuse('not_allowlisted', `session ${name ?? '(unnamed)'} is not in the steer allowlist`);
  }

  const limit = ctx.settings.steerRateLimitPerHour;
  const recent = ctx.recentSteers.filter((t) => ctx.now - t < HOUR_MS).length;
  if (recent >= limit) {
    return refuse('rate_limited', `${recent} steers in the last hour reaches the limit of ${limit}`);
  }

  return { allowed: true };
}
