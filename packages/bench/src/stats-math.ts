/** Nearest-rank percentile (p from 0 to 100). Null when there is nothing to rank; NaN and Infinity are skipped. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const k = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[k] ?? null;
}
/** "40 ms", "1.92 s", or "n/a" when there is no number. */
export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
/** "88.0%", or "n/a" when there is no number. */
export function fmtPct(x: number | null): string {
  return x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
/** "12,345". */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
