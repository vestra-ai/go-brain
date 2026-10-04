/**
 * CONTEXT_ELISION_V1 — the monotonic ratchet across a REAL journal rewrite.
 *
 * `elide.test.ts` case 9 proves the release over hand-built projections. This file
 * proves it over the real machinery: a real `Journal`, the real `planCompaction`
 * cut, the real `journal.compact()` splice, and the real `applyCompaction`
 * re-heading inside `project()`. Nothing about the rewrite is simulated, which is
 * the point — the release is derived from what the splice DOES to the projection,
 * so a test that hand-built the "after" list could not tell a real release from a
 * fixture that happened to look like one.
 *
 * Two describe blocks, and the second is the one nothing else covers:
 *
 *   the ratchet across a real compaction — the kernel functions over a real splice.
 *   prepareElision across two turns  — the ENGINE SEAM. Every other harness case
 *     runs one turn, where `rc.elisionCut` is null and the clamp is inert whatever
 *     it is handed, so nothing pinned that prepareElision passes it the projection
 *     at all. Both directions are covered here: a carry across a text shrink and a
 *     release across a compaction.
 *
 * The numbers are the dominant lane's: budget 180,000 (the compaction trigger on
 * every model that declares `preferredMaxInputTokens`), stride 54,000, live 45,000.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { planCompaction } from '../../kernel/compaction/compactor.js';
import { SNAPSHOT_TEXT_HEADER } from '../../kernel/compaction/prune-snapshots.js';
import { prepareElision } from '../context-elision.js';
import { summarizeSpan, type CompactionDeps } from '../compaction-run.js';
import {
  COMPACTION_USER,
  COMPACTION_PREVIOUS_SUMMARY_LABEL,
  COMPACTION_PREVIOUS_SUMMARY_OPEN,
  COMPACTION_PREVIOUS_SUMMARY_CLOSE,
} from '../../contract/compaction-prompt.js';
import { FakeTransport, type ProviderHistory, type StreamEvent } from '../transport.js';
import { createRunContext } from '../run-context.js';
import { projectTokenCount } from '../../kernel/journal/token-ledger.js';
import {
  computeElisionCut,
  clampCutMonotonic,
  elideProjection,
} from '../../kernel/compaction/elide.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';

const FLAG = 'CONTEXT_ELISION_V1';
const V2 = 'COMPACTION_V2';
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[V2];
});

/** The compaction trigger on the dominant lane — see engine/compaction-budget.ts. */
const BUDGET = 180_000;
/** The shipped default (compaction-run.ts DEFAULT_COMPACTION). */
const KEEP_WINDOW_TOKENS = 20_000;
/** ~15,000 estimated tokens of tool output per turn. */
const fatBody = 'result-line-of-output '.repeat(2_700);

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(
    tmpdir(),
    `elide-rewrite-${process.pid}-${Math.random().toString(36).slice(2)}`,
    `${taskId}.jsonl`,
  );
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** `from` keeps toolUseIds unique across two calls — a repeated id is not an
 *  append, it is `keepLastToolResultPerId` dropping the earlier result. */
async function seedTurns(j: Journal, taskId: string, n: number, from = 0): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { file_path: `/f${i}` } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: `tu-${i}`,
        blocks: [{ type: 'text', text: fatBody } as ContentBlock],
      },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'fake-model',
      },
    });
  }
}

/** The compaction body's splice, verbatim from compaction-run.ts runCompaction. */
async function reallyCompact(j: Journal, taskId: string): Promise<void> {
  const messages = (await j.project()).messages;
  const plan = await planCompaction({
    entries: messages,
    keepWindowTokens: KEEP_WINDOW_TOKENS,
    preTokens: projectTokenCount(messages).messages,
    summarize: async () => 'The agent read several files and reported on each.',
  });
  const summaryEntry = await j.append({
    ...base(taskId),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text: plan.summaryText } as ContentBlock] },
  });
  await j.compact({
    summaryUuid: summaryEntry.uuid,
    preservedUuids: plan.preservedUuids,
    firstKeptId: plan.firstKeptId,
    trigger: 'auto',
    preTokens: 0,
    postTokens: plan.postTokens,
    base: base(taskId),
  });
}

const userEntries = (m: ReadonlyArray<{ payload: { type: string } }>) =>
  m.filter((e) => e.payload.type === 'user').length;

describe('CONTEXT_ELISION_V1 — the ratchet across a real compaction', () => {
  it('releases the cut, and the keep window survives intact', async () => {
    const taskId = 't-rewrite-release';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    // BEFORE — a real, live cut on a real projection.
    const before = (await j.project()).messages;
    const cutBefore = clampCutMonotonic(computeElisionCut(before, BUDGET), null, before);
    expect(cutBefore.strideTokens).toBe(54_000);
    expect(cutBefore.resultCutTokens).toBeGreaterThan(0);
    expect(elideProjection(before, cutBefore, { taskId }).elidedResults).toBeGreaterThan(0);

    // THE REWRITE — the real planner, the real splice, the real re-projection.
    await reallyCompact(j, taskId);
    const after = (await j.project()).messages;
    expect(after[0].payload.type).toBe('user'); // applyCompaction re-headed the list
    expect(after[0].seq).toBeGreaterThan(before[before.length - 1].seq); // …with a NEW entry
    expect(after.length).toBeLessThan(before.length);

    // The raw policy is correct on its own: too few user turns survive to elide.
    const raw = computeElisionCut(after, BUDGET);
    expect(userEntries(after)).toBeLessThan(4);
    expect(raw.resultCutTokens).toBe(0);

    // THE FIX — the ratchet must not override that zero.
    const clamped = clampCutMonotonic(raw, cutBefore, after);
    expect(clamped.resultCutTokens).toBe(0);
    expect(clamped.imageCutTokens).toBe(0);
    expect(elideProjection(after, clamped, { taskId }).replacements.size).toBe(0);

    // POSITIVE CONTROL — the carried cut really would have gutted the keep window
    // the compactor just ran in order to preserve.
    const unreleased = elideProjection(after, cutBefore, { taskId });
    expect(unreleased.elidedResults).toBeGreaterThan(0);
    expect(unreleased.freedTokens).toBeGreaterThan(KEEP_WINDOW_TOKENS / 4);
  });

  it('CONTROL: without a rewrite, more turns on the same journal still ratchet', async () => {
    // The other half of the contract, on the same real journal: appends carry the
    // cut forward exactly as before. A release that fired on ordinary growth would
    // reinstate the 2026-08-13 cache regression, so this is asserted, not assumed.
    const taskId = 't-rewrite-control';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const first = (await j.project()).messages;
    const cut1 = clampCutMonotonic(computeElisionCut(first, BUDGET), null, first);
    expect(cut1.resultCutTokens).toBeGreaterThan(0);

    await seedTurns(j, taskId, 6, 20);
    const second = (await j.project()).messages;
    const cut2 = clampCutMonotonic(computeElisionCut(second, BUDGET), cut1, second);
    expect(cut2.resultCutTokens).toBeGreaterThanOrEqual(cut1.resultCutTokens);
    expect(cut2.anchor).not.toBeNull();

    // MONOTONE, the property the ratchet exists for: every entry elided at the
    // shorter length is still elided at the longer one.
    const elided1 = new Set(elideProjection(first, cut1, { taskId }).replacements.keys());
    const elided2 = elideProjection(second, cut2, { taskId }).replacements;
    expect(elided1.size).toBeGreaterThan(0);
    for (const seq of elided1) expect(elided2.has(seq)).toBe(true);
  });

  it('a real rewindTo releases too — the head never moves', async () => {
    // The second rewrite `project()` performs. applyRewind drops an abandoned
    // MIDDLE span, so entries[0] is untouched: a release keyed on the compaction
    // summary alone would carry a cut straight over it.
    const taskId = 't-rewrite-rewind';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const before = (await j.project()).messages;
    const cutBefore = clampCutMonotonic(computeElisionCut(before, BUDGET), null, before);
    expect(cutBefore.resultCutTokens).toBeGreaterThan(0);

    await j.rewindTo(before[8].uuid);
    const after = (await j.project()).messages;
    expect(after[0].uuid).toBe(before[0].uuid); // head unchanged
    expect(after.length).toBeLessThan(before.length); // …but the span is not

    const raw = computeElisionCut(after, BUDGET);
    // NOT VACUOUS: released and carried have to give different answers here.
    expect(raw.resultCutTokens).toBeLessThan(cutBefore.resultCutTokens);
    const clamped = clampCutMonotonic(raw, cutBefore, after);
    expect(clamped.resultCutTokens).toBe(raw.resultCutTokens);
    expect(clamped.imageCutTokens).toBe(raw.imageCutTokens);
  });
});

// ─── The engine seam: prepareElision across two turns of one run ──────────────

/** One `user → tool_use → tool_result → assistant` round with an explicit body. */
async function round(j: Journal, taskId: string, id: string, text: string): Promise<void> {
  await j.append({
    ...base(taskId),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text: `q-${id}` } as ContentBlock] },
  });
  await j.append({
    ...base(taskId),
    payload: { type: 'tool_use', toolUseId: id, name: 'Read', input: { file_path: `/${id}` } },
  });
  await j.append({
    ...base(taskId),
    payload: { type: 'tool_result', toolUseId: id, blocks: [{ type: 'text', text } as ContentBlock] },
  });
  await j.append({
    ...base(taskId),
    payload: {
      type: 'assistant',
      blocks: [{ type: 'text', text: `a-${id}` } as ContentBlock],
      api: 'anthropic_messages',
      provider: 'anthropic',
      model: 'fake-model',
    },
  });
}

/** A page snapshot of roughly `tokens` weight — the shape `pruneSnapshots` matches. */
const snapshot = (tokens: number) => `${SNAPSHOT_TEXT_HEADER}\n` + 'node '.repeat((tokens * 4) / 5);

function harness(taskId: string, j: Journal): {
  ctx: HarnessContext<NativeConfig>;
  cfg: NativeConfig;
} {
  const cfg = {
    journal: j,
    compaction: { keepWindowTokens: KEEP_WINDOW_TOKENS },
    workingDir: join(tmpdir(), `elide-seam-${process.pid}-${Math.random().toString(36).slice(2)}`),
  } as unknown as NativeConfig;
  return {
    cfg,
    ctx: {
      taskId,
      sessionId: 's',
      cwd: '/tmp',
      model: 'claude-sonnet-5',
      signal: new AbortController().signal,
      config: cfg,
    } as HarnessContext<NativeConfig>,
  };
}

describe('CONTEXT_ELISION_V1 — prepareElision carries and releases across turns', () => {
  it('CARRIES across a pruneSnapshots text shrink — the seam hands the clamp the projection', async () => {
    // The retreat here is produced by SHIPPED machinery, not by a fixture pretending:
    // `project()` keeps the newest 2 page snapshots and stubs the rest, so a 4th
    // snapshot landing between two turns drops ~60,000 tokens out of an entry that
    // is still in the projection. The raw cut falls 108,000 -> 54,000; the ratchet
    // is what must hold it, and it can only do that if prepareElision hands it the
    // current projection to reconcile the anchor against.
    process.env[FLAG] = '1';
    process.env[V2] = 'true';
    const taskId = 't-seam-carry';
    const j = makeJournal(taskId);
    await round(j, taskId, 's0', snapshot(60_000));
    await round(j, taskId, 's1', snapshot(60_000));
    await round(j, taskId, 's2', snapshot(400));
    for (let i = 0; i < 8; i++) await round(j, taskId, `f${i}`, fatBody);

    const { ctx, cfg } = harness(taskId, j);
    const rc = createRunContext(taskId);

    const turn1 = await prepareElision(ctx, cfg, rc);
    expect(turn1).not.toBeNull();
    expect(rc.elisionCut!.resultCutTokens).toBe(108_000);

    // A 4th snapshot arrives, so pruneSnapshots now stubs s1 too.
    await round(j, taskId, 's3', snapshot(400));
    expect(computeElisionCut((await j.project()).messages, BUDGET).resultCutTokens).toBe(54_000);

    const turn2 = await prepareElision(ctx, cfg, rc);
    expect(turn2).not.toBeNull();
    expect(rc.elisionCut!.resultCutTokens).toBe(108_000); // held, not retreated

    // MONOTONE at the seam: nothing that shipped as a stub goes back to full bytes.
    // Scoped to the `f*` rounds, because the SNAPSHOT rounds are the ones
    // pruneSnapshots just shrank — their bodies are now placeholders below
    // minResultTokens, so they are no longer worth a stub. That is a shorter wire,
    // not a re-inflated one, and it is pruneSnapshots' behaviour, not the ratchet's.
    const projected = (await j.project()).messages;
    const fatSeqs = new Set(
      projected
        .filter((e) => e.payload.type === 'tool_result' && e.payload.toolUseId.startsWith('f'))
        .map((e) => e.seq),
    );
    let carried = 0;
    for (const seq of turn1!.replacements.keys()) {
      if (!fatSeqs.has(seq)) continue;
      expect(turn2!.replacements.has(seq)).toBe(true);
      carried++;
    }
    expect(carried).toBeGreaterThan(0); // the loop above was not vacuous
  });

  it('RELEASES across a real compaction — end to end through the seam', async () => {
    process.env[FLAG] = '1';
    process.env[V2] = 'true';
    const taskId = 't-seam-release';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const { ctx, cfg } = harness(taskId, j);
    const rc = createRunContext(taskId);

    const turn1 = await prepareElision(ctx, cfg, rc);
    expect(turn1!.replacements.size).toBeGreaterThan(0);
    expect(rc.elisionCut!.resultCutTokens).toBeGreaterThan(0);

    await reallyCompact(j, taskId);
    const after = (await j.project()).messages;
    expect(userEntries(after)).toBeLessThan(4);

    // Nothing in the keep window the compactor preserved is stubbed. Without the
    // release this returns a live elision built on the carried 216,000 cut.
    expect(await prepareElision(ctx, cfg, rc)).toBeNull();
    expect(rc.elision).toBeNull();
  });
});

// ─── The one rewrite that is NOT a rewrite ────────────────────────────────────

/** Records the exact entry array every provider history is built from. */
class SpanRecordingTransport extends FakeTransport {
  spans: JournalEntry[][] = [];
  constructor() {
    super([
      { kind: 'text', text: 'a summary' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ] as StreamEvent[]);
  }
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    this.spans.push(entries);
    return super.historyFromJournal(entries);
  }
}

const textOf = (e: JournalEntry): string =>
  ('blocks' in e.payload ? (e.payload.blocks as Array<{ text?: string }>) : [])
    .map((b) => b.text ?? '')
    .join('');

describe('withLabelledPreviousSummary does not rewrite the journal', () => {
  it('leaves every input entry byte-identical AND by the same reference', async () => {
    // Flagged as an in-place payload rewrite that the anchor would miss. It is not
    // one: `entries.slice()` then `out[idx] = { ...entry, payload }` replaces a SLOT
    // in a COPY, and the result is handed to `historyFromJournal` for the one-shot
    // summarize call and nowhere else — `journal` is never touched. It also operates
    // on `toSummarize`, the span compaction is about to DELETE, not on the projection
    // elision measures. Asserted here rather than read off the source, because
    // "pure" in a doc comment is exactly the kind of claim that goes stale.
    process.env[V2] = 'true';
    const taskId = 't-labelled-summary';
    const transport = new SpanRecordingTransport();

    const head: JournalEntry = {
      uuid: 'prev-summary',
      parentUuid: null,
      seq: 0,
      taskId,
      rootTaskId: taskId,
      spawnDepth: 0,
      workspaceId: 'w',
      agentId: 'native',
      principal: { kind: 'user', userId: 'u' },
      timestamp: '2024-01-01T00:00:00.000Z',
      // The recognizer string previousSummaryIndex matches on.
      payload: {
        type: 'user',
        blocks: [
          { type: 'text', text: 'earlier work.\n\n(Full pre-compaction transcript archived at /a/b.md)' },
        ] as ContentBlock[],
      },
    };
    const tail: JournalEntry = { ...head, uuid: 'a1', parentUuid: 'prev-summary', seq: 1,
      principal: { kind: 'agent', agentId: 'native' },
      payload: { type: 'user', blocks: [{ type: 'text', text: 'then more' } as ContentBlock] } };

    const span = [head, tail];
    const before = JSON.stringify(span);

    await summarizeSpan(
      {
        ctx: { taskId, model: 'claude-sonnet-5', config: {} } as never,
        transport,
      } as unknown as CompactionDeps,
      span,
    );

    // PURITY — the caller's array and its entries are untouched, so a cut anchored
    // on `head` still reconciles: same seq, same index, same head.
    expect(JSON.stringify(span)).toBe(before);
    expect(span[0]).toBe(head);
    expect(span[1]).toBe(tail);

    // POSITIVE CONTROL — the labelling branch actually FIRED, so the purity above is
    // not the trivial "previousSummaryIndex returned -1 and nothing happened".
    expect(transport.spans).toHaveLength(1);
    expect(textOf(transport.spans[0][0])).toContain(COMPACTION_PREVIOUS_SUMMARY_LABEL);
    // …and FENCED, not merely labelled (finding 7): the carried summary sits between the
    // <previous_summary> markers on the wire. Mutation: drop the fence from the call
    // site (a bare label prefix again) → no markers reach the transport.
    const carried = textOf(transport.spans[0][0]);
    expect(carried).toContain(COMPACTION_PREVIOUS_SUMMARY_OPEN);
    expect(carried.trimEnd().endsWith(COMPACTION_PREVIOUS_SUMMARY_CLOSE)).toBe(true);
    expect(carried.indexOf(COMPACTION_PREVIOUS_SUMMARY_OPEN)).toBeLessThan(carried.indexOf(textOf(head)));
    expect(transport.spans[0][0]).not.toBe(head); // a NEW object, not a mutation

    // RE-RULED by T9b fix round 2 (S-R4): the TRAILING entry is now a copy too, when the
    // span ends on a `user` entry — the summarize instruction is appended as a second text
    // block ON it rather than as a separate entry, because Chat Completions and OpenAI
    // Responses have no rule that merges two consecutive user messages. The PURITY claim
    // this test exists for is unchanged and asserted above (the caller's array and entries
    // are untouched); what is re-ruled is only "everything else rides by reference".
    expect(transport.spans[0][1]).not.toBe(tail);
    expect(textOf(transport.spans[0][1])).toContain('then more'); // the original text survives
    expect(textOf(transport.spans[0][1])).toContain(COMPACTION_USER); // …with the instruction on it
  });
});
