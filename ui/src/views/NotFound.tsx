import { Link, useLocation } from 'react-router-dom';
import { Panel } from '../components/ui';

/**
 * A real not-found page.
 *
 * The catch-all route used to redirect silently to the fleet, which turns a
 * mistyped or stale URL into "the app forgot where I was going" — the worst
 * kind of bug report, because nothing appears to be wrong. Saying what was not
 * found, and offering the way back, costs a few lines.
 */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <Panel>
      <div className="px-4 py-16 text-center">
        <p className="tnum text-sm font-semibold uppercase tracking-wider text-slate-500">404</p>
        <h1 className="mt-2 text-slate-100">Nothing lives at that address</h1>
        <p className="prose mx-auto mt-2 max-w-md text-sm text-slate-500">
          <code className="font-mono text-slate-400">{pathname}</code> isn't a view in this
          dashboard. If you followed a link to a job, it may have been pruned from the store since.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link
            to="/"
            className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-slate-200 transition-colors hover:border-sky-400/60"
          >
            Back to the fleet
          </Link>
          <Link
            to="/jobs"
            className="rounded-lg px-3 py-2 text-sm text-slate-500 transition-colors hover:text-slate-200"
          >
            Browse jobs
          </Link>
        </div>
      </div>
    </Panel>
  );
}
