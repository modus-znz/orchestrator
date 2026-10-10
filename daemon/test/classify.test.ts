import { describe, it, expect } from 'vitest';
import { classifyArg } from '../src/learning/classify.js';

describe('classifyArg — Bash', () => {
  it('keeps the command word', () => {
    expect(classifyArg('Bash', { command: 'grep -rn foo src/' })).toBe('grep');
  });

  it('separates multiplexer subcommands so git commit and git log do not collapse', () => {
    expect(classifyArg('Bash', { command: 'git commit -m "x"' })).toBe('git commit');
    expect(classifyArg('Bash', { command: 'git log --oneline -3' })).toBe('git log');
    expect(classifyArg('Bash', { command: 'npm run dev' })).toBe('npm run');
  });

  // The whole no-content guarantee rests on this: a second token is taken only
  // for known multiplexers, so an argument can never become a label.
  it('never takes a second token from a non-multiplexer', () => {
    expect(classifyArg('Bash', { command: 'cat /home/ghost/Desktop/hash.env' })).toBe('cat');
    expect(classifyArg('Bash', { command: 'rm -rf /home/ghost/secrets' })).toBe('rm');
  });

  it('stops at one token when a multiplexer is followed by a flag or a value', () => {
    // `odoo` here is the value of -u, not a verb. Reporting it would leak an
    // account name and would also be wrong.
    expect(classifyArg('Bash', { command: 'sudo -u odoo psql' })).toBe('sudo');
    expect(classifyArg('Bash', { command: 'git -C /home/ghost/private log' })).toBe('git');
  });

  it('unwraps sudo so the wrapped binary is what gets counted', () => {
    expect(classifyArg('Bash', { command: 'sudo systemctl restart odoo' })).toBe('sudo systemctl');
  });

  it('steps over inline env assignments rather than classifying their values', () => {
    const label = classifyArg('Bash', { command: 'ROOT_PWD=hunter2 sudo -S -v' });
    expect(label).toBe('sudo');
    expect(label).not.toContain('hunter2');
  });

  it('steps over a leading cd so the real command is what is recorded', () => {
    expect(classifyArg('Bash', { command: 'cd /home/ghost/orchestrator && git status' })).toBe(
      'git status',
    );
  });

  it('reports cd when cd is genuinely all that ran', () => {
    expect(classifyArg('Bash', { command: 'cd /home/ghost' })).toBe('cd');
  });

  it('reduces an absolute binary path to its basename', () => {
    expect(classifyArg('Bash', { command: '/usr/bin/python3 script.py' })).toBe('python3');
  });

  it('returns null for an empty or whitespace command', () => {
    expect(classifyArg('Bash', { command: '   ' })).toBeNull();
    expect(classifyArg('Bash', {})).toBeNull();
  });
});

describe('classifyArg — file tools', () => {
  it('keeps only the extension, never the path', () => {
    const label = classifyArg('Read', { file_path: '/home/ghost/Desktop/hash.env' });
    expect(label).toBe('.env');
    expect(label).not.toContain('ghost');
  });

  it('takes the last dot so a compound name still classifies', () => {
    expect(classifyArg('Edit', { file_path: 'src/store/index.test.ts' })).toBe('.ts');
  });

  it('treats a dotfile as having no extension, because the dot is its name', () => {
    expect(classifyArg('Read', { file_path: '/home/ghost/.gitignore' })).toBe('(none)');
  });

  it('treats an extensionless file as having no extension', () => {
    expect(classifyArg('Read', { file_path: '/home/ghost/.claude/orchestrator/token' })).toBe(
      '(none)',
    );
  });

  it('rejects an absurdly long extension rather than storing it', () => {
    expect(classifyArg('Write', { file_path: 'x.' + 'a'.repeat(40) })).toBe('(none)');
  });

  it('lowercases so .TS and .ts are one row', () => {
    expect(classifyArg('Write', { file_path: 'A.TS' })).toBe('.ts');
  });

  it('reads the notebook path for NotebookEdit', () => {
    expect(classifyArg('NotebookEdit', { notebook_path: 'a/b.ipynb' })).toBe('.ipynb');
  });
});

describe('classifyArg — identity tools', () => {
  it('keeps the skill name, which is what skill demand counts', () => {
    expect(classifyArg('Skill', { skill: 'superpowers:brainstorming' })).toBe(
      'superpowers:brainstorming',
    );
  });

  it('keeps the subagent type', () => {
    expect(classifyArg('Agent', { subagent_type: 'Explore', prompt: 'secret prompt text' })).toBe(
      'Explore',
    );
  });

  it('classifies tools carrying user content to null rather than guessing', () => {
    expect(classifyArg('Grep', { pattern: 'password=' })).toBeNull();
    expect(classifyArg('WebFetch', { url: 'https://x.test/?token=abc' })).toBeNull();
  });
});

describe('classifyArg — malformed input', () => {
  it('survives input that is not an object', () => {
    expect(classifyArg('Bash', null)).toBeNull();
    expect(classifyArg('Bash', 'a string')).toBeNull();
    expect(classifyArg('Read', 42)).toBeNull();
  });

  it('survives fields of the wrong type', () => {
    expect(classifyArg('Bash', { command: 12345 })).toBeNull();
    expect(classifyArg('Skill', { skill: { nested: true } })).toBeNull();
  });
});
