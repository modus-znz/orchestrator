import type { EventBus } from '../bus.js';
import type { Store } from '../store/index.js';
import type { StoredEvent } from '../types.js';
import type { Ctx } from './http.js';

/** Events read per page while catching a reconnecting client up. */
const REPLAY_PAGE = 500;
/** Total events we will replay before declaring the gap too large to close.
 *  A client away for a day must not be able to make the daemon materialise the
 *  whole history into one socket buffer. */
const REPLAY_MAX = 5_000;
/** Comment frames keep the connection warm and let a dead peer be noticed. */
const HEARTBEAT_MS = 15_000;

/**
 * The live event stream.
 *
 * Clients resume with `Last-Event-ID` (or `?from=`), which carries the
 * fleet-wide `events.id` — not `seq`, which is per session and cannot order the
 * fleet (§5.1).
 */
export class SseHub {
  readonly #bus: EventBus;
  readonly #store: Store;
  #clients = 0;

  constructor(bus: EventBus, store: Store) {
    this.#bus = bus;
    this.#store = store;
  }

  get clientCount(): number {
    return this.#clients;
  }

  handle({ req, res, query }: Ctx): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Harmless here, decisive the moment this sits behind a reverse proxy
      // for Tailscale access: without it the proxy buffers the stream and the
      // dashboard goes silent for minutes at a time.
      'x-accel-buffering': 'no',
    });
    // Small frames written promptly beat batched ones; a dashboard's whole
    // value is that it is current.
    res.socket?.setNoDelay(true);
    req.socket.setTimeout(0);
    this.#clients++;

    const write = (event: StoredEvent): void => {
      // No `event:` field on purpose: every orchestrator event arrives on the
      // default `message` listener with its type inside the JSON, so a client
      // needs one handler rather than one per member of a growing union. The
      // exception below is `gap`, which is deliberately NOT an orchestrator
      // event and must not be mistakable for one.
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Subscribe *before* replaying. Both halves are synchronous today, so
    // nothing can interleave — but the buffer costs nothing and means the
    // correctness of this stream does not depend on that staying true.
    const pending: StoredEvent[] = [];
    let liveFrom: number | null = null;
    const unsubscribe = this.#bus.subscribe((event) => {
      if (liveFrom === null) pending.push(event);
      else if (event.id > liveFrom) write(event);
    });

    let cursor = resumePoint(req.headers['last-event-id'], query.get('from'), this.#store);
    let replayed = 0;
    for (;;) {
      const page = this.#store.eventsSince(cursor, REPLAY_PAGE);
      if (page.length === 0) break;
      for (const event of page) write(event);
      cursor = page[page.length - 1]?.id ?? cursor;
      replayed += page.length;
      if (replayed >= REPLAY_MAX) {
        // Say so rather than truncating quietly: a dashboard that silently
        // skips history draws a chart with a hole in it and no warning.
        const skipTo = this.#store.latestEventId();
        res.write(`event: gap\ndata: ${JSON.stringify({ from: cursor, to: skipTo })}\n\n`);
        cursor = skipTo;
        break;
      }
    }

    for (const event of pending) if (event.id > cursor) write(event);
    liveFrom = cursor;
    pending.length = 0;

    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    beat.unref?.();
    const close = (): void => {
      clearInterval(beat);
      unsubscribe();
      this.#clients--;
    };
    // Both, because a client that vanishes mid-write ends the response without
    // ever closing the request cleanly.
    res.on('close', close);
    res.on('error', close);
  }
}

/**
 * Where to resume from.
 *
 * A client with no cursor gets the *live tail*, not the whole history: an
 * opening dashboard wants what is happening, and the charts fetch their own
 * ranges over REST. Explicit `?from=0` is how a caller asks for everything.
 */
function resumePoint(header: string | string[] | undefined, from: string | null, store: Store): number {
  const raw = typeof header === 'string' ? header : from;
  if (raw === null || raw === undefined || raw === '') return store.latestEventId();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : store.latestEventId();
}
