import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxProc, type ProcTable } from '../src/registry/proc.js';
import type { SessionRecord } from '../src/types.js';

let home: string;
let Store: typeof import('../src/store/index.js').Store;
let EventBus: typeof import('../src/bus.js').EventBus;
let RegistryWatcher: typeof import('../src/registry/watcher.js').RegistryWatcher;

/** A /proc that only knows the pids a test decides are alive. */
class FakeProc implements ProcTable {
  readonly live = new Map<number, string>();
  startTime(pid: number): string | null {
    return this.live.get(pid) ?? null;
  }
}

interface FileOpts {
  readonly name?: string;
  readonly cwd?: string;
  readonly status?: string;
  readonly procStart?: string | number;
}

describe('linuxProc', () => {
  it('reads a start time for a process that is certainly alive', () => {
    const own = linuxProc.startTime(process.pid);
    expect(own).toMatch(/^\d+$/);
  });

  it('is stable across calls, because start time is fixed for a process', () => {
    expect(linuxProc.startTime(process.pid)).toBe(linuxProc.startTime(process.pid));
  });

  it('returns null rather than throwing for a pid that cannot exist', () => {
    expect(linuxProc.startTime(0x7fffffff)).toBeNull();
  });
});

describe('RegistryWatcher', () => {
  let dir: string;
  let store: InstanceType<typeof Store>;
  let bus: InstanceType<typeof EventBus>;
  let proc: FakeProc;
  let watcher: InstanceType<typeof RegistryWatcher>;
  let seen: { type: string; sessionId: string }[];

  const write = (pid: number, sessionId: string, o: FileOpts = {}): void => {
    const procStart = o.procStart ?? '111';
    proc.live.set(pid, String(procStart));
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        procStart,
        name: o.name ?? `ghost-${pid}`,
        cwd: o.cwd ?? '/home/ghost',
        status: o.status ?? 'idle',
        kind: 'interactive',
        version: 1,
      }),
    );
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'orch-scratch-'));
    process.env['ORCHESTRATOR_HOME'] = home;
    ({ Store } = await import('../src/store/index.js'));
    ({ EventBus } = await import('../src/bus.js'));
    ({ RegistryWatcher } = await import('../src/registry/watcher.js'));
    dir = join(home, 'sessions');
    mkdirSync(dir, { recursive: true });
    store = new Store(join(home, 'orchestrator.db'));
    bus = new EventBus(store);
    seen = [];
    bus.subscribe((e) => seen.push({ type: e.type, sessionId: e.sessionId }));
    proc = new FakeProc();
    watcher = new RegistryWatcher(store, bus, { dir, proc });
  });
  afterEach(() => {
    watcher.stop();
    store.close();
    Store.destroyScratch(home);
    rmSync(home, { recursive: true, force: true });
  });

  it('takes identity from the registry file rather than inventing one', () => {
    write(4242, 'aaaaaaaa-0000-0000-0000-000000000001', { name: 'ghost-71', cwd: '/srv/app' });
    const [row] = watcher.scan();
    expect(row?.sessionId).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect(row?.name).toBe('ghost-71');
    expect(row?.cwd).toBe('/srv/app');
    expect(row?.kind).toBe('observed');
  });

  it('carries the coarse status through, since every interactive session has one', () => {
    write(4242, 'sess-busy', { status: 'busy' });
    expect(watcher.scan()[0]?.status).toBe('busy');
  });

  it('records an unrecognised status as unknown instead of passing it through', () => {
    write(4242, 'sess-weird', { status: 'transcendent' });
    expect(watcher.scan()[0]?.status).toBeNull();
  });

  it('ignores a stale registry file whose process is gone', () => {
    write(4242, 'sess-dead');
    proc.live.delete(4242);
    expect(watcher.scan()).toHaveLength(0);
  });

  it('treats a recycled pid as not being the session in the file', () => {
    write(4242, 'sess-old', { procStart: '111' });
    expect(watcher.scan()).toHaveLength(1);
    // Same pid, different process: the file is a leftover and must not match.
    proc.live.set(4242, '999');
    expect(watcher.scan()).toHaveLength(0);
  });

  it('announces a session once, not on every sweep', () => {
    write(4242, 'sess-a');
    watcher.scan();
    watcher.scan();
    watcher.scan();
    expect(seen.filter((e) => e.type === 'session.registered')).toHaveLength(1);
  });

  it('emits session.gone exactly once when a session exits', () => {
    write(4242, 'sess-a');
    watcher.scan();
    rmSync(join(dir, '4242.json'));
    proc.live.delete(4242);
    watcher.scan();
    watcher.scan();
    const gone = seen.filter((e) => e.type === 'session.gone');
    expect(gone).toHaveLength(1);
    expect(gone[0]?.sessionId).toBe('sess-a');
    expect(store.getSession('sess-a')?.alive).toBe(false);
  });

  it('preserves firstSeenAt across sweeps while advancing lastSeenAt', () => {
    let clock = new Date('2026-09-05T10:00:00.000Z');
    watcher = new RegistryWatcher(store, bus, { dir, proc, now: () => clock });
    write(4242, 'sess-a');
    watcher.scan();
    clock = new Date('2026-09-05T10:05:00.000Z');
    const [row] = watcher.scan();
    expect(row?.firstSeenAt).toBe('2026-09-05T10:00:00.000Z');
    expect(row?.lastSeenAt).toBe('2026-09-05T10:05:00.000Z');
  });

  it('never retires a managed session it cannot see', () => {
    const managed: SessionRecord = {
      sessionId: 'sess-managed',
      kind: 'managed',
      jobId: 'job-1',
      pid: 9999,
      name: null,
      cwd: '/tmp',
      alive: true,
      procStart: null,
      status: null,
      firstSeenAt: '2026-09-05T09:00:00.000Z',
      lastSeenAt: '2026-09-05T09:00:00.000Z',
    };
    store.putSession(managed);
    write(4242, 'sess-observed');
    watcher.scan();
    expect(store.getSession('sess-managed')?.alive).toBe(true);
    expect(seen.some((e) => e.sessionId === 'sess-managed')).toBe(false);
  });

  it('skips a half-written file instead of crashing the sweep', () => {
    writeFileSync(join(dir, '1.json'), '{"pid":1,"sessionId":');
    write(4242, 'sess-good');
    expect(watcher.scan().map((s) => s.sessionId)).toEqual(['sess-good']);
  });

  it('skips a file that parses but carries no session id', () => {
    proc.live.set(7, '111');
    writeFileSync(join(dir, '7.json'), JSON.stringify({ pid: 7, procStart: '111' }));
    expect(watcher.scan()).toHaveLength(0);
  });

  it('survives a missing registry directory', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(() => watcher.scan()).not.toThrow();
    expect(watcher.scan()).toHaveLength(0);
  });

  it('re-announces a session whose pid comes back after exiting', () => {
    write(4242, 'sess-a');
    watcher.scan();
    rmSync(join(dir, '4242.json'));
    proc.live.delete(4242);
    watcher.scan();
    write(4242, 'sess-a', { procStart: '222' });
    watcher.scan();
    expect(seen.filter((e) => e.type === 'session.registered')).toHaveLength(2);
    expect(store.getSession('sess-a')?.alive).toBe(true);
  });
});
