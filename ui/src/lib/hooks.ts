import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, isEvent, streamEvents } from './api';
import type { StoredEvent } from './types';

export interface Fetched<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * A one-shot GET with a manual reload.
 *
 * Deliberately not TanStack Query: there is exactly one live data source here
 * (the event stream) and a handful of GETs beside it. A cache-invalidation
 * layer would be more machinery than the thing it manages, and SSE-driven
 * freshness does not map onto a staleness model built around polling.
 */
export function useFetch<T>(path: string, deps: readonly unknown[] = []): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      // The flag, not an AbortController: aborting would also cancel a request
      // whose result a remounted component still wants under StrictMode.
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export type StreamState = 'connecting' | 'live' | 'retrying' | 'error';

export interface LiveEvents {
  readonly events: readonly StoredEvent[];
  readonly state: StreamState;
  readonly lastId: number;
  readonly error: string | null;
}

/**
 * Follow the fleet-wide stream, keeping at most `cap` events in memory.
 *
 * `filter` is applied at ingest so a job view holds only its own events; the
 * connection stays fleet-wide because that is the only stream the daemon
 * offers and the only cursor that survives a resume or fork.
 */
export function useEventStream(opts: {
  from: number | null;
  cap?: number;
  filter?: (e: StoredEvent) => boolean;
}): LiveEvents {
  const { from, cap = 1000, filter } = opts;
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(0);

  // Held in a ref so a changing filter identity never tears down the
  // connection — reconnecting on every render would drop events and bill a
  // resume query for nothing.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (from === null) return;
    lastId.current = from;
    const controller = new AbortController();
    let stopped = false;
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          setState(attempt === 0 ? 'connecting' : 'retrying');
          for await (const frame of streamEvents(lastId.current, controller.signal)) {
            setState('live');
            attempt = 0;
            if (frame.id > lastId.current) lastId.current = frame.id;
            if (!isEvent(frame)) continue;
            const event = frame.data;
            if (filterRef.current && !filterRef.current(event)) continue;
            setEvents((prev) => {
              const next = prev.concat(event);
              return next.length > cap ? next.slice(next.length - cap) : next;
            });
          }
        } catch (e: unknown) {
          if (stopped || controller.signal.aborted) return;
          setError(e instanceof ApiError ? e.message : String(e));
          if (e instanceof ApiError && e.status === 401) {
            // A bad token will not fix itself by retrying, and hammering the
            // daemon with rejected requests hides the real problem.
            setState('error');
            return;
          }
        }
        if (stopped) return;
        // Backoff caps at 5s: this is loopback, so a long backoff is all
        // downside — but a tight loop against a dead daemon is worse.
        const delay = Math.min(5000, 250 * 2 ** attempt++);
        setState('retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    };
    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [from, cap]);

  return { events, state, lastId: lastId.current, error };
}

/** A ticking clock, so "age" columns move without a refetch. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
