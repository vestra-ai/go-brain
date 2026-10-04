/**
 * Task 6 — pruneScreenshots: the SINGLE native screenshot-prune authority.
 *
 * Pure in-memory fixtures only. No disk, no Journal, no model call.
 * Mirrors the entry() fixture builder from prune.test.ts / compactor.test.ts.
 *
 * Contract under test (mirrors prune.ts):
 *  - ReadonlyArray in; SAME reference out when nothing changes (≤2 image
 *    tool_results).
 *  - Keep the LATEST KEEP_RECENT_SCREENSHOTS (=2) image-bearing tool_result
 *    entries with their ImageBlocks intact; every OLDER one has its image
 *    block(s) replaced by a `{type:'text', text: SCREENSHOT_PRUNE_PLACEHOLDER}`.
 *  - NEVER deletes an entry (pairing stays valid); NEVER touches tool_use.
 *  - NEVER counts/stubs a USER-uploaded ImageBlock — only tool_result payload
 *    images count toward the window and get stubbed.
 *  - idempotent (a re-run is deep-equal AND returns identity); never throws on
 *    degenerate input.
 */

import { describe, it, expect } from 'vitest';
import {
  pruneScreenshots,
  SCREENSHOT_PRUNE_PLACEHOLDER,
  KEEP_RECENT_SCREENSHOTS,
} from '../prune-screenshots.js';
import type { JournalEntry } from '../../../contract/journal.js';
import type { ContentBlock } from '../../../contract/blocks.js';

// ─── Fixture builder ──────────────────────────────────────────────────────────

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

const IMG = (data = 'B64'): ContentBlock => ({ type: 'image', data, mediaType: 'image/jpeg' });
const TXT = (text: string): ContentBlock => ({ type: 'text', text });

function entry(
  type: JournalEntry['payload']['type'],
  opts: { blocks?: ContentBlock[]; toolUseId?: string; text?: string } = {},
): JournalEntry {
  const seq = _seq++;
  let payload: JournalEntry['payload'];
  if (type === 'user') {
    payload = { type: 'user', blocks: opts.blocks ?? [TXT(opts.text ?? '')] };
  } else if (type === 'assistant') {
    payload = { type: 'assistant', blocks: opts.blocks ?? [TXT(opts.text ?? '')] };
  } else if (type === 'tool_use') {
    payload = { type: 'tool_use', toolUseId: opts.toolUseId ?? `tu-${seq}`, name: 'computer_screenshot', input: {} };
  } else if (type === 'tool_result') {
    payload = { type: 'tool_result', toolUseId: opts.toolUseId ?? `tu-${seq}`, blocks: opts.blocks ?? [TXT(opts.text ?? '')] };
  } else {
    payload = { type: 'custom', key: 'x', data: null };
  }
  return {
    uuid: `entry-${seq}`,
    parentUuid: seq === 0 ? null : `entry-${seq - 1}`,
    seq,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'g',
    principal: { kind: 'system' },
    timestamp: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** Pull a tool_result entry's blocks for assertions. */
const trBlocks = (e: JournalEntry): ContentBlock[] =>
  (e.payload as { blocks: ContentBlock[] }).blocks;
const hasImage = (e: JournalEntry): boolean => trBlocks(e).some((b) => b.type === 'image');
const placeholderCount = (e: JournalEntry): number =>
  trBlocks(e).filter((b) => b.type === 'text' && b.text === SCREENSHOT_PRUNE_PLACEHOLDER).length;

describe('pruneScreenshots — constants', () => {
  it('KEEP_RECENT_SCREENSHOTS === 2', () => {
    expect(KEEP_RECENT_SCREENSHOTS).toBe(2);
  });
  it('SCREENSHOT_PRUNE_PLACEHOLDER matches the canonical Claude-hook value', () => {
    expect(SCREENSHOT_PRUNE_PLACEHOLDER).toBe(
      '[screenshot from earlier turn — truncated for context efficiency]',
    );
  });
});

describe('pruneScreenshots — keep-window', () => {
  it('Test 1 — KEEP=2: 4 image tool_results → 2 OLDEST stubbed, 2 NEWEST keep image data', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('img-a')] }), // oldest → stub
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('img-b')] }), // stub
      entry('tool_result', { toolUseId: 'c', blocks: [IMG('img-c')] }), // keep
      entry('tool_result', { toolUseId: 'd', blocks: [IMG('img-d')] }), // newest → keep
    ];
    const out = pruneScreenshots(entries);

    expect(out).toHaveLength(4);
    // Oldest two: image replaced with placeholder text.
    expect(hasImage(out[0])).toBe(false);
    expect(hasImage(out[1])).toBe(false);
    expect(placeholderCount(out[0])).toBe(1);
    expect(placeholderCount(out[1])).toBe(1);
    // Newest two: image data intact.
    expect(hasImage(out[2])).toBe(true);
    expect(hasImage(out[3])).toBe(true);
    expect((trBlocks(out[3])[0] as { data: string }).data).toBe('img-d');
    // Stubbed entries are NEW references; kept entries are SAME references.
    expect(out[0]).not.toBe(entries[0]);
    expect(out[2]).toBe(entries[2]);
    expect(out[3]).toBe(entries[3]);
  });
});

describe('pruneScreenshots — identity', () => {
  it('Test 2 — ≤2 image tool_results → SAME array reference', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'hi' }),
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', blocks: [IMG()] }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG()] }),
    ];
    const out = pruneScreenshots(entries);
    expect(out).toBe(entries); // same reference — nothing changed
  });

  it('zero image tool_results → SAME array reference (the non-browser 99% case)', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'hi' }),
      entry('assistant', { text: 'reply' }),
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', text: 'plain text result' }),
    ];
    const out = pruneScreenshots(entries);
    expect(out).toBe(entries);
  });
});

describe('pruneScreenshots — sibling text', () => {
  it('Test 3 — a tool_result [text,image] keeps the text, replaces only the image', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [TXT('kept text'), IMG('img-a')] }), // oldest → stub image
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('img-b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [IMG('img-c')] }),
    ];
    const out = pruneScreenshots(entries);
    const blocks = trBlocks(out[0]);
    expect(blocks).toEqual([TXT('kept text'), TXT(SCREENSHOT_PRUNE_PLACEHOLDER)]);
    // sibling TextBlock preserved, image replaced — never deleted.
    expect(blocks).toHaveLength(2);
  });

  it('a tool_result with MULTIPLE images replaces each image with its own placeholder', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('1'), TXT('mid'), IMG('2')] }), // oldest → stub both
      entry('tool_result', { toolUseId: 'b', blocks: [IMG()] }),
      entry('tool_result', { toolUseId: 'c', blocks: [IMG()] }),
    ];
    const out = pruneScreenshots(entries);
    expect(trBlocks(out[0])).toEqual([
      TXT(SCREENSHOT_PRUNE_PLACEHOLDER),
      TXT('mid'),
      TXT(SCREENSHOT_PRUNE_PLACEHOLDER),
    ]);
  });
});

describe('pruneScreenshots — never deletes / never touches tool_use', () => {
  it('Test 4 — output length === input length; no orphaned tool_use; tool_use untouched', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', blocks: [IMG()] }), // oldest → stub
      entry('tool_use', { toolUseId: 'b' }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG()] }),
      entry('tool_use', { toolUseId: 'c' }),
      entry('tool_result', { toolUseId: 'c', blocks: [IMG()] }),
    ];
    const out = pruneScreenshots(entries);
    expect(out).toHaveLength(entries.length);
    // Every tool_use survives, by SAME reference (never touched).
    expect(out[0]).toBe(entries[0]);
    expect(out[2]).toBe(entries[2]);
    expect(out[4]).toBe(entries[4]);
    // Every tool_use still has its paired tool_result somewhere in the output.
    for (const id of ['a', 'b', 'c']) {
      const hasUse = out.some((e) => e.payload.type === 'tool_use' && (e.payload as { toolUseId: string }).toolUseId === id);
      const hasRes = out.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === id);
      expect(hasUse && hasRes).toBe(true);
    }
  });
});

describe('pruneScreenshots — ignores non-tool_result images', () => {
  it('Test 5 — a USER entry uploaded image is never counted, never stubbed', () => {
    resetSeq();
    const userImg = entry('user', { blocks: [TXT('look at this'), IMG('user-upload')] });
    const entries: JournalEntry[] = [
      userImg,
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('tr-a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('tr-b')] }),
    ];
    // Only 2 tool_result images → within the keep window → identity.
    const out = pruneScreenshots(entries);
    expect(out).toBe(entries);
    // The user upload image survives untouched.
    expect((out[0].payload as { blocks: ContentBlock[] }).blocks).toEqual([TXT('look at this'), IMG('user-upload')]);
  });

  it('a USER uploaded image does NOT count toward the keep window (3 tool_results still stub the oldest)', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { blocks: [IMG('user-upload')] }),                  // not counted, not stubbed
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('tr-a')] }),  // oldest tool_result → stub
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('tr-b')] }),  // keep
      entry('tool_result', { toolUseId: 'c', blocks: [IMG('tr-c')] }),  // keep
    ];
    const out = pruneScreenshots(entries);
    // user upload untouched (same reference)
    expect(out[0]).toBe(entries[0]);
    expect((out[0].payload as { blocks: ContentBlock[] }).blocks).toEqual([IMG('user-upload')]);
    // oldest tool_result stubbed; the 2 newest tool_results kept.
    expect(hasImage(out[1])).toBe(false);
    expect(hasImage(out[2])).toBe(true);
    expect(hasImage(out[3])).toBe(true);
  });
});

describe('pruneScreenshots — idempotent', () => {
  it('Test 6 — running twice is deep-equal; the second run returns identity', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [IMG('c')] }),
      entry('tool_result', { toolUseId: 'd', blocks: [IMG('d')] }),
    ];
    const once = pruneScreenshots(entries);
    const twice = pruneScreenshots(once);
    expect(twice).toEqual(once); // deep-equal
    expect(twice).toBe(once);    // second run = identity (already-stubbed has no image to re-count)
  });
});

describe('pruneScreenshots — degenerate input never throws', () => {
  it('Test 7 — empty array, empty blocks, missing text', () => {
    resetSeq();
    expect(() => pruneScreenshots([])).not.toThrow();
    expect(pruneScreenshots([])).toEqual([]);

    const weird: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [] }),                       // empty blocks
      entry('tool_result', { toolUseId: 'b', blocks: [{ type: 'text' } as unknown as ContentBlock] }), // missing text
      entry('tool_result', { toolUseId: 'c', blocks: [IMG()] }),
    ];
    expect(() => pruneScreenshots(weird)).not.toThrow();
  });
});

describe('pruneScreenshots — incremental window slide', () => {
  it('Test 8 — append one screenshot at a time; after K only latest 2 keep images, 1..K-2 stubbed (never resurrected)', () => {
    resetSeq();
    const entries: JournalEntry[] = [];
    let prev: JournalEntry[] = entries;
    for (let k = 1; k <= 6; k++) {
      entries.push(entry('tool_result', { toolUseId: `tu-${k}`, blocks: [IMG(`img-${k}`)] }));
      const out = pruneScreenshots(entries);
      const imageBearing = out.filter((e) => e.payload.type === 'tool_result' && hasImage(e));
      if (k <= KEEP_RECENT_SCREENSHOTS) {
        expect(imageBearing).toHaveLength(k);
      } else {
        // exactly the latest 2 keep images; all older are stubbed.
        expect(imageBearing).toHaveLength(KEEP_RECENT_SCREENSHOTS);
        for (let i = 0; i < out.length - KEEP_RECENT_SCREENSHOTS; i++) {
          expect(hasImage(out[i])).toBe(false);
          expect(placeholderCount(out[i])).toBe(1);
        }
      }
      prev = out;
    }
    // Final: the oldest stays stubbed (no resurrection).
    expect(hasImage(prev[0])).toBe(false);
  });
});

describe('pruneScreenshots — purity (input not mutated)', () => {
  it('never mutates the input entries or their block arrays', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [IMG('a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [IMG('c')] }),
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    pruneScreenshots(entries);
    expect(entries).toEqual(snapshot); // raw input untouched (projection-only)
  });
});
