import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'orc.theme';

/**
 * Light is the default, and the system preference is deliberately not consulted.
 *
 * A dashboard that silently follows the OS is a dashboard that looks different
 * in the evening than it did in the morning, on a surface where colour carries
 * job state. One explicit choice, remembered, beats an ambient one.
 */
function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // Private windows and blocked site data throw on access, not just on write.
  }
  return 'light';
}

interface Ctx {
  readonly theme: Theme;
  readonly toggle: () => void;
}

const ThemeContext = createContext<Ctx>({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Persistence is a convenience; the session still themes correctly.
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): Ctx => useContext(ThemeContext);
