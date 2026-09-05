import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, rejectUnknownFlags, KNOWN } from '../src/args.js';
import { ensureHome, orchestratorHome } from '../src/paths.js';

describe('rejectUnknownFlags', () => {
  const check = (command: string, argv: string[]): void =>
    rejectUnknownFlags(command, parseArgs(argv));

  // The regression this exists for: `--file` is not an `orc run` flag, so the
  // parser treated it as a boolean and left `batch.json` in the positionals,
  // which become the prompt. The daemon spawned a billable session whose whole
  // instruction was a file path. That cost $0.13 and looked like a success.
  it('rejects the typo that once billed a session to read a filename', () => {
    expect(() => check('run', ['--file', 'batch.json'])).toThrow(/no --file/);
  });

  it('names what the command does take, so the fix needs no --help', () => {
    expect(() => check('run', ['--budgett', '2'])).toThrow(/--model, --cwd, --budget/);
  });

  it('says "takes no flags" rather than listing an empty set', () => {
    expect(() => check('batch', ['--model', 'haiku'])).toThrow(/takes no flags/);
  });

  it('accepts every flag it advertises, so the allowlist cannot rot silently', () => {
    for (const [command, flags] of Object.entries(KNOWN)) {
      // Valued flags need a value; booleans do not. Passing one to a boolean is
      // harmless here — only the flag names are under test.
      const argv = flags.flatMap((f) => [`--${f}`, 'x']);
      expect(() => check(command, argv), `${command} rejects its own flags`).not.toThrow();
    }
  });

  it('leaves an unknown command to the switch, which has the better message', () => {
    expect(() => check('frobnicate', ['--anything'])).not.toThrow();
  });

  it('does not mistake a prompt full of hyphens for flags', () => {
    expect(() => check('run', ['refactor the well-known half-baked parser'])).not.toThrow();
  });
});

describe('the -f short flag', () => {
  // parseArgs recognises `--` flags only — prompts are full of hyphens and a
  // parser that guesses will one day eat half an instruction — with exactly one
  // exception, carved out because `logs -f` is muscle memory from every log
  // tool there is. These pin the exception so a future tightening of the rule
  // cannot silently turn a documented flag into a no-op positional.
  it('sets follow, so `orc logs <job> -f` actually follows', () => {
    const p = parseArgs(['job_123', '-f']);
    expect(p.flags.get('follow')).toBe(true);
    expect(p.positional).toEqual(['job_123']);
  });

  it('works before the job id too, since argv order is the user\'s business', () => {
    const p = parseArgs(['-f', 'job_123']);
    expect(p.flags.get('follow')).toBe(true);
    expect(p.positional).toEqual(['job_123']);
  });

  it('stays a positional after `--`, which is what `--` is for', () => {
    const p = parseArgs(['--', '-f']);
    expect(p.flags.get('follow')).toBeUndefined();
    expect(p.positional).toEqual(['-f']);
  });

  it('does not fire on a hyphenated word inside free text', () => {
    const p = parseArgs(['what does -force do']);
    expect(p.flags.get('follow')).toBeUndefined();
  });
});

describe('ensureHome', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env['ORCHESTRATOR_HOME'];
  });

  it('creates the state directory on a machine that has never run the daemon', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-home-'));
    const home = join(dir, 'never', 'existed');
    process.env['ORCHESTRATOR_HOME'] = home;
    expect(existsSync(home)).toBe(false);
    expect(ensureHome()).toBe(home);
    expect(existsSync(home)).toBe(true);
  });

  it('creates it 0700, because the bearer token lives there', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-home-'));
    const home = join(dir, 'fresh');
    process.env['ORCHESTRATOR_HOME'] = home;
    ensureHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('is idempotent, so a second start is not an error', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-home-'));
    process.env['ORCHESTRATOR_HOME'] = dir;
    expect(() => {
      ensureHome();
      ensureHome();
    }).not.toThrow();
  });

  it('honours ORCHESTRATOR_HOME, or the CLI creates one directory and reads another', () => {
    dir = mkdtempSync(join(tmpdir(), 'orc-home-'));
    process.env['ORCHESTRATOR_HOME'] = dir;
    expect(orchestratorHome()).toBe(dir);
  });
});
