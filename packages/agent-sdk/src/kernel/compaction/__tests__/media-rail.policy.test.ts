/**
 * SCREENSHOT_PRUNE_CACHE_V1 — the media rail's policy (#4357 review H1, M1). The rail is a pure
 * function of the projection, so the legacy "evict to 75%" has no memory: past 20 images it keeps
 * the newest 15 and every new image moves the cut (pinned below as the legacy cadence). With the
 * policy the cut moves once per batch of 6, and the byte budget (under every lane's inline cap)
 * binds the newest images too.
 */
import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '../../../contract/journal.js';
import {
  applyMediaRail,
  RAIL_BATCH,
  RAIL_INLINE_SAFE_BYTES,
  RAIL_MAX_IMAGES,
  REQUEST_TEXT_HEADROOM,
  SMALLEST_INLINE_REQUEST_CAP,
  type MediaRailPolicy,
} from '../media-rail.js';

const POLICY: MediaRailPolicy = { maxBytes: RAIL_INLINE_SAFE_BYTES, batch: RAIL_BATCH };

const image = (i: number, chars: number): JournalEntry =>
  ({
    uuid: `u${i}`, seq: i,
    payload: { type: 'tool_result', toolUseId: `t${i}`, blocks: [{ type: 'text', text: `Image file /work/img${i}.jpg` }, { type: 'image', data: `${i}`.padEnd(chars, 'A'), mediaType: 'image/jpeg' }] },
  }) as unknown as JournalEntry;
const kept = (es: JournalEntry[]) =>
  es.filter((e) => (e.payload as { blocks: Array<{ type: string }> }).blocks.some((b) => b.type === 'image'));
const keptChars = (es: JournalEntry[]) =>
  kept(es).reduce((n, e) => n + ((e.payload as { blocks: Array<{ type: string; data?: string }> }).blocks.find((b) => b.type === 'image')!.data!.length), 0);

/** Grow by one image at a time; the 1-based image counts whose projection changed an earlier entry. */
function cadence(n: number, chars: number, policy?: MediaRailPolicy): number[] {
  const raw: JournalEntry[] = [];
  let prev: string[] = [];
  const edits: number[] = [];
  for (let i = 1; i <= n; i++) {
    raw.push(image(i, chars));
    const cur = applyMediaRail(raw, policy).map((e) => JSON.stringify(e));
    if (prev.some((p, k) => cur[k] !== p)) edits.push(i);
    prev = cur;
  }
  return edits;
}

describe('media rail policy: the budget is provably under every lane\'s inline cap', () => {
  it('images plus the text headroom fit the smallest inline cap (Gemini 20 MB), and so every larger one', () => {
    expect(RAIL_INLINE_SAFE_BYTES + REQUEST_TEXT_HEADROOM).toBeLessThanOrEqual(SMALLEST_INLINE_REQUEST_CAP);
    for (const cap of [20_000_000, 32_000_000, 50_000_000]) expect(RAIL_INLINE_SAFE_BYTES + REQUEST_TEXT_HEADROOM).toBeLessThanOrEqual(cap);
  });

  it('ten 5 MB images: the request carries at most the budget, the newest is always kept', () => {
    const five = Math.ceil((5 * 1024 * 1024) / 3) * 4; // base64 of 5 MiB
    const raw = Array.from({ length: 10 }, (_, i) => image(i + 1, five));
    const out = applyMediaRail(raw, POLICY);
    expect(keptChars(out)).toBeLessThanOrEqual(RAIL_INLINE_SAFE_BYTES);
    expect(kept(out).map((e) => e.seq)).toEqual([10]);
    // Mutation: the legacy rail (24 MiB, newest three protected) → three 7 MB images ride.
    expect(keptChars(applyMediaRail(raw))).toBeGreaterThan(SMALLEST_INLINE_REQUEST_CAP);
  });
});

describe('media rail policy: the cut moves once per batch', () => {
  it('by count: edits at the 21st, 27th and 33rd image, keeping 15 to 20', () => {
    expect(cadence(36, 300_000, POLICY)).toEqual([21, 27, 33]);
    const raw = Array.from({ length: 26 }, (_, i) => image(i + 1, 300_000));
    expect(kept(applyMediaRail(raw, POLICY))).toHaveLength(20);
    expect(kept(applyMediaRail(raw.slice(0, 21), POLICY))).toHaveLength(15);
    expect(RAIL_MAX_IMAGES).toBe(20);
  });

  it('the legacy rail moves the cut at every image past the 20th (why the policy exists)', () => {
    expect(cadence(26, 300_000)).toEqual([21, 22, 23, 24, 25, 26]);
  });

  it('by bytes: large images move the cut in batches too, never past the newest that fits', () => {
    // ~2.7 MB of base64 each: about five fit the budget; the cut moves in steps, not every image.
    const edits = cadence(30, 2_700_000, POLICY);
    expect(edits.length).toBeLessThan(30 - 5);
    const raw = Array.from({ length: 30 }, (_, i) => image(i + 1, 2_700_000));
    const out = applyMediaRail(raw, POLICY);
    expect(keptChars(out)).toBeLessThanOrEqual(RAIL_INLINE_SAFE_BYTES);
    expect(kept(out).at(-1)!.seq).toBe(30);
  });

  it('under both budgets: identity, the same array (flag on or off)', () => {
    const raw = Array.from({ length: 20 }, (_, i) => image(i + 1, 100_000));
    expect(applyMediaRail(raw, POLICY)).toBe(raw);
    expect(applyMediaRail(raw)).toBe(raw);
  });
});
