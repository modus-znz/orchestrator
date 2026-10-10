import { readFileSync } from 'node:fs';
import { ApiServer } from './api/index.js';
import { EventBus } from './bus.js';
import { acquireLock } from './lock.js';
import { Courier } from './courier/index.js';
import { paths } from './paths.js';
import { reconcile } from './reconcile.js';
import { RegistryWatcher } from './registry/watcher.js';
import { ChildRunner } from './runner/child.js';
import { mergePrices, type ModelPrice } from './runner/pricing.js';
import { Scheduler } from './scheduler/index.js';
import { Store } from './store/index.js';

const DEFAULT_PORT = 4317;
/** How often the scheduler looks for work it can start. */
const TICK_MS = 1_000;

/**
 * Literal strings that must never appear in an event payload, one per line.
 *
 * Read from disk on every start rather than stored, because the point of the
 * file is that an operator can add a secret to it and restart — and a copy
 * living in the database would be a second place for that secret to leak from.
 */
function loadRedactPatterns(): string[] {
  try {
    return readFileSync(paths.redactList, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Operator overrides for the price table, one entry per model key.
 *
 * Read from disk at start for the same reason as the redact list, and left out
 * of the settings API for a stronger one: these numbers drive the mid-run
 * budget kill in `child.ts`, so a client that could write them could set every
 * rate to a rounding error and switch budget enforcement off across the fleet.
 * That is a gate, and a gate a caller can open with one request is not one.
 *
 * A malformed file is rejected whole rather than row by row. Half-applying a
 * typo would leave the table in a state nobody wrote down, and the failure mode
 * of a price table that is quietly wrong is a job that runs past its budget.
 */
function loadPriceOverrides(): Record<string, ModelPrice> {
  let raw: string;
  try {
    raw = readFileSync(paths.prices, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of model key to price');
    }
    const out: Record<string, ModelPrice> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = value as Partial<ModelPrice> | null;
      const input = row?.inputPerMTok;
      const output = row?.outputPerMTok;
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (!ok(input) || !ok(output)) {
        throw new Error(`row "${key}" needs numeric inputPerMTok and outputPerMTok >= 0`);
      }
      out[key] = { inputPerMTok: input, outputPerMTok: output };
    }
    return out;
  } catch (e) {
    // Loud, because the fallback is a table the operator has already decided is
    // wrong — staying silent here is how a stale rate survives a restart that
    // was meant to fix it.
    console.warn(`[orchestrator] ignoring ${paths.prices}: ${(e as Error).message}`);
    return {};
  }
}

export interface Daemon {
  readonly port: number;
  /** Jobs settled at startup from a previous unclean shutdown. */
  readonly reconciled: { vanished: string[]; orphaned: string[] };
  readonly stop: () => Promise<void>;
}

export async function startDaemon(port = DEFAULT_PORT): Promise<Daemon> {
  // First, before anything opens a database or replays a log: a second daemon
  // on this home would duplicate every scheduled job and settle jobs the first
  // one still owns, and it would do it without producing a single error.
  const lock = acquireLock(paths.lock);
  const store = new Store();
  const bus = new EventBus(store);

  // The environment is authoritative for both of these on every start, not
  // just the first: a flag that persists in the database after the operator
  // stopped passing it is a gate that quietly stayed open.
  store.putSettings({
    allowBypassPermissions: process.env['ORCHESTRATOR_ALLOW_BYPASS'] === '1',
    redactPatterns: loadRedactPatterns(),
  });

  const runner = new ChildRunner(bus, { prices: mergePrices(loadPriceOverrides()) });
  const scheduler = new Scheduler(store, bus, runner);
  const courier = new Courier(bus);
  const watcher = new RegistryWatcher(store, bus, { isEphemeral: courier.isEphemeral });
  const api = new ApiServer({ store, bus, scheduler, courier, watcher });

  // Before anything can schedule: a previous daemon that was killed rather
  // than stopped left `running` rows behind, and those rows count against
  // maxConcurrency. Settling them is the difference between a restart that
  // works and one that quietly never starts another job.
  const settled = reconcile(store, bus);

  watcher.start();
  const ticker = setInterval(() => scheduler.tick(), TICK_MS);
  ticker.unref?.();

  let bound: number;
  try {
    bound = await api.listen(port);
  } catch (e) {
    // The commonest way to get here is a port already in use, which is very
    // often a daemon on a DIFFERENT home. Holding the lock on the way out
    // would make that transient collision look like a permanently wedged home
    // for the next start, and the operator would be told to delete a lock file
    // that never had a live daemon behind it.
    clearInterval(ticker);
    watcher.stop();
    store.close();
    lock.release();
    throw e;
  }

  let stopping: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    // Shutdown races: a signal handler and a normal exit can both arrive, and
    // draining twice would cancel jobs the first drain already reported on.
    stopping ??= (async () => {
      clearInterval(ticker);
      watcher.stop();
      await api.close();
      await scheduler.drain();
      store.close();
      lock.release();
    })();
    return stopping;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }

  return { port: bound, reconciled: settled, stop };
}

// Only when run directly, so importing the daemon in a test does not start one.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['ORCHESTRATOR_PORT'] ?? DEFAULT_PORT);
  startDaemon(Number.isFinite(port) ? port : DEFAULT_PORT)
    .then(({ port: bound, reconciled }) => {
      process.stdout.write(`orchestratord listening on http://127.0.0.1:${bound}\n`);
      process.stdout.write(`token: ${paths.token}\n`);
      const stale = reconciled.vanished.length + reconciled.orphaned.length;
      if (stale > 0) {
        process.stdout.write(
          `settled ${stale} job(s) from an unclean shutdown ` +
            `(${reconciled.orphaned.length} still running, terminated)\n`,
        );
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`orchestratord failed to start: ${String(err)}\n`);
      process.exit(1);
    });
}
