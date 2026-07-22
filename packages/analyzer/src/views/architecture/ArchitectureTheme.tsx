import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import './architecture.css';

export type ArchTheme = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const KEY = 'prov-arch-theme';

type Ctx = { theme: ArchTheme; resolved: Resolved; setTheme: (t: ArchTheme) => void };
const ArchThemeContext = createContext<Ctx | null>(null);

export function useArchTheme(): Ctx {
  const ctx = useContext(ArchThemeContext);
  if (!ctx) throw new Error('useArchTheme must be used inside <ArchitectureTheme>');
  return ctx;
}

function systemPref(): Resolved {
  if (typeof matchMedia !== 'function') return 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function stored(): ArchTheme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ArchitectureTheme({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ArchTheme>(stored);
  const [sys, setSys] = useState<Resolved>(systemPref);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSys(mq.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const setTheme = useCallback((t: ArchTheme) => {
    setThemeState(t);
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* private browsing — in-memory only */
    }
  }, []);

  const resolved: Resolved = theme === 'system' ? sys : theme;
  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return (
    <ArchThemeContext.Provider value={value}>
      <div data-arch-theme={resolved} className="arch-root">
        {children}
      </div>
    </ArchThemeContext.Provider>
  );
}

export function ArchThemeToggle() {
  const { resolved, setTheme } = useArchTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="arch-btn"
      aria-label={`Switch to ${next} mode`}
      onClick={() => setTheme(next)}
    >
      {resolved === 'dark' ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />}
      <span>{next}</span>
    </button>
  );
}
