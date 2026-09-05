import { redact } from './redact.js';
import type { Store } from './store/index.js';
import type { OrchestratorEvent, UnsequencedEvent } from './types.js';

export type Subscriber = (event: OrchestratorEvent) => void;

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

  publish(event: UnsequencedEvent): OrchestratorEvent {
    const literals = this.#store.getSettings().redactPatterns;
    const full: OrchestratorEvent = {
      ...event,
      // Redaction happens before persistence and before fan-out, so no
      // subscriber can ever observe an unredacted payload (§4.4).
      payload: redact(event.payload, literals),
      seq: this.#store.nextSeq(event.sessionId),
    };
    this.#store.appendEvent(full);
    for (const sub of this.#subs) {
      try {
        sub(full);
      } catch {
        // A misbehaving SSE client must not be able to stop ingest.
      }
    }
    return full;
  }

  subscribe(sub: Subscriber): () => void {
    this.#subs.add(sub);
    return () => this.#subs.delete(sub);
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }
}
