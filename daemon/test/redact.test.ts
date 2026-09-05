import { describe, it, expect } from 'vitest';
import { redact, redactString, REDACTED } from '../src/redact.js';

describe('redact', () => {
  // Modelled on the real leak found in ~/.claude/jobs/<id>/adopt.json (spec F9):
  // secrets sitting inside a captured shell command string, not in tidy fields.
  const REAL_LEAK_SHAPE = {
    origin: 'exit',
    fan: [
      {
        id: 'bsc1w7pxk',
        kind: 'shell',
        command:
          "DATABASE_URL='postgres://freshco:freshco_dev@localhost:5432/freshco_dev' " +
          "SESSION_SECRET='hunter2hunter2' ADMIN_PASSWORD=\"s3cr3t-admin\" npm run dev",
      },
    ],
  };

  it('scrubs secrets embedded in a captured command string', () => {
    const out = JSON.stringify(redact(REAL_LEAK_SHAPE));
    expect(out).not.toContain('freshco_dev@');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('s3cr3t-admin');
    expect(out).toContain(REDACTED);
    // Non-secret context survives, or the log stops being useful.
    expect(out).toContain('npm run dev');
    expect(out).toContain('bsc1w7pxk');
  });

  it('redacts sensitive keys wholesale', () => {
    const out = redact({
      api_key: 'abc123',
      authorization: 'Bearer xyz',
      password: 'pw',
      DATABASE_URL: 'postgres://a:b@h/db',
    }) as Record<string, unknown>;
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('never redacts sessionId — it is the primary key', () => {
    const out = redact({
      sessionId: '7e89efe0-826e-4609-ae6a-3064c3347fb2',
      resumeSessionId: 'a581da21-31c2-45be-af1a-a56ccbf0c813',
    }) as Record<string, unknown>;
    expect(out['sessionId']).toBe('7e89efe0-826e-4609-ae6a-3064c3347fb2');
    expect(out['resumeSessionId']).toBe('a581da21-31c2-45be-af1a-a56ccbf0c813');
  });

  it('keeps the harness token-count object, which is not a secret', () => {
    const out = redact({ tokens: { input: 1200, output: 340 } }) as Record<
      string,
      unknown
    >;
    expect(out['tokens']).toEqual({ input: 1200, output: 340 });
  });

  it('applies user literals but ignores short ones', () => {
    expect(redactString('my pass is swordfish99', ['swordfish99'])).toContain(
      REDACTED,
    );
    expect(redactString('a cat sat', ['cat'])).toBe('a cat sat');
  });

  it('survives cycles and deep nesting without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('does not mutate its input', () => {
    const input = { password: 'pw', keep: 'ok' };
    redact(input);
    expect(input.password).toBe('pw');
  });

  it('redacts a camelCased token key, which has no separator to anchor on', () => {
    const out = redact({ peerToken: 'abc123', bearerToken: 'xyz' }, []) as Record<string, unknown>;
    expect(out['peerToken']).not.toContain('abc123');
    expect(out['bearerToken']).not.toContain('xyz');
  });

  it('never redacts the identity fields the whole system joins on', () => {
    // A regression here would not throw — it would quietly turn every event
    // into an orphan whose session cannot be found again.
    const out = redact(
      { sessionId: 'a581da21-31c2', resumeSessionId: 'b16376c8', jobId: 'job-1', name: 'ghost-71' },
      [],
    ) as Record<string, unknown>;
    expect(out['sessionId']).toBe('a581da21-31c2');
    expect(out['resumeSessionId']).toBe('b16376c8');
    expect(out['jobId']).toBe('job-1');
    expect(out['name']).toBe('ghost-71');
  });
});
