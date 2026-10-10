import { NavLink } from 'react-router-dom';
import { useTheme } from '../lib/theme';
import type { StreamState } from '../lib/hooks';

const LINKS = [
  { to: '/', label: 'Fleet', key: '1', end: true },
  { to: '/jobs', label: 'Jobs', key: '2', end: false },
  { to: '/graphs', label: 'Graphs', key: '3', end: false },
  { to: '/insights', label: 'Insights', key: '4', end: false },
  { to: '/settings', label: 'Settings', key: '5', end: false },
] as const;

const DOT: Record<StreamState, string> = {
  live: 'bg-green-400',
  connecting: 'bg-amber-400 animate-pulse',
  retrying: 'bg-amber-400 animate-pulse',
  error: 'bg-red-500',
};

const EXPLAIN: Record<StreamState, string> = {
  live: 'live — receiving events as they happen',
  connecting: 'connecting to the daemon event stream',
  retrying: 'connection dropped, retrying with backoff',
  error: 'stream stopped — the token was rejected',
};

export function Nav({ stream, onSignOut }: { stream: StreamState; onSignOut: () => void }) {
  const { theme, toggle } = useTheme();
  return (
    <header className="border-b border-edge bg-ink/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-1 px-3 py-2 sm:gap-3 sm:px-5">
        {/* An identity, not three bare letters: the mark gives the header a
            fixed left edge that survives the nav wrapping on a phone, and the
            subtitle says what this is to someone opening the tab cold. */}
        <span className="mr-1 flex items-center gap-2 sm:mr-3">
          <span
            aria-hidden
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-black text-accent-ink"
          >
            o
          </span>
          <span className="hidden leading-none sm:block">
            <span className="block text-sm font-black tracking-tight text-slate-100">orchestrator</span>
            <span className="block text-[10px] uppercase tracking-wider text-slate-500">session fleet</span>
          </span>
        </span>
        <nav className="flex items-center gap-1" aria-label="Views">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              title={`${l.label}  (g then ${l.key})`}
              className={({ isActive }) =>
                `rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
                  isActive ? 'bg-slate-500/15 font-semibold text-slate-100' : 'text-slate-500 hover:text-slate-200'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-500" title={EXPLAIN[stream]}>
            <span className={`h-2 w-2 rounded-full ${DOT[stream]}`} aria-hidden />
            <span className="hidden sm:inline">{stream}</span>
          </span>
          <button
            onClick={toggle}
            aria-label={`switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            title={`switch to ${theme === 'light' ? 'dark' : 'light'} theme  (t)`}
            className="rounded-lg border border-edge px-2 py-1 text-xs text-slate-500 transition-colors hover:text-slate-200"
          >
            {theme === 'light' ? '☾' : '☀'}
          </button>
          <button onClick={onSignOut} className="text-xs text-slate-500 hover:text-slate-200">
            forget token
          </button>
        </div>
      </div>
    </header>
  );
}
