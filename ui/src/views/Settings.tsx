import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useFetch } from '../lib/hooks';
import { ErrorNote, Panel } from '../components/ui';
import type { ModelTier, PermissionMode, Settings as S } from '../lib/types';

const MODELS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus', 'fable'];
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const TERMINALS = ['auto', 'ghostty', 'konsole', 'none'] as const;

export function Settings() {
  const { data, error, reload } = useFetch<{ settings: S }>('/api/settings');
  const [draft, setDraft] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(data.settings);
  }, [data]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!draft) return null;

  const set = <K extends keyof S>(key: K, value: S[K]): void => {
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(draft) });
      setSaved(true);
      reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {saveError && <ErrorNote>{saveError}</ErrorNote>}

      <Panel title="Scheduling" subtitle="how much runs at once, and for how much">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Num label="Max concurrency" hint="each job is a full session; higher burns rate limit faster"
               value={draft.maxConcurrency} min={1} max={32} onChange={(v) => set('maxConcurrency', v)} />
          <Num label="Default budget (USD)" hint="the ceiling every job inherits" step={0.25}
               value={draft.defaultBudgetUsd} min={0} onChange={(v) => set('defaultBudgetUsd', v)} />
          <Num label="Default timeout (minutes)" value={Math.round(draft.defaultTimeoutMs / 60000)} min={1}
               onChange={(v) => set('defaultTimeoutMs', v * 60000)} />
          <Num label="Retry limit" hint="a retry re-runs the whole prompt, at full cost"
               value={draft.retryLimit} min={0} max={5} onChange={(v) => set('retryLimit', v)} />
          <Select label="Default model" value={draft.defaultModel} options={MODELS}
                  hint="tier first, trim second" onChange={(v) => set('defaultModel', v as ModelTier)} />
          <Select label="Default permission mode" value={draft.defaultPermissionMode} options={MODES}
                  onChange={(v) => set('defaultPermissionMode', v as PermissionMode)} />
        </div>
      </Panel>

      <Panel title="Steering" subtitle="two gates, both closed by default">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <List label="Steer allowlist" hint="session names allowed to receive a steer; empty means none"
                value={draft.steerAllowlist} onChange={(v) => set('steerAllowlist', v)} />
          <Num label="Steers per session per hour" hint="each courier costs about $0.04"
               value={draft.steerRateLimitPerHour} min={0} max={200} onChange={(v) => set('steerRateLimitPerHour', v)} />
        </div>
      </Panel>

      <Panel title="Terminal" subtitle="where attach opens">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Select label="Terminal" value={draft.terminal} options={TERMINALS}
                  hint="none disables attach entirely" onChange={(v) => set('terminal', v as S['terminal'])} />
        </div>
      </Panel>

      <Panel title="Redaction" subtitle="applied at ingest, never at render">
        <div className="px-4 py-4">
          <List label="Redaction patterns"
                hint="literals scrubbed before an event is stored — a secret already in the store is in the JSONL log too"
                value={draft.redactPatterns} onChange={(v) => set('redactPatterns', v)} />
        </div>
      </Panel>

      <Panel title="Permissions">
        <div className="px-4 py-4">
          {/* Read-only on purpose: allowBypassPermissions comes from
              ORCHESTRATOR_ALLOW_BYPASS at daemon start, so a flag you stopped
              passing is a gate that closed rather than one that stayed open —
              and it is not something to toggle from a UI reachable remotely. */}
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${draft.allowBypassPermissions ? 'bg-amber-400' : 'bg-slate-600'}`} aria-hidden />
            <span className="text-sm text-slate-300">
              bypassPermissions is {draft.allowBypassPermissions ? 'allowed' : 'refused'}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Not settable here. Start the daemon with <code className="font-mono">ORCHESTRATOR_ALLOW_BYPASS=1</code> to
            allow it. This is the most dangerous capability in the system, so the operator opts in on the box.
          </p>
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-sky-500/90 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-xs text-green-400">Saved.</span>}
      </div>
    </div>
  );
}

function Field({ label, hint, children, htmlFor }: {
  label: string; hint?: string | undefined; children: React.ReactNode; htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs uppercase tracking-wider text-slate-500">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-600">{hint}</p>}
    </div>
  );
}

const INPUT = 'rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-slate-200';

function Num({ label, hint, value, onChange, min, max, step }: {
  label: string; hint?: string | undefined; value: number; onChange: (v: number) => void;
  min?: number | undefined; max?: number | undefined; step?: number | undefined;
}) {
  const id = `f-${label.replace(/\W+/g, '-')}`;
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id} type="number" className={`tnum ${INPUT}`} value={value}
        min={min} max={max} step={step ?? 1}
        onChange={(e) => {
          const n = Number(e.target.value);
          // Guard rather than send NaN: the daemon would reject it, but the
          // input would already look accepted.
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </Field>
  );
}

function Select({ label, hint, value, options, onChange }: {
  label: string; hint?: string | undefined; value: string; options: readonly string[]; onChange: (v: string) => void;
}) {
  const id = `f-${label.replace(/\W+/g, '-')}`;
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}

/** One entry per line — a comma-separated box invites a value containing a
 *  comma, and a redaction pattern very well might. */
function List({ label, hint, value, onChange }: {
  label: string; hint?: string | undefined; value: readonly string[]; onChange: (v: string[]) => void;
}) {
  const id = `f-${label.replace(/\W+/g, '-')}`;
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea
        id={id} rows={4} className={`${INPUT} font-mono text-xs`}
        value={value.join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      />
    </Field>
  );
}
