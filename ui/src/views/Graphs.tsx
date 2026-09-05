import { useMemo, useState } from 'react';
import {
  Bar, BarChart, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useFetch } from '../lib/hooks';
import { duration, shortId, STATUS_COLOR, usd } from '../lib/format';
import { Empty, ErrorNote, Panel, Scroller } from '../components/ui';
import { TOOLTIP } from '../lib/chart';
import type {
  ConcurrencyStats, CostStats, FailureStats, JobRecord, JobStatus, QueueStats, ToolStats,
} from '../lib/types';

type Bucket = 'hour' | 'day';

/**
 * Every series here is fetched from `/api/stats/*` or `/api/jobs`, never
 * reduced out of the event stream in the browser. That is the spec's rule and
 * it has a practical edge: a chart computed from the last N streamed events
 * silently reports on a window rather than on the fleet, and looks right while
 * doing it.
 */
export function Graphs({ tick }: { tick: number }) {
  const [bucket, setBucket] = useState<Bucket>('hour');
  const cost = useFetch<CostStats>(`/api/stats/cost?bucket=${bucket}`, [tick]);
  const conc = useFetch<ConcurrencyStats>(`/api/stats/concurrency?bucket=${bucket}`, [tick]);
  const queue = useFetch<QueueStats>(`/api/stats/queue?bucket=${bucket}`, [tick]);
  const tools = useFetch<ToolStats>('/api/stats/tools', [tick]);
  const fails = useFetch<FailureStats>('/api/stats/failures', [tick]);
  const jobs = useFetch<{ jobs: JobRecord[] }>('/api/jobs', [tick]);

  const error = cost.error ?? conc.error ?? queue.error ?? tools.error ?? fails.error ?? jobs.error;
  const shortBucket = (b: string): string => (bucket === 'hour' ? b.slice(11, 13) + 'h' : b.slice(5));

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-slate-500">Bucket</span>
        {(['hour', 'day'] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBucket(b)}
            aria-pressed={bucket === b}
            className={`rounded-lg px-2.5 py-1 text-xs ${
              bucket === b ? 'bg-slate-700/60 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {b}
          </button>
        ))}
      </div>

      <Gantt jobs={jobs.data?.jobs ?? []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Spend" subtitle={`per ${bucket}`}>
          <Chart empty={!cost.data?.series.length}>
            <BarChart data={cost.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? []}>
              <XAxis dataKey="label" stroke="#475569" fontSize={11} tickLine={false} />
              <YAxis stroke="#475569" fontSize={11} tickLine={false} width={56} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v) => usd(Number(v ?? 0))} />
              <Bar dataKey="usd" fill="#38bdf8" radius={[3, 3, 0, 0]} />
            </BarChart>
          </Chart>
        </Panel>

        <Panel title="Spend by model" subtitle="tier is where the money is">
          <Chart empty={!cost.data?.byModel.length}>
            <BarChart layout="vertical" data={[...(cost.data?.byModel ?? [])]}>
              <XAxis type="number" stroke="#475569" fontSize={11} tickLine={false} />
              <YAxis type="category" dataKey="model" stroke="#475569" fontSize={11} width={90} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v) => usd(Number(v ?? 0))} />
              <Bar dataKey="usd" fill="#a855f7" radius={[0, 3, 3, 0]} />
            </BarChart>
          </Chart>
        </Panel>

        <Panel title="Queue depth" subtitle="jobs waiting vs running">
          <Chart empty={!queue.data?.series.length}>
            <LineChart data={queue.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? []}>
              <XAxis dataKey="label" stroke="#475569" fontSize={11} tickLine={false} />
              <YAxis stroke="#475569" fontSize={11} tickLine={false} width={36} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="stepAfter" dataKey="waiting" stroke="#f59e0b" dot={false} strokeWidth={2} />
              <Line type="stepAfter" dataKey="running" stroke="#22c55e" dot={false} strokeWidth={2} />
            </LineChart>
          </Chart>
        </Panel>

        <Panel title="Active sessions" subtitle={conc.data?.measure ?? 'distinct per bucket'}>
          <Chart empty={!conc.data?.series.length}>
            <LineChart data={conc.data?.series.map((r) => ({ ...r, label: shortBucket(r.bucket) })) ?? []}>
              <XAxis dataKey="label" stroke="#475569" fontSize={11} tickLine={false} />
              <YAxis stroke="#475569" fontSize={11} tickLine={false} width={36} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="sessions" stroke="#38bdf8" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="jobs" stroke="#64748b" dot={false} strokeWidth={2} />
            </LineChart>
          </Chart>
        </Panel>

        <StateDistribution jobs={jobs.data?.jobs ?? []} />

        <Panel title="Tool calls" subtitle="what the fleet reaches for">
          <Chart empty={!tools.data?.tools.length}>
            <BarChart layout="vertical" data={[...(tools.data?.tools ?? [])].slice(0, 12)}>
              <XAxis type="number" stroke="#475569" fontSize={11} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="tool" stroke="#475569" fontSize={11} width={110} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="uses" fill="#22c55e" radius={[0, 3, 3, 0]} />
            </BarChart>
          </Chart>
        </Panel>
      </div>

      <Failures stats={fails.data} />
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
function Gantt({ jobs }: { jobs: readonly JobRecord[] }) {
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
          name: j.name ? j.name.slice(0, 18) : shortId(j.id),
          offset: begin - t0,
          length: Math.max(end - begin, 1),
          status: j.status,
        };
      })
      .slice(-25);
  }, [jobs]);

  if (!rows.length) return null;
  return (
    <Panel title="Job spans" subtitle="most recent 25, aligned to the first start">
      <div className="px-2 py-3" style={{ height: Math.max(180, rows.length * 26 + 40) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={rows} barCategoryGap={4}>
            <XAxis type="number" stroke="#475569" fontSize={11} tickLine={false} tickFormatter={(v: number) => duration(v)} />
            <YAxis type="category" dataKey="name" stroke="#475569" fontSize={11} width={130} tickLine={false} />
            <Tooltip
              contentStyle={TOOLTIP}
              formatter={(v, key) => (key === 'length' ? duration(Number(v ?? 0)) : null)}
            />
            <Bar dataKey="offset" stackId="s" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="length" stackId="s" radius={[3, 3, 3, 3]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.name} fill={STATUS_COLOR[r.status]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function StateDistribution({ jobs }: { jobs: readonly JobRecord[] }) {
  const data = useMemo(() => {
    const counts = new Map<JobStatus, number>();
    for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, value]) => ({ status, value }));
  }, [jobs]);

  return (
    <Panel title="State distribution" subtitle={`${jobs.length} jobs`}>
      <Chart empty={!data.length}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="status" innerRadius={44} outerRadius={72} paddingAngle={2}>
            {data.map((d) => (
              <Cell key={d.status} fill={STATUS_COLOR[d.status]} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </Chart>
    </Panel>
  );
}

function Failures({ stats }: { stats: FailureStats | null }) {
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
            <tbody className="divide-y divide-edge/60">
              {stats.recent.map((f) => (
                <tr key={f.id}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-300">{f.name || shortId(f.id)}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{f.finishedAt?.slice(11, 19) ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-red-300">{f.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}
      <div className="flex flex-wrap gap-2 border-t border-edge px-4 py-3">
        {stats.byStatus.map((s) => (
          <span key={s.status} className="rounded bg-slate-700/40 px-2 py-1 text-xs text-slate-300">
            {s.status} <span className="tnum text-slate-500">{s.count}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}
