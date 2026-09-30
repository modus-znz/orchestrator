import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useFetch, useNow } from '../lib/hooks';
import { clock, duration, span, tidyPath, usd } from '../lib/format';
import {
  BurnBar, Chip, Empty, ErrorNote, Panel, Scroller, Select, SortHeader,
  StatusBadge, TextInput, Tile, Toolbar,
} from '../components/ui';
import type { JobRecord, JobStatus } from '../lib/types';

const OPEN = new Set<JobStatus>(['queued', 'blocked', 'running']);
const STATUSES: JobStatus[] = ['queued', 'blocked', 'running', 'succeeded', 'failed', 'cancelled', 'budget_exceeded'];

type SortKey = 'name' | 'status' | 'model' | 'cost' | 'elapsed' | 'turns' | 'created';

/**
 * Filters live in the URL, not in component state.
 *
 * That is what lets a bar in Graphs link here — "show me the jobs in that
 * hour" is a link, not a cross-view message bus — and it means a filtered
 * view survives a reload and can be pasted to someone else.
 */
export function Jobs({ tick }: { tick: number }) {
  const { data, error } = useFetch<{ jobs: JobRecord[] }>('/api/jobs', [tick]);
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'created', dir: 'desc' });
  const [openRow, setOpenRow] = useState<string | null>(null);
  const now = useNow();

  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? '') as JobStatus | '';
  const model = params.get('model') ?? '';
  const from = params.get('from');
  const to = params.get('to');

  const set = (k: string, v: string): void => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const clearAll = (): void => setParams(new URLSearchParams(), { replace: true });

  const jobs = data?.jobs ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return jobs.filter((j) => {
      if (status && j.status !== status) return false;
      if (model && j.model !== model) return false;
      if (from || to) {
        // createdAt, not startedAt: a job that never started still belongs to
        // the window in which someone asked for it.
        const t = Date.parse(j.createdAt);
        if (from && t < Date.parse(from)) return false;
        if (to && t >= Date.parse(to)) return false;
      }
      if (!needle) return true;
      return (
        (j.name ?? '').toLowerCase().includes(needle) ||
        j.prompt.toLowerCase().includes(needle) ||
        j.cwd.toLowerCase().includes(needle) ||
        j.id.toLowerCase().includes(needle) ||
        (j.error ?? '').toLowerCase().includes(needle)
      );
    });
  }, [jobs, q, status, model, from, to]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const elapsed = (j: JobRecord): number =>
      j.startedAt ? (j.finishedAt ? Date.parse(j.finishedAt) : now) - Date.parse(j.startedAt) : -1;
    const val = (j: JobRecord): string | number => {
      switch (sort.key) {
        case 'name': return (j.name ?? j.prompt).toLowerCase();
        case 'status': return j.status;
        case 'model': return j.model;
        case 'cost': return j.costUsd;
        case 'turns': return j.numTurns;
        case 'elapsed': return elapsed(j);
        case 'created': return Date.parse(j.createdAt);
      }
    };
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return 0;
      return (x < y ? -1 : 1) * dir;
    });
  }, [filtered, sort, now]);

  const onSort = (key: SortKey): void =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'model' ? 'asc' : 'desc' }));

  const open = filtered.filter((j) => OPEN.has(j.status));
  const spend = filtered.reduce((s, j) => s + j.costUsd, 0);
  const turns = filtered.reduce((s, j) => s + j.numTurns, 0);
  const models = [...new Set(jobs.map((j) => j.model))];
  const filtering = !!(q || status || model || from || to);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* The tiles are filters, not decoration — clicking "Open" is the fastest
          way to answer "what is still in flight?". */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Open"
          value={open.length}
          hint="queued, blocked or running"
          tone={open.length > 0 ? 'live' : 'default'}
          active={status === 'running'}
          onClick={() => set('status', status === 'running' ? '' : 'running')}
        />
        <Tile label={filtering ? 'Matching' : 'Total jobs'} value={filtered.length} hint={filtering ? `of ${jobs.length}` : undefined} />
        <Tile label="Spend" value={usd(spend)} hint={filtering ? 'matching jobs' : 'all jobs, all time'} />
        <Tile label="Turns" value={turns} hint={turns ? `${usd(spend / Math.max(turns, 1))} per turn` : undefined} />
      </div>

      <Panel
        title="Jobs"
        subtitle={`${sorted.length} shown · click a row for detail`}
        right={<span className="text-[11px] text-slate-500">press / to search</span>}
      >
        <Toolbar>
          <TextInput label="Search jobs" value={q} onChange={(v) => set('q', v)} placeholder="name, prompt, path, error…" />
          <Select
            label="Filter by status"
            value={status}
            onChange={(v) => set('status', v)}
            options={[{ value: '' as JobStatus | '', label: 'any status' }, ...STATUSES.map((s) => ({ value: s as JobStatus | '', label: s.replace('_', ' ') }))]}
          />
          <Select
            label="Filter by model"
            value={model}
            onChange={(v) => set('model', v)}
            options={[{ value: '', label: 'any model' }, ...models.map((m) => ({ value: m, label: m }))]}
          />
          {from && (
            <Chip onClear={() => { const n = new URLSearchParams(params); n.delete('from'); n.delete('to'); setParams(n, { replace: true }); }}>
              window {clock(from)}{to ? ` – ${clock(to)}` : ''}
            </Chip>
          )}
          {filtering && (
            <button type="button" onClick={clearAll} className="ml-auto text-xs text-slate-500 hover:text-red-400">
              clear all
            </button>
          )}
        </Toolbar>

        {sorted.length === 0 ? (
          <Empty>
            {jobs.length === 0
              ? <>Nothing submitted yet. Start one with <code className="font-mono">orc run</code>.</>
              : 'No job matches those filters.'}
          </Empty>
        ) : (
          <Scroller>
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-edge">
                  <SortHeader label="Job" field={'name' as SortKey} sort={sort} onSort={onSort} />
                  <SortHeader label="Status" field={'status' as SortKey} sort={sort} onSort={onSort} />
                  <SortHeader label="Model" field={'model' as SortKey} sort={sort} onSort={onSort} />
                  <SortHeader label="Cost" field={'cost' as SortKey} sort={sort} onSort={onSort} align="right" />
                  <th scope="col" className="px-4 py-2 text-left font-medium">Budget</th>
                  <SortHeader label="Turns" field={'turns' as SortKey} sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Elapsed" field={'elapsed' as SortKey} sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Created" field={'created' as SortKey} sort={sort} onSort={onSort} />
                  <th scope="col" className="px-4 py-2 text-left font-medium">Directory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {sorted.map((j) => (
                  <Fragment key={j.id}>
                    <tr
                      onClick={() => setOpenRow((o) => (o === j.id ? null : j.id))}
                      aria-expanded={openRow === j.id}
                      className={`cursor-pointer transition-colors hover:bg-slate-500/8 ${openRow === j.id ? 'bg-slate-500/10' : ''}`}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <span aria-hidden className={`text-[10px] text-slate-500 transition-transform ${openRow === j.id ? 'rotate-90' : ''}`}>▶</span>
                          <span className="font-semibold text-slate-200">{j.name ?? j.prompt.slice(0, 44)}</span>
                        </div>
                        <div className="ml-4 font-mono text-[11px] text-slate-600">{j.id.slice(0, 8)}</div>
                      </td>
                      <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                      <td className="px-4 py-2 text-slate-400">{j.model}</td>
                      {/* Amber once spend passes 80% of the ceiling: the useful
                          moment is before the kill, not after it. */}
                      <td className={`tnum px-4 py-2 text-right ${j.costUsd >= j.budgetUsd * 0.8 ? 'text-amber-300' : 'text-slate-300'}`}>
                        {usd(j.costUsd)}
                      </td>
                      <td className="px-4 py-2"><BurnBar cost={j.costUsd} budget={j.budgetUsd} /></td>
                      <td className="tnum px-4 py-2 text-right text-slate-400">{j.numTurns || '—'}</td>
                      <td className="tnum px-4 py-2 text-right text-slate-400">{span(j.startedAt, j.finishedAt, now)}</td>
                      <td className="tnum px-4 py-2 text-slate-500">{clock(j.createdAt)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{tidyPath(j.cwd)}</td>
                    </tr>
                    {openRow === j.id && (
                      <tr className="bg-slate-500/5">
                        <td colSpan={9} className="px-4 pb-4 pt-1">
                          <Expanded job={j} now={now} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Scroller>
        )}
      </Panel>
    </div>
  );
}

/** The row's own detail, inline. Enough to decide whether the full job view is
 *  worth a navigation — which for most rows it is not. */
function Expanded({ job, now }: { job: JobRecord; now: number }) {
  const queueWait = job.startedAt ? Date.parse(job.startedAt) - Date.parse(job.createdAt) : null;
  return (
    <div className="orc-reveal grid gap-4 rounded-lg border border-edge bg-panel p-4 lg:grid-cols-[2fr_1fr]">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Prompt</div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-slate-400">
          {job.prompt}
        </pre>
        {job.error && (
          <>
            <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Error</div>
            <p className="mt-1 font-mono text-xs text-red-400">{job.error}</p>
          </>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <Row k="queue wait" v={queueWait === null ? 'not started' : duration(queueWait)} />
        <Row k="started" v={job.startedAt ? clock(job.startedAt) : '—'} />
        <Row k="finished" v={job.finishedAt ? clock(job.finishedAt) : job.startedAt ? `running ${span(job.startedAt, null, now)}` : '—'} />
        <Row k="exit code" v={job.exitCode === null ? '—' : String(job.exitCode)} />
        <Row k="session" v={job.sessionId?.slice(0, 8) ?? '—'} />
        <Row k="cli" v={job.cliVersion ?? '—'} />
        <Row k="permissions" v={job.permissionMode} />
        <Row k="steerable" v={job.steerable ? 'yes' : 'no'} />
        <Row k="depends on" v={job.dependsOn.length ? job.dependsOn.map((d) => d.slice(0, 8)).join(', ') : '—'} />
        <dt className="col-span-2 mt-2">
          <Link to={`/jobs/${job.id}`} className="text-xs font-semibold text-sky-400 hover:underline">
            Open full job view →
          </Link>
        </dt>
      </dl>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt className="text-slate-500">{k}</dt>
    <dd className="tnum truncate font-mono text-slate-300" title={v}>{v}</dd>
  </>
);
