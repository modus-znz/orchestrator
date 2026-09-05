import { Link } from 'react-router-dom';
import { useFetch, useNow } from '../lib/hooks';
import { age, tidyPath } from '../lib/format';
import { Empty, ErrorNote, KindBadge, Panel, Scroller, Tile } from '../components/ui';
import type { FleetResponse, Health, SessionRecord } from '../lib/types';

/**
 * Every Claude Code session on this machine, not only the ones we started.
 *
 * The managed/observed split is the whole point of the view: an observed row
 * carries name, cwd and liveness and nothing else, and pretending otherwise
 * would invent detail we do not have.
 */
export function Fleet({ tick }: { tick: number }) {
  const fleet = useFetch<FleetResponse>('/api/fleet', [tick]);
  const health = useFetch<Health>('/api/health', [tick]);
  const now = useNow();

  const sessions = fleet.data?.sessions ?? [];
  const live = sessions.filter((s) => s.alive);

  return (
    <div className="flex flex-col gap-4">
      {fleet.error && <ErrorNote>{fleet.error}</ErrorNote>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Managed" value={fleet.data?.managed ?? '—'} hint="spawned by the daemon" />
        <Tile label="Observed" value={fleet.data?.observed ?? '—'} hint="other terminals" />
        <Tile label="Running jobs" value={health.data?.running ?? '—'} hint="against maxConcurrency" />
        <Tile label="Events" value={health.data?.latestEventId ?? '—'} hint="fleet-wide id" />
      </div>

      <Panel title="Sessions" subtitle={`${live.length} live of ${sessions.length} seen`}>
        {sessions.length === 0 ? (
          <Empty>No sessions yet. Start one with <code className="font-mono">orc run</code>.</Empty>
        ) : (
          <Scroller>
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-edge">
                  <th scope="col" className="px-4 py-2 font-medium">Session</th>
                  <th scope="col" className="px-4 py-2 font-medium">Kind</th>
                  <th scope="col" className="px-4 py-2 font-medium">State</th>
                  <th scope="col" className="px-4 py-2 font-medium">Directory</th>
                  <th scope="col" className="px-4 py-2 font-medium">PID</th>
                  <th scope="col" className="px-4 py-2 font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/60">
                {sessions.map((s) => (
                  <Row key={s.sessionId} s={s} now={now} />
                ))}
              </tbody>
            </table>
          </Scroller>
        )}
      </Panel>
    </div>
  );
}

function Row({ s, now }: { s: SessionRecord; now: number }) {
  return (
    <tr className={s.alive ? '' : 'opacity-45'}>
      <td className="px-4 py-2">
        <div className="font-mono text-slate-200">{s.name ?? s.sessionId.slice(0, 8)}</div>
        <div className="font-mono text-[11px] text-slate-600">{s.sessionId.slice(0, 8)}</div>
      </td>
      <td className="px-4 py-2">
        <KindBadge kind={s.kind} />
        {s.jobId && (
          <Link to={`/jobs/${s.jobId}`} className="ml-2 text-xs text-sky-400 hover:underline">
            job
          </Link>
        )}
      </td>
      <td className="px-4 py-2">
        {/* `status` is null for a managed headless child, which publishes no
            such field. Rendering "unknown" is honest; rendering "idle" is not. */}
        <span className="text-slate-300">{s.alive ? (s.status ?? 'unknown') : 'gone'}</span>
        {s.harness?.state && <span className="ml-2 text-xs text-slate-500">{s.harness.state}</span>}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-slate-400">{tidyPath(s.cwd)}</td>
      <td className="tnum px-4 py-2 text-slate-500">{s.pid ?? '—'}</td>
      <td className="tnum px-4 py-2 text-slate-500">{age(s.lastSeenAt, now)}</td>
    </tr>
  );
}
