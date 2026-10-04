import { describe, it, expect } from 'vitest';
import { planCompaction, CompactionPlanError } from '../compactor.js';
import type { JournalEntry } from '../../../contract/journal.js';

// ─── In-memory JournalEntry fixture builder (mirrors journal-stats.test.ts:7-49) ──
// No disk, no Journal — pure-planner fixtures only.

let _seq = 0;
function resetSeq() {
  _seq = 0;
}

/** Build a minimal, union-safe JournalEntry. `text` populates user/assistant/tool_result
 *  blocks (so estimateTokens has something to count); `toolUseId` pairs tool entries. */
function entry(
  type: JournalEntry['payload']['type'],
  opts: { text?: string; toolUseId?: string; input?: unknown } = {},
): JournalEntry {
  const seq = _seq++;
  const text = opts.text ?? '';
  let payload: JournalEntry['payload'];
  if (type === 'user') {
    payload = { type: 'user', blocks: [{ type: 'text', text }] };
  } else if (type === 'assistant') {
    payload = { type: 'assistant', blocks: [{ type: 'text', text }] };
  } else if (type === 'tool_use') {
    payload = { type: 'tool_use', toolUseId: opts.toolUseId ?? `tu-${seq}`, name: 'bash', input: opts.input ?? { cmd: text } };
  } else if (type === 'tool_result') {
    payload = { type: 'tool_result', toolUseId: opts.toolUseId ?? `tu-${seq}`, blocks: [{ type: 'text', text }] };
  } else if (type === 'compact_boundary') {
    payload = { type: 'compact_boundary', summaryUuid: 'x', preservedUuids: [], firstKeptId: 'y', trigger: 'auto', preTokens: 0, postTokens: 0 };
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

/** A big block of text whose estimateTokens comfortably exceeds a tiny keep window. */
const big = (label: string) => `${label} ${'word '.repeat(60)}`; // ~78 tokens by word-count

const fakeSummarize = async (e: JournalEntry[]) => `SUMMARY(${e.length})`;

// ─── Step 1: failing contract test ───────────────────────────────────────────────

describe('planCompaction — contract', () => {
  it('returns a turn-boundary plan with the injected summary', async () => {
    resetSeq();
    // user/assistant/tool_use/tool_result/user/assistant exceeding a tiny keep window.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: 'ls' } }),
      entry('tool_result', { toolUseId: 'tu-A', text: big('r0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160, // keeps the last user turn (~158 tok), drops the earlier one
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const kept = entries.find((e) => e.uuid === plan.firstKeptId);
    expect(kept).toBeDefined();
    // RE-RULED by T9b: the rule is no longer "firstKeptId MUST be a user entry" — the
    // boundary set is {user, assistant}. This fixture's raw cut lands ON the recent
    // `user` entry, so the planned cut is UNCHANGED, which is what this now pins.
    expect(kept!.payload.type).toBe('user');
    expect(plan.summaryText).toMatch(/^SUMMARY\(\d+\)$/);
    expect(plan.trigger).toBe('auto');
    expect(plan.preservedUuids).toEqual([]);
    // droppedEntries === toSummarize (the onPreCompact reflect slice)
    expect(plan.droppedEntries.every((e) => e.seq < kept!.seq)).toBe(true);
    // postTokens is the kept-span + summary estimate (a positive number)
    expect(plan.postTokens).toBeGreaterThan(0);
  });
});

// ─── Step 5: orphan-pair safety ──────────────────────────────────────────────────

describe('planCompaction — never orphans a tool_use/tool_result pair', () => {
  it('snaps the cut so both halves of a pair land on the same side', async () => {
    resetSeq();
    // Turn 1 (old): a tool pair tu-A. The raw token-walk cut lands BETWEEN tu-A and its
    // result (mid-pair); snap-forward must move firstKeptId to the next clean user turn so
    // the whole turn (pair included) drops together.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),          // 0  turn 1
      entry('assistant', { text: big('a0') }),     // 1
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: big('q') } }), // 2 (big input)
      entry('tool_result', { toolUseId: 'tu-A', text: big('r-A') }),      // 3 (big body)
      entry('assistant', { text: big('a0b') }),    // 4
      entry('user', { text: big('u1') }),          // 5  turn 2 (recent)
      entry('assistant', { text: big('a1') }),     // 6
    ];

    // Window keeps roughly the last ~158 tok (u1 + a1), dropping turn 1 incl. the pair.
    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.payload.type).toBe('user');
    expect(firstKept.uuid).toBe('entry-5'); // the recent user turn

    // Reconstruct the kept span; every kept tool_result must have a matching kept tool_use.
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
    // And the pair must be fully on the DROPPED side (no orphan created).
    expect(plan.droppedEntries.some((e) => e.payload.type === 'tool_use' && (e.payload as { toolUseId: string }).toolUseId === 'tu-A')).toBe(true);
    expect(plan.droppedEntries.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'tu-A')).toBe(true);
  });

  it('retreats the cut to an earlier user boundary that keeps a cross-turn pair intact', async () => {
    resetSeq();
    // Malformed: tu-A (turn 2) and its tool_result (turn 3) straddle a user boundary.
    // The token-walk would naively snap firstKeptId to turn-3's user (idx4), KEEPING the
    // result while DROPPING the use → orphan. The planner must retreat to turn-2's user
    // (idx2), which keeps the WHOLE pair while still dropping the older turn 1.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),          // 0  turn 1 (droppable — retreat keeps this droppable)
      entry('assistant', { text: big('a0') }),     // 1
      entry('user', { text: big('u1') }),          // 2  turn 2  ← retreat target
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: big('q') } }), // 3
      entry('user', { text: big('u2') }),          // 4  turn 3  ← naive (splitting) snap target
      entry('tool_result', { toolUseId: 'tu-A', text: big('r-A') }),      // 5  (cross-turn!)
      entry('assistant', { text: big('a2') }),     // 6
      entry('user', { text: big('u3') }),          // 7  turn 4 (recent)
      entry('assistant', { text: big('a3') }),     // 8
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 400, // raw walk snaps to idx4 (splits tu-A↔tr-A) → must retreat to idx2
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.payload.type).toBe('user');
    expect(firstKept.uuid).toBe('entry-2'); // retreated to turn-2 user, keeping the pair whole
    // No orphan in the kept span.
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
    // Turn 1 still dropped (compaction still made progress).
    expect(plan.droppedEntries.map((e) => e.uuid)).toEqual(['entry-0', 'entry-1']);
  });

  it('forward-snaps past STACKED straddling cross-turn pairs (N=2) instead of throwing', async () => {
    resetSeq();
    // BUG-1 regression: two cross-turn pairs (A=use@1/result@5, B=use@3/result@6) both
    // straddle the naive snap-forward cut (idx4). A pure backward retreat cascades to idx0
    // and throws "no valid turn-boundary cut" — even though a clean FORWARD user boundary
    // (idx7, dropping both whole pairs and keeping the recent turn) exists. The planner
    // must forward-snap past the pairs' later halves when the backward retreat fails.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),                                 // 0
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: big('qA') } }), // 1  pair A use
      entry('user', { text: big('u1') }),                                 // 2
      entry('tool_use', { toolUseId: 'tu-B', input: { cmd: big('qB') } }), // 3  pair B use
      entry('user', { text: big('u2') }),                                 // 4  naive split snap
      entry('tool_result', { toolUseId: 'tu-A', text: big('rA') }),       // 5  pair A result (cross-turn)
      entry('tool_result', { toolUseId: 'tu-B', text: big('rB') }),       // 6  pair B result (cross-turn)
      entry('user', { text: big('u3') }),                                 // 7  turn 4 (recent)
      entry('assistant', { text: big('a3') }),                            // 8
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 400,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.payload.type).toBe('user');
    expect(firstKept.uuid).toBe('entry-7'); // forward-snapped past both pairs to the recent turn

    // No orphan in the kept span — both pairs are fully on the DROPPED side.
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
    // Both pairs (A and B) dropped whole.
    for (const id of ['tu-A', 'tu-B']) {
      expect(plan.droppedEntries.some((e) => e.payload.type === 'tool_use' && (e.payload as { toolUseId: string }).toolUseId === id)).toBe(true);
      expect(plan.droppedEntries.some((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === id)).toBe(true);
    }
  });
});

// ─── Step 6: split-turn dual-summary FOLD → ONE summaryText ───────────────────────

describe('planCompaction — split-turn dual-summary folds into ONE summaryText', () => {
  it('returns exactly one summaryText string even for a span that conceptually splits', async () => {
    resetSeq();
    // A single long turn whose body alone exceeds the keep window (many big tool rounds).
    // pi might conceptually produce two summaries; the schema has ONE summaryUuid
    // (entry.ts:15 — do NOT widen compact_boundary) so we MUST get one concatenated string.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),                                     // 0  old turn
      entry('assistant', { text: big('a0') }),                                // 1
      entry('tool_use', { toolUseId: 'tu-1', input: { cmd: big('c1') } }),    // 2
      entry('tool_result', { toolUseId: 'tu-1', text: big('r1') }),           // 3
      entry('tool_use', { toolUseId: 'tu-2', input: { cmd: big('c2') } }),    // 4
      entry('tool_result', { toolUseId: 'tu-2', text: big('r2') }),           // 5
      entry('assistant', { text: big('a0b') }),                               // 6
      entry('user', { text: big('u1') }),                                     // 7  recent turn
      entry('assistant', { text: big('a1') }),                                // 8
    ];

    // The summarize callback would, in a naive split, be called twice; assert it is the
    // SINGLE call whose ONE returned string lands verbatim on plan.summaryText.
    let calls = 0;
    const summarizeOnce = async (e: JournalEntry[]) => {
      calls++;
      return `FOLDED-SUMMARY-of-${e.length}`;
    };

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160, // keeps only the recent turn; the whole old turn is summarized
      preTokens: 999,
      summarize: summarizeOnce,
    });

    expect(calls).toBe(1); // one summarize call → one summary
    expect(typeof plan.summaryText).toBe('string');
    expect(plan.summaryText).toBe('FOLDED-SUMMARY-of-7'); // single concatenated string
    // plan exposes ONE summaryText field — there is no array/second-summary path.
    expect(Object.keys(plan)).not.toContain('summaryTexts');
  });
});

// ─── Step 7: re-summarize from the prior firstKeptId (subsumption) ────────────────

describe('planCompaction — re-summarizes from the prior firstKeptId', () => {
  it('includes the leading prior-summary entry in the new toSummarize span', async () => {
    resetSeq();
    // Post-prior-compaction projection: the prior summary leads (a `user` payload, the kind
    // the harness appends + applyCompaction puts first), then kept turns, then new turns.
    const entries: JournalEntry[] = [
      entry('user', { text: big('PRIOR-SUMMARY') }), // 0  prior summary (user payload, leads)
      entry('assistant', { text: big('a-kept') }),   // 1  previously kept
      entry('user', { text: big('u-mid') }),         // 2  a turn that the new cut will drop
      entry('assistant', { text: big('a-mid') }),    // 3
      entry('user', { text: big('u-recent') }),      // 4  recent turn (new firstKept)
      entry('assistant', { text: big('a-recent') }), // 5
    ];

    let received: JournalEntry[] | null = null;
    const captureSummarize = async (e: JournalEntry[]) => {
      received = e;
      return 'NEW-SUMMARY-subsumes-prior';
    };

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160, // keeps only the recent turn; everything before is re-summarized
      preTokens: 999,
      summarize: captureSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.payload.type).toBe('user');
    // The new cut is a user boundary inside the post-prior span (NOT the prior summary itself).
    expect(firstKept.uuid).not.toBe('entry-0');
    expect(firstKept.uuid).toBe('entry-4');

    // The new toSummarize INCLUDES the leading prior-summary entry as element 0 → the new
    // summary subsumes the old (rule 5).
    expect(received).not.toBeNull();
    expect(received![0].uuid).toBe('entry-0');
    expect(plan.droppedEntries[0].uuid).toBe('entry-0');
    expect(plan.summaryText).toBe('NEW-SUMMARY-subsumes-prior');
  });
});

// ─── Step 7b: structured-summary passthrough (fact-recall precursor) ──────────────
//
// The kernel NEVER picks the prompt. The REAL structured prompt (COMPACTION_SYSTEM) is
// wired in T2; the numeric ≥0.90 fact-recall gate lives in T3. This step uses a
// STRUCTURED-SHAPED fake summarize (the §2b multi-section schema) and proves the planner
// faithfully passes the structured summary — including its pinned discrete facts — through
// to plan.summaryText verbatim.

describe('planCompaction — relays a structured (§2b) summary verbatim', () => {
  it('passes the structured multi-section summary (and its pinned facts) through unchanged', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('Decided on Postgres for the store') }),       // 0
      entry('assistant', { text: big('Using API prefix sk-x for the key') }),  // 1
      entry('tool_use', { toolUseId: 'tu-1', input: { file: 'db.ts' } }),      // 2
      entry('tool_result', { toolUseId: 'tu-1', text: big('migrated schema') }), // 3
      entry('user', { text: big('recent question') }),                          // 4
      entry('assistant', { text: big('recent answer') }),                       // 5
    ];

    // Structured multi-section shape (§2b) pinning ≥3 discrete facts.
    const structuredSummary = [
      '## Primary request / intent',
      'Build a durable store; decided on Postgres.',
      '## Key technical concepts',
      'Append-only journal; API prefix sk-x.',
      '## Files & code touched',
      'db.ts — migrated schema.',
      '## Next step',
      'Wire the migration into CI.',
    ].join('\n');
    const structuredSummarize = async (_e: JournalEntry[]) => structuredSummary;

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 200, // keeps the recent user turn; the earlier turns are summarized
      preTokens: 999,
      summarize: structuredSummarize,
    });

    // The planner relays the structured summary verbatim (it never rewrites/truncates it).
    expect(plan.summaryText).toBe(structuredSummary);
    // The pinned discrete facts survive the passthrough.
    expect(plan.summaryText).toContain('decided on Postgres');
    expect(plan.summaryText).toContain('sk-x');
    expect(plan.summaryText).toContain('db.ts — migrated schema');
    // Multi-section structure preserved.
    expect(plan.summaryText).toContain('## Primary request / intent');
    expect(plan.summaryText).toContain('## Next step');
  });
});

// ─── T9b: the cut boundary is {user, assistant} — the one-ask agentic loop ────────
//
// Until T9b the cut had to land on a `user` entry. A Nami dream pass and a long
// single-ask Bash task have exactly ONE `user` entry (the prompt); every round
// appends assistant / tool_use / tool_result and never another `user`. So the snap
// ran off the end and the planner threw `no valid turn-boundary cut` on every pass
// worth compacting. The rule is now pi's (`compaction.ts:351` findValidCutPoints):
// a cut point is a context-visible USER-like OR ASSISTANT message, never a tool
// result — an assistant message OWNS its tool calls, so its results follow it and
// are kept. Pair-safety (`avoidOrphanPair`) is unchanged in shape.

describe('planCompaction — cuts a history that holds NO user turn in the keep-window (T9b)', () => {
  /** ONE user entry, then three tool rounds — the dream-pass / single-ask shape. */
  function oneAskFixture(): JournalEntry[] {
    resetSeq();
    return [
      entry('user', { text: big('u0') }),                                  // 0  the ONLY user entry
      entry('assistant', { text: big('a0') }),                             // 1  round 1
      entry('tool_use', { toolUseId: 'tu-1', input: { cmd: big('c1') } }), // 2
      entry('tool_result', { toolUseId: 'tu-1', text: big('r1') }),        // 3
      entry('assistant', { text: big('a1') }),                             // 4  round 2
      entry('tool_use', { toolUseId: 'tu-2', input: { cmd: big('c2') } }), // 5
      entry('tool_result', { toolUseId: 'tu-2', text: big('r2') }),        // 6
      entry('assistant', { text: big('a2') }),                             // 7  round 3
    ];
  }

  it('plans a cut at the nearest ASSISTANT boundary at/after the raw cut (RED before T9b: threw "no valid turn-boundary cut")', async () => {
    const entries = oneAskFixture();

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160, // raw cut lands on the tool_result at idx 6
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.uuid).toBe('entry-7');
    expect(firstKept.payload.type).toBe('assistant'); // an ASSISTANT boundary is now legal
    expect(plan.splitTurn).toBe(true); // the cut is not a `user` entry → the turn is split
    // Everything before the cut is summarized; the whole one-ask prefix drops.
    expect(plan.droppedEntries.map((e) => e.uuid)).toEqual([
      'entry-0', 'entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-5', 'entry-6',
    ]);
  });

  it('never lands the cut on a tool_use or a tool_result, and never orphans a pair', async () => {
    const entries = oneAskFixture();

    // 320 (not 160) so the KEPT span holds a whole round — `a1, tu-2, r2, a2`. At 160 the
    // cut was the last assistant and the kept span had no `tool_result` at all, so the
    // orphan loop below never executed and clause 2 pinned nothing.
    //
    // Clause 2 now EXECUTES, but no mutation reddens it on THIS fixture (nothing here
    // straddles). The pair-safety guarantee is carried by the ladder pins and the retreat
    // pin below, and by the generated-journal invariants at the end of this file.
    const plan = await planCompaction({
      entries,
      keepWindowTokens: 320,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(['user', 'assistant']).toContain(firstKept.payload.type);
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
  });

  it('retreats to the previous ASSISTANT boundary rather than orphan a cross-round pair (pair-safety, unchanged in shape)', async () => {
    resetSeq();
    // tu-A's result lands AFTER a later assistant entry, so the nearest boundary
    // at/after the raw cut (idx 3) would keep the result and drop its use.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),                                  // 0
      entry('assistant', { text: big('a0') }),                             // 1  ← retreat target
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: big('qA') } }), // 2
      entry('assistant', { text: big('a1') }),                             // 3  ← naive (orphaning) boundary
      entry('tool_result', { toolUseId: 'tu-A', text: big('rA') }),        // 4  cross-round result
      entry('assistant', { text: big('a2') }),                             // 5
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 240, // raw cut = idx 3, which splits tu-A ↔ its result
      preTokens: 999,
      summarize: fakeSummarize,
    });

    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    expect(firstKept.uuid).toBe('entry-1'); // retreated so the WHOLE pair stays kept
    expect(plan.droppedEntries.map((e) => e.uuid)).toEqual(['entry-0']);
    // No orphan on the kept side — the assertion the pair-safety mutation reddens.
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
  });

  it('a CHAT-shaped journal whose raw cut lands on a `user` entry plans the IDENTICAL cut, and is NOT a split turn', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: 'ls' } }),
      entry('tool_result', { toolUseId: 'tu-A', text: big('r0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 160,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    // The pre-T9b cut, unchanged: the recent `user` turn.
    expect(plan.firstKeptId).toBe('entry-4');
    expect(plan.splitTurn).toBe(false);
  });
});

// ─── T9b: the split-turn signal reaches the injected summarize callback ───────────

describe('planCompaction — tells the summarizer whether a real ask survived the cut', () => {
  it('reports retainedHasRealUserTurn TRUE when a later user turn is kept', async () => {
    // The round-0-of-a-new-turn shape: the cut lands inside the COMPLETED previous turn
    // while the user's fresh ask sits in the kept span. `splitTurn` is true and says
    // nothing useful; only this bit tells the caller the turn it is summarizing is over.
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('the old ask') }),
      entry('assistant', { text: big('a0') }),
      entry('assistant', { text: big('a1') }),
      entry('user', { text: big('the fresh ask') }),
    ];

    let meta: { splitTurn: boolean; retainedHasRealUserTurn: boolean } | undefined;
    const plan = await planCompaction({
      entries,
      // ~78 tokens per big() entry: a window of 200 reaches back past the fresh ask and
      // a1, so the backward walk stops ON a1 (an assistant) and the fresh ask is kept.
      keepWindowTokens: 200,
      preTokens: 999,
      summarize: async (_e, _s, m) => {
        meta = m;
        return 'SUMMARY';
      },
    });

    expect(meta?.splitTurn).toBe(true); // the cut did land on an assistant…
    expect(meta?.retainedHasRealUserTurn).toBe(true); // …but the live ask survived it
    expect(plan.retainedHasRealUserTurn).toBe(true); // and the plan carries it too
  });
});

describe('planCompaction — tells the summarizer when the cut splits a turn', () => {
  it('passes { splitTurn: true } as the third argument when the cut is not a `user` entry', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('tool_use', { toolUseId: 'tu-1', input: { cmd: big('c1') } }),
      entry('tool_result', { toolUseId: 'tu-1', text: big('r1') }),
      entry('assistant', { text: big('a1') }),
    ];

    let meta: { splitTurn: boolean; retainedHasRealUserTurn: boolean } | undefined;
    await planCompaction({
      entries,
      keepWindowTokens: 80,
      preTokens: 999,
      summarize: async (_e, _s, m) => {
        meta = m;
        return 'SUMMARY';
      },
    });

    // T9c: the callback is also told whether a real ask SURVIVED the cut, because
    // `splitTurn` alone does not mean the LIVE turn was split. Here nothing after the
    // cut is a user turn, so the span really is a live turn's prefix.
    expect(meta).toEqual({ splitTurn: true, retainedHasRealUserTurn: false });
  });

  it('passes { splitTurn: false } on a chat-shaped cut that lands on a `user` entry', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    let meta: { splitTurn: boolean; retainedHasRealUserTurn: boolean } | undefined;
    await planCompaction({
      entries,
      keepWindowTokens: 160,
      preTokens: 999,
      summarize: async (_e, _s, m) => {
        meta = m;
        return 'SUMMARY';
      },
    });

    expect(meta).toEqual({ splitTurn: false, retainedHasRealUserTurn: true });
  });
});

// ─── T9b: every refusal carries a NAMED reason (Hermes's guard included) ──────────

describe('planCompaction — refuses with a NAMED reason, never an anonymous throw', () => {
  it('reason `no_valid_cut` when the whole conversation fits the keep window', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'hi' }),
      entry('assistant', { text: 'yo' }),
    ];

    const err = await planCompaction({
      entries,
      keepWindowTokens: 200,
      preTokens: 0,
      summarize: fakeSummarize,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CompactionPlanError);
    expect((err as CompactionPlanError).reason).toBe('no_valid_cut');
    // The message stays the one the fleet already pins.
    expect(String(err)).toContain('no valid turn-boundary cut');
  });

  it('reason `summary_not_smaller` when the dropped span is no larger than its summary (Hermes)', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: 'u0' }),          // 0  the whole dropped span: ~1 token
      entry('user', { text: big('u1') }),     // 1  the cut lands here
      entry('assistant', { text: big('a1') }),// 2
    ];

    const err = await planCompaction({
      entries,
      keepWindowTokens: 156,
      preTokens: 0,
      // A summary far larger than the 1-token span it would replace.
      summarize: async () => 'S'.repeat(400),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CompactionPlanError);
    expect((err as CompactionPlanError).reason).toBe('summary_not_smaller');
  });

  it('reason `summarize_failed` when the injected callback throws, and keeps the cause', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    const boom = new Error('provider 500');
    const err = await planCompaction({
      entries,
      keepWindowTokens: 160,
      preTokens: 0,
      summarize: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CompactionPlanError);
    expect((err as CompactionPlanError).reason).toBe('summarize_failed');
    expect((err as CompactionPlanError).cause).toBe(boom);
  });

  it('reason `empty_summary` when the summarize returns nothing but whitespace (was: a plan to compact to nothing)', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    for (const summary of ['', '  \n\t ']) {
      const err = await planCompaction({
        entries,
        keepWindowTokens: 160,
        preTokens: 0,
        summarize: async () => summary,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CompactionPlanError);
      expect((err as CompactionPlanError).reason).toBe('empty_summary');
    }
  });
});

// ─── S1: the pair-safety loop must never RETURN an orphaning cut ─────────────────
//
// The backward retreat and the forward snap can chase each other: retreating to keep
// pair Q whole pulls pair P across the cut, and snapping forward past P pulls Q back.
// The loop alternated between the two boundaries until its guard ran out and then
// returned whichever cut it happened to hold — an UNVERIFIED cut that orphans a
// `tool_result` from its `tool_use`, which is the one thing this primitive exists to
// prevent. A valid cut existed the whole time.

describe('planCompaction — the pair-safety loop never returns an orphaning cut', () => {
  it('escapes a back/forward ladder by snapping past EVERY pair the walk has straddled', async () => {
    resetSeq();
    // The ladder: at cut 5 pair Q straddles and the retreat goes to 2; at cut 2 pair P
    // straddles and the forward snap goes back to 5. entry-7 is pair-safe for both.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),                                  // 0
      entry('tool_use', { toolUseId: 'tu-P', input: { cmd: big('qP') } }), // 1  pair P use
      entry('assistant', { text: big('a1') }),                             // 2
      entry('tool_result', { toolUseId: 'tu-P', text: big('rP') }),        // 3  pair P result
      entry('tool_use', { toolUseId: 'tu-Q', input: { cmd: big('qQ') } }), // 4  pair Q use
      entry('assistant', { text: big('a2') }),                             // 5
      entry('tool_result', { toolUseId: 'tu-Q', text: big('rQ') }),        // 6  pair Q result
      entry('assistant', { text: big('a3') }),                             // 7  ← the safe cut
      entry('assistant', { text: big('a4') }),                             // 8
    ];

    const plan = await planCompaction({
      entries,
      keepWindowTokens: 390,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    expect(plan.firstKeptId).toBe('entry-7');

    // The property, asserted directly: no kept tool_result may lose its tool_use.
    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
  });
});

// ─── N8: a steer that aborts the summarize is not a compaction FAILURE ───────────

describe('planCompaction — an aborted summarize is named `aborted`, not `summarize_failed`', () => {
  it('classifies an abort-shaped throw so a meter never pages on a steer', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
      entry('user', { text: big('u1') }),
      entry('assistant', { text: big('a1') }),
    ];

    // What a steer looks like from here: the OLD run scope is aborted mid-summarize while
    // the LIVE signal is untouched, so the throw reaches the planner rather than the
    // user_aborted path. Recording it as a failure would page T11o on ordinary steering.
    const aborted = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    const err = await planCompaction({
      entries,
      keepWindowTokens: 160,
      preTokens: 0,
      summarize: async () => {
        throw aborted;
      },
    }).catch((e: unknown) => e);

    expect((err as CompactionPlanError).reason).toBe('aborted');
    expect((err as CompactionPlanError).cause).toBe(aborted);
  });
});

// ─── S-R2: the ladder is a SCAN, not a chase ─────────────────────────────────────
//
// The chase's termination proof was wrong: it alternated backward/forward and could burn its
// guard while a safe cut existed. At k = 13 interleaved pairs it refused outright. The
// primitive is now a SCAN over candidate boundaries — from the raw cut downward, then upward
// — returning the first with no straddling pair. Same preference order (backward first), so
// it returns the identical cut everywhere the chase succeeded; it terminates by construction.

/** `k` interleaved pairs: user, then k x (tool_use_i, assistant_i, tool_result_i), then two
 *  trailing assistants. Every in-ladder assistant sits INSIDE its own pair, so the only
 *  pair-safe boundaries are the two at the end. n = 1 + 3k + 2. */
function interleavedLadder(k: number): JournalEntry[] {
  resetSeq();
  const out: JournalEntry[] = [entry('user', { text: big('u0') })];
  for (let i = 0; i < k; i++) {
    out.push(entry('tool_use', { toolUseId: `tu-${i}`, input: { cmd: big(`q${i}`) } }));
    out.push(entry('assistant', { text: big(`a${i}`) }));
    out.push(entry('tool_result', { toolUseId: `tu-${i}`, text: big(`r${i}`) }));
  }
  out.push(entry('assistant', { text: big('tail-1') }));
  out.push(entry('assistant', { text: big('tail-2') }));
  return out;
}

describe('planCompaction — the k=13 interleaved ladder (RED with the chase: no_valid_cut)', () => {
  it('finds the safe cut past every pair instead of burning a guard', async () => {
    const entries = interleavedLadder(13);
    expect(entries).toHaveLength(42);

    // 3,120 puts the raw cut on the FIRST ladder boundary (entry-2), which straddles pair 0.
    const plan = await planCompaction({
      entries,
      keepWindowTokens: 3_120,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    // The only pair-safe boundaries are the two trailing assistants; the scan takes the first.
    expect(plan.firstKeptId).toBe('entry-40');
    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
  });
});

// ─── S-R2: the generated property pin ────────────────────────────────────────────
//
// The spec reviewer ran 800k generated journals by hand once. This is the small, seeded,
// permanent version: it asserts the two invariants on every shape, and — for this round only
// — that the scan agrees with the chase wherever the chase returned a cut at all.

/** Deterministic PRNG (mulberry32) so a failure is reproducible from the seed alone. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random journal of `n` entries: users, assistants, and tool pairs whose halves may be
 *  separated by other entries (the shape that makes pair-safety hard). */
function generateJournal(rand: () => number, n: number): JournalEntry[] {
  resetSeq();
  const out: JournalEntry[] = [];
  const openUses: string[] = [];
  let pairId = 0;
  while (out.length < n) {
    const roll = rand();
    if (roll < 0.3) out.push(entry('user', { text: big('u') }));
    else if (roll < 0.6) out.push(entry('assistant', { text: big('a') }));
    else if (roll < 0.85) {
      const id = `tu-${pairId++}`;
      openUses.push(id);
      out.push(entry('tool_use', { toolUseId: id, input: { cmd: big('q') } }));
    } else if (openUses.length > 0) {
      // Close a RANDOM open pair, so halves interleave rather than nest neatly.
      const idx = Math.floor(rand() * openUses.length);
      out.push(entry('tool_result', { toolUseId: openUses.splice(idx, 1)[0]!, text: big('r') }));
    } else {
      out.push(entry('assistant', { text: big('a') }));
    }
  }
  return out;
}

describe('planCompaction — generated journals (seed 20260901, 400 journals, n <= 30)', () => {
  it('never plans an orphaning cut and never lands on a tool entry, whatever the shape', async () => {
    // The permanent half of the equivalence work. Before the chase was deleted this same
    // corpus also asserted scan === chase on every cut the planner would accept: 400 journals,
    // 367 cuts, 353 agreements, 47 chase refusals/out-of-range, zero disagreements. What
    // survives is the pair of invariants, driven through the REAL planner contract rather
    // than the private primitive.
    const rand = prng(20260901);
    let planned = 0;
    let refused = 0;

    for (let j = 0; j < 400; j++) {
      const n = 4 + Math.floor(rand() * 27); // 4..30
      const entries = generateJournal(rand, n);

      let plan: Awaited<ReturnType<typeof planCompaction>> | undefined;
      try {
        plan = await planCompaction({
          entries,
          keepWindowTokens: Math.floor(entries.length * 78 * rand()),
          preTokens: 0,
          summarize: fakeSummarize,
        });
      } catch (e) {
        // Every refusal is named — that is itself the contract.
        expect(e).toBeInstanceOf(CompactionPlanError);
        refused++;
        continue;
      }
      planned++;

      const firstKept = entries.find((e) => e.uuid === plan!.firstKeptId)!;
      // INVARIANT 1 — the cut is a boundary, never a tool entry.
      expect(['user', 'assistant']).toContain(firstKept.payload.type);
      // INVARIANT 2 — no kept tool_result lost its tool_use.
      const kept = entries.filter((e) => e.seq >= firstKept.seq);
      const keptUseIds = new Set(
        kept.filter((e) => e.payload.type === 'tool_use')
          .map((e) => (e.payload as { toolUseId: string }).toolUseId),
      );
      for (const e of kept) {
        if (e.payload.type === 'tool_result') {
          expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
        }
      }
    }

    // The corpus exercised both outcomes — otherwise this pins nothing.
    expect(planned).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(0);
  });
});

// ─── S-3: a raw cut INSIDE the final round must retreat, not refuse ───────────────
//
// The snap is forward-only, so when the raw token walk stops inside the last round there is
// no boundary at or after it and the plan refused — even though the round's own assistant
// entry sits just below and is pair-safe. On a 1M lane a single capped tool result (~20k,
// the keep window itself) reproduces this at the next head. Hermes retreats when it cannot
// advance; the scan already walks downward, so the snap just has to hand it a real index
// instead of the off-the-end sentinel.

describe('planCompaction — the raw cut lands inside the FINAL round (RED: no_valid_cut)', () => {
  it('retreats to the round\'s own boundary instead of refusing', async () => {
    resetSeq();
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),                                   // 0
      entry('assistant', { text: big('a0') }),                              // 1  ← the safe cut
      entry('tool_use', { toolUseId: 'tu-A', input: { cmd: 'a' } }),        // 2
      entry('tool_use', { toolUseId: 'tu-B', input: { cmd: 'b' } }),        // 3
      entry('tool_result', { toolUseId: 'tu-A', text: 'x '.repeat(1_500) }), // 4
      entry('tool_result', { toolUseId: 'tu-B', text: 'y '.repeat(1_500) }), // 5
    ];

    // 2,000 stops the walk at entry 4, so the raw cut is 5 — a `tool_result`, with only
    // tool entries after it. Nothing to snap forward TO.
    const plan = await planCompaction({
      entries,
      keepWindowTokens: 2_000,
      preTokens: 999,
      summarize: fakeSummarize,
    });

    expect(plan.firstKeptId).toBe('entry-1');
    // Both pairs stay whole on the kept side.
    const firstKept = entries.find((e) => e.uuid === plan.firstKeptId)!;
    const kept = entries.filter((e) => e.seq >= firstKept.seq);
    const keptUseIds = new Set(
      kept.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { toolUseId: string }).toolUseId),
    );
    for (const e of kept) {
      if (e.payload.type === 'tool_result') {
        expect(keptUseIds.has((e.payload as { toolUseId: string }).toolUseId)).toBe(true);
      }
    }
  });

  it('but a journal where NOTHING fits the window still refuses', async () => {
    resetSeq();
    // The raw walk never gets inside the budget at all — that is not "the cut landed in the
    // final round", it is "there is no window", and it must stay a refusal.
    const entries: JournalEntry[] = [
      entry('user', { text: big('u0') }),
      entry('assistant', { text: big('a0') }),
    ];
    const err = await planCompaction({
      entries,
      keepWindowTokens: 1,
      preTokens: 0,
      summarize: fakeSummarize,
    }).catch((e: unknown) => e);
    expect((err as CompactionPlanError).reason).toBe('no_valid_cut');
  });
});
