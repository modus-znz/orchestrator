import { createReadStream, statSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

/**
 * Where the built web UI lives.
 *
 * Resolved from this module's own location rather than `process.cwd()`, because
 * the daemon is started detached by `orc daemon start` and inherits whatever
 * directory the operator happened to be in.
 */
export function uiDir(): string {
  const override = process.env['ORCHESTRATOR_UI_DIR'];
  if (override !== undefined && override !== '') return resolve(override);
  // dist/api/static.js -> dist/api -> dist -> daemon -> <repo>
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'ui', 'dist');
}

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
]);

const typeOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES.get(path.slice(dot))) ?? 'application/octet-stream';
};

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * The guard is a prefix test on the *resolved* path, not a scan for `..` in the
 * URL: `%2e%2e` and the many other spellings all collapse during resolution, so
 * checking after resolving is the only version that cannot be spelled around.
 */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // Malformed percent-encoding: not a path we own.
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(root, '.' + normalize(decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Everything Vite fingerprints lives here, so it can be cached forever. */
const HASHED = /\/assets\//;

/**
 * Serve the built UI, falling back to `index.html` for client-side routes.
 *
 * Returns false when there is nothing to serve — no build on disk — so the
 * caller can answer with something more useful than a bare 404.
 */
export function serveStatic(root: string, urlPath: string, res: ServerResponse, method = 'GET'): boolean {
  const index = join(root, 'index.html');
  if (!isFile(index)) return false;

  const direct = safeJoin(root, urlPath);
  // A deep link like /jobs/abc123 is a route, not a file: the SPA resolves it
  // in the browser, so unknown paths get index.html rather than a 404. Paths
  // that escaped the root fall here too, which is the safe direction.
  const target = direct !== null && isFile(direct) ? direct : index;

  const immutable = target !== index && HASHED.test(urlPath);
  res.writeHead(200, {
    'content-type': typeOf(target),
    'content-length': statSync(target).size,
    'x-content-type-options': 'nosniff',
    // index.html carries the app's entry hashes, so caching it is how a
    // rebuilt UI keeps serving the previous build until someone hard-reloads.
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}
