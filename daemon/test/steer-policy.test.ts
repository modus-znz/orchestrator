import { describe, it, expect } from 'vitest';
import { evaluateSteer, MAX_STEER_CHARS, type SteerContext } from '../src/courier/policy.js';
import { DEFAULT_SETTINGS, type JobRecord, type SessionRecord, type Settings } from '../src/types.js';

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 's1', kind: 'managed', jobId: 'j1', pid: 123, name: 'worker-a',
  cwd: '/tmp', alive: true, procStart: '111', status: 'idle',
  firstSeenAt: '', lastSeenAt: '', ...over,
});

const jobRec = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'j1', name: 'j1', prompt: 'p', cwd: '/tmp', model: 'haiku', budgetUsd: 1,
  timeoutMs: 1000, permissionMode: 'default', dependsOn: [], steerable: true,
  status: 'running', sessionId: 's1', createdAt: '', startedAt: null, finishedAt: null,
  costUsd: 0, numTurns: 0, exitCode: null, error: null, cliVersion: null, ...over,
});

const ctx = (over: Partial<SteerContext> = {}): SteerContext => ({
  settings: { ...DEFAULT_SETTINGS, steerAllowlist: ['worker-a'] } satisfies Settings,
  job: jobRec(), session: session(), recentSteers: [], now: NOW, ...over,
});

describe('steer policy', () => {
  it('allows a steer only when every gate passes', () => {
    expect(evaluateSteer('focus on the failing test', ctx())).toEqual({ allowed: true });
  });

  it('refuses everything under the shipped defaults', () => {
    // DEFAULT_SETTINGS.steerAllowlist is empty, and that must mean "no one".
    const d = evaluateSteer('do the thing', ctx({ settings: DEFAULT_SETTINGS }));
    expect(d).toMatchObject({ allowed: false, code: 'not_allowlisted' });
  });

  it('refuses a job that was not submitted as steerable', () => {
    const d = evaluateSteer('do the thing', ctx({ job: jobRec({ steerable: false }) }));
    expect(d).toMatchObject({ allowed: false, code: 'not_steerable' });
  });

  it('refuses a steerable job whose session is not allowlisted', () => {
    // Per-job opt-in alone is not sufficient; both gates must pass.
    const d = evaluateSteer('do the thing', ctx({ session: session({ name: 'stranger' }) }));
    expect(d).toMatchObject({ allowed: false, code: 'not_allowlisted' });
  });

  it('refuses an unnamed session even when the allowlist is non-empty', () => {
    const d = evaluateSteer('do the thing', ctx({ session: session({ name: null }) }));
    expect(d).toMatchObject({ allowed: false, code: 'not_allowlisted' });
  });

  it('refuses an unknown or dead target', () => {
    expect(evaluateSteer('x', ctx({ session: null })))
      .toMatchObject({ allowed: false, code: 'unknown_target' });
    expect(evaluateSteer('x', ctx({ session: session({ alive: false }) })))
      .toMatchObject({ allowed: false, code: 'session_gone' });
  });

  it('refuses empty and oversized messages', () => {
    expect(evaluateSteer('   ', ctx())).toMatchObject({ allowed: false, code: 'empty_message' });
    expect(evaluateSteer('x'.repeat(MAX_STEER_CHARS + 1), ctx()))
      .toMatchObject({ allowed: false, code: 'message_too_long' });
  });

  it('rate limits per hour and forgets steers older than that', () => {
    const limit = DEFAULT_SETTINGS.steerRateLimitPerHour;
    const justNow = Array.from({ length: limit }, (_, i) => NOW - i * 1000);
    expect(evaluateSteer('x', ctx({ recentSteers: justNow })))
      .toMatchObject({ allowed: false, code: 'rate_limited' });

    const yesterday = justNow.map((t) => t - 24 * 60 * 60 * 1000);
    expect(evaluateSteer('x', ctx({ recentSteers: yesterday }))).toEqual({ allowed: true });
  });

  it('allows an observed session that the operator explicitly allowlisted', () => {
    // No job record to opt in, so the allowlist is the only gate — which is
    // why the allowlist is operator-set and empty by default.
    const d = evaluateSteer('x', ctx({ job: null, session: session({ kind: 'observed', jobId: null }) }));
    expect(d).toEqual({ allowed: true });
  });

  it('accepts a sessionId in the allowlist, since derived names are not durable', () => {
    const decision = evaluateSteer('go', ctx({
      settings: { ...DEFAULT_SETTINGS, steerAllowlist: ['s1'] },
      session: session({ name: 'renamed-after-restart' }),
    }));
    expect(decision.allowed).toBe(true);
  });

  it('matches the allowlist against the live row, not against a caller-supplied name', () => {
    // The caller cannot smuggle in an allowlisted name: the name comes from the
    // fleet row, and this row's name is not on the list.
    const decision = evaluateSteer('go', ctx({
      settings: { ...DEFAULT_SETTINGS, steerAllowlist: ['worker-a'] },
      session: session({ sessionId: 's9', name: 'worker-b' }),
    }));
    expect(decision).toMatchObject({ allowed: false, code: 'not_allowlisted' });
  });
});
