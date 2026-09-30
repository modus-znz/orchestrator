import { readFileSync } from 'node:fs';
import { baseUrl, tokenPath } from './paths.js';

/** Thrown for anything the daemon refused, carrying its own explanation. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the daemon is not listening, which is a different fix entirely. */
export class NotRunningError extends Error {}

function token(): string {
  try {
    return readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    throw new NotRunningError(
      `no token at ${tokenPath()} — start the daemon with \`orc daemon start\``,
    );
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token()}`, 'content-type': 'application/json' };
}

/** Read the daemon's own error text rather than inventing one: it knows why. */
async function explain(res: Response): Promise<never> {
  const body = await res.text();
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      message = String((parsed as { error: unknown }).error);
    }
  } catch {
    // Not JSON. The raw text is still the best explanation available.
  }
  throw new ApiError(res.status, message || `HTTP ${res.status}`);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: authHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new NotRunningError(
      `cannot reach the daemon at ${baseUrl()} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) await explain(res);
  return (await res.json()) as T;
}

export interface SseEvent {
  readonly id: number;
  readonly name: string;
  readonly data: unknown;
}

/**
 * Follow `/api/stream` from a fleet-wide event id.
 *
 * `from` is an `events.id`, never a `seq`. A job that is resumed or forked
 * spans several sessionIds and each one's `seq` restarts at zero, so a follower
 * that carried a seq across the boundary would silently skip everything the new
 * session said until it caught back up. `id` is monotonic across the whole
 * fleet and has no such discontinuity.
 */
export async function* stream(from: number, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(`${baseUrl()}/api/stream?from=${from}`, {
    headers: { authorization: `Bearer ${token()}`, accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) await explain(res);
  if (!res.body) throw new Error('stream had no body');

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf('\n\n');
    for (; cut !== -1; cut = buffer.indexOf('\n\n')) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      // Heartbeats are comment frames; they keep the socket warm and mean
      // nothing to a reader.
      if (frame.startsWith(':') || frame.trim() === '') continue;

      let id = 0;
      let name = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length === 0) continue;
      try {
        yield { id, name, data: JSON.parse(data.join('\n')) };
      } catch {
        // A frame we cannot parse is not worth killing a follow session over.
      }
    }
  }
}
