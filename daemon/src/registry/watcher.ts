import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EventBus } from '../bus.js';
import type { Store } from '../store/index.js';
import type { SessionRecord, SessionStatus } from '../types.js';
import { linuxProc, type ProcTable } from './proc.js';

/** Where Claude Code publishes one JSON file per live session, named `<pid>.json`. */
export const REGISTRY_DIR = join(homedir(), '.claude', 'sessions');

/**
 * The subset of a registry file we rely on. The real file carries more
 * (`bridgeSessionId`, `peerFeatures`, `nameSource`, `entrypoint`, …) but every
 * extra field we depend on is a field that can break us, so we read narrowly
 * and treat anything missing as "not a session we can use".
 */
interface RegistryFile {
  readonly pid: number;
  readonly sessionId: string;
  readonly procStart: string | number;
  readonly name?: string;
  readonly cwd?: string;
  readonly status?: string;
}

const STATUSES = new Set<string>(['shell', 'idle', 'busy']);

function parse(text: string): RegistryFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // A file being written as we read it is normal, not exceptional: reject the
  // partial record and pick it up on the next sweep.
  if (typeof r['sessionId'] !== 'string' || typeof r['pid'] !== 'number') return null;
  if (typeof r['procStart'] !== 'string' && typeof r['procStart'] !== 'number') return null;
  return {
    pid: r['pid'],
    sessionId: r['sessionId'],
    procStart: r['procStart'] as string | number,
    ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
    ...(typeof r['cwd'] === 'string' ? { cwd: r['cwd'] } : {}),
    ...(typeof r['status'] === 'string' ? { status: r['status'] } : {}),
  };
}

const asStatus = (v: string | undefined): SessionStatus | null =>
  v !== undefined && STATUSES.has(v) ? (v as SessionStatus) : null;

export interface WatcherOptions {
  readonly dir?: string;
  readonly proc?: ProcTable;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

/**
 * Source B of the fleet view (§4.1): the sessions running in the user's own
 * terminals, which we did not spawn and do not control.
 *
 * Two things make this more than a directory listing. First, a registry file
 * outliving its process is normal — a killed session never cleans up — so a
 * file is only evidence of a session when `/proc` agrees the pid is alive AND
 * its start time still matches the file's `procStart` (F18). Without that
 * second half, a recycled pid silently inherits a dead session's identity.
 * Second, we announce a session once rather than on every sweep, because the
 * event log is a history of changes, not a transcript of polling.
 */
export class RegistryWatcher {
  readonly #store: Store;
  readonly #bus: EventBus;
  readonly #dir: string;
  readonly #proc: ProcTable;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  /** sessionIds this watcher has already announced, so `scan` is idempotent. */
  readonly #announced = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(store: Store, bus: EventBus, opts: WatcherOptions = {}) {
    this.#store = store;
    this.#bus = bus;
    this.#dir = opts.dir ?? REGISTRY_DIR;
    this.#proc = opts.proc ?? linuxProc;
    this.#intervalMs = opts.intervalMs ?? 2000;
    this.#now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer) return;
    this.scan();
    this.#timer = setInterval(() => this.scan(), this.#intervalMs);
    // The watcher is a background poller; it must never be the reason the
    // process stays up.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One sweep. Public so tests (and the API) can force one without waiting. */
  scan(): SessionRecord[] {
    const ts = this.#now().toISOString();
    const live: SessionRecord[] = [];

    for (const entry of this.#listFiles()) {
      const file = parse(entry);
      if (!file) continue;
      // Liveness, not existence. Both halves matter: a missing start time means
      // the process is gone, a differing one means the pid was recycled.
      const started = this.#proc.startTime(file.pid);
      if (started === null || started !== String(file.procStart)) continue;

      const known = this.#store.getSession(file.sessionId);
      live.push({
        sessionId: file.sessionId,
        kind: 'observed',
        jobId: known?.jobId ?? null,
        pid: file.pid,
        name: file.name ?? null,
        cwd: file.cwd ?? null,
        alive: true,
        procStart: started,
        status: asStatus(file.status),
        firstSeenAt: known?.firstSeenAt ?? ts,
        lastSeenAt: ts,
      });
    }

    for (const session of live) {
      this.#store.putSession(session);
      if (this.#announced.has(session.sessionId)) continue;
      this.#announced.add(session.sessionId);
      this.#bus.publish({
        jobId: null,
        sessionId: session.sessionId,
        ts,
        source: 'registry',
        type: 'session.registered',
        payload: {
          pid: session.pid,
          name: session.name,
          cwd: session.cwd,
          status: session.status,
        },
      });
    }

    // Scoped to 'observed': this watcher has no view of the sessions we spawned
    // ourselves, and absence from a list you cannot see is not evidence of death.
    for (const sessionId of this.#store.markSessionsGone(
      'observed',
      live.map((s) => s.sessionId),
    )) {
      this.#announced.delete(sessionId);
      this.#bus.publish({
        jobId: null,
        sessionId,
        ts,
        source: 'registry',
        type: 'session.gone',
        payload: { reason: 'registry entry no longer live' },
      });
    }

    return live;
  }

  #listFiles(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      // No registry directory means no observed sessions — a normal state on a
      // box where no interactive session has ever run, not an error.
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(readFileSync(join(this.#dir, name), 'utf8'));
      } catch {
        // Vanished between listing and reading: the session just exited.
      }
    }
    return out;
  }
}
