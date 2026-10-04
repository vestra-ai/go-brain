/**
 * CONTEXT_ELISION_V1 — eliding-projection tests.
 *
 * Pure in-memory fixtures only. No disk, no Journal, no model call.
 * Mirrors the entry() fixture builder from prune.test.ts.
 *
 * The load-bearing cases are the two INVARIANTS the cache design rests on
 * (case 5: the cut is always on the stride grid; case 6: the cut never retreats
 * as the journal grows). If either regresses, elision becomes a per-turn
 * mid-history rewrite and costs more than it saves — so they are asserted
 * directly, not inferred from output size.
 */

import { describe, it, expect } from 'vitest';
import {
  computeElisionCut,
  elideProjection,
  applyElision,
  clampCutMonotonic,
  anchorFor,
  spillPathFor,
  DEFAULT_ELISION_POLICY,
  type ElisionCut,
} from '../elide.js';
import type { JournalEntry } from '../../../contract/journal.js';
import { estimateTokens } from '../../journal/token-ledger.js';
import type { ImageMediaType } from '../../../contract/blocks.js';
// `fenceRecall` is DEFINED here; `engine/recall.ts` only re-exports it. The kernel —
// tests included — may import `contract/`, never `engine/`.
import { fenceRecall } from '../../../contract/injected-user-text.js';

// ─── Fixture builder ──────────────────────────────────────────────────────────

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

function entry(
  type: JournalEntry['payload']['type'],
  opts: { text?: string; toolUseId?: string; name?: string; images?: number } = {},
): JournalEntry {
  const seq = _seq++;
  const text = opts.text ?? '';
  const images = Array.from({ length: opts.images ?? 0 }, () => ({
    type: 'image' as const,
    data: 'AAAA',
    mediaType: 'image/png' as ImageMediaType,
    filename: 'screen.png',
    sizeBytes: 102_400,
  }));
  let payload: JournalEntry['payload'];
  if (type === 'user') {
    payload = { type: 'user', blocks: [{ type: 'text', text }, ...images] };
  } else if (type === 'assistant') {
    payload = { type: 'assistant', blocks: [{ type: 'text', text }, ...images] };
  } else if (type === 'tool_use') {
    payload = {
      type: 'tool_use',
      toolUseId: opts.toolUseId ?? `tu-${seq}`,
      name: opts.name ?? 'Read',
      input: { path: '/x' },
    };
  } else if (type === 'tool_result') {
    payload = {
      type: 'tool_result',
      toolUseId: opts.toolUseId ?? `tu-${seq}`,
      blocks: [{ type: 'text', text }, ...images],
    };
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

/** The elide ruler, re-derived for the offset assertion: TEXT BLOCKS ONLY, tool_use by
 *  its serialized input — the same rule elide.ts `entryTokens` applies. */
function entryTokensForTest(e: JournalEntry): number {
  const p = e.payload as { type: string; input?: unknown; blocks?: Array<{ type: string; text?: string }> };
  if (p.type === 'tool_use') return estimateTokens(JSON.stringify(p.input));
  if (!p.blocks) return 0;
  let text = '';
  for (const b of p.blocks) if (b.type === 'text' && b.text) text += b.text + ' ';
  return estimateTokens(text);
}

/** ~5,000 estimated tokens (20,000 chars / 4). */
const bigBody = 'word '.repeat(4_000);
const smallBody = 'ok';
/** The COMPACTION TRIGGER, not the context window — see elide.ts's base note.
 *  200,000 is the trigger a 250k-window model with no preferred ceiling would
 *  have; keeping the number lets every pre-existing case below read unchanged. */
const BUDGET = 200_000;

/** A conversation of `turns` user→tool_use→tool_result→assistant rounds. */
function conversation(turns: number, body = bigBody): JournalEntry[] {
  resetSeq();
  const out: JournalEntry[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(entry('user', { text: `ask ${i}` }));
    out.push(entry('tool_use', { toolUseId: `tu-${i}`, name: 'Read' }));
    out.push(entry('tool_result', { toolUseId: `tu-${i}`, text: body }));
    out.push(entry('assistant', { text: `answer ${i}` }));
  }
  return out;
}

// ─── Case 1: short conversations are never touched ────────────────────────────

describe('computeElisionCut — case 1: nothing elidable', () => {
  it('returns a zero cut for an empty projection', () => {
    const cut = computeElisionCut([], BUDGET);
    expect(cut.resultCutTokens).toBe(0);
    expect(cut.imageCutTokens).toBe(0);
  });

  it('RE-RULED by T9b: a zero cut needs fewer than keepTurns USERS *and* fewer than keepTurns ROUNDS', () => {
    // `conversation(3)` is 3 user turns AND 3 rounds, so BOTH units are under the floor
    // and everything is protected. The user count alone no longer decides it: a chat with
    // 3 users and 6 rounds DOES elide now — see the T9b case below.
    const cut = computeElisionCut(conversation(3), BUDGET);
    expect(cut.resultCutTokens).toBe(0);
  });

  it('returns a zero cut while the whole conversation fits in the live window', () => {
    // 6 turns x ~5k = ~30k tokens, under liveWindow (0.25 x 200k = 50k).
    const cut = computeElisionCut(conversation(6), BUDGET);
    expect(cut.resultCutTokens).toBe(0);
  });
});

// ─── Case 2: a long conversation elides old results ───────────────────────────

describe('elideProjection — case 2: old large results become stubs', () => {
  it('stubs old results, names the tool and the spill path, and keeps the pairing', () => {
    const entries = conversation(40);
    const cut = computeElisionCut(entries, BUDGET);
    expect(cut.resultCutTokens).toBeGreaterThan(0);

    const outcome = elideProjection(entries, cut, { taskId: 'task-9' });
    expect(outcome.elidedResults).toBeGreaterThan(0);
    expect(outcome.freedTokens).toBeGreaterThan(0);

    const wire = applyElision(entries, outcome.replacements);
    // PAIR SAFETY: entry count and every toolUseId are untouched.
    expect(wire).toHaveLength(entries.length);
    for (let i = 0; i < wire.length; i++) {
      expect(wire[i].payload.type).toBe(entries[i].payload.type);
      const a = wire[i].payload;
      const b = entries[i].payload;
      if (a.type === 'tool_result' && b.type === 'tool_result') {
        expect(a.toolUseId).toBe(b.toolUseId);
      }
    }

    const stubbed = wire.find(
      (e) =>
        e.payload.type === 'tool_result' &&
        (e.payload.blocks[0] as { text?: string }).text?.startsWith('[elided:'),
    );
    expect(stubbed).toBeDefined();
    const stubText = (stubbed!.payload as { blocks: Array<{ text?: string }> }).blocks[0].text!;
    // The stub names the tool, the spill path, and the exact next call.
    expect(stubText).toContain('Read');
    expect(stubText).toContain(spillPathFor('task-9', (stubbed!.payload as { toolUseId: string }).toolUseId));
    expect(stubText).toContain('offset/limit');
    // And the full body is handed back for the engine to spill.
    expect(outcome.spills.length).toBe(outcome.elidedResults);
    expect(outcome.spills[0].text).toContain('word');
  });

  it('leaves the newest turns fully intact', () => {
    const entries = conversation(40);
    const cut = computeElisionCut(entries, BUDGET);
    const outcome = elideProjection(entries, cut, { taskId: 't' });
    const wire = applyElision(entries, outcome.replacements);

    // The last 4 user turns (keepTurns) contain 4 tool_results; none may be stubbed.
    const tail = wire.slice(-16);
    for (const e of tail) {
      if (e.payload.type !== 'tool_result') continue;
      expect((e.payload.blocks[0] as { text?: string }).text).not.toContain('[elided:');
    }
  });

  it('never stubs a result below minResultTokens', () => {
    const entries = conversation(40, smallBody);
    const cut = computeElisionCut(entries, BUDGET);
    // Small bodies barely move the prefix sums, so nothing crosses the cut anyway;
    // assert the stronger property directly.
    const outcome = elideProjection(entries, { ...cut, resultCutTokens: 10_000_000 }, { taskId: 't' });
    expect(outcome.elidedResults).toBe(0);
  });
});

// ─── Case 3: idempotence ──────────────────────────────────────────────────────

describe('elideProjection — case 3: deterministic + stub-safe', () => {
  it('is byte-stable: the same raw projection and cut produce identical stubs', () => {
    // THE cache-critical property. Two projections of the same journal must
    // produce the same wire bytes, or the prefix cache is busted for free.
    const entries = conversation(40);
    const cut = computeElisionCut(entries, BUDGET);
    const a = applyElision(entries, elideProjection(entries, cut, { taskId: 't' }).replacements);
    const b = applyElision(entries, elideProjection(entries, cut, { taskId: 't' }).replacements);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('applying a frozen map twice changes nothing', () => {
    const entries = conversation(40);
    const cut = computeElisionCut(entries, BUDGET);
    const map = elideProjection(entries, cut, { taskId: 't' }).replacements;
    const once = applyElision(entries, map);
    expect(JSON.stringify(applyElision(once, map))).toBe(JSON.stringify(once));
  });

  it('skips entries this pass already stubbed', () => {
    // Re-running the PURE pass over an already-elided array is not a supported
    // call (the cut is defined against RAW prefix sums, and a shrunken array
    // makes the same absolute cut reach further — which is exactly why
    // prepareElision always recomputes from journal.project()). What must hold
    // is narrower and is what protects a resumed run: an entry already carrying
    // an [elided: stub is never re-stubbed or re-spilled.
    const entries = conversation(40);
    const cut = computeElisionCut(entries, BUDGET);
    const once = applyElision(entries, elideProjection(entries, cut, { taskId: 't' }).replacements);
    const stubbedSeqs = new Set(
      once
        .filter(
          (e) =>
            e.payload.type === 'tool_result' &&
            (e.payload.blocks[0] as { text?: string }).text?.startsWith('[elided:'),
        )
        .map((e) => e.seq),
    );
    expect(stubbedSeqs.size).toBeGreaterThan(0);
    const second = elideProjection(once, cut, { taskId: 't' });
    for (const seq of stubbedSeqs) expect(second.replacements.has(seq)).toBe(false);
  });

  it('leaves prune.ts stubs alone', () => {
    resetSeq();
    const entries = [
      ...conversation(40),
      entry('tool_result', { text: '[pruned: 900 tokens of tool output elided]' }),
    ];
    const cut = computeElisionCut(entries, BUDGET);
    const outcome = elideProjection(entries, cut, { taskId: 't' });
    for (const [, e] of outcome.replacements) {
      const b = (e.payload as { blocks: Array<{ text?: string }> }).blocks[0];
      expect(b.text).not.toContain('[pruned:');
    }
  });
});

// ─── Case 4: images ───────────────────────────────────────────────────────────

describe('elideProjection — case 4: images age out', () => {
  it('replaces an old image with a placeholder that names it', () => {
    resetSeq();
    const entries: JournalEntry[] = [];
    entries.push(entry('user', { text: 'start' }));
    entries.push(entry('tool_use', { toolUseId: 'shot', name: 'screenshot' }));
    entries.push(entry('tool_result', { toolUseId: 'shot', text: smallBody, images: 1 }));
    entries.push(...conversation(40).map((e) => e));

    // Re-seq so the appended conversation keeps unique seqs.
    const seqd = entries.map((e, i) => ({ ...e, seq: i }));
    const cut = computeElisionCut(seqd, BUDGET);
    const outcome = elideProjection(seqd, cut, { taskId: 't' });

    expect(outcome.elidedImages).toBeGreaterThan(0);
    const wire = applyElision(seqd, outcome.replacements);
    const placeholder = wire
      .flatMap((e) =>
        'blocks' in e.payload ? (e.payload.blocks as Array<{ text?: string }>) : [],
      )
      .find((b) => b.text?.includes('image ('));
    expect(placeholder).toBeDefined();
    expect(placeholder!.text).toContain('screen.png');
    expect(placeholder!.text).toContain('image/png');
    // No image block survives behind the cut.
    expect(outcome.freedTokens).toBeGreaterThan(0);
  });

  it('ages images no earlier than results when the result cut is zero', () => {
    // Short conversation → nothing elidable at all, images included. The image
    // bonus must never fire on its own, or it would step off its own clock and
    // double the number of cache busts.
    resetSeq();
    const entries = [entry('user', { text: 'hi', images: 1 }), entry('assistant', { text: 'yo' })];
    const cut = computeElisionCut(entries, BUDGET);
    expect(cut.resultCutTokens).toBe(0);
    expect(cut.imageCutTokens).toBe(0);
  });
});

// ─── Case 5: THE GRID INVARIANT (cache safety) ────────────────────────────────

describe('computeElisionCut — case 5: the cut is always on the stride grid', () => {
  it('every cut is an exact multiple of strideTokens, at every length', () => {
    for (let turns = 4; turns <= 80; turns++) {
      const cut = computeElisionCut(conversation(turns), BUDGET);
      expect(cut.resultCutTokens % cut.strideTokens).toBe(0);
      expect(cut.imageCutTokens % cut.strideTokens).toBe(0);
    }
  });

  it('the cut changes only a handful of times across a long conversation', () => {
    // This is the cache argument in test form: a sliding window would produce a
    // distinct cut at nearly every length. On the grid it must be a step function.
    const seen = new Set<number>();
    for (let turns = 4; turns <= 80; turns++) {
      seen.add(computeElisionCut(conversation(turns), BUDGET).resultCutTokens);
    }
    // ~80 turns x ~5k tokens = ~400k of growth over a 60k stride → <= ~8 distinct
    // cuts. Anything close to 77 (one per length) means the grid broke.
    expect(seen.size).toBeLessThanOrEqual(10);
  });
});

// ─── Case 6: monotonicity ─────────────────────────────────────────────────────

describe('computeElisionCut — case 6: monotone as the journal grows', () => {
  it('never retreats as turns are appended — BOTH cuts', () => {
    // imageCut is swept too: it only became a moving quantity when
    // imageBonusFraction was raised to the stride (it used to be identically
    // resultCut, so this sweep proved nothing about it).
    let previousResult = 0;
    let previousImage = 0;
    for (let turns = 4; turns <= 80; turns++) {
      const cut = computeElisionCut(conversation(turns), BUDGET);
      expect(cut.resultCutTokens).toBeGreaterThanOrEqual(previousResult);
      expect(cut.imageCutTokens).toBeGreaterThanOrEqual(previousImage);
      expect(cut.imageCutTokens).toBeGreaterThanOrEqual(cut.resultCutTokens);
      previousResult = cut.resultCutTokens;
      previousImage = cut.imageCutTokens;
    }
  });

  it('an entry elided once stays elided as the conversation grows', () => {
    const shortEntries = conversation(40);
    const shortCut = computeElisionCut(shortEntries, BUDGET);
    const elidedSeqs = new Set(
      elideProjection(shortEntries, shortCut, { taskId: 't' }).replacements.keys(),
    );
    expect(elidedSeqs.size).toBeGreaterThan(0);

    const longEntries = conversation(70);
    const longOutcome = elideProjection(
      longEntries,
      computeElisionCut(longEntries, BUDGET),
      { taskId: 't' },
    );
    for (const seq of elidedSeqs) {
      expect(longOutcome.replacements.has(seq)).toBe(true);
    }
  });

  it('clampCutMonotonic refuses a retreat', () => {
    // Same journal both times (append-only), so the anchor reconciles and the
    // ratchet holds. `anchorFor` is the same function computeElisionCut uses.
    const entries = conversation(40);
    const previous = {
      resultCutTokens: 120_000,
      imageCutTokens: 150_000,
      strideTokens: 60_000,
      anchor: anchorFor(entries, 150_000),
    };
    const next = {
      resultCutTokens: 60_000,
      imageCutTokens: 60_000,
      strideTokens: 60_000,
      anchor: anchorFor(entries, 60_000),
    };
    expect(clampCutMonotonic(next, previous, entries).resultCutTokens).toBe(120_000);
    expect(clampCutMonotonic(next, previous, entries).imageCutTokens).toBe(150_000);
    expect(clampCutMonotonic(previous, null, entries)).toEqual(previous);
  });
});

// ─── Case 7: budget-relative sizing + degenerate input ────────────────────────

describe('computeElisionCut — case 7: budget-relative and total', () => {
  it('a larger budget gets a proportionally larger stride and live window', () => {
    const entries = conversation(40);
    const small = computeElisionCut(entries, 200_000);
    const large = computeElisionCut(entries, 1_000_000);
    expect(large.strideTokens).toBe(small.strideTokens * 5);
    // The same conversation that elides against a 200k budget is untouched
    // against a 1M one. THIS IS THE BUG THE RE-BASE FIXES: passing the context
    // window here is passing the 1M number on a lane whose conversation can
    // never exceed the 180k compaction trigger.
    expect(small.resultCutTokens).toBeGreaterThan(0);
    expect(large.resultCutTokens).toBe(0);
  });

  it('never throws on degenerate input', () => {
    const junk = [
      { ...entry('tool_result'), payload: { type: 'tool_result', toolUseId: 'x', blocks: [] } },
      { ...entry('user'), payload: { type: 'user', blocks: [] } },
    ] as JournalEntry[];
    expect(() => computeElisionCut(junk, BUDGET)).not.toThrow();
    expect(() =>
      elideProjection(junk, { resultCutTokens: 10, imageCutTokens: 10, strideTokens: 1, anchor: null }, { taskId: 't' }),
    ).not.toThrow();
    expect(() => computeElisionCut(conversation(10), 0)).not.toThrow();
  });

  it('applyElision returns the same reference when nothing was elided', () => {
    const entries = conversation(5);
    expect(applyElision(entries, new Map())).toBe(entries);
  });

  it('the default policy is the one the cost model was derived for', () => {
    expect(DEFAULT_ELISION_POLICY.keepTurns).toBe(4);
    expect(DEFAULT_ELISION_POLICY.liveBudgetFraction).toBe(0.25);
    expect(DEFAULT_ELISION_POLICY.strideFraction).toBe(0.3);
    expect(DEFAULT_ELISION_POLICY.minResultTokens).toBe(500);
    // >= strideFraction or the image branch is a provable no-op (case 8).
    expect(DEFAULT_ELISION_POLICY.imageBonusFraction).toBe(
      DEFAULT_ELISION_POLICY.strideFraction,
    );
  });
});

// ─── Case 8: the image bonus is no longer a no-op ─────────────────────────────

describe('computeElisionCut — case 8: imageBonusFraction actually moves the image cut', () => {
  it('the DEFAULT policy ages images exactly ONE stride ahead, whenever the floor allows', () => {
    // The bonus can only land a full stride ahead when the keepTurns floor is far
    // enough back; otherwise it clamps to resultCut. Both outcomes are correct, and
    // the ONLY two outcomes allowed — an imageCut anywhere else is off the grid.
    let aheadByAStride = 0;
    let clampedToResult = 0;
    for (let turns = 4; turns <= 80; turns++) {
      const cut = computeElisionCut(conversation(turns), BUDGET);
      if (cut.resultCutTokens === 0) continue;
      expect([cut.resultCutTokens, cut.resultCutTokens + cut.strideTokens]).toContain(
        cut.imageCutTokens,
      );
      if (cut.imageCutTokens === cut.resultCutTokens + cut.strideTokens) aheadByAStride++;
      else clampedToResult++;
    }
    // The assertion that matters: the bonus FIRES. Under the old 0.15 this count
    // is 0 at every length (next case).
    expect(aheadByAStride).toBeGreaterThan(0);
    // …and the floor still clamps it sometimes, so the sweep exercised both arms.
    expect(clampedToResult).toBeGreaterThan(0);
  });

  it('CONTROL: the OLD 0.15 value collapses to resultCut on every input', () => {
    // The proof that the old default never fired. bonus < stride ⇒
    // quantize(k*stride + bonus, stride) === k*stride, and the floor-clipped
    // branch collapses to the same value — so imageCut === resultCut, always.
    const old = { ...DEFAULT_ELISION_POLICY, imageBonusFraction: 0.15 };
    let sawNonZero = false;
    for (let turns = 4; turns <= 80; turns++) {
      const cut = computeElisionCut(conversation(turns), BUDGET, old);
      expect(cut.imageCutTokens).toBe(cut.resultCutTokens);
      if (cut.resultCutTokens > 0) sawNonZero = true;
    }
    // Positive control: the sweep really did produce live cuts, so the equality
    // above is not the trivial 0 === 0.
    expect(sawNonZero).toBe(true);
  });

  it('the bonus never pushes the image cut past the keepTurns floor', () => {
    // Exactly 4 user turns ⇒ floorTokens is the FIRST entry's offset (0), so both
    // cuts must be 0 no matter how large the bodies are.
    const cut = computeElisionCut(conversation(4), BUDGET);
    expect(cut.resultCutTokens).toBe(0);
    expect(cut.imageCutTokens).toBe(0);
  });

  it('both cuts stay on the grid and monotone with the raised bonus', () => {
    let previous = 0;
    for (let turns = 4; turns <= 80; turns++) {
      const cut = computeElisionCut(conversation(turns), BUDGET);
      expect(cut.imageCutTokens % cut.strideTokens).toBe(0);
      expect(cut.imageCutTokens).toBeGreaterThanOrEqual(previous);
      previous = cut.imageCutTokens;
    }
  });
});

// ─── Case 9: the ratchet releases when the journal is REWRITTEN ───────────────

describe('clampCutMonotonic — case 9: appends ratchet, rewrites release', () => {
  /**
   * What `applyCompaction` does to a projection: a FRESH summary entry (a `user`
   * payload with a brand-new, higher seq) takes index 0, the summarized span is
   * gone, and the keep window survives. Built by hand here because this file is
   * pure fixtures; the same splice is driven through a REAL `Journal.compact()`
   * in engine/__tests__/context-elision.rewrite-release.test.ts.
   */
  function compacted(entries: JournalEntry[], keepEntries: number): JournalEntry[] {
    const summary: JournalEntry = {
      ...entry('user', { text: 'summary of the earlier conversation' }),
      seq: 10_000,
      uuid: 'compaction-summary',
    };
    return [summary, ...entries.slice(-keepEntries)];
  }

  it('THE BUG: a cut computed before a compaction does not survive it', () => {
    const before = conversation(40);
    const cutBefore = clampCutMonotonic(computeElisionCut(before, BUDGET), null, before);
    expect(cutBefore.resultCutTokens).toBeGreaterThan(0);

    // 2 user turns + the summary = 3 user entries, BELOW keepTurns (4). The raw
    // policy correctly says "protect everything".
    const after = compacted(before, 8);
    const raw = computeElisionCut(after, BUDGET);
    expect(raw.resultCutTokens).toBe(0);
    expect(raw.imageCutTokens).toBe(0);
    expect(raw.resultCutTokens).toBeLessThan(cutBefore.resultCutTokens); // not vacuous

    // The ratchet must NOT override that. Its premise — an append-only journal,
    // so prefix sums never shrink — is false the moment history is spliced.
    const clamped = clampCutMonotonic(raw, cutBefore, after);
    expect(clamped.resultCutTokens).toBe(0);
    expect(clamped.imageCutTokens).toBe(0);

    // …and therefore nothing inside the keep window the compactor deliberately
    // preserved gets stubbed. Without the release this is 2 of 2 tool_results.
    const outcome = elideProjection(after, clamped, { taskId: 't' });
    expect(outcome.replacements.size).toBe(0);
    expect(outcome.elidedResults).toBe(0);
  });

  it('POSITIVE CONTROL: the same rewrite WOULD have stubbed the keep window', () => {
    // The proof the case above is not vacuous — feed the pre-compaction cut to
    // elideProjection directly and it guts the post-compaction keep window.
    const before = conversation(40);
    const cutBefore = computeElisionCut(before, BUDGET);
    const after = compacted(before, 8);
    const outcome = elideProjection(after, cutBefore, { taskId: 't' });
    expect(outcome.elidedResults).toBe(2);
    expect(outcome.freedTokens).toBeGreaterThan(0);
  });

  it('PROOF: within an append-only run the ratchet holds at every length', () => {
    // Monotonicity is the reason the clamp exists (every backward step is a cache
    // miss on the whole prefix — the 2026-08-13 rollback). Proven over the real
    // functions across the same 4..80 sweep the grid invariants use, not assumed.
    let previous: ElisionCut | null = null;
    for (let turns = 4; turns <= 80; turns++) {
      const entries = conversation(turns);
      const cut = clampCutMonotonic(computeElisionCut(entries, BUDGET), previous, entries);
      expect(cut.resultCutTokens).toBeGreaterThanOrEqual(previous?.resultCutTokens ?? 0);
      expect(cut.imageCutTokens).toBeGreaterThanOrEqual(previous?.imageCutTokens ?? 0);
      previous = cut;
    }
    expect(previous!.resultCutTokens).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a text SHRINK below the cut still ratchets', () => {
    // This is what the clamp is FOR: pruneSnapshots shrinks text inside entries
    // that are still there, the raw cut retreats, and the ratchet holds it. Same
    // entries, same order, same seqs — only the weights moved.
    const entries = conversation(40);
    const cut = clampCutMonotonic(computeElisionCut(entries, BUDGET), null, entries);
    expect(cut.resultCutTokens).toBeGreaterThan(0);

    const shrunk = entries.map((e, i) =>
      i < 60 && e.payload.type === 'tool_result'
        ? ({ ...e, payload: { ...e.payload, blocks: [{ type: 'text', text: 'x' }] } } as JournalEntry)
        : e,
    );
    const raw = computeElisionCut(shrunk, BUDGET);
    expect(raw.resultCutTokens).toBeLessThan(cut.resultCutTokens); // it DID retreat
    const held = clampCutMonotonic(raw, cut, shrunk);
    expect(held.resultCutTokens).toBe(cut.resultCutTokens);

    // A RAISED cut is re-anchored against the projection it was raised over, not
    // left describing the narrower span `raw` covered — otherwise the next turn
    // verifies less than it is about to carry.
    expect(held.anchor).toEqual(anchorFor(shrunk, held.imageCutTokens));
    expect(held.anchor).not.toEqual(raw.anchor);
  });

  it('a REWIND releases too — same head, different span', () => {
    // applyRewind drops an abandoned MIDDLE span; entries[0] is untouched, so a
    // release keyed only on "did the head change" would miss this one.
    const entries = conversation(40);
    const cut = clampCutMonotonic(computeElisionCut(entries, BUDGET), null, entries);
    expect(cut.anchor!.index).toBeGreaterThan(8);

    const rewound = [...entries.slice(0, 8), ...entries.slice(60)];
    expect(rewound[0].seq).toBe(entries[0].seq); // head unchanged
    const raw = computeElisionCut(rewound, BUDGET);
    // NOT VACUOUS: the two answers have to differ, or "released" and "carried"
    // look the same and the case proves nothing.
    expect(raw.resultCutTokens).toBeLessThan(cut.resultCutTokens);
    expect(clampCutMonotonic(raw, cut, rewound).resultCutTokens).toBe(raw.resultCutTokens);
  });

  it('the HEAD check is what catches a splice the index check cannot', () => {
    // The index check alone is not enough. A compaction that drops exactly ONE
    // entry below the anchor while adding the summary at index 0 leaves the
    // anchor's INDEX holding its original seq — the two shifts cancel. The head
    // cannot cancel: applyCompaction always seats an entry that did not exist
    // when the cut was taken at index 0, so headSeq always moves.
    // The dropped entry carries a stride's worth of tokens on its own, so the raw
    // cut has to move — otherwise "released" and "carried" agree and the case is
    // vacuous.
    const before = conversation(40);
    before[2] = {
      ...before[2],
      payload: { type: 'tool_result', toolUseId: 'tu-0', blocks: [{ type: 'text', text: bigBody.repeat(20) }] },
    } as JournalEntry;
    const cut = clampCutMonotonic(computeElisionCut(before, BUDGET), null, before);
    const k = cut.anchor!.index;
    expect(k).toBeGreaterThan(2);

    const summary: JournalEntry = {
      ...entry('user', { text: 'summary of the earlier conversation' }),
      seq: 10_000,
      uuid: 'compaction-summary',
    };
    const spliced = [summary, ...before.slice(0, 2), ...before.slice(3)];
    expect(spliced[k].seq).toBe(cut.anchor!.seq); // the index check is SATISFIED
    expect(spliced[0].seq).not.toBe(cut.anchor!.headSeq);

    const raw = computeElisionCut(spliced, BUDGET);
    expect(raw.resultCutTokens).toBeLessThan(cut.resultCutTokens);
    expect(clampCutMonotonic(raw, cut, spliced).resultCutTokens).toBe(raw.resultCutTokens);
  });

  it('an empty projection releases rather than carrying a cut into nothing', () => {
    const entries = conversation(40);
    const cut = clampCutMonotonic(computeElisionCut(entries, BUDGET), null, entries);
    const empty = computeElisionCut([], BUDGET);
    expect(clampCutMonotonic(empty, cut, []).resultCutTokens).toBe(0);
  });
});

// ─── T9b: the floor mirrors Hermes's protected tail when there are no user turns ──
//
// `keepTurns` counts USER turns, and an agentic loop has exactly one: a Nami dream
// pass, and every long single-ask Bash task. So the floor protected EVERYTHING and
// elision could never fire in the lane that needs it most. When the journal holds
// fewer than `keepTurns` user entries the floor becomes Hermes's protected tail
// (`trajectory_compressor.py:743-889` — protect the LAST `protect_last_n_turns`),
// measured in the unit an agentic lane actually grows in: ROUNDS.

/** One `user` entry, then `rounds` real rounds — assistant, its tool_use, its result. */
function oneAskConversation(rounds: number, body = bigBody): JournalEntry[] {
  resetSeq();
  const out: JournalEntry[] = [entry('user', { text: 'the one ask' })];
  for (let i = 0; i < rounds; i++) {
    out.push(entry('assistant', { text: `step ${i}` }));
    out.push(entry('tool_use', { toolUseId: `tu-${i}`, name: 'Read' }));
    out.push(entry('tool_result', { toolUseId: `tu-${i}`, text: body }));
  }
  return out;
}

/** The SMALL budget the round-floor cases are sized against (live = 5,000; stride = 6,000). */
const SMALL_BUDGET = 20_000;

describe('computeElisionCut — T9b: a one-user-turn journal elides (RED before T9b: always empty)', () => {
  it('cuts a one-ask journal of 8 rounds instead of protecting all of it', () => {
    // Arithmetic, so the number is a claim and not a recording:
    //   user 'the one ask'            =     4 tok
    //   per round: assistant 3 + tool_use 3 + result 5,200 = 5,206 tok
    //   total                        = 4 + 8 x 5,206 = 41,652
    //   live  = 0.25 x 20,000        = 5,000  → total - live = 36,652
    //   floor = start of round 4 (the 4th-from-last round) = 4 + 4 x 5,206 = 20,828
    //   cut   = quantize(min(36,652, 20,828), stride 6,000) = 18,000
    const cut = computeElisionCut(oneAskConversation(8), SMALL_BUDGET);
    expect(cut.resultCutTokens).toBe(18_000);
    expect(cut.strideTokens).toBe(6_000);
  });

  it('protects the last keepTurns ROUNDS — their results are never stubbed', () => {
    const entries = oneAskConversation(8);
    const cut = computeElisionCut(entries, SMALL_BUDGET);
    // The floor is the START of the 4th-from-last round, and the cut stays under it.
    expect(cut.resultCutTokens).toBeLessThan(20_828);

    const outcome = elideProjection(entries, cut, { taskId: 'task-t9b' });
    // Rounds 4..7 (the protected tail) keep their full bodies.
    for (const i of [4, 5, 6, 7]) {
      const result = entries.find(
        (e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === `tu-${i}`,
      )!;
      expect(outcome.replacements.has(result.seq)).toBe(false);
    }
    // …and something older WAS elided, so the pin is not vacuously green.
    expect(outcome.elidedResults).toBeGreaterThan(0);
  });

  it('stays monotone as the one-ask journal grows — a round start\'s prefix offset never moves', () => {
    // The SEQUENCE, not just "non-decreasing": an all-zeros regression is monotone too,
    // so the ordering assertion alone pinned nothing.
    const rounds = [4, 5, 6, 7, 8, 9, 10, 12, 16];
    const cuts = rounds.map((n) => computeElisionCut(oneAskConversation(n), SMALL_BUDGET));
    expect(cuts.map((c) => c.resultCutTokens)).toEqual([
      0, 0, 6_000, 12_000, 18_000, 24_000, 30_000, 36_000, 60_000,
    ]);
    for (const cut of cuts) expect(cut.resultCutTokens % cut.strideTokens).toBe(0);

    // And the claim the name makes, asserted directly: the prefix offset of a given round
    // start is the SAME however much the journal has grown past it (append-only prefix sums).
    const offsetOfRoundStart = (n: number, round: number): number => {
      const entries = oneAskConversation(n);
      let running = 0;
      let seen = 0;
      for (const e of entries) {
        if (e.payload.type === 'assistant' && seen++ === round) return running;
        running += entryTokensForTest(e);
      }
      return -1;
    };
    expect(offsetOfRoundStart(16, 3)).toBe(offsetOfRoundStart(6, 3));
    expect(offsetOfRoundStart(16, 3)).toBeGreaterThan(0);
  });

  it('protects everything while the journal holds fewer than keepTurns ROUNDS', () => {
    // 3 rounds < keepTurns (4) → the tail rule has nothing to protect behind.
    expect(computeElisionCut(oneAskConversation(3), SMALL_BUDGET).resultCutTokens).toBe(0);
  });
});

describe('computeElisionCut — T9b: a journal with >= keepTurns user entries is UNCHANGED', () => {
  it('computes the identical cut for a chat-shaped 40-turn conversation (equivalence pin)', () => {
    // Same numbers this policy produced before T9b: the user floor is still the rule
    // whenever the journal actually holds keepTurns user entries.
    const cut = computeElisionCut(conversation(40), BUDGET);
    expect(cut.resultCutTokens).toBe(120_000);
    expect(cut.imageCutTokens).toBe(180_000);
  });
});

describe('clampCutMonotonic — T9b: the keepTurns SWITCH-OVER never re-inflates the wire', () => {
  it('holds the round-floor cut when the keepTurns-th user entry arrives and the raw floor RETREATS to zero', () => {
    const before = oneAskConversation(8);
    const held = clampCutMonotonic(computeElisionCut(before, SMALL_BUDGET), null, before);
    expect(held.resultCutTokens).toBe(18_000);

    // Three more user entries arrive → the journal now holds keepTurns (4) users, so the
    // floor switches rule to the USER floor, whose 4th-from-last user is entry 0 → zero.
    const after = [...before];
    for (let i = 0; i < 3; i++) after.push(entry('user', { text: `follow-up ${i}` }));
    const raw = computeElisionCut(after, SMALL_BUDGET);
    expect(raw.resultCutTokens).toBe(0); // the rule really does retreat

    // Nothing was SPLICED, so the anchor still reconciles and the ratchet carries the
    // cut forward: an un-elided entry would re-inflate the wire AND bust the cache.
    const carried = clampCutMonotonic(raw, held, after);
    expect(carried.resultCutTokens).toBe(18_000);
    expect(carried.imageCutTokens).toBe(held.imageCutTokens);
  });
});

// ─── T9b: a SHORT chat with heavy tool use now elides (intended by rule 3) ────────

/** `users` user turns, each followed by `roundsPerUser` real rounds. */
function fewUsersManyRounds(users: number, roundsPerUser: number): JournalEntry[] {
  resetSeq();
  const out: JournalEntry[] = [];
  for (let u = 0; u < users; u++) {
    out.push(entry('user', { text: `ask ${u}` }));
    for (let r = 0; r < roundsPerUser; r++) {
      out.push(entry('assistant', { text: `step ${u}.${r}` }));
      out.push(entry('tool_use', { toolUseId: `tu-${u}-${r}`, name: 'Read' }));
      out.push(entry('tool_result', { toolUseId: `tu-${u}-${r}`, text: bigBody }));
    }
  }
  return out;
}

describe('computeElisionCut — T9b: 3 users with 6 ROUNDS elides, where 3 users alone did not', () => {
  it('cuts a 3-user / 6-round chat — the round floor is what decides now', () => {
    //   user 3 tok (`estimateTokens('ask 0 ')`); per round assistant 3 + tool_use 3 +
    //   result 5,200 = 5,206
    //   total  = 3 x (3 + 2 x 5,206) = 31,245 ; live = 5,000 → total - live = 26,245
    //   floor  = start of the 4th-from-last ROUND = 3 + 5,206 + 5,206 + 3 = 10,418
    //   cut    = quantize(min(26,245, 10,418), stride 6,000) = 6,000
    const cut = computeElisionCut(fewUsersManyRounds(3, 2), SMALL_BUDGET);
    expect(cut.resultCutTokens).toBe(6_000);
  });
});

// ─── D4: recall fences must not flip the floor's UNIT ─────────────────────────
//
// `nthFromLastOffset(entries, before, 'user', keepTurns)` asked only for a user-role
// payload. Nami's per-round consult appends a `<recalled_memory …>` fence as one, so a
// one-ask agentic journal with keepTurns fences LOOKS like a chat: the floor switches to
// the USER rule, its keepTurns-th-from-last user is at or near the head, and the cut
// collapses to zero — elision silently disabled on the one lane it exists for.

/** A recall fence entry. `stamped` writes `payload.injected`; false is a pre-field journal. */
function fenceEntry(text: string, stamped = true): JournalEntry {
  const e = entry('user', { text: fenceRecall(text) });
  if (stamped) (e.payload as { injected?: string }).injected = 'engine';
  return e;
}

describe('computeElisionCut — D4: recall fences do not make a one-ask journal look like a chat', () => {
  it('3 fences: keeps the ROUND floor instead of protecting everything (RED: zero cut)', () => {
    // keepTurns is 4. With 3 fences the journal holds 4 user-role entries, so the floor
    // switched to the USER rule and its 4th-from-last user was the ASK at offset 0 — a
    // zero cut. Elision silently disabled on the one lane it exists for.
    //
    // Appending after the rounds cannot move any earlier prefix offset, so the round
    // floor — and the cut — must be IDENTICAL to the fence-free journal's 18,000.
    const plain = oneAskConversation(8);
    const withFences = [...plain, fenceEntry('hit 0'), fenceEntry('hit 1'), fenceEntry('hit 2')];

    expect(computeElisionCut(plain, SMALL_BUDGET).resultCutTokens).toBe(18_000);
    expect(computeElisionCut(withFences, SMALL_BUDGET).resultCutTokens).toBe(18_000);
  });

  it('4 fences: the floor does not jump PAST the protected tail (RED: cuts 36,000)', () => {
    // The other direction, and the more dangerous one. With 4 fences the 4th-from-last
    // user-role entry is the FIRST fence — sitting after all 8 rounds — so the floor
    // rose to ~41,652 and the cut ran to 36,000, eliding the last four rounds' results:
    // exactly the work the floor exists to protect.
    const withFences = [...oneAskConversation(8)];
    for (let i = 0; i < 4; i++) withFences.push(fenceEntry(`hit ${i}`));
    expect(computeElisionCut(withFences, SMALL_BUDGET).resultCutTokens).toBe(18_000);
  });

  it('holds for fences written BEFORE `payload.injected` existed (byte fallback)', () => {
    // A warm task resumes across a deploy; its earlier entries can never gain the field.
    const withFences = [...oneAskConversation(8)];
    for (let i = 0; i < 4; i++) withFences.push(fenceEntry(`hit ${i}`, false));
    expect(computeElisionCut(withFences, SMALL_BUDGET).resultCutTokens).toBe(18_000);
  });

  it('REAL user turns still flip the rule — the switch-over is intact', () => {
    // The load-bearing negative control. If the predicate over-claimed and skipped real
    // turns too, the user floor would never engage and every chat would elide by the
    // round rule. Three real follow-ups put the journal on keepTurns users, whose
    // 4th-from-last is the head ⇒ a zero raw cut (case 9's switch-over, unchanged).
    const withUsers = [...oneAskConversation(8)];
    for (let i = 0; i < 3; i++) withUsers.push(entry('user', { text: `follow-up ${i}` }));
    expect(computeElisionCut(withUsers, SMALL_BUDGET).resultCutTokens).toBe(0);
  });

  it('a chat with >= keepTurns REAL user entries computes the identical cut (equivalence)', () => {
    // Unchanged from case 7 / the T9b equivalence pin: fences are the only thing that
    // moved, so a fence-free chat must still produce exactly these numbers.
    const cut = computeElisionCut(conversation(40), BUDGET);
    expect(cut.resultCutTokens).toBe(120_000);
    expect(cut.imageCutTokens).toBe(180_000);
  });
});
