import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../src/lock.js';

let dir: string;
const lockPath = (): string => join(dir, 'daemon.lock');

/** Above the kernel's pid_max, so it can never name a live process. Reading a
 *  pid that merely happens to be free would make this test racy against
 *  anything else starting on the machine. */
const DEAD_PID = 999_999_999;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon lock', () => {
  it('writes the holder pid, so the error can name who to stop', () => {
    const lock = acquireLock(lockPath(), 4242);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe('4242');
  });

  it('refuses a second daemon while the first is alive', () => {
    acquireLock(lockPath());
    expect(() => acquireLock(lockPath())).toThrow(/already owns this home/);
  });

  it('reclaims a lock left behind by a daemon that was killed', () => {
    // The kill -9 case. Requiring an operator to hunt down and delete a file
    // they have never heard of before the daemon will start is a worse failure
    // than the crash that caused it.
    writeFileSync(lockPath(), `${DEAD_PID}\n`);
    const lock = acquireLock(lockPath(), 7);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe('7');
  });

  it('treats an unreadable pid as garbage rather than as a lock', () => {
    // A torn write from a machine that lost power mid-start. There is no live
    // process behind it and never will be.
    writeFileSync(lockPath(), '');
    expect(() => acquireLock(lockPath(), 9)).not.toThrow();
  });

  it('frees the home on release', () => {
    const lock = acquireLock(lockPath());
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(() => acquireLock(lockPath())).not.toThrow();
  });

  it('is safe to release twice, because shutdown can arrive twice', () => {
    const lock = acquireLock(lockPath());
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});
