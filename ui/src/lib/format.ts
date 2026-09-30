import type { JobStatus } from './types';

/** Costs are small and the difference between $0.03 and $0.003 matters here. */
export const usd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

export const int = (n: number): string => n.toLocaleString();

export function age(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  return duration(now - Date.parse(iso));
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Elapsed time for a job, whether it is still running or already done. */
export function span(startedAt: string | null, finishedAt: string | null, now = Date.now()): string {
  if (!startedAt) return '—';
  return duration((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt));
}

export const shortId = (id: string): string => id.slice(0, 8);

/** Home-relative, because every cwd on this machine starts the same way. */
export const tidyPath = (p: string | null): string => (p ? p.replace(/^\/home\/[^/]+/, '~') : '—');

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString();

/**
 * One colour vocabulary for job state, used by tables, charts and badges
 * alike — a status that is amber in the table and blue in the chart is a
 * status the operator has to re-learn per view.
 *
 * Two ramps, because contrast is not symmetric: the dark values are tuned
 * against #0b0f17 and turn to pastel fog on white, so light mode takes the
 * 600/700 rungs of the same hues rather than the same hex with a filter.
 */
export const STATUS_COLORS: Record<'light' | 'dark', Record<JobStatus, string>> = {
  dark: {
    queued: '#64748b',
    blocked: '#a855f7',
    running: '#38bdf8',
    succeeded: '#22c55e',
    failed: '#ef4444',
    cancelled: '#94a3b8',
    budget_exceeded: '#f59e0b',
  },
  light: {
    queued: '#475569',
    blocked: '#7e22ce',
    running: '#0284c7',
    succeeded: '#15803d',
    failed: '#dc2626',
    cancelled: '#64748b',
    budget_exceeded: '#b45309',
  },
};

/** Tint classes read through the slate/accent ramp, so both themes are covered
 *  by the ramp inversion in index.css without a second class table. */
export const STATUS_CLASS: Record<JobStatus, string> = {
  queued: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  blocked: 'bg-purple-500/15 text-purple-300 ring-purple-500/30',
  running: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  succeeded: 'bg-green-500/15 text-green-300 ring-green-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/30',
  cancelled: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
  budget_exceeded: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
};

/** Fraction of budget consumed, clamped — a job that overran its ceiling still
 *  renders a full bar rather than one that overflows its track. */
export const burn = (cost: number, budget: number): number =>
  budget > 0 ? Math.min(cost / budget, 1) : 0;

export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Token counts get thousands separators and a k/M suffix past four digits —
 *  "1.2M" reads at a glance where "1204883" has to be counted. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cost with four decimals — for per-turn figures, where usd() would round
 *  three consecutive turns to the same string. */
export const usd4 = (n: number): string => `$${n.toFixed(4)}`;
