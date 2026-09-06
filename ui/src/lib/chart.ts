import type { Theme } from './theme';

/**
 * Recharts chrome, per theme.
 *
 * Recharts wants literal colour strings for SVG `stroke` and for the tooltip's
 * inline style, so these cannot simply be `var(--color-…)` the way the utility
 * classes are — a CSS variable in an SVG presentation attribute is not reliably
 * resolved. Passing the theme in explicitly keeps the charts honest instead of
 * leaving a slate-600 axis invisible on a white panel.
 */
export interface ChartTheme {
  readonly axis: string;
  readonly grid: string;
  readonly cursor: string;
  readonly tooltip: React.CSSProperties;
  readonly tooltipLabel: React.CSSProperties;
  readonly accent: string;
  readonly accentAlt: string;
  readonly positive: string;
  readonly warn: string;
  readonly muted: string;
}

const SHARED = {
  borderRadius: 10,
  fontSize: 12,
  fontFamily: "'Source Sans 3', system-ui, sans-serif",
  padding: '6px 10px',
} as const;

export const CHART: Record<Theme, ChartTheme> = {
  dark: {
    axis: '#475569',
    grid: '#1f2937',
    cursor: 'rgba(148,163,184,0.12)',
    tooltip: { ...SHARED, background: '#0f172a', border: '1px solid #1f2937', color: '#e2e8f0' },
    tooltipLabel: { color: '#94a3b8', fontWeight: 600 },
    accent: '#38bdf8',
    accentAlt: '#a855f7',
    positive: '#22c55e',
    warn: '#f59e0b',
    muted: '#64748b',
  },
  light: {
    axis: '#94a3b8',
    grid: '#e2e8f0',
    cursor: 'rgba(15,23,42,0.06)',
    tooltip: { ...SHARED, background: '#ffffff', border: '1px solid #e2e8f0', color: '#1e293b', boxShadow: '0 4px 12px rgb(15 23 42 / 0.10)' },
    tooltipLabel: { color: '#64748b', fontWeight: 600 },
    accent: '#0284c7',
    accentAlt: '#7e22ce',
    positive: '#15803d',
    warn: '#b45309',
    muted: '#64748b',
  },
};
