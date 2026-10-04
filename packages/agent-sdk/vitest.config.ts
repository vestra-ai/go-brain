import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // bench/: the harness bench's report-shape pin (coverage stays src-only below).
    include: ['src/**/*.test.ts', 'bench/**/*.test.ts'],
    // v8 instrumentation slows execution ~2-3x, which tips disk-heavy tests (e.g.
    // the journal 5001-entry buffer-cap test) past the 5000ms default on CI. Give
    // the suite headroom only under coverage (KERNEL_COVERAGE is set by the
    // test:coverage script); plain `test` stays strict so real hangs still surface.
    // Same convention as the journal perf test, which relaxes its timing assertions
    // under KERNEL_COVERAGE.
    testTimeout: process.env.KERNEL_COVERAGE ? 20_000 : 5_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.test.ts'],
      // Real floors, enforced by the `test:coverage` step in
      // .github/workflows/test.yml (not `test`) and ratcheted up-only by R4
      // (apps/reconciler/data/ratchets/coverage-thresholds-baseline.json). Set to the
      // measured actual minus ~1pt on 2026-07-08 (stmts 84.35 / branches 75.24 /
      // funcs 86.03 / lines 86.93). Floors sit BELOW actual by design — raise them
      // (and the R4 baseline, same PR) as coverage climbs, never above actual.
      thresholds: {
        statements: 83,
        branches: 74,
        functions: 85,
        lines: 85,
      },
    },
  },
});
