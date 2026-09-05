import { useState } from 'react';
import { ErrorNote } from './ui';

/**
 * The manual fallback for the token handoff.
 *
 * `orc ui` normally supplies it in the URL fragment. Someone who navigated
 * here by typing the address needs a way in that is not "go read a file and
 * craft a URL", so we tell them exactly which file and take a paste.
 */
export function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error: string | null }) {
  const [value, setValue] = useState('');
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">orchestrator</h1>
        <p className="mt-1 text-sm text-slate-400">
          This dashboard needs the daemon&rsquo;s bearer token. Run <code className="font-mono text-sky-300">orc ui</code>{' '}
          to open it with the token already attached, or paste it below.
        </p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label htmlFor="token" className="text-xs uppercase tracking-wider text-slate-500">
          Bearer token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="contents of ~/.claude/orchestrator/token"
          className="rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-sm text-slate-200 placeholder:text-slate-600"
        />
        <button
          type="submit"
          className="rounded-lg bg-sky-500/90 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
          disabled={!value.trim()}
        >
          Connect
        </button>
      </form>
      <p className="text-xs text-slate-600">
        Stored in this browser only. The daemon listens on 127.0.0.1 and never on a public interface.
      </p>
    </main>
  );
}
