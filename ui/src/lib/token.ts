const KEY = 'orchestrator.token';

/**
 * Where the bearer comes from, in priority order.
 *
 * `orc ui` opens `http://127.0.0.1:4317/#token=<hex>`. A URL *fragment* is
 * never sent to the server, so it appears in no access log and in no proxy
 * we might one day put in front of this — unlike a query string, which is
 * logged by essentially everything. We read it once, persist it, and strip it
 * from the address bar so a screenshot of the dashboard is not a credential.
 */
export function loadToken(): string | null {
  const fromHash = readHash();
  if (fromHash) {
    try {
      localStorage.setItem(KEY, fromHash);
    } catch {
      // Private mode or blocked storage: the token still works for this page
      // load, it just will not survive a refresh. Better than refusing to run.
    }
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(KEY, token.trim());
  } catch {
    /* see above */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
}

function readHash(): string | null {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const value = new URLSearchParams(hash).get('token');
  return value && value.trim() ? value.trim() : null;
}
