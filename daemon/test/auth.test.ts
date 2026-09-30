import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsecureTokenError, loadOrMintToken, verifyBearer } from '../src/api/auth.js';

let home: string;
const tokenPath = (): string => join(home, 'token');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-scratch-auth-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('loadOrMintToken', () => {
  it('mints a token on first start instead of demanding one', () => {
    const token = loadOrMintToken(tokenPath());
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes it owner-only', () => {
    loadOrMintToken(tokenPath());
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  });

  it('returns the same token on the next start', () => {
    expect(loadOrMintToken(tokenPath())).toBe(loadOrMintToken(tokenPath()));
  });

  it('refuses to serve with a token other accounts can read', () => {
    // The whole reason for a token on loopback is that loopback is not a trust
    // boundary here. A 644 token file makes the check theatre.
    writeFileSync(tokenPath(), 'deadbeef\n', { mode: 0o600 });
    chmodSync(tokenPath(), 0o644);
    expect(() => loadOrMintToken(tokenPath())).toThrow(InsecureTokenError);
  });

  it('refuses a group-readable token too, not only a world-readable one', () => {
    writeFileSync(tokenPath(), 'deadbeef\n', { mode: 0o600 });
    chmodSync(tokenPath(), 0o640);
    expect(() => loadOrMintToken(tokenPath())).toThrow(InsecureTokenError);
  });

  it('refuses an empty token file rather than authenticating everyone', () => {
    writeFileSync(tokenPath(), '\n', { mode: 0o600 });
    expect(() => loadOrMintToken(tokenPath())).toThrow(/empty/);
  });
});

describe('verifyBearer', () => {
  const token = 'a'.repeat(64);

  it('accepts the right token', () => {
    expect(verifyBearer(`Bearer ${token}`, token)).toBe(true);
  });

  it('rejects a missing header, a bare token, and the wrong scheme', () => {
    expect(verifyBearer(undefined, token)).toBe(false);
    expect(verifyBearer(token, token)).toBe(false);
    expect(verifyBearer(`Basic ${token}`, token)).toBe(false);
  });

  it('rejects a token of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the length check exists so
    // a short token is a 401 rather than a 500.
    expect(() => verifyBearer('Bearer short', token)).not.toThrow();
    expect(verifyBearer('Bearer short', token)).toBe(false);
  });

  it('rejects a token that shares a prefix with the real one', () => {
    expect(verifyBearer(`Bearer ${'a'.repeat(63)}b`, token)).toBe(false);
  });
});
