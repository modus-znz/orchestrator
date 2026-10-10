import { redact } from './redact.js';
import type { Store } from './store/index.js';
import type { OrchestratorEvent, StoredEvent, UnsequencedEvent } from './types.js';

export type Subscriber = (event: StoredEvent) => void;

/**
 * The single ingest path. Everything — spawned children, the registry watcher,
 * steer results — publishes here, and here is the only place that assigns
 * sequence numbers, redacts, and persists. One writer, so ordering is a
 * property of the system rather than a hope.
 */
export class EventBus {
  readonly #store: Store;
  readonly #subs = new Set<Subscriber>();
  #failures = 0;
  #lastError: string | null = null;

  constructor(store: Store) {
    this.#store = store;
  }

  publish(event: UnsequencedEvent): StoredEvent {
    // Shutdown drains before it closes, so this is a race and not the normal
    // path — but a child that settles a millisecond late must not take the
    // process down with it. There is genuinely nowhere to record this: the
    // JSONL log closed with the store.
    if (this.#store.closed) return { ...event, seq: -1, id: 0 };
    const literals = this.#store.getSettings().redactPatterns;
    const full: OrchestratorEvent = {
      ...event,
      // Redaction happens before persistence and before fan-out, so no
      // subscriber can ever observe an unredacted payload (§4.4).
      payload: redact(event.payload, literals),
      seq: this.#store.nextSeq(event.sessionId),
    };
    // The projection assigns the fleet-wide id, so subscribers are handed the
    // stored event rather than the one we built: an SSE client needs the id it
    // can later resume from, not the one we hoped it would get.
    //
    // Guarded, because most callers are in no position to handle a throw. A
    // child's stdout 'data' handler and the registry watcher's setInterval are
    // both bare EventEmitter callbacks with nothing above them, so a full disk
    // reaching this line would not fail one job — it would be an uncaught
    // exception taking down every running child, the scheduler and the API in
    // one go. Losing one event is survivable; losing the fleet is not. The
    // failure is counted and surfaced rather than swallowed, and fan-out still
    // happens so a live dashboard shows the event that could not be stored.
    let id = 0;
    try {
      id = this.#store.appendEvent(full);
    } catch (e) {
      this.#failures += 1;
      this.#lastError = e instanceof Error ? e.message : String(e);
    }
    const stored: StoredEvent = { ...full, id };
    for (const sub of this.#subs) {
      try {
        sub(stored);
      } catch {
        // A misbehaving SSE client must not be able to stop ingest.
      }
    }
    return stored;
  }

  subscribe(sub: Subscriber): () => void {
    this.#subs.add(sub);
    return () => this.#subs.delete(sub);
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }

  /**
   * Events that reached the bus but could not be persisted.
   *
   * Non-zero means the projection and the JSONL log have diverged and the run
   * is no longer fully reconstructible — worth showing an operator loudly,
   * which is why /api/health carries it rather than only the daemon log.
   */
  get storeFailures(): { count: number; lastError: string | null } {
    return { count: this.#failures, lastError: this.#lastError };
  }
}
