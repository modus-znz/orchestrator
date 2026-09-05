import type { ReactNode } from 'react';
import { STATUS_CLASS } from '../lib/format';
import type { JobStatus } from '../lib/types';

export function Panel({ title, subtitle, right, children, className = '' }: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-edge bg-panel/70 ${className}`}>
      {title && (
        <header className="flex items-baseline gap-3 border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          <div className="ml-auto">{right}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_CLASS[status]}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

/** A managed session is one we spawned and can read in full; an observed one
 *  is someone else's terminal. Never rendered as the same thing (§4.1). */
export function KindBadge({ kind }: { kind: 'managed' | 'observed' }) {
  const managed = kind === 'managed';
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        managed ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30' : 'bg-slate-700/40 text-slate-400 ring-slate-600/40'
      }`}
      title={managed ? 'spawned by the daemon — full transcript' : 'observed only — name, cwd and liveness'}
    >
      {kind}
    </span>
  );
}

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel/70 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-slate-500">{children}</p>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {children}
    </p>
  );
}

/** A horizontally scrollable wrapper — the page itself must never scroll
 *  sideways on a phone, but a wide table legitimately does. */
export function Scroller({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}
