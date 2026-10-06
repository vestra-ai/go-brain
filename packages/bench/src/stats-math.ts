/** Nearest-rank percentile (p from 0 to 100). Null when there is nothing to rank; NaN and Infinity are skipped. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const k = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[k] ?? null;
}
