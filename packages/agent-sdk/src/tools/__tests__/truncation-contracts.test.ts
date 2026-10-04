/**
 * Truncation ergonomics — every cap names the EXACT next call.
 *
 * A truncated result that does not say how to get the rest costs a round-trip:
 * the model either re-runs the identical call or, worse, treats the capped
 * output as complete. These pin the three caps that ride the native arm — Grep's
 * head_limit, Bash's byte cap, and the dispatch-boundary hard cap — plus the
 * tool descriptions that state each contract up front, so the model knows the
 * shape of a truncated result before it ever sees one.
 */
import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../output-limits.js';
import { pageGrepLines } from '../grep-tool.js';
import { guardToolOutput, TOOL_OUTPUT_MAX_CHARS } from '../../engine/tool-output-guard.js';
import { TOOL_DESCRIPTIONS } from '../descriptions/index.js';

describe('truncateOutput — Bash byte cap', () => {
  it('names the recovery, not just the loss', () => {
    const out = truncateOutput('x'.repeat(200_000), 50_000);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('bytes omitted');
    // The exact next call, spelled out — Bash has no offset to page with.
    expect(out.text).toContain('> out.txt 2>&1');
    expect(out.text).toContain('offset/limit');
  });

  it('leaves an under-cap result completely untouched', () => {
    const out = truncateOutput('small output', 50_000);
    expect(out).toEqual({ text: 'small output', truncated: false, omittedBytes: 0 });
  });
});

describe('pageGrepLines — Grep head_limit cap', () => {
  const lines = Array.from({ length: 1_000 }, (_, i) => `src/f${i}.ts:1:hit`);

  it('states the window and the exact next offset when matches are hidden', () => {
    const out = pageGrepLines(lines, 0, 250);
    expect(out).toContain('[showing 1-250 of 1000 matches; continue with offset=250]');
    // The model is never asked to work the offset out itself.
    expect(out).not.toContain('offset=N');
  });

  it('carries the window forward on a paged follow-up', () => {
    expect(pageGrepLines(lines, 250, 250)).toContain(
      '[showing 251-500 of 1000 matches; continue with offset=500]',
    );
  });

  it('adds NO footer when nothing is hidden', () => {
    expect(pageGrepLines(lines.slice(0, 10), 0, 250)).not.toContain('showing');
    expect(pageGrepLines(lines, 0, 0)).not.toContain('showing'); // 0 = unlimited
    expect(pageGrepLines(lines, 750, 250)).not.toContain('showing'); // exact last page
  });

  it('reports no matches rather than an empty string', () => {
    expect(pageGrepLines([], 0, 250)).toBe('No matches found');
    expect(pageGrepLines(lines, 5_000, 250)).toBe('No matches found');
  });
});

describe('guardToolOutput — dispatch-boundary hard cap', () => {
  it('names a next call for each tool shape and still respects the cap', () => {
    const guarded = guardToolOutput('y'.repeat(TOOL_OUTPUT_MAX_CHARS + 5_000));
    expect(guarded.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(guarded).toContain('Read with offset/limit');
    expect(guarded).toContain('Grep with head_limit/offset');
    expect(guarded).toContain('redirect to a file');
  });

  it('leaves an under-cap result unchanged', () => {
    expect(guardToolOutput('fine')).toBe('fine');
  });
});

describe('tool descriptions — each states its own truncation contract', () => {
  it('Read documents the range marker and the next offset', () => {
    expect(TOOL_DESCRIPTIONS.Read).toContain('offset');
    expect(TOOL_DESCRIPTIONS.Read.toLowerCase()).toContain('whole file');
  });

  it('Grep documents the head_limit cap and the continuation offset', () => {
    expect(TOOL_DESCRIPTIONS.Grep).toContain('head_limit');
    expect(TOOL_DESCRIPTIONS.Grep).toContain('next `offset`');
    expect(TOOL_DESCRIPTIONS.Grep).toContain('shown range');
  });

  it('Bash documents the head/tail cap and the redirect recovery', () => {
    expect(TOOL_DESCRIPTIONS.Bash).toContain('head and tail');
    expect(TOOL_DESCRIPTIONS.Bash).toContain('out.txt');
  });
});
