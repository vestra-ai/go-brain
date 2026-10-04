/**
 * SCREENSHOT_PRUNE_CACHE_V1 — the screenshot prune with the host's policy (prod incident 10-03,
 * task 28edef30): only the host's screenshot tools count (by the paired tool_use's exact name),
 * and the stubbing moves in whole batches, so the history the model sees is edited once a batch
 * and never by an image Read. No policy ⇒ the legacy pass (prune-screenshots.test.ts pins it).
 *
 * "Edit" below = a projection whose earlier entries differ from the previous projection's: the
 * thing that throws away a provider's prompt cache from that point on.
 */
import { describe, it, expect } from 'vitest';
import {
  pruneScreenshots,
  KEEP_RECENT_SCREENSHOTS,
  SCREENSHOT_PRUNE_BATCH,
  SCREENSHOT_PRUNE_PLACEHOLDER,
  type ScreenshotPrunePolicy,
} from '../prune-screenshots.js';
import type { JournalEntry } from '../../../contract/journal.js';
import type { ContentBlock } from '../../../contract/blocks.js';

const SCREENSHOT = 'mcp__browser-control__computer_screenshot';
const CLICK = 'mcp__browser-control__computer_click';
const POLICY: ScreenshotPrunePolicy = { tools: new Set([SCREENSHOT, CLICK]), batch: SCREENSHOT_PRUNE_BATCH };

let seq = 0;
function base(payload: JournalEntry['payload']): JournalEntry {
  const s = seq++;
  return {
    uuid: `e-${s}`, parentUuid: s === 0 ? null : `e-${s - 1}`, seq: s, taskId: 't', rootTaskId: 't', spawnDepth: 0,
    workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '2026-01-01T00:00:00.000Z', payload,
  };
}
const IMG = (data: string): ContentBlock => ({ type: 'image', data, mediaType: 'image/jpeg' });
/** One tool round: the call and its result carrying one image. */
function imageRound(name: string, i: number): JournalEntry[] {
  const id = `tu-${name}-${i}`;
  return [
    base({ type: 'tool_use', toolUseId: id, name, input: { i } }),
    base({ type: 'tool_result', toolUseId: id, blocks: [{ type: 'text', text: `result ${i}` }, IMG(`IMAGE-${i}`)] }),
  ];
}
const images = (es: JournalEntry[]): number =>
  es.filter((e) => e.payload.type === 'tool_result' && e.payload.blocks.some((b) => b.type === 'image')).length;
const stubs = (es: JournalEntry[]): number =>
  es.filter((e) => e.payload.type === 'tool_result' && e.payload.blocks.some((b) => b.type === 'text' && b.text === SCREENSHOT_PRUNE_PLACEHOLDER)).length;

/** Grow a journal one image round at a time; return the round numbers (1-based) whose projection edited history. */
function editsWhileGrowing(name: string, rounds: number, policy?: ScreenshotPrunePolicy): { edits: number[]; last: JournalEntry[] } {
  seq = 0;
  const raw: JournalEntry[] = [base({ type: 'user', blocks: [{ type: 'text', text: 'go' }] })];
  let prev: string[] = [];
  const edits: number[] = [];
  let last: JournalEntry[] = [];
  for (let r = 1; r <= rounds; r++) {
    raw.push(...imageRound(name, r));
    last = pruneScreenshots(raw, policy);
    const cur = last.map((e) => JSON.stringify(e));
    if (prev.some((p, i) => cur[i] !== p)) edits.push(r);
    prev = cur;
  }
  return { edits, last };
}

describe('SCREENSHOT_PRUNE_CACHE_V1: an image Read is not a screenshot', () => {
  it('eight image Reads: no edit to history at any step, every image kept (the 28edef30 shape)', () => {
    const { edits, last } = editsWhileGrowing('Read', 8, POLICY);
    expect(edits).toEqual([]);
    expect(images(last)).toBe(8);
    expect(stubs(last)).toBe(0);
  });

  it('without the policy the same journal edits history at image Reads 3 to 8 (the incident, pinned)', () => {
    // Mutation: drop the name check (count every image result) → the policy case above turns into this.
    const { edits, last } = editsWhileGrowing('Read', 8);
    expect(edits).toEqual([3, 4, 5, 6, 7, 8]);
    expect(images(last)).toBe(KEEP_RECENT_SCREENSHOTS);
  });

  it('a tool outside the catalog, and a result whose call is not in the projection, are left alone', () => {
    seq = 0;
    const orphan = base({ type: 'tool_result', toolUseId: 'gone', blocks: [IMG('ORPHAN')] });
    const es = [orphan, ...Array.from({ length: 12 }, (_, i) => imageRound('mcp__other__render', i)).flat()];
    expect(pruneScreenshots(es, POLICY)).toBe(es); // identity: nothing counts
  });
});

describe('SCREENSHOT_PRUNE_CACHE_V1: screenshots go in batches', () => {
  it('a browser run edits history once per batch, keeping 2 to 9 screenshots', () => {
    const { edits, last } = editsWhileGrowing(SCREENSHOT, 20, POLICY);
    // n - 2 reaches 8 at the 10th screenshot and 16 at the 18th: the only two edits in 20 steps.
    // Mutation: batch of 1 → an edit at every step from the 3rd.
    expect(edits).toEqual([10, 18]);
    expect(stubs(last)).toBe(16);
    expect(images(last)).toBe(4);
  });

  it('without the policy a browser run edits history at every step from the 3rd', () => {
    const { edits } = editsWhileGrowing(SCREENSHOT, 20);
    expect(edits).toEqual(Array.from({ length: 18 }, (_, i) => i + 3));
  });

  it('every catalog member counts, by its exact name', () => {
    seq = 0;
    const es = [...Array.from({ length: 5 }, (_, i) => imageRound(SCREENSHOT, i)).flat(), ...Array.from({ length: 5 }, (_, i) => imageRound(CLICK, i)).flat()];
    const out = pruneScreenshots(es, POLICY);
    expect(stubs(out)).toBe(8); // 10 screenshots: n - 2 = 8, one whole batch
    expect(images(out)).toBe(2);
    // A near-miss name is not a member (no prefix or pattern match).
    seq = 0;
    const near = Array.from({ length: 10 }, (_, i) => imageRound(`${SCREENSHOT}_v2`, i)).flat();
    expect(pruneScreenshots(near, POLICY)).toBe(near);
  });

  it('idempotent, and a bad batch value reads as 1', () => {
    const { last } = editsWhileGrowing(SCREENSHOT, 12, POLICY);
    expect(pruneScreenshots(last, POLICY)).toBe(last);
    seq = 0;
    const es = Array.from({ length: 4 }, (_, i) => imageRound(SCREENSHOT, i)).flat();
    expect(stubs(pruneScreenshots(es, { tools: POLICY.tools, batch: Number.NaN }))).toBe(2);
    expect(stubs(pruneScreenshots(es, { tools: POLICY.tools, batch: 0 }))).toBe(2);
  });
});
