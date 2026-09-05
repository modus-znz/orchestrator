import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobRecord, OrchestratorEvent } from '../src/types.js';

let home: string;
let bin: string;
let Store: typeof import('../src/store/index.js').Store;
let EventBus: typeof import('../src/bus.js').EventBus;
let ChildRunner: typeof import('../src/runner/child.js').ChildRunner;
let buildArgs: typeof import('../src/runner/child.js').buildArgs;

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'j1', name: 'j1', prompt: 'hello', cwd: tmpdir(), model: 'haiku',
  budgetUsd: 1, timeoutMs: 20_000, permissionMode: 'default', dependsOn: [],
  steerable: false, status: 'queued', sessionId: null, createdAt: new Date().toISOString(),
  startedAt: null, finishedAt: null, costUsd: 0, numTurns: 0, exitCode: null,
  error: null, cliVersion: null, ...over,
});

/** Write an executable stand-in for the `claude` binary. */
function fakeBin(body: string): string {
  const path = join(home, `fake-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const RESULT_OK = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: 'from-stream',
  total_cost_usd: 0.0317, num_turns: 1, duration_ms: 6582, result: 'OK',
});

/** One assistant turn priced high enough to blow a small budget. */
const bigTurn = (id: string): string =>
  JSON.stringify({
    type: 'assistant', session_id: 'from-stream',
    message: { id, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 200_000, output_tokens: 100_000 } },
  });

describe('buildArgs', () => {
  beforeEach(async () => {
    ({ buildArgs } = await import('../src/runner/child.js'));
  });

  it('always passes --verbose, which stream-json requires alongside -p', () => {
    const args = buildArgs(job(), 'sid-1');
    expect(args).toContain('--verbose');
    const i = args.indexOf('--output-format');
    expect(args[i + 1]).toBe('stream-json');
  });

  it('pins the pre-minted session id so the join exists before the process does', () => {
    const args = buildArgs(job(), 'sid-1');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sid-1');
  });

  it('omits --allowed-tools entirely when no tools are requested', () => {
    expect(buildArgs(job(), 'sid-1')).not.toContain('--allowed-tools');
    expect(buildArgs(job({ allowedTools: [] }), 'sid-1')).not.toContain('--allowed-tools');
  });

  it('joins allowed tools with commas', () => {
    const args = buildArgs(job({ allowedTools: ['Read', 'Bash'] }), 'sid-1');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Bash');
  });

  it('leaves partial messages off by default and on only when asked', () => {
    expect(buildArgs(job(), 'sid-1')).not.toContain('--include-partial-messages');
    expect(buildArgs(job(), 'sid-1', { includePartialMessages: true }))
      .toContain('--include-partial-messages');
  });

  it('passes the prompt as one argv entry, never shell-interpolated', () => {
    const nasty = 'fix $(rm -rf /) `whoami` "quoted"';
    const args = buildArgs(job({ prompt: nasty }), 'sid-1');
    expect(args[args.indexOf('-p') + 1]).toBe(nasty);
  });
});

describe('ChildRunner', () => {
  let store: InstanceType<typeof Store>;
  let bus: InstanceType<typeof EventBus>;
  let seen: OrchestratorEvent[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'orc-child-'));
    process.env['ORCHESTRATOR_HOME'] = home;
    ({ Store } = await import('../src/store/index.js'));
    ({ EventBus } = await import('../src/bus.js'));
    ({ ChildRunner } = await import('../src/runner/child.js'));
    store = new Store();
    bus = new EventBus(store);
    seen = [];
    bus.subscribe((e) => seen.push(e));
  });

  afterEach(() => {
    store.close();
    delete process.env['ORCHESTRATOR_HOME'];
  });

  const types = (): string[] => seen.map((e) => e.type);
  const closing = (): OrchestratorEvent | undefined =>
    [...seen].reverse().find((e) => (e.payload as { final?: boolean })?.final === true);

  it('reports success and adopts the stream-reported session id', async () => {
    bin = fakeBin(`echo '${RESULT_OK}'`);
    const out = await new ChildRunner(bus, { claudeBin: bin }).start(job()).done;
    expect(out.status).toBe('succeeded');
    expect(out.sessionId).toBe('from-stream');
    expect(out.costUsd).toBeCloseTo(0.0317, 4);
    expect(types()).toContain('job.finished');
  });

  it('still publishes a closing event when the child dies without a result', async () => {
    // The failure mode the runner's "always publish" branch exists for: a
    // child killed mid-stream leaves no terminal `result` line behind.
    bin = fakeBin(`echo '{"type":"system","subtype":"init","session_id":"from-stream"}'\necho 'Warning: no stdin data received in 3s'\nexit 1`);
    const out = await new ChildRunner(bus, { claudeBin: bin }).start(job()).done;
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);
    const final = closing();
    expect(final).toBeDefined();
    expect(final?.type).toBe('job.failed');
    // Estimated, because no authoritative total_cost_usd ever arrived (F13).
    expect((final?.payload as { estimated: boolean }).estimated).toBe(true);
  });

  it('survives a non-JSON line instead of dying on it (F12)', async () => {
    bin = fakeBin(`echo 'Warning: no stdin data received in 3s'\necho '${RESULT_OK}'`);
    const out = await new ChildRunner(bus, { claudeBin: bin }).start(job()).done;
    expect(out.status).toBe('succeeded');
    expect(seen.some((e) => e.type === 'raw' && (e.payload as { parsed?: boolean }).parsed === false)).toBe(true);
  });

  it('kills the child when the running estimate breaches the budget', async () => {
    bin = fakeBin(`echo '${bigTurn('msg_1')}'\nexec sleep 30\necho '${RESULT_OK}'`);
    const out = await new ChildRunner(bus, { claudeBin: bin, killGraceMs: 200 })
      .start(job({ budgetUsd: 0.01 })).done;
    expect(out.status).toBe('budget_exceeded');
    expect(types()).toContain('job.budget_exceeded');
  }, 20_000);

  it('does not double-bill repeated assistant events sharing one message id (F14)', async () => {
    // One API response arrives as several assistant events with identical
    // usage; billing each would inflate the estimate and kill jobs early.
    bin = fakeBin(`echo '${bigTurn('msg_1')}'\necho '${bigTurn('msg_1')}'\necho '${RESULT_OK}'`);
    const out = await new ChildRunner(bus, { claudeBin: bin }).start(job({ budgetUsd: 100 })).done;
    expect(out.status).toBe('succeeded');
    expect(seen.filter((e) => e.type === 'cost.turn')).toHaveLength(1);
  });

  it('cancels a running child and reports the reason', async () => {
    bin = fakeBin(`echo '{"type":"system","subtype":"init","session_id":"from-stream"}'\nexec sleep 30`);
    const handle = new ChildRunner(bus, { claudeBin: bin, killGraceMs: 200 }).start(job());
    await new Promise((r) => setTimeout(r, 300));
    handle.cancel('operator cancelled');
    const out = await handle.done;
    expect(out.status).toBe('cancelled');
    expect(out.error).toBe('operator cancelled');
    expect(closing()?.type).toBe('job.cancelled');
  }, 20_000);

  it('enforces the timeout and does not leave the job open', async () => {
    bin = fakeBin(`exec sleep 30`);
    const out = await new ChildRunner(bus, { claudeBin: bin, killGraceMs: 200 })
      .start(job({ timeoutMs: 300 })).done;
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/timeout/);
    expect(closing()).toBeDefined();
  }, 20_000);

  it('fails cleanly when the binary does not exist', async () => {
    const out = await new ChildRunner(bus, { claudeBin: join(home, 'nope') }).start(job()).done;
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/ENOENT/);
    expect(closing()).toBeDefined();
  });

  it('forwards stderr as raw events without letting it settle the job', async () => {
    bin = fakeBin(`echo 'some warning' >&2\necho '${RESULT_OK}'`);
    const out = await new ChildRunner(bus, { claudeBin: bin }).start(job()).done;
    expect(out.status).toBe('succeeded');
    expect(seen.some((e) => (e.payload as { stderr?: string })?.stderr === 'some warning')).toBe(true);
  });
});
