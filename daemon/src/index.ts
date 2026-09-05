import { readFileSync } from 'node:fs';
import { ApiServer } from './api/index.js';
import { EventBus } from './bus.js';
import { Courier } from './courier/index.js';
import { paths } from './paths.js';
import { RegistryWatcher } from './registry/watcher.js';
import { ChildRunner } from './runner/child.js';
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

export interface Daemon {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

export async function startDaemon(port = DEFAULT_PORT): Promise<Daemon> {
  const store = new Store();
  const bus = new EventBus(store);

  // The environment is authoritative for both of these on every start, not
  // just the first: a flag that persists in the database after the operator
  // stopped passing it is a gate that quietly stayed open.
  store.putSettings({
    allowBypassPermissions: process.env['ORCHESTRATOR_ALLOW_BYPASS'] === '1',
    redactPatterns: loadRedactPatterns(),
  });

  const runner = new ChildRunner(bus);
  const scheduler = new Scheduler(store, bus, runner);
  const courier = new Courier(bus);
  const watcher = new RegistryWatcher(store, bus, { isEphemeral: courier.isEphemeral });
  const api = new ApiServer({ store, bus, scheduler, courier, watcher });

  watcher.start();
  const ticker = setInterval(() => scheduler.tick(), TICK_MS);
  ticker.unref?.();
  const bound = await api.listen(port);

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
    })();
    return stopping;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }

  return { port: bound, stop };
}

// Only when run directly, so importing the daemon in a test does not start one.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['ORCHESTRATOR_PORT'] ?? DEFAULT_PORT);
  startDaemon(Number.isFinite(port) ? port : DEFAULT_PORT)
    .then(({ port: bound }) => {
      process.stdout.write(`orchestratord listening on http://127.0.0.1:${bound}\n`);
      process.stdout.write(`token: ${paths.token}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`orchestratord failed to start: ${String(err)}\n`);
      process.exit(1);
    });
}
