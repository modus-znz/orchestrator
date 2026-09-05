import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let server: Server;
let body = '';
let seenUrl = '';
let seenAuth = '';

/** A stub daemon: serves one canned SSE body and records what it was asked. */
function listen(): Promise<number> {
  server = createServer((req, res) => {
    seenUrl = req.url ?? '';
    seenAuth = String(req.headers['authorization'] ?? '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orc-cli-'));
  writeFileSync(join(home, 'token'), 'sekrit\n');
  process.env['ORCHESTRATOR_HOME'] = home;
  process.env['ORCHESTRATOR_PORT'] = String(await listen());
});
afterEach(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const frame = (id: number, data: unknown): string => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;

async function collect(from: number): Promise<Array<{ id: number; name: string; data: unknown }>> {
  const { stream } = await import('../src/client.js');
  const got = [];
  for await (const e of stream(from)) got.push(e);
  return got;
}

describe('stream', () => {
  it('sends the bearer token and asks from the given fleet-wide id', async () => {
    body = frame(7, { id: 7, type: 'msg.assistant' });
    await collect(4);
    expect(seenAuth).toBe('Bearer sekrit');
    expect(seenUrl).toBe('/api/stream?from=4');
  });

  it('parses frames split across chunk boundaries', async () => {
    body = frame(1, { id: 1, type: 'a' }) + frame(2, { id: 2, type: 'b' });
    const got = await collect(0);
    expect(got.map((e) => e.id)).toEqual([1, 2]);
  });

  it('skips heartbeat comments without yielding them as events', async () => {
    body = `: ping\n\n${frame(9, { id: 9, type: 'x' })}`;
    const got = await collect(0);
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe(9);
  });

  it('surfaces a gap frame by name, so a follower can say history was dropped', async () => {
    body = `event: gap\ndata: ${JSON.stringify({ from: 1, to: 900 })}\n\n`;
    const got = await collect(0);
    expect(got[0]?.name).toBe('gap');
  });

  it('survives an unparseable frame rather than ending the follow', async () => {
    body = `data: {not json\n\n${frame(3, { id: 3, type: 'ok' })}`;
    const got = await collect(0);
    expect(got.map((e) => e.id)).toEqual([3]);
  });

  it('explains a missing token as a daemon that is not running', async () => {
    rmSync(join(home, 'token'));
    const { NotRunningError } = await import('../src/client.js');
    await expect(collect(0)).rejects.toBeInstanceOf(NotRunningError);
  });
});
