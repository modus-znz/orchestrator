import { Link } from 'react-router-dom';
import { useFetch, useNow } from '../lib/hooks';
import { span, tidyPath, usd } from '../lib/format';
import { Empty, ErrorNote, Panel, Scroller, StatusBadge, Tile } from '../components/ui';
import type { JobRecord } from '../lib/types';

const OPEN = new Set(['queued', 'blocked', 'running']);

export function Jobs({ tick }: { tick: number }) {
  const { data, error } = useFetch<{ jobs: JobRecord[] }>('/api/jobs', [tick]);
  const now = useNow();
  const jobs = data?.jobs ?? [];
  const open = jobs.filter((j) => OPEN.has(j.status));
  const spend = jobs.reduce((sum, j) => sum + j.costUsd, 0);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Open" value={open.length} hint="queued, blocked or running" />
        <Tile label="Total jobs" value={jobs.length} />
        <Tile label="Spend" value={usd(spend)} hint="all jobs, all time" />
        <Tile label="Turns" value={jobs.reduce((s, j) => s + j.numTurns, 0)} />
      </div>

      <Panel title="Jobs" subtitle="newest first">
        {jobs.length === 0 ? (
          <Empty>Nothing submitted yet.</Empty>
        ) : (
          <Scroller>
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-edge">
                  <th scope="col" className="px-4 py-2 font-medium">Job</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 font-medium">Model</th>
                  <th scope="col" className="px-4 py-2 font-medium">Cost</th>
                  <th scope="col" className="px-4 py-2 font-medium">Budget</th>
                  <th scope="col" className="px-4 py-2 font-medium">Elapsed</th>
                  <th scope="col" className="px-4 py-2 font-medium">Directory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/60">
                {[...jobs].reverse().map((j) => (
                  <tr key={j.id}>
                    <td className="px-4 py-2">
                      <Link to={`/jobs/${j.id}`} className="text-slate-200 hover:text-sky-300">
                        {j.name ?? j.prompt.slice(0, 40)}
                      </Link>
                      <div className="font-mono text-[11px] text-slate-600">{j.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                    <td className="px-4 py-2 text-slate-400">{j.model}</td>
                    {/* Amber once spend passes 80% of the ceiling: the useful
                        moment is before the kill, not after it. */}
                    <td className={`tnum px-4 py-2 ${j.costUsd >= j.budgetUsd * 0.8 ? 'text-amber-300' : 'text-slate-300'}`}>
                      {usd(j.costUsd)}
                    </td>
                    <td className="tnum px-4 py-2 text-slate-500">{usd(j.budgetUsd)}</td>
                    <td className="tnum px-4 py-2 text-slate-500">{span(j.startedAt, j.finishedAt, now)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">{tidyPath(j.cwd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        )}
      </Panel>
    </div>
  );
}
