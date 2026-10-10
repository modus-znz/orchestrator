import { useMemo, useState } from 'react';
import { useFetch } from '../lib/hooks';
import { int, pct, tokens, usd4 } from '../lib/format';
import {
  CopyButton,
  EmptyState,
  ErrorNote,
  Meter,
  Panel,
  Scroller,
  Select,
  SkeletonRows,
  SortHeader,
  Tile,
  WindowPicker,
} from '../components/ui';
import type {
  DenialsResponse,
  LearningStatus,
  LearningWindow,
  SkillsResponse,
  ToolHealthRow,
  ToolsResponse,
  TokensResponse,
} from '../lib/types';

/** Wall-clock only: the date is on the window picker, and a full timestamp in a
 *  header reads as data rather than as the aside it is. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * What the fleet has actually been doing — the read side of the learning store.
 *
 * Everything here is a fact the daemon folded in as events arrived, not a live
 * poll: the store is durable and survives the projection being rebuilt, so this
 * view answers "what keeps failing" across weeks rather than across one boot.
 *
 * Four questions, four panels, one shared window. They are deliberately not
 * merged into a single grid — each answers a different operator question and
 * each is actionable on its own.
 */
export function Insights() {
  const [win, setWin] = useState<LearningWindow>('24h');
  // Every panel keys its fetch on this, so one button re-reads all four at the
  // same instant — four panels drifting to four different "now"s is how a
  // dashboard starts contradicting itself.
  const [readAt, setReadAt] = useState(() => Date.now());
  const status = useFetch<LearningStatus>('/api/learning/status', [readAt]);

  // `available: false` is a real answer, not a failure: the daemon runs fine
  // without a learning store, and saying so beats four panels of empty tables.
  if (status.data && !status.data.available) {
    return (
      <Panel title="Insights">
        <EmptyState title="The learning store isn't open">
          This daemon is running without <code className="font-mono">learning.db</code>. Restart it
          and the store opens itself, then backfills from the job logs already on disk — nothing is
          lost in the meantime.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {status.error && <ErrorNote>{status.error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-bold tracking-tight text-slate-100">Insights</h1>
        <p className="prose text-sm text-slate-500">
          Learned from every session the daemon has seen, not just the live ones.
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* These are aggregates over weeks, so they deliberately do not
              re-fetch on every event the way the fleet view does — a table
              reshuffling under the cursor while you read it is worse than a
              slightly stale one. Saying when it was read, and offering the
              button, is what keeps "not live" from reading as "broken". */}
          <span className="tnum text-xs text-slate-500">as of {clock(readAt)}</span>
          <button
            onClick={() => setReadAt(Date.now())}
            className="rounded-lg border border-edge px-2 py-1 text-xs text-slate-400 transition-colors hover:border-sky-400/60 hover:text-slate-200"
          >
            Refresh
          </button>
          <WindowPicker value={win} onChange={setWin} />
        </div>
      </div>

      <ToolHealth win={win} at={readAt} />
      <Denials win={win} at={readAt} />
      <TokenEconomics win={win} at={readAt} />
      <SkillDemand win={win} at={readAt} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type SortKey = 'calls' | 'errors' | 'denied' | 'p95Ms';

/**
 * Which tools get used, and which of them keep breaking.
 *
 * The three outcome counts share one track rather than three columns: a tool
 * that is 40% errors should be visible without arithmetic. `argClass` is a
 * bounded classification the daemon derives at ingest — `git commit`, `.ts` —
 * never the argument itself, so nothing here can leak a path or a secret.
 */
function ToolHealth({ win, at }: { win: LearningWindow; at: number }) {
  const q = useFetch<ToolsResponse>(`/api/learning/tools?window=${win}`, [win, at]);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'calls', dir: 'desc' });

  const rows = useMemo(() => {
    const list = [...(q.data?.tools ?? [])];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => ((a[sort.key] ?? -1) - (b[sort.key] ?? -1)) * dir);
  }, [q.data, sort]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({
          calls: t.calls + r.calls,
          errors: t.errors + r.errors,
          denied: t.denied + r.denied,
          bySubagent: t.bySubagent + r.bySubagent,
        }),
        { calls: 0, errors: 0, denied: 0, bySubagent: 0 },
      ),
    [rows],
  );

  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' }));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Tool calls" value={q.loading ? '—' : int(totals.calls)} hint={`in the last ${win}`} />
        <Tile
          label="Error rate"
          value={q.loading || totals.calls === 0 ? '—' : pct(totals.errors / totals.calls)}
          hint={`${int(totals.errors)} failed`}
          tone={totals.calls > 0 && totals.errors / totals.calls >= 0.1 ? 'bad' : 'default'}
        />
        <Tile
          label="Denied"
          value={q.loading ? '—' : int(totals.denied)}
          hint="a config gap, not a code bug"
          tone={totals.denied > 0 ? 'warn' : 'default'}
        />
        <Tile
          label="By subagent"
          value={q.loading || totals.calls === 0 ? '—' : pct(totals.bySubagent / totals.calls)}
          hint="share delegated off the main thread"
        />
      </div>

      <Panel title="Tool health" subtitle={`${rows.length} tool/argument pairs`}>
        {q.error && <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>}
        {q.loading && <SkeletonRows rows={6} cols={5} />}
        {!q.loading && !q.error && rows.length === 0 && (
          <EmptyState title={`No tool calls in the last ${win}`}>
            Widen the window, or run a job — every tool call a managed session makes lands here
            within a second of happening.
          </EmptyState>
        )}
        {!q.loading && rows.length > 0 && (
          <Scroller>
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-edge">
                  <th scope="col" className="px-4 py-2 text-left font-medium">Tool</th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Argument class</th>
                  <SortHeader label="Calls" field="calls" sort={sort} onSort={onSort} align="right" />
                  <th scope="col" className="px-4 py-2 text-left font-medium">Outcome</th>
                  <SortHeader label="Errors" field="errors" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Denied" field="denied" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="p95" field="p95Ms" sort={sort} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/60">
                {rows.map((r) => (
                  <ToolRow key={`${r.toolName}|${r.argClass ?? ''}`} r={r} />
                ))}
              </tbody>
            </table>
          </Scroller>
        )}
      </Panel>
    </div>
  );
}

function ToolRow({ r }: { r: ToolHealthRow }) {
  const bad = r.calls > 0 && r.errors / r.calls >= 0.25;
  return (
    <tr>
      <td className="px-4 py-2 font-mono text-slate-200">{r.toolName}</td>
      <td className="px-4 py-2 font-mono text-xs text-slate-400">{r.argClass ?? '—'}</td>
      <td className="tnum px-4 py-2 text-right text-slate-300">{int(r.calls)}</td>
      <td className="w-40 px-4 py-2">
        <Meter
          segments={[
            { value: r.ok, tone: 'ok', label: 'ok' },
            { value: r.errors, tone: 'error', label: 'errors' },
            { value: r.denied, tone: 'denied', label: 'denied' },
            { value: r.pending, tone: 'pending', label: 'still open' },
          ]}
        />
      </td>
      <td className={`tnum px-4 py-2 text-right ${bad ? 'text-red-400' : 'text-slate-500'}`}>{int(r.errors)}</td>
      <td className={`tnum px-4 py-2 text-right ${r.denied > 0 ? 'text-amber-300' : 'text-slate-500'}`}>
        {int(r.denied)}
      </td>
      {/* Latency is only known for calls whose result came back — a tool that is
          still open contributes nothing, and a dash says that plainly. */}
      <td className="tnum px-4 py-2 text-right text-slate-500">{r.p95Ms === null ? '—' : `${int(r.p95Ms)}ms`}</td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The permission rule that would have let this call through.
 *
 * Bash is the only tool whose argument class maps onto a real rule shape
 * (`Bash(git commit:*)`); for everything else the honest suggestion is the bare
 * tool name, because the store holds a *classification* and never the path that
 * a narrower rule would have to name. Follow the live event stream for that.
 */
function permissionRule(toolName: string, argClass: string | null): string {
  return toolName === 'Bash' && argClass ? `Bash(${argClass}:*)` : toolName;
}

/**
 * Commands whose rule this panel will describe but never hand over ready to paste.
 *
 * The arg-class allowlist classifies these the same as any other command, so a
 * denied `sudo apt install …` renders as `Bash(sudo apt:*)` — and a copy button
 * beside it turns a diagnostic panel into a one-click root grant with a
 * trailing `:*` doing the real damage. The rule is still shown, because hiding
 * it would just make the operator guess; what it loses is the affordance that
 * makes granting it thoughtless.
 */
const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'systemctl', 'docker', 'kubectl', 'chmod', 'chown']);

function isPrivileged(toolName: string, argClass: string | null): boolean {
  if (toolName !== 'Bash' || !argClass) return false;
  return PRIVILEGED.has(argClass.split(' ')[0] ?? '');
}

/**
 * Denials, read as configuration rather than as failure.
 *
 * A denial means the job asked for something `allowedTools` does not grant — it
 * is fixed once, in settings, and then never again. An error means the request
 * itself was wrong and is fixed in the job. Keeping the two apart is why this
 * panel exists separately from the error column above.
 */
function Denials({ win, at }: { win: LearningWindow; at: number }) {
  const q = useFetch<DenialsResponse>(`/api/learning/denials?window=${win}`, [win, at]);
  const rows = q.data?.denials ?? [];

  return (
    <Panel
      title="Denials → configuration"
      subtitle="each one is a permission rule you haven't granted yet"
    >
      {q.error && <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>}
      {q.loading && <SkeletonRows rows={3} cols={4} />}
      {!q.loading && !q.error && rows.length === 0 && (
        <EmptyState title="Nothing was denied">
          Every tool call in this window was permitted. If jobs are still stalling, look at the
          error column above — that is a different problem with a different fix.
        </EmptyState>
      )}
      {!q.loading && rows.length > 0 && (
        <ul className="divide-y divide-edge/60">
          {rows.map((d) => {
            const rule = permissionRule(d.toolName, d.argClass);
            const privileged = isPrivileged(d.toolName, d.argClass);
            return (
              <li key={`${d.toolName}|${d.argClass ?? ''}|${d.reasonType ?? ''}`} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-sm text-slate-200">{rule}</span>
                  <span className="tnum text-xs text-amber-300">
                    {int(d.denials)} {d.denials === 1 ? 'denial' : 'denials'}
                  </span>
                  {d.reasonType && <span className="text-xs text-slate-500">{d.reasonType}</span>}
                  <div className="ml-auto">
                    {privileged ? (
                      <span className="rounded-md border border-amber-400/40 px-2 py-1 text-xs text-amber-300">
                        privileged — grant by hand
                      </span>
                    ) : (
                      <CopyButton text={rule} label="copy rule" />
                    )}
                  </div>
                </div>
                {privileged && (
                  <p className="prose mt-1 text-xs text-amber-300/80">
                    This rule ends in <code className="font-mono">:*</code>, so granting it allows
                    every argument to a privileged command, not just the one that was denied. Write
                    the narrowest rule you actually need instead.
                  </p>
                )}
                <p className="prose mt-1 text-sm text-slate-400">{d.recommendation}</p>
                {d.sampleReason && (
                  <p className="mt-1 font-mono text-[11px] text-slate-600">{d.sampleReason}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Where the money goes, and how much of it the cache is saving.
 *
 * Cache hit ratio is the lever with the largest effect and the least visibility:
 * reads are an order of magnitude cheaper than fresh input, so a model whose
 * ratio drops is a prompt prefix that stopped being stable, and that is worth
 * knowing on the day it happens rather than on the invoice.
 */
function TokenEconomics({ win, at }: { win: LearningWindow; at: number }) {
  const [by, setBy] = useState<'model' | 'job'>('model');
  const q = useFetch<TokensResponse>(`/api/learning/tokens?by=${by}&window=${win}`, [by, win, at]);
  const rows = q.data?.rows ?? [];
  const spend = rows.reduce((a, r) => a + r.usd, 0);

  return (
    <Panel
      title="Token economics"
      subtitle={spend > 0 ? `${usd4(spend)} across ${int(rows.length)} ${by === 'model' ? 'models' : 'jobs'}` : undefined}
      right={
        <Select
          value={by}
          onChange={setBy}
          label="group token costs by"
          options={[
            { value: 'model', label: 'by model' },
            { value: 'job', label: 'by job' },
          ]}
        />
      }
    >
      {q.error && <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>}
      {q.loading && <SkeletonRows rows={4} cols={5} />}
      {!q.loading && !q.error && rows.length === 0 && (
        <EmptyState title={`No turns costed in the last ${win}`}>
          Costs are recorded per assistant turn, so a window with no active jobs is genuinely
          empty. Widen it to see historical spend.
        </EmptyState>
      )}
      {!q.loading && rows.length > 0 && (
        <Scroller>
          <table className="w-full min-w-[50rem] text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-edge">
                <th scope="col" className="px-4 py-2 text-left font-medium">{by === 'model' ? 'Model' : 'Job'}</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Turns</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Cost</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">In / out</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Cache read</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Cache hit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/60">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-4 py-2 font-mono text-slate-200">{r.key}</td>
                  <td className="tnum px-4 py-2 text-right text-slate-400">{int(r.turns)}</td>
                  <td className="tnum px-4 py-2 text-right text-slate-200">{usd4(r.usd)}</td>
                  <td className="tnum px-4 py-2 text-right text-slate-500">
                    {tokens(r.input)} / {tokens(r.output)}
                  </td>
                  <td className="tnum px-4 py-2 text-right text-slate-500">{tokens(r.cacheRead)}</td>
                  <td className="w-32 px-4 py-2">
                    {r.cacheHitRatio === null ? (
                      <span className="text-xs text-slate-600">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Meter
                          segments={[
                            { value: r.cacheRead, tone: 'ok', label: 'cache read' },
                            { value: r.cacheCreation + r.input, tone: 'pending', label: 'fresh input' },
                          ]}
                        />
                        <span className="tnum shrink-0 text-xs text-slate-400">{pct(r.cacheHitRatio)}</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Which skills the fleet actually reaches for.
 *
 * Useful in two directions: a skill invoked constantly is a candidate for
 * promotion out of the hidden set, and one that is never invoked is paying a
 * listing cost for nothing.
 */
function SkillDemand({ win, at }: { win: LearningWindow; at: number }) {
  const q = useFetch<SkillsResponse>(`/api/learning/skills?window=${win}`, [win, at]);
  const rows = q.data?.skills ?? [];
  const top = rows[0]?.invocations ?? 0;

  return (
    <Panel title="Skill demand" subtitle={`${rows.length} distinct skills invoked`}>
      {q.error && <div className="p-4"><ErrorNote>{q.error}</ErrorNote></div>}
      {q.loading && <SkeletonRows rows={4} cols={3} />}
      {!q.loading && !q.error && rows.length === 0 && (
        <EmptyState title={`No skills invoked in the last ${win}`}>
          Skill invocations are read off the transcript, so only managed sessions contribute.
          Observed terminals are counted in the fleet but not here.
        </EmptyState>
      )}
      {!q.loading && rows.length > 0 && (
        <ul className="divide-y divide-edge/60">
          {rows.map((s) => (
            <li key={s.skill} className="flex items-center gap-4 px-4 py-2.5">
              <span className="w-56 shrink-0 truncate font-mono text-sm text-slate-200" title={s.skill}>
                {s.skill}
              </span>
              <Meter
                className="flex-1"
                segments={[
                  { value: s.invocations - s.errors, tone: 'ok', label: 'clean' },
                  { value: s.errors, tone: 'error', label: 'errors' },
                  // The remainder of the leader's bar, so every row is read
                  // against the same scale rather than each filling its own width.
                  { value: Math.max(0, top - s.invocations), tone: 'pending', label: 'behind the leader' },
                ]}
              />
              <span className="tnum w-24 shrink-0 text-right text-sm text-slate-400">
                {int(s.invocations)} × in {int(s.jobs)} {s.jobs === 1 ? 'job' : 'jobs'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
