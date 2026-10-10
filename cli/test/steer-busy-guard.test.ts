import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseArgs } from '../src/args.js';

/**
 * The busy-guard proof.
 *
 * `orc steer` into an *observed* session that is currently *busy* refuses unless
 * `--force` is given — and it must refuse CLIENT-SIDE, before the steer endpoint
 * is ever touched, so a mistaken steer into a human's live work costs nothing
 * and delivers nothing. The courier bills per delivery (~$0.07), so "no POST"
 * is not a nicety here; it is the whole guarantee.
 *
 * A live demo of this flickers — an observed session flips busy/idle between the
 * fleet fetch and the eye — so the guard is pinned here instead, where the fleet
 * is whatever we say it is. We assert the exact thing that matters: the steer
 * POST is never called when the guard should fire, and IS called when it should
 * not (with --force, or against a managed / idle session).
 */

// A full uuid target skips sessionFor's fleet round-trip, so the only api calls
// steer() makes are the guard's own GET /api/fleet and the eventual steer POST —
// which is exactly what we want to count.
const SID = '136fa7c5-3d15-43e5-9684-6f3ee3815bdc';

const fleet = (over: Partial<Record<string, unknown>> = {}) => ({
  sessions: [
    {
      sessionId: SID,
      kind: 'observed',
      jobId: null,
      name: 'tmp-eb',
      cwd: '/tmp',
      alive: true,
      status: 'busy',
      lastSeenAt: new Date().toISOString(),
      ...over,
    },
  ],
});

const api = vi.fn();
vi.mock('../src/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/client.js')>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});

// Imported after the mock is registered so it binds to the spy.
const { steer } = await import('../src/commands.js');

/** Route each api(method, path) call to a canned response for one test. */
function route(handlers: { fleet: () => unknown; steer?: () => unknown }) {
  api.mockImplementation((method: string, path: string) => {
    if (path === '/api/fleet') return Promise.resolve(handlers.fleet());
    if (path.includes('/steer')) {
      return Promise.resolve(
        handlers.steer?.() ?? { delivered: true, costUsd: 0.069, error: null },
      );
    }
    throw new Error(`unexpected api call in test: ${method} ${path}`);
  });
}

const steerCalls = () =>
  api.mock.calls.filter((c) => typeof c[1] === 'string' && c[1].includes('/steer'));

// A block body, deliberately: `mockReset()` returns the mock, and vitest treats
// a function returned from a hook as a teardown callback — it would then call
// api() with no args during cleanup and blow up the mock. Return undefined.
beforeEach(() => {
  api.mockReset();
});

describe('orc steer busy-guard', () => {
  it('refuses a busy observed session without --force — and never calls the steer endpoint', async () => {
    route({ fleet: () => fleet() });
    await expect(steer(parseArgs([SID, 'stop', 'what', 'you', 'are', 'doing']))).rejects.toThrow(
      /observed and busy/,
    );
    // The guarantee: nothing was delivered, no courier spawned, $0 spent.
    expect(steerCalls()).toHaveLength(0);
  });

  it('names the session and points at --force in the refusal', async () => {
    route({ fleet: () => fleet() });
    await expect(steer(parseArgs([SID, 'hi']))).rejects.toThrow(/tmp-eb.*Re-run with --force/s);
  });

  it('delivers to the same busy session WHEN --force is given', async () => {
    route({ fleet: () => fleet() });
    await steer(parseArgs([SID, 'do', 'it', 'anyway', '--force']));
    expect(steerCalls()).toHaveLength(1);
    // --force also means the guard's fleet fetch is skipped entirely.
    expect(api.mock.calls.some((c) => c[1] === '/api/fleet')).toBe(false);
  });

  it('does NOT guard an idle observed session — steer goes straight through', async () => {
    route({ fleet: () => fleet({ status: 'idle' }) });
    await steer(parseArgs([SID, 'you', 'are', 'free', 'now']));
    expect(steerCalls()).toHaveLength(1);
  });

  it('does NOT guard a managed (daemon-spawned) session, even when busy', async () => {
    // Redirecting a managed job in flight is the whole point of steer; the guard
    // is only for interactive sessions the daemon did not start.
    route({ fleet: () => fleet({ kind: 'managed', jobId: 'j-1' }) });
    await steer(parseArgs([SID, 'change', 'course']));
    expect(steerCalls()).toHaveLength(1);
  });
});
