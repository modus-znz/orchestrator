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
    const stored: StoredEvent = { ...full, id: this.#store.appendEvent(full) };
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
}
