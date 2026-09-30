import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useFetch } from '../lib/hooks';
import { duration, int, shortId, STATUS_COLORS, tokens, usd } from '../lib/format';
import { Empty, ErrorNote, Panel, Scroller } from '../components/ui';
import { CHART } from '../lib/chart';
import { useTheme } from '../lib/theme';
import type {
  ConcurrencyStats, CostStats, FailureStats, JobRecord, JobStatus, QueueStats, ToolStats,
} from '../lib/types';

type Bucket = 'hour' | 'day';

/**
 * Buckets are `substr(ts, 1, 13)` server-side — "2026-09-06T14", which
 * `Date.parse` rejects outright. Reconstructing the window explicitly is what
 * lets a bar link through to the jobs inside it.
 */
/**
 * Recharts' click-handler types describe only the synthetic-event fields and
 * omit `activePayload`, which every cartesian chart actually passes. One
 * narrowing helper is honest about that gap; five inline casts would not be.
 */
function clicked<T>(e: unknown): Partial<T> | undefined {
  const row = (e as { activePayload?: { payload?: unknown }[] } | null | undefined)
    ?.activePayload?.[0]?.payload;
  return (row ?? undefined) as Partial<T> | undefined;
}

function windowOf(bucket: string, kind: Bucket): { from: string; to: string } {
  const from = kind === 'hour' ? `${bucket}:00:00.000Z` : `${bucket}T00:00:00.000Z`;
  const ms = kind === 'hour' ? 3_600_000 : 86_400_000;
  return { from, to: new Date(Date.parse(from) + ms).toISOString() };
}

/**
 * Every series here is fetched from `/api/stats/*` or `/api/jobs`, never
 * reduced out of the event stream in the browser. That is the spec's rule and
 * it has a practical edge: a chart computed from the last N streamed events
 * silently reports on a window rather than on the fleet, and looks right while
 * doing it.
 *
 * Charts are navigation, not decoration: a bar, a slice and a span all link
 * into a filtered Jobs view, because "what is that spike?" is the only
 * question anyone actually asks a spend chart.
 */
export function Graphs({ tick }: { tick: number }) {
  const [bucket, setBucket] = useState<Bucket>('hour');
  const { theme } = useTheme();
  const c = CHART[theme];
  const navigate = useNavigate();

  const cost = useFetch<CostStats>(`/api/stats/cost?bucket=${bucket}`, [tick]);
  const conc = useFetch<ConcurrencyStats>(`/api/stats/concurrency?bucket=${bucket}`, [tick]);
  const queue = useFetch<QueueStats>(`/api/stats/queue?bucket=${bucket}`, [tick]);
  const tools = useFetch<ToolStats>('/api/stats/tools', [tick]);
  const fails = useFetch<FailureStats>('/api/stats/failures', [tick]);
  const jobs = useFetch<{ jobs: JobRecord[] }>('/api/jobs', [tick]);

  const error = cost.error ?? conc.error ?? queue.error ?? tools.error ?? fails.error ?? jobs.error;
  const shortBucket = (b: string): string => (bucket === 'hour' ? `${b.slice(11, 13)}h` : b.slice(5));

  const toWindow = (b: string | undefined): void => {
    if (!b) return;
    const w = windowOf(b, bucket);
    navigate(`/jobs?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`);
  };

  const axis = { stroke: c.axis, fontSize: 11, tickLine: false } as const;
  const grid = <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />;
  const tip = { contentStyle: c.tooltip, labelStyle: c.tooltipLabel, cursor: { fill: c.cursor } } as const;

  const costSeries = cost.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? [];
  const totalSpend = costSeries.reduce((s, r) => s + r.usd, 0);
  const totalTok = costSeries.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bucket</span>
        {(['hour', 'day'] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBucket(b)}
            aria-pressed={bucket === b}
            className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
              bucket === b ? 'bg-slate-500/15 font-semibold text-slate-100' : 'text-slate-500 hover:text-slate-200'
            }`}
          >
            {b}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-500">click any bar, slice or span to filter the jobs behind it</span>
      </div>

      <Gantt jobs={jobs.data?.jobs ?? []} theme={theme} onOpen={(id) => navigate(`/jobs/${id}`)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Spend"
          subtitle={`per ${bucket}`}
          right={<span className="tnum text-xs text-slate-500">{usd(totalSpend)} · {tokens(totalTok)} tok</span>}
        >
          <Chart empty={!costSeries.length}>
            <BarChart data={costSeries} onClick={(e) => toWindow(clicked<{ bucket: string }>(e)?.bucket)}>
              {grid}
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={58} tickFormatter={(v: number) => usd(v)} />
              <Tooltip {...tip} content={<SpendTip theme={theme} />} />
              <Bar dataKey="usd" fill={c.accent} radius={[3, 3, 0, 0]} className="cursor-pointer" />
            </BarChart>
          </Chart>
        </Panel>

        <Panel title="Spend by model" subtitle="tier is where the money is">
          <Chart empty={!cost.data?.byModel.length}>
            <BarChart
              layout="vertical"
              data={[...(cost.data?.byModel ?? [])]}
              onClick={(e) => {
                const m = clicked<{ model: string }>(e)?.model;
                if (m) navigate(`/jobs?model=${encodeURIComponent(String(m))}`);
              }}
            >
              <CartesianGrid stroke={c.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" {...axis} tickFormatter={(v: number) => usd(v)} />
              <YAxis type="category" dataKey="model" {...axis} width={90} />
              <Tooltip
                {...tip}
                formatter={(v, _k, p) => [`${usd(Number(v ?? 0))} over ${int(Number(p?.payload?.turns ?? 0))} turns`, 'spend']}
              />
              <Bar dataKey="usd" fill={c.accentAlt} radius={[0, 3, 3, 0]} className="cursor-pointer" />
            </BarChart>
          </Chart>
        </Panel>

        <Panel title="Queue depth" subtitle="jobs waiting vs running — a persistent gap means maxConcurrency is the limit">
          <Chart empty={!queue.data?.series.length}>
            <LineChart
              data={queue.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? []}
              onClick={(e) => toWindow(clicked<{ bucket: string }>(e)?.bucket)}
            >
              {grid}
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={36} allowDecimals={false} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="stepAfter" dataKey="waiting" stroke={c.warn} dot={false} strokeWidth={2} />
              <Line type="stepAfter" dataKey="running" stroke={c.positive} dot={false} strokeWidth={2} />
            </LineChart>
          </Chart>
        </Panel>

        <Panel title="Active sessions" subtitle={conc.data?.measure ?? 'distinct per bucket'}>
          <Chart empty={!conc.data?.series.length}>
            <LineChart
              data={conc.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? []}
              onClick={(e) => toWindow(clicked<{ bucket: string }>(e)?.bucket)}
            >
              {grid}
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={36} allowDecimals={false} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="sessions" stroke={c.accent} dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="jobs" stroke={c.muted} dot={false} strokeWidth={2} />
            </LineChart>
          </Chart>
        </Panel>

        <StateDistribution jobs={jobs.data?.jobs ?? []} theme={theme} onPick={(s) => navigate(`/jobs?status=${s}`)} />

        <Panel title="Tool calls" subtitle="what the fleet reaches for">
          <Chart empty={!tools.data?.tools.length}>
            <BarChart layout="vertical" data={[...(tools.data?.tools ?? [])].slice(0, 12)}>
              <CartesianGrid stroke={c.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" {...axis} allowDecimals={false} />
              <YAxis type="category" dataKey="tool" {...axis} width={110} />
              <Tooltip {...tip} formatter={(v) => [`${int(Number(v ?? 0))} calls`, 'uses']} />
              <Bar dataKey="uses" fill={c.positive} radius={[0, 3, 3, 0]} />
            </BarChart>
          </Chart>
        </Panel>
      </div>

      <Failures stats={fails.data} onOpen={(id) => navigate(`/jobs/${id}`)} />
    </div>
  );
}

/** Spend needs three numbers at once — money, and the tokens on each side of
 *  it — because "expensive" and "long" are different problems with different
 *  fixes. A default Recharts tooltip shows only the one bar it hit. */
function SpendTip({ theme, active, payload, label }: {
  theme: 'light' | 'dark';
  active?: boolean | undefined;
  payload?: readonly { payload: { usd: number; inputTokens: number; outputTokens: number } }[] | undefined;
  label?: string | undefined;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const c = CHART[theme];
  return (
    <div style={{ ...c.tooltip, padding: '8px 10px' }}>
      <div style={{ ...c.tooltipLabel, marginBottom: 4 }}>{label}</div>
      <div className="tnum" style={{ fontWeight: 700 }}>{usd(row.usd)}</div>
      <div className="tnum" style={{ opacity: 0.75 }}>
        {tokens(row.inputTokens)} in · {tokens(row.outputTokens)} out
      </div>
      <div style={{ opacity: 0.55, marginTop: 4, fontSize: 11 }}>click to see these jobs</div>
    </div>
  );
}

function Chart({ empty, children }: { empty: boolean; children: React.ReactElement }) {
  if (empty) return <Empty>No data in this window yet.</Empty>;
  return (
    <div className="h-56 px-2 py-3">
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

/**
 * Job spans on one timeline.
 *
 * Recharts has no Gantt, so this is a stacked horizontal bar: a transparent
 * `offset` bar positions the visible `length` bar. Both are milliseconds from
 * the first job's start, which keeps the axis honest about gaps — a fleet that
 * idled for an hour should look like it idled for an hour.
 */
function Gantt({ jobs, theme, onOpen }: {
  jobs: readonly JobRecord[];
  theme: 'light' | 'dark';
  onOpen: (id: string) => void;
}) {
  const c = CHART[theme];
  const rows = useMemo(() => {
    const started = jobs.filter((j) => j.startedAt);
    if (!started.length) return [];
    const t0 = Math.min(...started.map((j) => Date.parse(j.startedAt as string)));
    const now = Date.now();
    return started
      .map((j) => {
        const begin = Date.parse(j.startedAt as string);
        const end = j.finishedAt ? Date.parse(j.finishedAt) : now;
        return {
          id: j.id,
          name: j.name ? j.name.slice(0, 18) : shortId(j.id),
          offset: begin - t0,
          length: Math.max(end - begin, 1),
          status: j.status,
          cost: j.costUsd,
          turns: j.numTurns,
        };
      })
      .slice(-25);
  }, [jobs]);

  if (!rows.length) return null;
  return (
    <Panel title="Job spans" subtitle="most recent 25, aligned to the first start">
      <div className="px-2 py-3" style={{ height: Math.max(180, rows.length * 26 + 40) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={rows}
            barCategoryGap={4}
            onClick={(e) => {
              const id = clicked<{ id: string }>(e)?.id;
              if (id) onOpen(String(id));
            }}
          >
            <CartesianGrid stroke={c.grid} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke={c.axis} fontSize={11} tickLine={false} tickFormatter={(v: number) => duration(v)} />
            <YAxis type="category" dataKey="name" stroke={c.axis} fontSize={11} width={130} tickLine={false} />
            <Tooltip
              cursor={{ fill: c.cursor }}
              content={({ active, payload }) => {
                const r = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                if (!active || !r) return null;
                return (
                  <div style={{ ...c.tooltip, padding: '8px 10px' }}>
                    <div style={{ ...c.tooltipLabel, marginBottom: 4 }}>{r.name}</div>
                    <div className="tnum">{duration(r.length)} · {usd(r.cost)} · {r.turns} turns</div>
                    <div style={{ opacity: 0.55, marginTop: 4, fontSize: 11 }}>{r.status.replace('_', ' ')} — click to open</div>
                  </div>
                );
              }}
            />
            <Bar dataKey="offset" stackId="s" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="length" stackId="s" radius={[3, 3, 3, 3]} isAnimationActive={false} className="cursor-pointer">
              {rows.map((r) => (
                <Cell key={r.id} fill={STATUS_COLORS[theme][r.status]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function StateDistribution({ jobs, theme, onPick }: {
  jobs: readonly JobRecord[];
  theme: 'light' | 'dark';
  onPick: (s: JobStatus) => void;
}) {
  const c = CHART[theme];
  const data = useMemo(() => {
    const counts = new Map<JobStatus, number>();
    for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, value]) => ({ status, value }));
  }, [jobs]);

  return (
    <Panel title="State distribution" subtitle={`${jobs.length} jobs · click a slice to filter`}>
      <Chart empty={!data.length}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="status"
            innerRadius={44}
            outerRadius={72}
            paddingAngle={2}
            onClick={(d) => {
              // A slice carries the row it was built from; the Pie types insist on
              // their own sector shape, so the row is read back explicitly.
              const s = clicked<{ status: JobStatus }>({ activePayload: [{ payload: d }] })?.status;
              if (s) onPick(s);
            }}
            className="cursor-pointer"
          >
            {data.map((d) => (
              <Cell key={d.status} fill={STATUS_COLORS[theme][d.status]} stroke={c.tooltip.background as string} strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip contentStyle={c.tooltip} labelStyle={c.tooltipLabel} formatter={(v, n) => [`${int(Number(v ?? 0))} jobs`, String(n).replace('_', ' ')]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </Chart>
    </Panel>
  );
}

function Failures({ stats, onOpen }: { stats: FailureStats | null; onOpen: (id: string) => void }) {
  if (!stats) return null;
  return (
    <Panel title="Failure taxonomy" subtitle="what went wrong, and to which job">
      {stats.recent.length === 0 ? (
        <Empty>Nothing has failed yet.</Empty>
      ) : (
        <Scroller>
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-edge">
                <th scope="col" className="px-4 py-2 font-medium">Job</th>
                <th scope="col" className="px-4 py-2 font-medium">Finished</th>
                <th scope="col" className="px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {stats.recent.map((f) => (
                <tr
                  key={f.id}
                  onClick={() => onOpen(f.id)}
                  className="cursor-pointer transition-colors hover:bg-slate-500/8"
                >
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-slate-300">{f.name || shortId(f.id)}</td>
                  <td className="tnum px-4 py-2 text-xs text-slate-500">{f.finishedAt?.slice(11, 19) ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-red-400">{f.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}
      <div className="flex flex-wrap gap-2 border-t border-edge px-4 py-3">
        {stats.byStatus.map((s) => (
          <span key={s.status} className="rounded bg-slate-500/10 px-2 py-1 text-xs text-slate-300">
            {s.status.replace('_', ' ')} <span className="tnum font-semibold text-slate-500">{s.count}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}
