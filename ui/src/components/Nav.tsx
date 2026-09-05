import { NavLink } from 'react-router-dom';
import type { StreamState } from '../lib/hooks';

const LINKS = [
  { to: '/', label: 'Fleet', end: true },
  { to: '/jobs', label: 'Jobs', end: false },
  { to: '/graphs', label: 'Graphs', end: false },
  { to: '/settings', label: 'Settings', end: false },
] as const;

const DOT: Record<StreamState, string> = {
  live: 'bg-green-400',
  connecting: 'bg-amber-400 animate-pulse',
  retrying: 'bg-amber-400 animate-pulse',
  error: 'bg-red-500',
};

export function Nav({ stream, onSignOut }: { stream: StreamState; onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-10 border-b border-edge bg-ink/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-1 px-3 py-2 sm:gap-3 sm:px-5">
        <span className="mr-1 font-mono text-sm font-semibold tracking-tight text-slate-200 sm:mr-3">orc</span>
        <nav className="flex items-center gap-1" aria-label="Views">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
                  isActive ? 'bg-slate-700/50 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-500" title={`event stream: ${stream}`}>
            <span className={`h-2 w-2 rounded-full ${DOT[stream]}`} aria-hidden />
            <span className="hidden sm:inline">{stream}</span>
          </span>
          <button onClick={onSignOut} className="text-xs text-slate-500 hover:text-slate-300">
            forget token
          </button>
        </div>
      </div>
    </header>
  );
}
