import { describe, it, expect } from 'vitest';
import { parseArgs, rejectUnknownFlags, str, bool } from '../src/args.js';

/**
 * These pin the argument shapes of the two verbs that steer an observed
 * session — `orc steer --force` and `orc allow` — because a mis-declared flag
 * here is not a cosmetic bug. `steer`'s positionals become the courier message
 * and `allow`'s positional becomes an allowlisted sessionId; a flag that
 * silently falls through to the positionals corrupts one or the other. This
 * codebase already paid $0.13 to learn that lesson once (see flags.test.ts).
 */

describe('orc steer --force', () => {
  it('sets force without eating any of the message', () => {
    const p = parseArgs(['abc-123', 'stop', 'the', 'refactor', '--force']);
    rejectUnknownFlags('steer', p);
    expect(bool(p.flags, 'force')).toBe(true);
    // Target + message survive intact — the guard flag is not a positional.
    expect(p.positional).toEqual(['abc-123', 'stop', 'the', 'refactor']);
  });

  it('is off by default, so an ordinary steer keeps its guard', () => {
    const p = parseArgs(['abc-123', 'just do it']);
    expect(bool(p.flags, 'force')).toBe(false);
  });

  it('still rejects a genuinely unknown flag on steer', () => {
    expect(() => rejectUnknownFlags('steer', parseArgs(['x', 'y', '--forcce']))).toThrow(/no --forcce/);
  });
});

describe('orc allow', () => {
  it('takes a bare sessionId as the thing to allow', () => {
    const p = parseArgs(['e1505ad7-1111-2222-3333-444455556666']);
    rejectUnknownFlags('allow', p);
    expect(p.positional).toEqual(['e1505ad7-1111-2222-3333-444455556666']);
    expect(bool(p.flags, 'list')).toBe(false);
  });

  it('treats --list as a boolean, not a value-eater', () => {
    const p = parseArgs(['--list']);
    rejectUnknownFlags('allow', p);
    expect(bool(p.flags, 'list')).toBe(true);
    expect(p.positional).toEqual([]);
  });

  it('reads --remove <id> as a valued flag, so the id is the value not a positional', () => {
    const id = 'e1505ad7-1111-2222-3333-444455556666';
    const p = parseArgs(['--remove', id]);
    rejectUnknownFlags('allow', p);
    expect(str(p.flags, 'remove')).toBe(id);
    // Crucial: the id must NOT leak into positionals, or a later add path would
    // re-allow the very session being removed.
    expect(p.positional).toEqual([]);
  });

  it('rejects a flag it does not define, the way every other verb does', () => {
    expect(() => rejectUnknownFlags('allow', parseArgs(['--purge']))).toThrow(/orc allow has no --purge/);
  });
});
