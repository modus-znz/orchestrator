/** Shared Recharts tooltip styling. Lives here rather than in a view so the
 *  two chart-bearing views do not import each other just to agree on a box. */
export const TOOLTIP = {
  background: '#0f172a',
  border: '1px solid #1f2937',
  borderRadius: 8,
  fontSize: 12,
} as const;
