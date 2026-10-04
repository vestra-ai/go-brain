/**
 * Cobrowse P1 (Perception V2) — pruneSnapshots: prune stale AX page-snapshots.
 *
 * Pure in-memory fixtures only. No disk, no Journal, no model call.
 * Mirrors the entry() fixture builder from prune-screenshots.test.ts.
 *
 * Contract under test (mirrors prune-screenshots.ts):
 *  - ReadonlyArray in; SAME reference out when nothing changes (≤2 snapshot
 *    tool_results) — this is also the flag-OFF byte-identical guarantee: the
 *    header only exists when BROWSER_PERCEPTION_V2 emitted it, so a flag-off
 *    journal ALWAYS takes the identity path (no env read in the kernel).
 *  - Keep the LATEST KEEP_RECENT_SNAPSHOTS (=2) snapshot-bearing tool_result
 *    entries intact; every OLDER one has its header-matched text block(s)
 *    replaced by `{type:'text', text: SNAPSHOT_PRUNE_PLACEHOLDER}`.
 *  - NEVER deletes an entry (pairing stays valid); NEVER touches tool_use.
 *  - Only a text block STARTING with the header counts — header mid-text
 *    (page-planted) never matches; non-header tool_results are ignored.
 *  - idempotent (a re-run is deep-equal AND returns identity); never throws on
 *    degenerate input.
 */

import { describe, it, expect } from 'vitest';
import {
  pruneSnapshots,
  SNAPSHOT_TEXT_HEADER,
  SNAPSHOT_PRUNE_PLACEHOLDER,
  KEEP_RECENT_SNAPSHOTS,
} from '../prune-snapshots.js';
import type { JournalEntry } from '../../../contract/journal.js';
import type { ContentBlock } from '../../../contract/blocks.js';

// ─── Fixture builder ──────────────────────────────────────────────────────────

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

const TXT = (text: string): ContentBlock => ({ type: 'text', text });
const IMG = (data = 'B64'): ContentBlock => ({ type: 'image', data, mediaType: 'image/jpeg' });
/** A flag-on snapshot text block: header first line, body below. */
const SNAP = (body = 'button "Submit" @e1'): ContentBlock =>
  TXT(`${SNAPSHOT_TEXT_HEADER}\n${body}`);

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
    payload = { type: 'tool_use', toolUseId: opts.toolUseId ?? `tu-${seq}`, name: 'computer_snapshot', input: {} };
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
const hasSnapshot = (e: JournalEntry): boolean =>
  trBlocks(e).some((b) => b.type === 'text' && typeof (b as { text?: string }).text === 'string' && (b as { text: string }).text.startsWith(SNAPSHOT_TEXT_HEADER));
const placeholderCount = (e: JournalEntry): number =>
  trBlocks(e).filter((b) => b.type === 'text' && (b as { text?: string }).text === SNAPSHOT_PRUNE_PLACEHOLDER).length;

describe('pruneSnapshots — constants', () => {
  it('SNAPSHOT_TEXT_HEADER matches the flag-on snapshot first line exactly', () => {
    expect(SNAPSHOT_TEXT_HEADER).toBe('[page snapshot · visual order]');
  });
  it('KEEP_RECENT_SNAPSHOTS === 2', () => {
    expect(KEEP_RECENT_SNAPSHOTS).toBe(2);
  });
  it('SNAPSHOT_PRUNE_PLACEHOLDER is pinned and does NOT itself match the header (idempotency)', () => {
    expect(SNAPSHOT_PRUNE_PLACEHOLDER).toBe(
      '[page snapshot from an earlier step — superseded; call computer_snapshot for current state]',
    );
    expect(SNAPSHOT_PRUNE_PLACEHOLDER.startsWith(SNAPSHOT_TEXT_HEADER)).toBe(false);
  });
});

describe('pruneSnapshots — keep-window', () => {
  it('Test 1 — KEEP=2: 4 snapshot tool_results → 2 OLDEST stubbed, 2 NEWEST keep snapshot text', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('snap-a')] }), // oldest → stub
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('snap-b')] }), // stub
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('snap-c')] }), // keep
      entry('tool_result', { toolUseId: 'd', blocks: [SNAP('snap-d')] }), // newest → keep
    ];
    const out = pruneSnapshots(entries);

    expect(out).toHaveLength(4);
    // Oldest two: snapshot text replaced with placeholder.
    expect(hasSnapshot(out[0])).toBe(false);
    expect(hasSnapshot(out[1])).toBe(false);
    expect(placeholderCount(out[0])).toBe(1);
    expect(placeholderCount(out[1])).toBe(1);
    // Newest two: snapshot text intact.
    expect(hasSnapshot(out[2])).toBe(true);
    expect(hasSnapshot(out[3])).toBe(true);
    expect((trBlocks(out[3])[0] as { text: string }).text).toContain('snap-d');
    // Stubbed entries are NEW references; kept entries are SAME references.
    expect(out[0]).not.toBe(entries[0]);
    expect(out[2]).toBe(entries[2]);
    expect(out[3]).toBe(entries[3]);
  });
});

describe('pruneSnapshots — identity', () => {
  it('Test 2 — ≤2 snapshot tool_results → SAME array reference', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'hi' }),
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP()] }),
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP()] }),
    ];
    const out = pruneSnapshots(entries);
    expect(out).toBe(entries); // same reference — nothing changed
  });

  it('zero snapshot tool_results → SAME array reference (the flag-OFF / non-browser case)', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'hi' }),
      entry('assistant', { text: 'reply' }),
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', text: 'plain text result' }),
      entry('tool_result', { toolUseId: 'b', blocks: [IMG()] }), // screenshot ≠ snapshot
    ];
    const out = pruneSnapshots(entries);
    expect(out).toBe(entries);
  });
});

describe('pruneSnapshots — ignores tool_results without the header', () => {
  it('Test 3 — plain-text and image tool_results are never counted, never stubbed', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'p', text: 'plain result' }),        // ignored
      entry('tool_result', { toolUseId: 'i', blocks: [IMG('img')] }),        // ignored
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }),         // oldest snapshot → stub
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),         // keep
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),         // keep
    ];
    const out = pruneSnapshots(entries);
    // Non-snapshot results untouched, SAME reference.
    expect(out[0]).toBe(entries[0]);
    expect(out[1]).toBe(entries[1]);
    // Oldest snapshot stubbed; 2 newest kept.
    expect(hasSnapshot(out[2])).toBe(false);
    expect(placeholderCount(out[2])).toBe(1);
    expect(hasSnapshot(out[3])).toBe(true);
    expect(hasSnapshot(out[4])).toBe(true);
  });

  it('header MID-text (page-planted) never matches — startsWith, not includes', () => {
    resetSeq();
    const planted = TXT(`the page says ${SNAPSHOT_TEXT_HEADER} in visible text`);
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'x', blocks: [planted] }), // NOT a snapshot
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
    ];
    // planted doesn't count → only 2 real snapshots → identity.
    const out = pruneSnapshots(entries);
    expect(out).toBe(entries);
    expect(trBlocks(out[0])).toEqual([planted]);
  });

  it('a USER entry containing the header text is never counted, never stubbed', () => {
    resetSeq();
    const userSnapLike = entry('user', { blocks: [SNAP('pasted by user')] });
    const entries: JournalEntry[] = [
      userSnapLike,
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }), // oldest tool_result → stub
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }), // keep
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }), // keep
    ];
    const out = pruneSnapshots(entries);
    // user entry untouched (same reference), does not count toward the window.
    expect(out[0]).toBe(entries[0]);
    expect(hasSnapshot(out[1])).toBe(false);
    expect(hasSnapshot(out[2])).toBe(true);
    expect(hasSnapshot(out[3])).toBe(true);
  });
});

describe('pruneSnapshots — sibling blocks', () => {
  it('Test 4 — a tool_result [text, snapshot] keeps the sibling text, replaces only the header-matched block', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [TXT('kept text'), SNAP('a')] }), // oldest → stub snapshot
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),
    ];
    const out = pruneSnapshots(entries);
    const blocks = trBlocks(out[0]);
    expect(blocks).toEqual([TXT('kept text'), TXT(SNAPSHOT_PRUNE_PLACEHOLDER)]);
    expect(blocks).toHaveLength(2); // replaced, never deleted
  });

  it('an image sibling in a stubbed snapshot result is preserved (screenshots are pruneScreenshots territory)', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a'), IMG('shot-a')] }), // oldest → stub text only
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),
    ];
    const out = pruneSnapshots(entries);
    expect(trBlocks(out[0])).toEqual([TXT(SNAPSHOT_PRUNE_PLACEHOLDER), IMG('shot-a')]);
  });
});

describe('pruneSnapshots — never deletes / never touches tool_use', () => {
  it('Test 5 — output length === input length; no orphaned tool_use; tool_use untouched', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_use', { toolUseId: 'a' }),
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }), // oldest → stub
      entry('tool_use', { toolUseId: 'b' }),
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
      entry('tool_use', { toolUseId: 'c' }),
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),
    ];
    const out = pruneSnapshots(entries);
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

describe('pruneSnapshots — idempotent', () => {
  it('Test 6 — running twice is deep-equal; the second run returns identity', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),
      entry('tool_result', { toolUseId: 'd', blocks: [SNAP('d')] }),
    ];
    const once = pruneSnapshots(entries);
    const twice = pruneSnapshots(once);
    expect(twice).toEqual(once); // deep-equal
    expect(twice).toBe(once);    // second run = identity (placeholder doesn't match the header)
  });
});

describe('pruneSnapshots — degenerate input never throws', () => {
  it('Test 7 — empty array, empty blocks, missing text', () => {
    resetSeq();
    expect(() => pruneSnapshots([])).not.toThrow();
    expect(pruneSnapshots([])).toEqual([]);

    const weird: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [] }),                       // empty blocks
      entry('tool_result', { toolUseId: 'b', blocks: [{ type: 'text' } as unknown as ContentBlock] }), // missing text
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP()] }),
    ];
    expect(() => pruneSnapshots(weird)).not.toThrow();
  });
});

describe('pruneSnapshots — incremental window slide', () => {
  it('Test 8 — append one snapshot at a time; after K only latest 2 keep text, 1..K-2 stubbed (never resurrected)', () => {
    resetSeq();
    const entries: JournalEntry[] = [];
    let prev: JournalEntry[] = entries;
    for (let k = 1; k <= 6; k++) {
      entries.push(entry('tool_result', { toolUseId: `tu-${k}`, blocks: [SNAP(`snap-${k}`)] }));
      const out = pruneSnapshots(entries);
      const snapshotBearing = out.filter((e) => e.payload.type === 'tool_result' && hasSnapshot(e));
      if (k <= KEEP_RECENT_SNAPSHOTS) {
        expect(snapshotBearing).toHaveLength(k);
      } else {
        // exactly the latest 2 keep snapshot text; all older are stubbed.
        expect(snapshotBearing).toHaveLength(KEEP_RECENT_SNAPSHOTS);
        for (let i = 0; i < out.length - KEEP_RECENT_SNAPSHOTS; i++) {
          expect(hasSnapshot(out[i])).toBe(false);
          expect(placeholderCount(out[i])).toBe(1);
        }
      }
      prev = out;
    }
    // Final: the oldest stays stubbed (no resurrection).
    expect(hasSnapshot(prev[0])).toBe(false);
  });
});

describe('pruneSnapshots — purity (input not mutated)', () => {
  it('never mutates the input entries or their block arrays', () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('tool_result', { toolUseId: 'a', blocks: [SNAP('a')] }),
      entry('tool_result', { toolUseId: 'b', blocks: [SNAP('b')] }),
      entry('tool_result', { toolUseId: 'c', blocks: [SNAP('c')] }),
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    pruneSnapshots(entries);
    expect(entries).toEqual(snapshot); // raw input untouched (projection-only)
  });
});
