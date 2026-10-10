import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/bus.js';
import type { Store } from '../src/store/index.js';
import type { StoredEvent, UnsequencedEvent } from '../src/types.js';

let home: string;
let store: Store;
let StoreCtor: typeof import('../src/store/index.js').Store;

const ev = (over: Partial<UnsequencedEvent> = {}): UnsequencedEvent => ({
  jobId: 'job-1', sessionId: 'sess-a', ts: '2026-09-06T00:00:01.000Z',
  source: 'child', type: 'msg.assistant', payload: { text: 'hi' }, ...over,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orch-bus-'));
  process.env['ORCHESTRATOR_HOME'] = home;
  ({ Store: StoreCtor } = await import('../src/store/index.js'));
  store = new StoreCtor(join(home, 'orchestrator.db'));
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe('EventBus', () => {
  it('assigns sequence numbers in order for one session', () => {
    const bus = new EventBus(store);
    const seqs = [bus.publish(ev()), bus.publish(ev()), bus.publish(ev())].map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(bus.storeFailures.count).toBe(0);
  });

  it('survives a store that cannot persist, and says so', () => {
    // The realistic shape of this is ENOSPC inside the JSONL append, reached
    // from a child's stdout handler where there is no try/catch above us. If
    // publish() rethrows there, one full disk takes down every running job.
    const bus = new EventBus(store);
    const seen: StoredEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(ev({ payload: { text: 'before' } }));

    const original = store.appendEvent.bind(store);
    let failing = true;
    // reason: replacing one method on a concrete class for a fault-injection
    // test; a full Store double would assert nothing about the real one.
    (store as unknown as { appendEvent: Store['appendEvent'] }).appendEvent = ((e) => {
      if (failing) throw new Error('ENOSPC: no space left on device');
      return original(e);
    }) as Store['appendEvent'];

    expect(() => bus.publish(ev({ payload: { text: 'during' } }))).not.toThrow();
    expect(bus.storeFailures.count).toBe(1);
    expect(bus.storeFailures.lastError).toContain('ENOSPC');

    failing = false;
    const after = bus.publish(ev({ payload: { text: 'after' } }));
    expect(after.id).toBeGreaterThan(0);
    expect(bus.storeFailures.count).toBe(1);

    // Fan-out still ran for the event that could not be stored, so a live
    // dashboard shows it rather than going quiet at the worst moment.
    expect(seen.map((e) => (e.payload as { text: string }).text))
      .toEqual(['before', 'during', 'after']);
  });

  it('does not let one bad subscriber stop the others', () => {
    const bus = new EventBus(store);
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error('rude client'); });
    bus.subscribe(() => seen.push('ok'));
    bus.publish(ev());
    expect(seen).toEqual(['ok']);
  });
});
