import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../lib/api';
import { TOOLTIP } from '../lib/chart';
import { useEventStream, useFetch, useNow } from '../lib/hooks';
import { clock, span, tidyPath, usd } from '../lib/format';
import { Empty, ErrorNote, Panel, StatusBadge, Tile } from '../components/ui';
import type { JobRecord, StoredEvent } from '../lib/types';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'budget_exceeded']);

export function JobDetail() {
  const { id = '' } = useParams();
  const job = useFetch<{ job: JobRecord }>(`/api/jobs/${id}`);
  const history = useFetch<{ events: StoredEvent[] }>(`/api/jobs/${id}/events`);
  const now = useNow();

  // Follow from the last event the history already contains, so the live tail
  // neither repeats what is on screen nor skips what arrived mid-request.
  const from = useMemo(
    () => (history.data ? history.data.events.reduce((max, e) => Math.max(max, e.id), 0) : null),
    [history.data],
  );
  const live = useEventStream({
    from,
    filter: useMemo(() => (e: StoredEvent) => e.jobId === id, [id]),
  });

  const events = useMemo(
    () => (history.data?.events ?? []).concat(live.events),
    [history.data, live.events],
  );

  // A refetch on every terminal event, because the job row carries the
  // authoritative cost and exit code that the stream only hints at.
  useEffect(() => {
    if (live.events.some((e) => e.type.startsWith('job.') && e.type !== 'job.started')) job.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.events.length]);

  const record = job.data?.job;
  if (job.error) return <ErrorNote>{job.error}</ErrorNote>;
  if (!record) return <Empty>Loading job…</Empty>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/jobs" className="text-sm text-slate-500 hover:text-slate-300">&larr; Jobs</Link>
        <h1 className="text-base font-semibold text-slate-100">{record.name ?? record.prompt.slice(0, 60)}</h1>
        <StatusBadge status={record.status} />
        <span className="font-mono text-xs text-slate-600">{record.id}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Cost" value={usd(record.costUsd)} hint={`budget ${usd(record.budgetUsd)}`} />
        <Tile label="Turns" value={record.numTurns} />
        <Tile label="Elapsed" value={span(record.startedAt, record.finishedAt, now)} />
        <Tile label="Model" value={record.model} hint={record.permissionMode} />
      </div>

      {record.error && <ErrorNote>{record.error}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <CostChart events={events} budget={record.budgetUsd} />
          <Transcript events={events} />
        </div>
        <div className="flex flex-col gap-4">
          <Controls job={record} onChanged={job.reload} />
          <ToolTimeline events={events} />
          <Panel title="Prompt">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-slate-400">
              {record.prompt}
            </pre>
          </Panel>
          <Panel title="Provenance">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3 text-xs">
              <dt className="text-slate-500">cwd</dt>
              <dd className="font-mono text-slate-300">{tidyPath(record.cwd)}</dd>
              <dt className="text-slate-500">session</dt>
              <dd className="font-mono text-slate-300">{record.sessionId?.slice(0, 8) ?? '—'}</dd>
              <dt className="text-slate-500">cli</dt>
              <dd className="font-mono text-slate-300">{record.cliVersion ?? '—'}</dd>
              <dt className="text-slate-500">exit</dt>
              <dd className="font-mono text-slate-300">{record.exitCode ?? '—'}</dd>
              <dt className="text-slate-500">depends on</dt>
              <dd className="font-mono text-slate-300">{record.dependsOn.length ? record.dependsOn.map((d) => d.slice(0, 8)).join(', ') : '—'}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Running spend, summed from `cost.turn` events — the same numbers the budget
 *  check reads, so the line and the kill decision cannot disagree. */
function CostChart({ events, budget }: { events: readonly StoredEvent[]; budget: number }) {
  const data = useMemo(() => {
    let total = 0;
    return events
      .filter((e) => e.type === 'cost.turn')
      .map((e, i) => {
        const p = e.payload as { usd?: number };
        total += typeof p.usd === 'number' ? p.usd : 0;
        return { turn: i + 1, usd: Number(total.toFixed(4)), at: clock(e.ts) };
      });
  }, [events]);

  if (!data.length) return null;
  return (
    <Panel title="Cost accumulation" subtitle={`ceiling ${usd(budget)}`}>
      <div className="h-40 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <XAxis dataKey="turn" stroke="#475569" fontSize={11} tickLine={false} />
            <YAxis stroke="#475569" fontSize={11} tickLine={false} width={52} domain={[0, Math.max(budget, data[data.length - 1]?.usd ?? 0)]} />
            <Tooltip contentStyle={TOOLTIP} formatter={(v) => usd(Number(v ?? 0))} />
            <Area type="monotone" dataKey="usd" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.15} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function Transcript({ events }: { events: readonly StoredEvent[] }) {
  const shown = events.filter((e) => e.type !== 'cost.turn');
  return (
    <Panel title="Transcript" subtitle={`${events.length} events`}>
      {shown.length === 0 ? (
        <Empty>No events yet.</Empty>
      ) : (
        <ol className="max-h-[32rem] divide-y divide-edge/50 overflow-y-auto">
          {shown.map((e) => (
            <li key={e.id} className="px-4 py-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-slate-600">{clock(e.ts)}</span>
                <span className="font-mono text-[11px] text-sky-400/80">{e.type}</span>
              </div>
              <EventBody event={e} />
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function EventBody({ event }: { event: StoredEvent }) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'msg.assistant' || event.type === 'msg.user') {
    return <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-300">{String(p['text'] ?? '')}</p>;
  }
  if (event.type === 'tool.use') {
    return (
      <p className="mt-0.5 font-mono text-xs text-slate-400">
        <span className="text-slate-200">{String(p['name'] ?? 'tool')}</span>{' '}
        {truncate(JSON.stringify(p['input'] ?? {}), 160)}
      </p>
    );
  }
  if (event.type === 'tool.result') {
    return (
      <p className={`mt-0.5 font-mono text-xs ${p['isError'] ? 'text-red-400' : 'text-slate-500'}`}>
        {truncate(typeof p['content'] === 'string' ? p['content'] : JSON.stringify(p['content'] ?? ''), 200)}
      </p>
    );
  }
  return <p className="mt-0.5 font-mono text-xs text-slate-500">{truncate(JSON.stringify(p), 200)}</p>;
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** What the job actually reached for, in order — the fastest read on whether a
 *  session is doing the work you asked for or wandering. */
function ToolTimeline({ events }: { events: readonly StoredEvent[] }) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'tool.use') continue;
      const name = String((e.payload as { name?: unknown }).name ?? 'unknown');
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  if (!counts.length) return null;
  const max = counts[0]?.[1] ?? 1;
  return (
    <Panel title="Tools used">
      <ul className="flex flex-col gap-1.5 px-4 py-3">
        {counts.map(([name, n]) => (
          <li key={name} className="flex items-center gap-2 text-xs">
            <span className="w-28 truncate font-mono text-slate-300">{name}</span>
            <span className="h-1.5 rounded bg-sky-500/60" style={{ width: `${(n / max) * 100}%` }} aria-hidden />
            <span className="tnum ml-auto text-slate-500">{n}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Controls({ job, onChanged }: { job: JobRecord; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = TERMINAL.has(job.status);

  const act = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      setNote(await fn());
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Control">
      <div className="flex flex-col gap-3 px-4 py-3">
        {err && <ErrorNote>{err}</ErrorNote>}
        {note && <p className="text-xs text-green-400">{note}</p>}

        <div className="flex gap-2">
          <button
            disabled={busy || done}
            onClick={() => act(async () => {
              await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'cancelled from the dashboard' }) });
              return 'cancelled';
            })}
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40"
          >
            Cancel job
          </button>
          <button
            disabled={busy || !job.sessionId}
            onClick={() => act(async () => {
              const r = await api<{ terminal: string }>(`/api/sessions/${job.sessionId}/attach`, { method: 'POST' });
              return `opened ${r.terminal}`;
            })}
            className="rounded-lg border border-edge bg-slate-700/30 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700/50 disabled:opacity-40"
            title="Opens a real terminal on this session; the orchestrator keeps observing but stops steering"
          >
            Attach
          </button>
        </div>

        {/* Rendered only when the job opted in. Showing a disabled steer box on
            every job would advertise a capability that is off by default and
            teach the wrong mental model of the two gates. */}
        {job.steerable ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim() || !job.sessionId) return;
              void act(async () => {
                const r = await api<{ delivered: boolean; costUsd?: number }>(
                  `/api/sessions/${job.sessionId}/steer`,
                  { method: 'POST', body: JSON.stringify({ text: text.trim() }) },
                );
                setText('');
                return `${r.delivered ? 'delivered' : 'not delivered'}${r.costUsd ? ` (${usd(r.costUsd)})` : ''}`;
              });
            }}
          >
            <label htmlFor="steer" className="text-[11px] uppercase tracking-wider text-slate-500">
              Steer &mdash; about $0.04 per send
            </label>
            <textarea
              id="steer"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy || done}
              placeholder="stop refactoring, just make the failing test pass"
              className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
            />
            <button
              type="submit"
              disabled={busy || done || !text.trim()}
              className="self-start rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
            >
              Send steer
            </button>
          </form>
        ) : (
          <p className="text-xs text-slate-500">
            Not steerable. Submit with <code className="font-mono">--steerable</code> and add the session name to{' '}
            <code className="font-mono">steerAllowlist</code> — both gates, closed by default.
          </p>
        )}
      </div>
    </Panel>
  );
}
