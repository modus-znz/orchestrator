import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError } from '../lib/api';
import { CHART } from '../lib/chart';
import { useTheme } from '../lib/theme';
import { useEventStream, useFetch, useNow } from '../lib/hooks';
import { clock, duration, span, tidyPath, tokens, usd, usd4 } from '../lib/format';
import {
  BurnBar, Chip, CopyButton, Empty, ErrorNote, Panel, StatusBadge, TextInput, Tile, Toolbar,
} from '../components/ui';
import type { JobRecord, StoredEvent } from '../lib/types';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'budget_exceeded']);

/** The payload the runner emits on every billed assistant message. */
interface TurnCost {
  usd?: number;
  model?: string;
  estimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

type Lens = 'all' | 'messages' | 'tools' | 'errors' | 'lifecycle';

const LENSES: { value: Lens; label: string }[] = [
  { value: 'all', label: 'everything' },
  { value: 'messages', label: 'messages' },
  { value: 'tools', label: 'tool calls' },
  { value: 'errors', label: 'errors only' },
  { value: 'lifecycle', label: 'lifecycle' },
];

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

  const usage = useMemo(() => {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
    for (const e of events) {
      if (e.type !== 'cost.turn') continue;
      const p = e.payload as TurnCost;
      input += p.inputTokens ?? 0;
      output += p.outputTokens ?? 0;
      cacheRead += p.cacheReadTokens ?? 0;
      cacheWrite += p.cacheCreationTokens ?? 0;
    }
    return { input, output, cacheRead, cacheWrite };
  }, [events]);

  const record = job.data?.job;
  if (job.error) return <ErrorNote>{job.error}</ErrorNote>;
  if (!record) return <Empty>Loading job…</Empty>;

  const running = !TERMINAL.has(record.status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/jobs" className="text-sm text-slate-500 hover:text-slate-200">&larr; Jobs</Link>
        <h1 className="text-base font-bold text-slate-100">{record.name ?? record.prompt.slice(0, 60)}</h1>
        <StatusBadge status={record.status} />
        <span className="font-mono text-xs text-slate-600">{record.id}</span>
        <CopyButton text={record.id} label="copy id" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile
          label="Cost"
          value={<span className="flex items-baseline gap-2">{usd(record.costUsd)}<BurnBar cost={record.costUsd} budget={record.budgetUsd} /></span>}
          hint={`budget ${usd(record.budgetUsd)}`}
          tone={record.costUsd >= record.budgetUsd * 0.8 ? 'warn' : 'default'}
        />
        <Tile label="Turns" value={record.numTurns} hint={record.numTurns ? `${usd4(record.costUsd / record.numTurns)} each` : undefined} />
        <Tile label="Elapsed" value={span(record.startedAt, record.finishedAt, now)} hint={running ? 'still running' : 'finished'} tone={running ? 'live' : 'default'} />
        {/* Cache reads are the single most useful token number here: a high
            read count against a low input count is prompt caching working. */}
        <Tile
          label="Tokens"
          value={tokens(usage.input + usage.output)}
          hint={`${tokens(usage.input)} in · ${tokens(usage.output)} out`}
        />
        <Tile
          label="Cache"
          value={tokens(usage.cacheRead)}
          hint={usage.cacheWrite ? `${tokens(usage.cacheWrite)} written` : 'read from cache'}
          tone={usage.cacheRead > 0 ? 'live' : 'default'}
        />
      </div>

      {record.error && <ErrorNote>{record.error}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <CostChart events={events} budget={record.budgetUsd} />
          <Transcript events={events} live={running} />
        </div>
        <div className="flex flex-col gap-4">
          <Controls job={record} onChanged={job.reload} />
          <ToolTimeline events={events} />
          <Panel title="Prompt" right={<CopyButton text={record.prompt} />}>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-slate-400">
              {record.prompt}
            </pre>
          </Panel>
          <Panel title="Provenance">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3 text-xs">
              <Meta k="cwd" v={tidyPath(record.cwd)} />
              <Meta k="session" v={record.sessionId?.slice(0, 8) ?? '—'} />
              <Meta k="cli" v={record.cliVersion ?? '—'} />
              <Meta k="model" v={record.model} />
              <Meta k="permissions" v={record.permissionMode} />
              <Meta k="exit" v={record.exitCode === null ? '—' : String(record.exitCode)} />
              <Meta k="queued at" v={clock(record.createdAt)} />
              <Meta k="queue wait" v={record.startedAt ? duration(Date.parse(record.startedAt) - Date.parse(record.createdAt)) : 'not started'} />
              <Meta k="timeout" v={duration(record.timeoutMs)} />
              <Meta k="depends on" v={record.dependsOn.length ? record.dependsOn.map((d) => d.slice(0, 8)).join(', ') : '—'} />
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

const Meta = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt className="text-slate-500">{k}</dt>
    <dd className="tnum truncate font-mono text-slate-300" title={v}>{v}</dd>
  </>
);

/** Running spend, summed from `cost.turn` events — the same numbers the budget
 *  check reads, so the line and the kill decision cannot disagree. */
function CostChart({ events, budget }: { events: readonly StoredEvent[]; budget: number }) {
  const { theme } = useTheme();
  const c = CHART[theme];
  const data = useMemo(() => {
    let total = 0;
    return events
      .filter((e) => e.type === 'cost.turn')
      .map((e, i) => {
        const p = e.payload as TurnCost;
        const step = typeof p.usd === 'number' ? p.usd : 0;
        total += step;
        return {
          turn: i + 1,
          usd: Number(total.toFixed(4)),
          step,
          at: clock(e.ts),
          inTok: p.inputTokens ?? 0,
          outTok: p.outputTokens ?? 0,
          cached: p.cacheReadTokens ?? 0,
        };
      });
  }, [events]);

  if (!data.length) return null;
  const last = data[data.length - 1];
  const ceiling = Math.max(budget, last?.usd ?? 0);

  return (
    <Panel
      title="Cost accumulation"
      subtitle={`ceiling ${usd(budget)}`}
      right={<span className="tnum text-xs text-slate-500">{data.length} billed turns</span>}
    >
      <div className="h-44 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="turn" stroke={c.axis} fontSize={11} tickLine={false} />
            <YAxis stroke={c.axis} fontSize={11} tickLine={false} width={56} domain={[0, ceiling]} tickFormatter={(v: number) => usd(v)} />
            {/* The ceiling drawn, not implied: an area that stops short of the
                top edge says nothing about how much room was left. */}
            <ReferenceLine y={budget} stroke={c.warn} strokeDasharray="4 4" />
            <Tooltip
              cursor={{ stroke: c.axis, strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const r = payload?.[0]?.payload as (typeof data)[number] | undefined;
                if (!active || !r) return null;
                return (
                  <div style={{ ...c.tooltip, padding: '8px 10px' }}>
                    <div style={{ ...c.tooltipLabel, marginBottom: 4 }}>turn {r.turn} · {r.at}</div>
                    <div className="tnum" style={{ fontWeight: 700 }}>{usd4(r.step)} this turn</div>
                    <div className="tnum" style={{ opacity: 0.75 }}>{usd(r.usd)} cumulative</div>
                    <div className="tnum" style={{ opacity: 0.6, fontSize: 11, marginTop: 3 }}>
                      {tokens(r.inTok)} in · {tokens(r.outTok)} out{r.cached ? ` · ${tokens(r.cached)} cached` : ''}
                    </div>
                  </div>
                );
              }}
            />
            <Area type="monotone" dataKey="usd" stroke={c.accent} fill={c.accent} fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

const MATCH: Record<Lens, (e: StoredEvent) => boolean> = {
  all: (e) => e.type !== 'cost.turn',
  messages: (e) => e.type === 'msg.assistant' || e.type === 'msg.user',
  tools: (e) => e.type === 'tool.use' || e.type === 'tool.result',
  errors: (e) =>
    e.type === 'job.failed' ||
    e.type === 'steer.failed' ||
    (e.type === 'tool.result' && !!(e.payload as { isError?: unknown }).isError),
  lifecycle: (e) => e.type.startsWith('job.') || e.type.startsWith('session.') || e.type.startsWith('steer.'),
};

/**
 * The transcript, with a lens and a tail.
 *
 * Follow-tail defaults on only while the job is still running, and releases
 * the moment the reader scrolls away from the bottom — an auto-scroll that
 * fights the reader is the reason people stop trusting a live log. It re-arms
 * on its own when they scroll back down, so following is a position rather
 * than a mode you have to remember to switch back on.
 */
function Transcript({ events, live }: { events: readonly StoredEvent[]; live: boolean }) {
  const [lens, setLens] = useState<Lens>('all');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(live);
  const box = useRef<HTMLOListElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return events.filter((e) => {
      if (!MATCH[lens](e)) return false;
      if (!needle) return true;
      return `${e.type} ${JSON.stringify(e.payload)}`.toLowerCase().includes(needle);
    });
  }, [events, lens, q]);

  useEffect(() => {
    if (!follow) return;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);

  const firstError = useMemo(() => events.find(MATCH.errors), [events]);

  const counts = useMemo(() => {
    const n: Record<Lens, number> = { all: 0, messages: 0, tools: 0, errors: 0, lifecycle: 0 };
    for (const e of events) for (const l of Object.keys(MATCH) as Lens[]) if (MATCH[l](e)) n[l] += 1;
    return n;
  }, [events]);

  return (
    <Panel
      title="Transcript"
      subtitle={`${shown.length} of ${events.length} events`}
      right={
        <>
          {firstError && lens !== 'errors' && (
            <button type="button" onClick={() => setLens('errors')} className="text-[11px] font-semibold text-red-400 hover:underline">
              {counts.errors} error{counts.errors === 1 ? '' : 's'} →
            </button>
          )}
          <button
            type="button"
            onClick={() => setFollow((f) => !f)}
            aria-pressed={follow}
            className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
              follow ? 'border-sky-400 text-sky-400' : 'border-edge text-slate-500 hover:text-slate-200'
            }`}
            title={follow ? 'pinned to the newest event' : 'scrolling is yours'}
          >
            {follow ? '▼ following' : 'follow tail'}
          </button>
        </>
      }
    >
      <Toolbar>
        <div className="flex flex-wrap gap-1">
          {LENSES.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => setLens(l.value)}
              aria-pressed={lens === l.value}
              className={`rounded-lg px-2 py-1 text-xs transition-colors ${
                lens === l.value ? 'bg-slate-500/15 font-semibold text-slate-100' : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              {l.label} <span className="tnum opacity-60">{counts[l.value]}</span>
            </button>
          ))}
        </div>
        <TextInput label="Search transcript" value={q} onChange={setQ} placeholder="filter events…" />
        {q && <Chip onClear={() => setQ('')}>“{q}”</Chip>}
      </Toolbar>

      {shown.length === 0 ? (
        <Empty>{events.length === 0 ? 'No events yet.' : 'No event matches that lens.'}</Empty>
      ) : (
        <ol
          ref={box}
          onScroll={(e) => {
            // Derived from position, not from the gesture: a wheel-down
            // toward the tail must not turn following off, and the
            // programmatic scroll below lands at the bottom, so it
            // re-affirms follow instead of cancelling it.
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
          className="max-h-[32rem] divide-y divide-edge overflow-y-auto"
        >
          {shown.map((e) => (
            <li key={e.id} className="px-4 py-2 transition-colors hover:bg-slate-500/5">
              <div className="flex items-baseline gap-2">
                <span className="tnum font-mono text-[11px] text-slate-600">{clock(e.ts)}</span>
                <span className="font-mono text-[11px] font-semibold text-sky-400">{e.type}</span>
                <span className="ml-auto font-mono text-[10px] text-slate-600">#{e.seq}</span>
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
    return <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-300">{String(p['text'] ?? '')}</p>;
  }
  if (event.type === 'tool.use') {
    return (
      <p className="mt-0.5 break-words font-mono text-xs text-slate-400">
        <span className="font-semibold text-slate-200">{String(p['name'] ?? 'tool')}</span>{' '}
        {truncate(JSON.stringify(p['input'] ?? {}), 220)}
      </p>
    );
  }
  if (event.type === 'tool.result') {
    return (
      <p className={`mt-0.5 break-words font-mono text-xs ${p['isError'] ? 'text-red-400' : 'text-slate-500'}`}>
        {truncate(typeof p['content'] === 'string' ? p['content'] : JSON.stringify(p['content'] ?? ''), 240)}
      </p>
    );
  }
  return <p className="mt-0.5 break-words font-mono text-xs text-slate-500">{truncate(JSON.stringify(p), 220)}</p>;
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** What the job actually reached for, in order — the fastest read on whether a
 *  session is doing the work you asked for or wandering. */
function ToolTimeline({ events }: { events: readonly StoredEvent[] }) {
  const stats = useMemo(() => {
    const map = new Map<string, { uses: number; errors: number }>();
    let pending: string | null = null;
    for (const e of events) {
      if (e.type === 'tool.use') {
        const name = String((e.payload as { name?: unknown }).name ?? 'unknown');
        pending = name;
        const row = map.get(name) ?? { uses: 0, errors: 0 };
        row.uses += 1;
        map.set(name, row);
      } else if (e.type === 'tool.result' && pending) {
        // The result carries no tool name, so it is attributed to the most
        // recent use — correct for a sequential transcript, which this is.
        if ((e.payload as { isError?: unknown }).isError) {
          const row = map.get(pending);
          if (row) row.errors += 1;
        }
        pending = null;
      }
    }
    return [...map.entries()].sort((a, b) => b[1].uses - a[1].uses);
  }, [events]);

  if (!stats.length) return null;
  const max = stats[0]?.[1].uses ?? 1;
  return (
    <Panel title="Tools used" subtitle={`${stats.length} distinct`}>
      <ul className="flex flex-col gap-1.5 px-4 py-3">
        {stats.map(([name, s]) => (
          <li key={name} className="flex items-center gap-2 text-xs" title={s.errors ? `${s.errors} of ${s.uses} returned an error` : `${s.uses} calls`}>
            <span className="w-24 truncate font-mono text-slate-300">{name}</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded bg-slate-500/15">
              <span className="h-full rounded bg-sky-400" style={{ width: `${(s.uses / max) * 100}%` }} aria-hidden />
            </span>
            {s.errors > 0 && <span className="tnum text-red-400">{s.errors}✕</span>}
            <span className="tnum w-6 text-right text-slate-500">{s.uses}</span>
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
        {note && <p className="text-xs font-semibold text-green-400">{note}</p>}

        <div className="flex gap-2">
          <button
            disabled={busy || done}
            onClick={() => act(async () => {
              await api(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'cancelled from the dashboard' }) });
              return 'cancelled';
            })}
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-40"
          >
            Cancel job
          </button>
          <button
            disabled={busy || !job.sessionId}
            onClick={() => act(async () => {
              const r = await api<{ terminal: string }>(`/api/sessions/${job.sessionId}/attach`, { method: 'POST' });
              return `opened ${r.terminal}`;
            })}
            className="rounded-lg border border-edge bg-slate-500/10 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-500/20 disabled:opacity-40"
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
            <label htmlFor="steer" className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Steer &mdash; about $0.04 per send
            </label>
            <textarea
              id="steer"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy || done}
              placeholder="stop refactoring, just make the failing test pass"
              className="rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500"
            />
            <button
              type="submit"
              disabled={busy || done || !text.trim()}
              className="self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40"
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
