import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamParser, LineSplitter } from '../src/runner/stream.js';
import { estimateUsd, priceKeyFor } from '../src/runner/pricing.js';
import type { UnsequencedEvent } from '../src/types.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'stream-haiku.jsonl'),
  'utf8',
);

function parseAll(): UnsequencedEvent[] {
  const parser = new StreamParser('job-1', 'pre-minted-uuid');
  return FIXTURE.split('\n').flatMap((l) => parser.parseLine(l));
}

describe('StreamParser (against a real captured stream)', () => {
  it('survives the non-JSON warning line the CLI emits first', () => {
    const events = parseAll();
    const raw = events.find(
      (e) => e.type === 'raw' && (e.payload as { parsed?: boolean }).parsed === false,
    );
    expect(raw).toBeDefined();
    expect((raw?.payload as { text: string }).text).toContain('no stdin data received');
  });

  it('adopts the session id reported by the stream over the pre-minted one', () => {
    const parser = new StreamParser('job-1', 'pre-minted-uuid');
    FIXTURE.split('\n').forEach((l) => parser.parseLine(l));
    expect(parser.sessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('emits job.started from system/init with the CLI version', () => {
    const started = parseAll().filter((e) => e.type === 'job.started');
    expect(started).toHaveLength(1);
    expect((started[0]?.payload as { cliVersion: string }).cliVersion).toBe('2.1.261');
  });

  it('bills each message id exactly once, though it arrives as several events', () => {
    const events = parseAll();
    const costs = events.filter((e) => e.type === 'cost.turn');
    const ids = costs.map((e) => (e.payload as { messageId: string }).messageId);
    // The real stream repeats a message id across a thinking event and a
    // tool_use event; naive summing would double-count it.
    expect(new Set(ids).size).toBe(ids.length);
    expect(costs.length).toBeGreaterThan(0);
  });

  it('extracts tool use and tool results', () => {
    const events = parseAll();
    const use = events.find((e) => e.type === 'tool.use');
    const result = events.find((e) => e.type === 'tool.result');
    expect((use?.payload as { name: string }).name).toBe('Bash');
    expect((result?.payload as { isError: boolean }).isError).toBe(false);
  });

  it('closes with an authoritative cost that supersedes the estimates', () => {
    const events = parseAll();
    const done = events.find((e) => e.type === 'job.finished');
    expect(done).toBeDefined();
    const cost = (done?.payload as { costUsd: number }).costUsd;
    expect(cost).toBeGreaterThan(0);
    expect((done?.payload as { exitCode: number }).exitCode).toBe(0);
  });

  it('never logs thinking blocks', () => {
    expect(JSON.stringify(parseAll())).not.toContain('"thinking"');
  });

  it('records an unknown event type instead of dropping or throwing', () => {
    const parser = new StreamParser('job-1', 'sid');
    const out = parser.parseLine('{"type":"some_future_event","session_id":"sid","x":1}');
    expect(out[0]?.type).toBe('raw');
  });

  it('reports a failed result as job.failed', () => {
    const parser = new StreamParser('job-1', 'sid');
    const out = parser.parseLine(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sid","result":"boom"}',
    );
    expect(out[0]?.type).toBe('job.failed');
    expect((out[0]?.payload as { error: string }).error).toBe('boom');
  });
});

describe('pricing', () => {
  it('maps wire model ids onto price rows', () => {
    expect(priceKeyFor('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(priceKeyFor('claude-opus-5')).toBe('opus');
    expect(priceKeyFor(undefined)).toBe('unknown');
  });

  it('prices an unknown model as the most expensive one, so it kills early', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(estimateUsd('some-new-model', usage)).toBe(estimateUsd('claude-opus-5', usage));
  });

  it('charges cache writes above and cache reads below plain input', () => {
    const write = estimateUsd('haiku', { cache_creation_input_tokens: 1_000_000 });
    const read = estimateUsd('haiku', { cache_read_input_tokens: 1_000_000 });
    const plain = estimateUsd('haiku', { input_tokens: 1_000_000 });
    expect(write).toBeGreaterThan(plain);
    expect(read).toBeLessThan(plain);
  });
});

describe('LineSplitter', () => {
  it('reassembles a line split across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push('{"a"')).toEqual([]);
    expect(s.push(':1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
  });
});
