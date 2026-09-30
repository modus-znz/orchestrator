import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { safeJoin, uiDir } from '../src/api/static.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orc-ui-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<div id=root></div>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('safeJoin', () => {
  it('resolves a normal asset path inside the root', () => {
    expect(safeJoin(root, '/assets/app-abc123.js')).toBe(join(root, 'assets', 'app-abc123.js'));
  });

  // The invariant is *never outside the root* — not *always null*. A leading
  // `..` on an absolute path is neutralised by normalize() rather than
  // rejected, so these resolve to a harmless non-existent path inside the
  // root (which then falls back to index.html). Asserting null here would be
  // asserting an implementation detail and would fail on a correct guard.
  const inside = (p: string | null): boolean => p === null || p === root || p.startsWith(root + sep);

  it('never escapes the root on a literal traversal', () => {
    const got = safeJoin(root, '/../../../etc/passwd');
    expect(inside(got)).toBe(true);
    expect(got).not.toBe('/etc/passwd');
  });

  it('never escapes the root on a percent-encoded traversal', () => {
    // %2e%2e decodes to .. before normalization, so it cannot smuggle past a
    // guard that runs after decoding — which is why decoding comes first.
    const got = safeJoin(root, '/%2e%2e/%2e%2e/etc/passwd');
    expect(inside(got)).toBe(true);
    expect(got).not.toBe('/etc/passwd');
  });

  it('refuses malformed percent-encoding rather than throwing', () => {
    expect(safeJoin(root, '/%zz')).toBeNull();
  });

  it('refuses a NUL byte, which truncates paths in some syscalls', () => {
    expect(safeJoin(root, '/index.html%00.png')).toBeNull();
  });

  it('allows the root itself', () => {
    expect(safeJoin(root, '/')).toBe(root);
  });
});

describe('uiDir', () => {
  it('honours the override, so a dev server build can be served', () => {
    process.env['ORCHESTRATOR_UI_DIR'] = root;
    expect(uiDir()).toBe(resolve(root));
    delete process.env['ORCHESTRATOR_UI_DIR'];
  });

  it('resolves relative to the module, not the daemon working directory', () => {
    // `orc daemon start` spawns the daemon detached from whatever directory
    // the operator was in, so a cwd-relative default would find nothing.
    delete process.env['ORCHESTRATOR_UI_DIR'];
    expect(uiDir().endsWith(join('ui', 'dist'))).toBe(true);
  });
});
