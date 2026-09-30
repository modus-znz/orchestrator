import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request body large enough to be a mistake or an attack, never a job. */
export const MAX_BODY_BYTES = 1_000_000;

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const badRequest = (m: string): HttpError => new HttpError(400, m);
export const notFound = (m: string): HttpError => new HttpError(404, m);
export const conflict = (m: string): HttpError => new HttpError(409, m);
/** A gate said no. Distinct from 401: the caller authenticated fine, the
 *  *action* is refused — which is the normal outcome of the steer policy. */
export const forbidden = (m: string): HttpError => new HttpError(403, m);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The API answers with data the operator's browser will render; sniffing
    // it as anything else is never useful and occasionally exploitable.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Read and parse a JSON body, refusing anything oversized.
 *
 * The cap is enforced as bytes arrive rather than after buffering, because a
 * limit you check at the end is a limit that has already been exceeded in
 * memory.
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw badRequest(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

interface Route {
  readonly method: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
}

/**
 * A router small enough to read in one sitting.
 *
 * Express would do this and more, but the daemon ships with zero runtime
 * dependencies on purpose (§5): it spawns Claude sessions with the operator's
 * credentials, and every transitive dependency is something that can change
 * under it without a decision being made here.
 */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        keys.push(seg.slice(1));
        // A path segment: anything but a slash, so a sessionId containing odd
        // characters still routes rather than 404-ing confusingly.
        return '([^/]+)';
      })
      .join('/');
    this.#routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    let pathExists = false;
    for (const route of this.#routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { handler: route.handler, params };
    }
    // A known path with the wrong verb is a 405, not a 404: telling the caller
    // "no such thing" when the thing exists sends them debugging the wrong end.
    if (pathExists) throw new HttpError(405, `${method} not allowed on ${path}`);
    return null;
  }
}
