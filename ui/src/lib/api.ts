import type { StoredEvent } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let token: string | null = null;
export const setToken = (t: string | null): void => {
  token = t;
};

const authHeaders = (): HeadersInit =>
  token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    // The daemon answers errors as {error}. Surfacing its own words beats a
    // generic "request failed" — it is the component that knows what went wrong.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface SseFrame {
  readonly id: number;
  readonly name: string;
  readonly data: unknown;
}

/**
 * Follow `/api/stream` with `fetch`, not `EventSource`.
 *
 * `EventSource` cannot set an `Authorization` header. The usual workaround is
 * `?token=`, which writes the credential into the request line that the daemon
 * — and any proxy ever put in front of it — logs. A streamed `fetch` carries a
 * real header, at the cost of hand-rolling reconnection: about fifteen lines,
 * and the `Last-Event-ID` resume was needed either way.
 *
 * `from` is a fleet-wide `events.id`, never a per-session `seq`: a job that
 * resumes or forks spans several sessionIds and each one's seq restarts at 0,
 * so a follower carrying a seq across that boundary silently skips everything
 * the new session says until it catches back up.
 */
export async function* streamEvents(from: number, signal: AbortSignal): AsyncGenerator<SseFrame> {
  const res = await fetch(`/api/stream?from=${from}`, { headers: authHeaders(), signal });
  if (!res.ok) throw new ApiError(res.status, `stream failed: ${res.status}`);
  if (!res.body) throw new ApiError(500, 'stream carried no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; a chunk boundary lands anywhere,
    // so the tail always stays in the buffer until its terminator arrives.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
      split = buffer.indexOf('\n\n');
    }
  }
}

function parseFrame(frame: string): SseFrame | null {
  let id = 0;
  let name = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat comment
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { id, name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    // A frame we cannot parse is one event lost, not a reason to drop the
    // connection and lose every event after it.
    return null;
  }
}

export const isEvent = (frame: SseFrame): frame is SseFrame & { data: StoredEvent } =>
  frame.name === 'message' && typeof frame.data === 'object' && frame.data !== null && 'type' in frame.data;
