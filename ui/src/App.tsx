import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from './lib/api';
import { clearToken, loadToken, saveToken } from './lib/token';
import { useEventStream } from './lib/hooks';
import { Nav } from './components/Nav';
import { KpiStrip } from './components/KpiStrip';
import { ThemeProvider, useTheme } from './lib/theme';
import { TokenGate } from './components/TokenGate';
import { Fleet } from './views/Fleet';
import { Jobs } from './views/Jobs';
import { Settings } from './views/Settings';

/** Recharts is two thirds of the bundle and only one view needs it, so the
 *  three views an operator actually leaves open do not pay for it. */
const Graphs = lazy(() => import('./views/Graphs').then((m) => ({ default: m.Graphs })));
const JobDetail = lazy(() => import('./views/JobDetail').then((m) => ({ default: m.JobDetail })));
import type { Health } from './lib/types';

function AppInner() {
  const [token, setTok] = useState<string | null>(() => loadToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(token);
    if (!token) {
      setReady(false);
      return;
    }
    let cancelled = false;
    // One health call decides whether the token is good, so a bad one shows a
    // sign-in prompt rather than five broken panels each blaming the daemon.
    api<Health>('/api/health')
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setAuthError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReady(false);
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          setTok(null);
          setAuthError('That token was rejected by the daemon.');
        } else {
          setAuthError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = useCallback((t: string) => {
    saveToken(t);
    setTok(t);
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setTok(null);
    setReady(false);
  }, []);

  if (!token || !ready) {
    return <TokenGate onSubmit={accept} error={authError} />;
  }
  return (
    <BrowserRouter>
      <Shell onSignOut={signOut} />
    </BrowserRouter>
  );
}

/**
 * One fleet-wide stream for the whole app.
 *
 * Views do not each open their own: the daemon holds a socket per client, and
 * four independent followers would quadruple that for no extra information.
 * The stream doubles as a refresh signal — `tick` advances when anything
 * lands, so tables refetch on real activity instead of on a timer.
 */
const Lazy = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<p className="px-1 py-8 text-sm text-slate-500">Loading…</p>}>{children}</Suspense>
);

function Shell({ onSignOut }: { onSignOut: () => void }) {
  useHotkeys();
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => {
    api<Health>('/api/health')
      .then((h) => setFrom(h.latestEventId))
      .catch(() => setFrom(0));
  }, []);

  const stream = useEventStream({ from, cap: 200 });

  // Coalesced: a burst of fifty events during one turn should cause one
  // refetch, not fifty.
  const [tick, setTick] = useState(0);
  const count = stream.events.length;
  useEffect(() => {
    if (count === 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), 400);
    return () => clearTimeout(t);
  }, [count]);

  const nav = useMemo(() => <Nav stream={stream.state} onSignOut={onSignOut} />, [stream.state, onSignOut]);

  return (
    <>
      {/* Nav and KPI strip stick as one block. A separately-sticky strip needs
          a hardcoded offset equal to the nav's height, and the nav's height
          moves with zoom, font scale and the wrapped mobile row — so the
          offset is wrong exactly when someone changes their type size. */}
      <div className="sticky top-0 z-10">
        {nav}
        <KpiStrip tick={tick} />
      </div>
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-5 sm:py-6">
        <Routes>
          <Route path="/" element={<Fleet tick={tick} />} />
          <Route path="/jobs" element={<Jobs tick={tick} />} />
          <Route path="/jobs/:id" element={<Lazy><JobDetail /></Lazy>} />
          <Route
            path="/graphs"
            element={<Lazy><Graphs tick={tick} /></Lazy>}
          />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

/**
 * Keyboard navigation: `g` then 1-4 for the four views, `t` for the theme,
 * `/` to jump into whatever the current view uses for search.
 *
 * The `g` prefix rather than bare digits, because a bare single-letter shortcut
 * fires while someone is typing a steer into a textarea. Anything typed into a
 * field is ignored outright for the same reason.
 */
function useHotkeys(): void {
  const navigate = useNavigate();
  const { toggle } = useTheme();
  const pending = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '/' && !typing) {
        const box = document.querySelector<HTMLInputElement>('input[type=search]');
        if (box) {
          e.preventDefault();
          box.focus();
        }
        return;
      }
      if (typing) return;

      if (pending.current) {
        pending.current = false;
        const to = { '1': '/', '2': '/jobs', '3': '/graphs', '4': '/settings' }[e.key];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (e.key === 'g') {
        pending.current = true;
        setTimeout(() => (pending.current = false), 1200);
      } else if (e.key === 't') {
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, toggle]);
}

export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
