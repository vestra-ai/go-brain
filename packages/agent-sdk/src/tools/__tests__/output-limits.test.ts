import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../output-limits.js';

describe('truncateOutput', () => {
  it('passes through short output unchanged', () => {
    const r = truncateOutput('hello', 50_000);
    expect(r).toEqual({ text: 'hello', truncated: false, omittedBytes: 0 });
  });

  it('truncates over-cap output to head + marker + tail', () => {
    const big = 'A'.repeat(10_000) + 'B'.repeat(10_000);
    const r = truncateOutput(big, 1_000);
    expect(r.truncated).toBe(true);
    expect(r.omittedBytes).toBe(20_000 - 1_000);
    expect(r.text.startsWith('A')).toBe(true);      // head preserved
    expect(r.text.endsWith('B')).toBe(true);        // tail preserved
    expect(r.text).toContain('OUTPUT TRUNCATED');
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThan(1_200); // ~cap + marker
  });
});
