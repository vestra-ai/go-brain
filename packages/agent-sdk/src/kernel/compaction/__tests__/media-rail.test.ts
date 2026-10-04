import { describe, it, expect } from 'vitest';
import type { JournalEntry } from '../../../contract/journal.js';
import {
  applyMediaRail,
  RAIL_MAX_IMAGES,
  RAIL_MAX_MEDIA_BYTES,
  RAIL_PROTECT_NEWEST,
} from '../media-rail.js';

const mkToolResultImage = (i: number, dataLen: number): JournalEntry =>
  ({
    uuid: `u${i}`,
    seq: i,
    payload: {
      type: 'tool_result',
      toolUseId: `t${i}`,
      blocks: [
        { type: 'text', text: `Image file /files/img${i}.png` },
        { type: 'image', data: 'x'.repeat(dataLen), mediaType: 'image/png' },
      ],
    },
  }) as unknown as JournalEntry;

const mkUserImage = (i: number, url: string): JournalEntry =>
  ({
    uuid: `u${i}`,
    seq: i,
    payload: {
      type: 'user',
      blocks: [
        { type: 'image', data: '', mediaType: 'image/png', url },
        { type: 'text', text: 'look at this' },
      ],
    },
  }) as unknown as JournalEntry;

const mkText = (i: number): JournalEntry =>
  ({
    uuid: `u${i}`,
    seq: i,
    payload: { type: 'user', blocks: [{ type: 'text', text: `t${i}` }] },
  }) as unknown as JournalEntry;

const countImages = (entries: ReadonlyArray<JournalEntry>): number =>
  entries.reduce((n, e) => {
    const blocks = (e.payload as { blocks?: Array<{ type?: string }> }).blocks;
    return n + (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'image').length : 0);
  }, 0);

describe('applyMediaRail', () => {
  it('identity (same reference) when under both budgets', () => {
    const entries = [mkText(0), mkToolResultImage(1, 1000), mkUserImage(2, 'https://x/a.png')];
    expect(applyMediaRail(entries)).toBe(entries);
  });

  it('never throws on degenerate input', () => {
    expect(applyMediaRail([])).toEqual([]);
    const weird = [
      { uuid: 'w', payload: { type: 'tool_result', blocks: null } },
    ] as unknown as JournalEntry[];
    expect(() => applyMediaRail(weird)).not.toThrow();
  });

  it('count breach: evicts oldest down to 75% of the count budget', () => {
    const entries = Array.from({ length: RAIL_MAX_IMAGES + 5 }, (_, i) => mkToolResultImage(i, 10));
    const out = applyMediaRail(entries);
    expect(out).not.toBe(entries);
    expect(countImages(out)).toBe(Math.floor(RAIL_MAX_IMAGES * 0.75));
    // Oldest evicted first: entry 0 stubbed, the last entry untouched (same ref).
    expect(out[out.length - 1]).toBe(entries[entries.length - 1]);
    const firstBlocks = (out[0].payload as { blocks: Array<{ type: string; text?: string }> }).blocks;
    expect(firstBlocks.some((b) => b.type === 'image')).toBe(false);
    expect(firstBlocks.some((b) => b.type === 'text' && b.text?.includes('evicted'))).toBe(true);
  });

  it('byte breach: evicts oldest heavy images down to 75% of the byte budget', () => {
    const heavy = Math.ceil(RAIL_MAX_MEDIA_BYTES / 4);
    const entries = Array.from({ length: 6 }, (_, i) => mkToolResultImage(i, heavy)); // 1.5× budget
    const out = applyMediaRail(entries);
    expect(out).not.toBe(entries);
    expect(countImages(out)).toBeLessThanOrEqual(3); // 3×heavy = 0.75×budget
  });

  it('newest RAIL_PROTECT_NEWEST always survive', () => {
    const heavy = Math.ceil(RAIL_MAX_MEDIA_BYTES / 2);
    const entries = Array.from({ length: 5 }, (_, i) => mkToolResultImage(i, heavy)); // 2.5× budget
    const out = applyMediaRail(entries);
    for (let i = entries.length - RAIL_PROTECT_NEWEST; i < entries.length; i++) {
      const blocks = (out[i].payload as { blocks: Array<{ type: string }> }).blocks;
      expect(blocks.some((b) => b.type === 'image')).toBe(true);
    }
  });

  it('pair-safe: never deletes entries, keeps sibling text blocks', () => {
    const entries = Array.from({ length: RAIL_MAX_IMAGES + 3 }, (_, i) => mkToolResultImage(i, 10));
    const out = applyMediaRail(entries);
    expect(out.length).toBe(entries.length);
    const blocks = (out[0].payload as { blocks: Array<{ type: string; text?: string }> }).blocks;
    expect(blocks.some((b) => b.type === 'text' && b.text === 'Image file /files/img0.png')).toBe(true);
  });

  it('placeholder carries the filename from a url-bearing block', () => {
    const many = Array.from({ length: RAIL_MAX_IMAGES + 1 }, (_, i) =>
      i === 0
        ? mkUserImage(0, 'https://host/bucket/inline-123-ab.png?token=zzz')
        : mkToolResultImage(i, 10),
    );
    const out = applyMediaRail(many);
    const blocks = (out[0].payload as { blocks: Array<{ type: string; text?: string }> }).blocks;
    expect(blocks.map((b) => b.text).join(' ')).toContain('inline-123-ab.png');
  });

  it('placeholder prefers the ref filename over the url basename (S2)', () => {
    const withRef: JournalEntry = {
      uuid: 'u0',
      seq: 0,
      payload: {
        type: 'user',
        blocks: [
          {
            type: 'image',
            data: '',
            mediaType: 'image/png',
            url: 'https://host/uploads/user-1/9f3a-uuid.png?token=zzz',
            filename: 'stamp v2.png',
          },
          { type: 'text', text: 'look' },
        ],
      },
    } as unknown as JournalEntry;
    const many = [withRef, ...Array.from({ length: RAIL_MAX_IMAGES }, (_, i) => mkToolResultImage(i + 1, 10))];
    const out = applyMediaRail(many);
    const blocks = (out[0].payload as { blocks: Array<{ type: string; text?: string }> }).blocks;
    const joined = blocks.map((b) => b.text).join(' ');
    expect(joined).toContain('stamp v2.png');
    expect(joined).not.toContain('9f3a-uuid.png');
  });

  it('S2 mirror pin: a ref-carrying image entry serializes far under the 250KB mirror cap', () => {
    // The S2 win the server mirror depends on: user images journal as refs
    // (data:'') — an entry that used to carry 120-200KB of base64 is now ~500B,
    // so the kernel-journal mirror's 250,000-byte entry cap never truncates it.
    const entry = {
      uuid: 'u-pin',
      seq: 0,
      payload: {
        type: 'user',
        blocks: [
          {
            type: 'image',
            data: '',
            mediaType: 'image/png',
            url: 'https://host.supabase.co/storage/v1/object/sign/uploads/user/9f3a.png?token=' + 'x'.repeat(220),
            filename: 'stamp v2.png',
            sizeBytes: 503_033,
            contentSha: 'ab'.repeat(32),
            originTaskId: 'task-origin-1',
          },
          { type: 'text', text: 'what is on this stamp?' },
        ],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(2_000);
  });

  it('idempotent: a second run over a railed projection is identity', () => {
    const entries = Array.from({ length: RAIL_MAX_IMAGES + 5 }, (_, i) => mkToolResultImage(i, 10));
    const once = applyMediaRail(entries);
    expect(applyMediaRail(once)).toBe(once);
  });
});
