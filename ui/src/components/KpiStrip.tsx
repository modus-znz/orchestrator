import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../lib/hooks';
import { duration, tokens, usd } from '../lib/format';
import type { CostStats, FleetResponse, Health, JobRecord, Settings } from '../lib/types';

const OPEN = new Set(['queued', 'blocked']);

/**
 * The six numbers an operator would otherwise assemble by flipping between
 * three views. Sticky under the nav, so they survive navigation.
 *
 * It fetches its own data rather than taking it from the views. On loopback,
 * against a store this size, four extra GETs per tick is free — and the
 * alternative (lifting every fetch into the shell and threading it down) makes
 * every view depend on the strip's shape for no measurable gain.
 */
export function KpiStrip({ tick }: { tick: number }) {
  const nav = useNavigate();
  const jobs = useFetch<{ jobs: JobRecord[] }>('/api/jobs', [tick]);
  const fleet = useFetch<FleetResponse>('/api/fleet', [tick]);
  const health = useFetch<Health>('/api/health', [tick]);
  const cost = useFetch<CostStats>('/api/stats/cost?bucket=hour', [tick]);
  const settings = useFetch<Settings>('/api/settings', []);

  const rows = jobs.data?.jobs ?? [];
  const sessions = fleet.data?.sessions ?? [];

  const m = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const series = cost.data?.series ?? [];
    const spendToday = series
      .filter((r) => r.bucket.slice(0, 10) === today)
      .reduce((s, r) => s + r.usd, 0);

    // The current hour's spend *is* the burn rate — a rate derived from an
    // all-time average would read low all through a busy hour, which is
    // exactly when someone is looking at it.
    const hour = new Date().toISOString().slice(0, 13);
    const burnNow = series.find((r) => r.bucket.slice(0, 13) === hour)?.usd ?? 0;
    const tok = series.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

    return {
      spendToday,
      burnNow,
      tok,
      queued: rows.filter((j) => OPEN.has(j.status)).length,
      live: sessions.filter((s) => s.alive).length,
    };
  }, [cost.data, rows, sessions]);

  const running = health.data?.running ?? 0;
  const cap = settings.data?.maxConcurrency ?? 0;
  const saturated = cap > 0 && running >= cap;

  return (
    <div className="border-b border-edge bg-ink/95 backdrop-blur">
      <dl className="mx-auto flex max-w-7xl gap-x-6 gap-y-2 overflow-x-auto px-3 py-2 sm:px-5">
        <Kpi label="Spend today" value={usd(m.spendToday)} sub={`${usd(m.burnNow)}/h now`} />
        <Kpi
          label="Running"
          value={cap ? `${running}/${cap}` : String(running)}
          sub={saturated ? 'at capacity' : 'of maxConcurrency'}
          tone={saturated ? 'warn' : running > 0 ? 'live' : 'idle'}
        />
        <Kpi
          label="Waiting"
          value={String(m.queued)}
          sub="queued or blocked"
          tone={m.queued > 0 ? 'warn' : 'idle'}
          onClick={m.queued > 0 ? () => nav('/jobs?status=queued') : undefined}
        />
        <Kpi label="Fleet" value={`${m.live}/${sessions.length}`} sub="live sessions" onClick={() => nav('/')} />
        <Kpi label="Tokens" value={tokens(m.tok)} sub="in + out, all buckets" />
        <Kpi label="Daemon" value={duration(health.data?.uptimeMs ?? 0)} sub={`pid ${health.data?.pid ?? '—'}`} />
      </dl>
    </div>
  );
}

function Kpi({ label, value, sub, tone = 'idle', onClick }: {
  label: string;
  value: string;
  sub: string;
  tone?: 'idle' | 'live' | 'warn' | undefined;
  onClick?: (() => void) | undefined;
}) {
  const TONE = { idle: 'text-slate-200', live: 'text-sky-400', warn: 'text-amber-300' } as const;
  const body = (
    <>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`tnum text-sm font-semibold leading-tight ${TONE[tone]}`}>{value}</dd>
      <dd className="text-[10px] leading-tight text-slate-500">{sub}</dd>
    </>
  );
  if (!onClick) return <div className="shrink-0">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded text-left transition-opacity hover:opacity-70"
    >
      {body}
    </button>
  );
}
