import { describe, it, expect } from 'vitest';
import { bool, list, num, parseArgs, str } from '../src/args.js';

describe('parseArgs', () => {
  it('keeps a prompt whole, hyphens and all', () => {
    // The failure this guards: a prompt is free text an operator typed, and
    // clever parsing eats half of it.
    const p = parseArgs(['refactor the auth-module', 'and', 'fix its tests']);
    expect(p.positional.join(' ')).toBe('refactor the auth-module and fix its tests');
    expect(p.flags.size).toBe(0);
  });

  it('reads valued flags in both spellings', () => {
    const a = parseArgs(['x', '--model', 'haiku', '--budget', '1.5']);
    const b = parseArgs(['x', '--model=haiku', '--budget=1.5']);
    for (const p of [a, b]) {
      expect(str(p.flags, 'model')).toBe('haiku');
      expect(num(p.flags, 'budget')).toBe(1.5);
    }
  });

  it('treats an unknown flag as boolean, so --steerable needs no value', () => {
    const p = parseArgs(['x', '--steerable', 'still-positional']);
    expect(bool(p.flags, 'steerable')).toBe(true);
    expect(p.positional).toEqual(['x', 'still-positional']);
  });

  it('stops parsing flags after --, for prompts that start with one', () => {
    const p = parseArgs(['--', '--model', 'is', 'part', 'of', 'the', 'prompt']);
    expect(p.flags.has('model')).toBe(false);
    expect(p.positional.join(' ')).toBe('--model is part of the prompt');
  });

  it('accepts -f as follow, because every log tool does', () => {
    expect(bool(parseArgs(['job1', '-f']).flags, 'follow')).toBe(true);
  });

  it('splits a comma list and drops the blanks', () => {
    expect(list(parseArgs(['--depends-on', 'a, b ,,c']).flags, 'depends-on')).toEqual(['a', 'b', 'c']);
  });

  it('refuses a valued flag with nothing after it', () => {
    expect(() => parseArgs(['x', '--model'])).toThrow(/needs a value/);
  });

  it('refuses a numeric flag that is not a number, rather than sending NaN', () => {
    expect(() => num(parseArgs(['--budget', 'lots']).flags, 'budget')).toThrow(/must be a number/);
  });
});
