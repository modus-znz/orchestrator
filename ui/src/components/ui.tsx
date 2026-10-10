import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { burn, STATUS_CLASS } from '../lib/format';
import type { JobStatus, LearningWindow } from '../lib/types';

export function Panel({ title, subtitle, right, children, className = '' }: {
  title?: string | undefined;
  subtitle?: string | undefined;
  right?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section
      className={`rounded-xl border border-edge bg-panel ${className}`}
      style={{ boxShadow: 'var(--shadow-panel)' }}
    >
      {title && (
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          <div className="ml-auto flex items-center gap-2">{right}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** A dot alongside the word: colour alone is not a signal for everyone, and the
 *  dot gives the badge a fixed left edge so a column of them lines up. */
export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_CLASS[status]}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-80" aria-hidden />
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
        managed ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30' : 'bg-slate-500/10 text-slate-400 ring-slate-500/25'
      }`}
      title={managed ? 'spawned by the daemon — full transcript' : 'observed only — name, cwd and liveness'}
    >
      {kind}
    </span>
  );
}

export function Tile({ label, value, hint, tone = 'default', onClick, active }: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
  tone?: 'default' | 'live' | 'warn' | 'bad' | undefined;
  onClick?: (() => void) | undefined;
  active?: boolean | undefined;
}) {
  const TONE = {
    default: 'text-slate-100',
    live: 'text-sky-400',
    warn: 'text-amber-300',
    bad: 'text-red-400',
  } as const;
  const interactive = onClick
    ? 'cursor-pointer transition-colors hover:border-sky-400/60 focus-visible:border-sky-400/60'
    : '';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { onClick, type: 'button' as const, 'aria-pressed': !!active } : {})}
      className={`rounded-xl border px-4 py-3 text-left bg-panel ${interactive} ${
        active ? 'border-sky-400' : 'border-edge'
      }`}
      style={{ boxShadow: 'var(--shadow-panel)' }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`tnum mt-1 text-2xl font-semibold ${TONE[tone]}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </Tag>
  );
}

/**
 * Budget consumption as a track.
 *
 * Amber at 80% rather than at the kill: the useful moment for a human is while
 * there is still room to intervene, not once the daemon has already stopped it.
 */
export function BurnBar({ cost, budget, className = '' }: { cost: number; budget: number; className?: string }) {
  const f = burn(cost, budget);
  const tone = f >= 1 ? 'bg-red-400' : f >= 0.8 ? 'bg-amber-400' : 'bg-sky-400';
  return (
    <span
      className={`inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-slate-500/20 align-middle ${className}`}
      title={`${(f * 100).toFixed(0)}% of budget`}
      role="img"
      aria-label={`${(f * 100).toFixed(0)} percent of budget consumed`}
    >
      <span className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${f * 100}%` }} />
    </span>
  );
}

/** A sortable column header. Keeping the arrow in the button (not beside it)
 *  means the whole label is the hit target, which matters on a phone. */
export function SortHeader<K extends string>({ label, field, sort, onSort, align = 'left', className = '' }: {
  label: string;
  field: K;
  sort: { key: K; dir: 'asc' | 'desc' };
  onSort: (k: K) => void;
  align?: 'left' | 'right' | undefined;
  className?: string | undefined;
}) {
  const on = sort.key === field;
  return (
    <th
      scope="col"
      className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-slate-200 ${
          on ? 'text-slate-200' : 'text-slate-500'
        }`}
      >
        {label}
        <span aria-hidden className={on ? 'opacity-100' : 'opacity-0'}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
      </button>
    </th>
  );
}

/** A removable filter pill. Every active filter is visible and clearable from
 *  one place — a filtered table with no visible reason is a bug report. */
export function Chip({ children, onClear }: { children: ReactNode; onClear?: (() => void) | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-slate-500/10 px-2.5 py-1 text-xs text-slate-300">
      {children}
      {onClear && (
        <button type="button" onClick={onClear} aria-label="clear filter" className="text-slate-500 hover:text-red-400">
          ✕
        </button>
      )}
    </span>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">{children}</div>;
}

export function TextInput({ value, onChange, placeholder, label }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  label: string;
}) {
  return (
    <input
      type="search"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 sm:max-w-xs"
    />
  );
}

export function Select<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-lg border border-edge bg-ink px-2.5 py-1.5 text-sm text-slate-300"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string | undefined }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    // Clipboard access is denied outside a secure context and in some
    // permission states; a silent failure would look like a broken button.
    navigator.clipboard?.writeText(text).then(
      () => {
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      },
      () => setDone(false),
    );
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-lg border border-edge px-2 py-1 text-[11px] text-slate-500 transition-colors hover:text-slate-200"
    >
      {done ? 'copied' : label}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-slate-500">{children}</p>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
      {children}
    </p>
  );
}

/** A horizontally scrollable wrapper — the page itself must never scroll
 *  sideways on a phone, but a wide table legitimately does. */
export function Scroller({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

/**
 * A placeholder shaped like the thing that is coming.
 *
 * `useFetch` has always exposed `loading` and the views have always ignored it,
 * so a slow query rendered as nothing at all — indistinguishable from an empty
 * result. A block the size of the real content says "wait" without a spinner
 * and without the layout jumping when the data lands. `animate-pulse` is
 * already disabled under `prefers-reduced-motion` in index.css.
 */
export function Skeleton({ className = '' }: { className?: string | undefined }) {
  return <span className={`block animate-pulse rounded bg-slate-500/15 ${className}`} aria-hidden />;
}

/** Rows of skeletons sized like a table, so the wait looks like the answer. */
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number | undefined; cols?: number | undefined }) {
  return (
    <div className="space-y-2 px-4 py-3" role="status" aria-label="loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? 'w-40' : 'flex-1'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * An empty state that tells you what to do next.
 *
 * The old `Empty` was one grey sentence, which reads as a dead end. Naming the
 * reason and the next action costs three lines and turns "nothing here" into
 * "here is how something gets here" — the same solution-finding rule the rest
 * of this app's copy follows.
 */
export function EmptyState({ title, children, action }: {
  title: string;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-semibold text-slate-300">{title}</p>
      {children && <p className="prose mx-auto mt-1.5 max-w-md text-sm text-slate-500">{children}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A proportion bar — ok / error / denied as one 100%-wide track.
 *
 * Three counts in three columns make you do arithmetic to see that a tool is
 * mostly failing; one track shows it at a glance, and the numbers stay beside
 * it for the exact value. Zero-width segments are dropped rather than rendered
 * as hairlines, which would otherwise imply a failure that isn't there.
 */
export function Meter({ segments, className = '' }: {
  segments: readonly { value: number; tone: 'ok' | 'error' | 'denied' | 'pending'; label: string }[];
  className?: string | undefined;
}) {
  const TONE = {
    ok: 'bg-green-400',
    error: 'bg-red-400',
    denied: 'bg-amber-400',
    pending: 'bg-slate-500/50',
  } as const;
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <span className={`inline-block h-1.5 w-full rounded-full bg-slate-500/20 ${className}`} />;
  const text = segments.filter((s) => s.value > 0).map((s) => `${s.value} ${s.label}`).join(', ');
  return (
    <span
      className={`flex h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20 ${className}`}
      role="img"
      aria-label={text}
      title={text}
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.tone} className={TONE[s.tone]} style={{ width: `${(s.value / total) * 100}%` }} />
        ))}
    </span>
  );
}

/**
 * The time window every learning query is scoped to.
 *
 * A segmented control rather than a `<select>`: there are five options, they
 * are ordered, and the current one is worth seeing without opening anything —
 * the window is the single most load-bearing bit of context on the page.
 */
export function WindowPicker({ value, onChange }: {
  value: LearningWindow;
  onChange: (w: LearningWindow) => void;
}) {
  const OPTIONS: readonly LearningWindow[] = ['1h', '6h', '24h', '7d', '30d'];
  return (
    <div className="inline-flex rounded-lg border border-edge p-0.5" role="group" aria-label="time window">
      {OPTIONS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          aria-pressed={w === value}
          className={`tnum rounded-md px-2 py-1 text-xs transition-colors ${
            w === value ? 'bg-slate-500/20 text-slate-200' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
