import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths.js';

/** Bits of entropy in a minted token. 32 bytes is far past anything reachable
 *  by a local attacker guessing against a loopback socket. */
const TOKEN_BYTES = 32;

export class InsecureTokenError extends Error {
  constructor(path: string, mode: number) {
    super(
      `token file ${path} is mode ${mode.toString(8).padStart(4, '0')}; ` +
        'it must not be readable by group or other',
    );
  }
}

/**
 * Read the API token, minting one on first start.
 *
 * Minting rather than demanding is deliberate: an operator who has to create
 * the file themselves meets a 401 with no file to point at, and the usual next
 * move is to turn the check off. The daemon creating its own credential means
 * the secure path is also the path of least effort.
 *
 * The mode is then read *back*. `writeFileSync`'s `mode` argument is masked by
 * the process umask, so asking for 600 is not the same as getting it — and a
 * token any other account on the box can read makes the bearer check theatre,
 * since the whole reason for a token on loopback is that loopback is not a
 * trust boundary here (§11).
 */
export function loadOrMintToken(path: string = paths.token): string {
  let token: string;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch {
    mkdirSync(dirname(path), { recursive: true });
    token = randomBytes(TOKEN_BYTES).toString('hex');
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  }
  if (!token) throw new Error(`token file ${path} is empty`);

  const mode = statSync(path).mode & 0o777;
  // Refuse rather than repair: chmod-ing it silently would hide the fact that
  // the credential was already exposed to every process that could read it.
  if (mode & 0o077) throw new InsecureTokenError(path, mode);
  return token;
}

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is compared
 * first — and that comparison is not itself a leak: the token length is fixed
 * and public. Comparing the secrets with `===` would leak the shared prefix to
 * a caller willing to measure, which on a loopback socket is every process on
 * the machine.
 */
export function verifyBearer(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length).trim(), 'utf8');
  const want = Buffer.from(token, 'utf8');
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}
