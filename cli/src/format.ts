/** Terminal output helpers. No colour library: three escape codes is not a dep. */
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

/** Respect NO_COLOR and a redirected stdout — a piped table should be plain. */
const styled = (): boolean => process.stdout.isTTY === true && !process.env['NO_COLOR'];

export const dim = (s: string): string => (styled() ? `${DIM}${s}${RESET}` : s);
export const bold = (s: string): string => (styled() ? `${BOLD}${s}${RESET}` : s);

export function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function age(iso: string | null): string {
  if (!iso) return '-';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Left-aligned columns sized to their contents. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [dim(line(headers)), ...rows.map(line)].join('\n');
}
