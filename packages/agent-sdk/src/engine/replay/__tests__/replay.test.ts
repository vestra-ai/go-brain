/**
 * Harness-9 W2 — keyless replay. A recorded journal drives the REAL kernel loop
 * (NativeHarness.run → runOneRound → gateAndDispatchTool) with no provider key and
 * must reproduce itself, with zero reconstruction mismatches. The three fixtures
 * under src/__fixtures__/replay are real staging recordings (redacted); 03 is 02
 * plus an in-stream `overloaded_error` fault directive before its second round.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { APIError } from '@anthropic-ai/sdk';
import {
  replaySession,
  parseFixture,
  groupRounds,
  journalToStreamEvents,
  ReplayTransport,
  ReplayExhausted,
  ReplayTools,
  ReplayMissingResult,
} from '../index.js';
import type { JournalEntry, JournalPayload } from '../../../contract/journal.js';
import { isContextEntry } from '../../../contract/journal.js';
import { suspendPending } from '../../../kernel/journal/journal.js';
import type { ContentBlock } from '../../../contract/blocks.js';
import type { StreamEvent } from '../../transport.js';
import type { RawToolOptions, ToolExecuteContext } from '../../../tools/tool-types.js';
import {
  fenceUntrustedText,
  stripUntrustedFence,
  UNTRUSTED_CONTENT_OPEN,
  UNTRUSTED_CONTENT_CLOSE,
} from '../../../tools/tool-types.js';
import { SUBAGENT_RUNAWAY_DIRECTIVE } from '../../subagent-watchdog.js';
import { collectTurnTaintSpans, isSideEffectingFamily, type InjectionTaintSpan } from '../../../policy/injection-screen.js';
import { classifySideEffect } from '../../../policy/side-effect-classifier.js';
import type { Journal } from '../../../kernel/journal/journal.js';
import type { ToolCall } from '../../../contract/harness.js';

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'FIREWORKS_API_KEY'];
beforeAll(() => {
  // Keyless by construction: the suite must never see a key.
  for (const k of KEYS) delete process.env[k];
});

const FIX = new URL('../../../__fixtures__/replay/', import.meta.url).pathname;
const FIXTURES = ['01-plain-text-turn.jsonl', '02-read-grep-tools.jsonl', '03-multi-round-with-error-frame.jsonl'];

async function loadFixture(path: string): Promise<JournalEntry[]> {
  return parseFixture(await readFile(path, 'utf8')).entries;
}

/**
 * Drop the fields Task 1 recorded as volatile: ids (uuid/parentUuid), seq,
 * timestamp, cost — plus the `tool_batch_shape` telemetry rows.
 *
 * Those rows are OBSERVATIONS OF the replay, not part of the conversation it
 * reproduces: the engine derives each one from the round's own tool_uses, they are
 * CONTEXT_POLICY:false (the reconstruction check above, which compares the model-
 * bound projection, is untouched and still asserted at zero mismatches), and the
 * three fixtures are recordings that predate the leg. Stripping BOTH sides keeps
 * this equality about what it is for — that a replay re-derives the recorded
 * conversation and its accounting — and keeps pre- and post-leg recordings
 * interchangeable. The rows' own content is pinned by
 * round-engine.batch-shape-telemetry.test.ts.
 */
function stripVolatile(entries: JournalEntry[]): unknown[] {
  return entries
    .filter((e) => !(e.payload.type === 'custom' && e.payload.key === 'tool_batch_shape'))
    .map((e) => {
    const { uuid: _u, parentUuid: _p, seq: _s, timestamp: _t, ...rest } = e;
    if (rest.payload.type === 'usage') {
      const { intelligence: _i, raw, ...payload } = rest.payload;
      const { costUsd: _c, ...rawRest } = (raw ?? {}) as Record<string, unknown>;
      return { ...rest, payload: { ...payload, raw: rawRest } };
    }
    return rest;
  });
}

const isAssistant = (e: JournalEntry): boolean => e.payload.type === 'assistant';
const countAssistant = (entries: JournalEntry[]): number => entries.filter(isAssistant).length;

describe('keyless replay', () => {
  it('the suite holds no provider key', () => {
    for (const k of KEYS) expect(process.env[k]).toBeUndefined();
  });

  it.each(FIXTURES)(
    '%s replays to a journal semantically identical to the recording, with zero reconstruction mismatches',
    async (name) => {
      const recorded = await loadFixture(FIX + name);
      const { journal, mismatches, transport } = await replaySession(FIX + name, { reconstructionCheck: 'throw' });
      expect(mismatches).toEqual([]);
      expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
      // Every recorded round was consumed — the replay neither skipped nor invented a model call.
      expect(transport.remaining).toBe(0);
    },
  );

  it('03 re-issues after the recorded in-stream overloaded_error (the Wave 1 classifier fix, pinned)', async () => {
    const recorded = await loadFixture(FIX + '03-multi-round-with-error-frame.jsonl');
    const { journal, transport, events } = await replaySession(FIX + '03-multi-round-with-error-frame.jsonl');
    // The recording has N assistant entries AFTER the error frame; the replay must reach them.
    expect(countAssistant(journal)).toBe(countAssistant(recorded));
    // The frame was delivered exactly once and cost exactly one extra model call (the re-issue).
    expect(transport.faultsThrown).toBe(1);
    expect(transport.calls).toBe(countAssistant(recorded) + 1);
    const ends = events.filter((e) => e.kind === 'turn_end');
    expect(ends.every((e) => e.kind === 'turn_end' && e.outcome.kind === 'completed')).toBe(true);
  });
});

/**
 * W3-2 — the concurrent read-only batch fixture. 04 is SYNTHESIZED (per the fixtures
 * README) with the TWO-PHASE journal shape the concurrent run writes: both tool_use
 * entries land before either result, results follow in wire order. It deliberately
 * stays OUT of the generic FIXTURES equality sweep: the default stubs are unmarked
 * (fail-closed), and 02's Grep+Read round was RECORDED pairwise-sequential — marking
 * the default stubs would re-shape 02's replay journal and break its equality. 04
 * instead passes explicitly `concurrencySafe`-marked tools through the existing
 * `opts.tools` seam. On a build without the feature the batch replays sequentially,
 * journals pairwise, and the equality assertion FAILS — the fixture pins the feature.
 */
describe('W3-2 — concurrent Read+Grep batch (fixture 04)', () => {
  const CONCURRENT_FIXTURE = '04-concurrent-read-grep-batch.jsonl';
  /** Marked shells for the recorded names; replaySession wraps them, so execute()
   *  is replaced by the recorded-result answerer — only name/schema/marker matter. */
  const markedTools = (): RawToolOptions[] =>
    ['Read', 'Grep'].map((name) => ({
      name,
      description: `replay ${name} (concurrencySafe)`,
      parameters: z.object({}).passthrough(),
      concurrencySafe: true,
      execute: async () => 'replaced-by-wrap',
    }));

  it('replays to equality with marked tools: both results land, journal order = wire order (two-phase batch)', async () => {
    const recorded = await loadFixture(FIX + CONCURRENT_FIXTURE);
    const { journal, mismatches, transport, events } = await replaySession(FIX + CONCURRENT_FIXTURE, {
      reconstructionCheck: 'throw',
      tools: markedTools(),
    });
    expect(mismatches).toEqual([]);
    // Journal-order stability — the recording carries the CONCURRENT two-phase
    // shape (tu, tu, res, res), so equality here proves the batch journaled in
    // wire order. A sequential replay (feature absent) journals pairwise and fails.
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    expect(transport.remaining).toBe(0);
    // Both results landed, in wire order.
    const results = journal
      .filter((e) => e.payload.type === 'tool_result')
      .map((e) => (e.payload as { toolUseId: string }).toolUseId);
    expect(results).toEqual(['toolu_04ReadConcurrent00001', 'toolu_04GrepConcurrent00001']);
    // The batch really took the concurrent path: PASS 1 emitted both tool_use
    // blocks up-front, PASS 2 drained results in batch order.
    const blockSeq = events
      .filter((e): e is Extract<typeof e, { kind: 'block' }> => e.kind === 'block')
      .map((e) => e.block as { type: string; toolUseId?: string })
      .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
      .map((b) => `${b.type}:${b.toolUseId}`);
    expect(blockSeq).toEqual([
      'tool_use:toolu_04ReadConcurrent00001',
      'tool_use:toolu_04GrepConcurrent00001',
      'tool_result:toolu_04ReadConcurrent00001',
      'tool_result:toolu_04GrepConcurrent00001',
    ]);
  });

  it('with DEFAULT (unmarked) stubs the same fixture replays the batch sequentially — fail-closed pinned', async () => {
    // No tools passed → stubsFor() shells, no marker → the partitioner must NOT
    // form a run. The journal then comes out PAIRWISE, i.e. NOT equal to the
    // two-phase recording — proving undeclared tools never parallelize.
    const { journal } = await replaySession(FIX + CONCURRENT_FIXTURE, { reconstructionCheck: 'throw' });
    const toolSeq = journal
      .filter((e) => e.payload.type === 'tool_use' || e.payload.type === 'tool_result')
      .map((e) => `${e.payload.type}:${(e.payload as { toolUseId: string }).toolUseId.slice(8, 12)}`);
    expect(toolSeq).toEqual(['tool_use:Read', 'tool_result:Read', 'tool_use:Grep', 'tool_result:Grep']);
  });
});

/**
 * L2 — fixture 04 again, with shells that declare only the `concurrency: 'shared'`
 * class (no W3-2 marker). Flag on: the two-phase recording replays to equality.
 * Flag off: the class is ignored and the batch journals pairwise, exactly as an
 * undeclared tool did before L2.
 */
describe('L2 — concurrency classes replay fixture 04', () => {
  const FLAG = 'TOOL_CONCURRENCY_CLASSES_V1';
  const sharedShells = (): RawToolOptions[] =>
    ['Read', 'Grep'].map((name) => ({
      name, description: `replay ${name} (shared)`, parameters: z.object({}).passthrough(),
      concurrency: 'shared' as const, execute: async () => 'replaced-by-wrap',
    }));
  const pairs = (journal: JournalEntry[]) => journal
    .filter((e) => e.payload.type === 'tool_use' || e.payload.type === 'tool_result')
    .map((e) => `${e.payload.type}:${(e.payload as { toolUseId: string }).toolUseId.slice(8, 12)}`);

  it('flag on: shared-declared reads replay the concurrent recording to equality', async () => {
    process.env[FLAG] = 'true';
    try {
      const recorded = await loadFixture(FIX + '04-concurrent-read-grep-batch.jsonl');
      const { journal, mismatches } = await replaySession(FIX + '04-concurrent-read-grep-batch.jsonl', {
        reconstructionCheck: 'throw', tools: sharedShells(),
      });
      expect(mismatches).toEqual([]);
      expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    } finally {
      delete process.env[FLAG];
    }
  });

  it('flag off: the same shells replay pairwise, as before the class existed', async () => {
    const { journal } = await replaySession(FIX + '04-concurrent-read-grep-batch.jsonl', {
      reconstructionCheck: 'throw', tools: sharedShells(),
    });
    expect(pairs(journal)).toEqual(['tool_use:Read', 'tool_result:Read', 'tool_use:Grep', 'tool_result:Grep']);
  });
});

// ── journalToStreamEvents: the fold runOneRound applies must rebuild the entry ──

function entry(seq: number, payload: JournalPayload): JournalEntry {
  return {
    uuid: `u${seq}`, parentUuid: seq ? `u${seq - 1}` : null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
    workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '', payload,
  };
}

/** Mirror of runOneRound's stream switch (round-engine.ts): what the loop accumulates. */
function fold(events: StreamEvent[]) {
  let text = '';
  const thinking: ContentBlock[] = [];
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  let done: Extract<StreamEvent, { kind: 'done' }> | undefined;
  for (const ev of events) {
    if (ev.kind === 'text') text += ev.text;
    else if (ev.kind === 'thinking_block') thinking.push(ev.signature ? { type: 'thinking', thinking: ev.thinking, signature: ev.signature } : { type: 'thinking', thinking: ev.thinking });
    else if (ev.kind === 'tool_use') toolUses.push(ev.toolUse);
    else if (ev.kind === 'done') done = ev;
  }
  const blocks: ContentBlock[] = [...thinking, ...(text ? [{ type: 'text', text } as ContentBlock] : [])];
  return { blocks, toolUses, done };
}

describe('journalToStreamEvents', () => {
  const signedThinking: ContentBlock = { type: 'thinking', thinking: 'plan', signature: 'sig-1' };
  const recorded = [
    entry(0, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
    entry(1, { type: 'assistant', blocks: [signedThinking, { type: 'text', text: 'looking' }], api: 'anthropic_messages', provider: 'anthropic', model: 'm' }),
    entry(2, { type: 'usage', intelligence: 0.1, actions: 0, compute: 0, raw: { costUsd: 0.1, model: 'm', source: 'round', inputTokens: 11, outputTokens: 7 } }),
    entry(3, { type: 'tool_use', toolUseId: 'tu-1', name: 'Read', input: { file_path: '/workspace/a' } }),
    entry(4, { type: 'tool_result', toolUseId: 'tu-1', blocks: [{ type: 'text', text: 'A' }], isError: false }),
    entry(5, { type: 'tool_use', toolUseId: 'tu-2', name: 'Grep', input: { pattern: 'x' } }),
    entry(6, { type: 'tool_result', toolUseId: 'tu-2', blocks: [{ type: 'text', text: 'no' }], isError: true }),
    entry(7, { type: 'assistant', blocks: [], api: 'anthropic_messages', provider: 'anthropic', model: 'm' }),
    entry(8, { type: 'usage', intelligence: 0.1, actions: 0, compute: 0, raw: { costUsd: 0.1, model: 'm', source: 'round', inputTokens: 5, outputTokens: 1 } }),
    entry(9, { type: 'tool_use', toolUseId: 'tu-3', name: 'Read', input: {} }),
    entry(10, { type: 'tool_result', toolUseId: 'tu-3', blocks: [{ type: 'text', text: 'B' }], isError: false }),
    entry(11, { type: 'assistant', blocks: [{ type: 'thinking', thinking: 'unsigned' }, { type: 'text', text: 'done' }], api: 'openai_chat_completions', provider: 'openai', model: 'd' }),
    entry(12, { type: 'usage', intelligence: 0, actions: 0, compute: 0, raw: { costUsd: 0, model: 'd', source: 'round', inputTokens: 1, outputTokens: 1 } }),
  ];

  it('groups the journal into rounds: assistant + its usage + its tool_use entries, in order', () => {
    const rounds = groupRounds(recorded, []);
    expect(rounds.map((r) => r.assistant.seq)).toEqual([1, 7, 11]);
    expect(rounds.map((r) => r.toolUses.map((t) => t.payload.type === 'tool_use' && t.payload.toolUseId))).toEqual([['tu-1', 'tu-2'], ['tu-3'], []]);
    expect(rounds.map((r) => r.usage?.seq)).toEqual([2, 8, 12]);
  });

  it('a signed-thinking + text + tool round folds back to the recorded blocks, tool_uses, stop reason and usage', () => {
    const [round] = groupRounds(recorded, []);
    const events = journalToStreamEvents(round);
    // Live-emission order: thinking opens before its fragment, before the text.
    expect(events.slice(0, 3).map((e) => e.kind)).toEqual(['thinking_start', 'thinking', 'text']);
    const { blocks, toolUses, done } = fold(events);
    expect(blocks).toEqual([signedThinking, { type: 'text', text: 'looking' }]);
    expect(toolUses).toEqual([
      { id: 'tu-1', name: 'Read', input: { file_path: '/workspace/a' } },
      { id: 'tu-2', name: 'Grep', input: { pattern: 'x' } },
    ]);
    expect(done).toEqual({ kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('a tool-only round (no blocks) emits no text and no thinking; an unsigned thinking block stays unsigned', () => {
    const [, toolOnly, unsigned] = groupRounds(recorded, []);
    const a = fold(journalToStreamEvents(toolOnly));
    expect(a.blocks).toEqual([]);
    expect(a.toolUses.map((t) => t.id)).toEqual(['tu-3']);
    expect(a.done?.stopReason).toBe('tool_use');
    const b = fold(journalToStreamEvents(unsigned));
    expect(b.blocks).toEqual([{ type: 'thinking', thinking: 'unsigned' }, { type: 'text', text: 'done' }]);
    expect(b.done?.stopReason).toBe('end_turn');
  });

  it('a fault directive attaches to the NEXT assistant round', () => {
    const fault = { kind: 'stream_error' as const, error: { type: 'overloaded_error', message: 'Overloaded' } };
    const rounds = groupRounds(recorded, [{ beforeEntryIndex: 7, fault }]);
    expect(rounds.map((r) => r.faults.length)).toEqual([0, 1, 0]);
  });
});

// ── parseFixture ─────────────────────────────────────────────────────────────

describe('parseFixture', () => {
  it('separates directive lines from journal entries and records where each directive sits', () => {
    const lines = [
      JSON.stringify(entry(0, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] })),
      '',
      JSON.stringify({ replay: { kind: 'stream_error', error: { type: 'overloaded_error', message: 'Overloaded' } } }),
      JSON.stringify(entry(1, { type: 'assistant', blocks: [], api: 'a', provider: 'p', model: 'm' })),
    ];
    const parsed = parseFixture(lines.join('\n') + '\n');
    expect(parsed.entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(parsed.directives).toEqual([{ beforeEntryIndex: 1, fault: { kind: 'stream_error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
  });
  it('rejects a line that is neither a valid journal entry nor a directive', () => {
    expect(() => parseFixture('{"nope":1}\n')).toThrow(/line 1/);
  });
});

// ── ReplayTransport ──────────────────────────────────────────────────────────

describe('ReplayTransport', () => {
  const fault = { kind: 'stream_error' as const, error: { type: 'overloaded_error', message: 'Overloaded' } };
  const entries = [
    entry(0, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
    entry(1, { type: 'assistant', blocks: [{ type: 'text', text: 'one' }], api: 'anthropic_messages', provider: 'anthropic', model: 'm' }),
    entry(2, { type: 'assistant', blocks: [{ type: 'text', text: 'two' }], api: 'anthropic_messages', provider: 'anthropic', model: 'm' }),
  ];
  const drain = async (t: ReplayTransport): Promise<StreamEvent[]> => {
    const out: StreamEvent[] = [];
    for await (const ev of t.readStream(t.callModel({ model: 'm', system: '', tools: [], history: [], maxTokens: 1 }))) out.push(ev);
    return out;
  };

  it('serves the recorded rounds in order and throws ReplayExhausted past the end', async () => {
    const t = new ReplayTransport(entries);
    expect((await drain(t)).find((e) => e.kind === 'text')).toEqual({ kind: 'text', text: 'one' });
    expect((await drain(t)).find((e) => e.kind === 'text')).toEqual({ kind: 'text', text: 'two' });
    expect(t.remaining).toBe(0);
    expect(() => t.callModel({ model: 'm', system: '', tools: [], history: [], maxTokens: 1 })).toThrow(ReplayExhausted);
  });

  it('a fault round throws the SDK in-stream error shape on the first read, then serves the real round', async () => {
    const t = new ReplayTransport(entries, { directives: [{ beforeEntryIndex: 2, fault }] });
    await drain(t);
    let thrown: unknown;
    try {
      await drain(t);
    } catch (err) {
      thrown = err;
    }
    // Byte-for-byte what @anthropic-ai/sdk core/streaming.js builds for an SSE `event: error`
    // frame: APIError, NO status, the body envelope in `.error`, the typed field in `.type`.
    expect(thrown).toBeInstanceOf(APIError);
    const e = thrown as APIError;
    expect(e.status).toBeUndefined();
    expect(e.type).toBe('overloaded_error');
    expect(e.error).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(t.faultsThrown).toBe(1);
    expect((await drain(t)).find((ev) => ev.kind === 'text')).toEqual({ kind: 'text', text: 'two' });
    expect(t.calls).toBe(3);
  });

  it('stamps api/provider from the recording and never constructs a provider client', () => {
    const t = new ReplayTransport([entry(1, { type: 'assistant', blocks: [], api: 'openai_chat_completions', provider: 'openai', model: 'd' })]);
    expect(t.api).toBe('openai_chat_completions');
    expect(t.provider).toBe('openai');
    expect(t.defaultModel()).toBe('claude-sonnet-5-5'); // the Anthropic dialect's pure default (Sonnet 5 retired 2026-09-29)
  });
});

// ── ReplayTools ──────────────────────────────────────────────────────────────

describe('ReplayTools', () => {
  const entries = [
    entry(0, { type: 'tool_use', toolUseId: 'tu-ok', name: 'Read', input: {} }),
    entry(1, { type: 'tool_result', toolUseId: 'tu-ok', blocks: [{ type: 'text', text: 'file body' }], isError: false }),
    entry(2, { type: 'tool_use', toolUseId: 'tu-err', name: 'Grep', input: {} }),
    entry(3, { type: 'tool_result', toolUseId: 'tu-err', blocks: [{ type: 'text', text: 'boom [error:exec_failed]' }], isError: true }),
  ];
  const ctx = (toolCallId: string): ToolExecuteContext => ({ toolCallId });

  it('resultFor returns the journaled result and throws ReplayMissingResult when absent', () => {
    const tools = new ReplayTools(entries);
    expect(tools.resultFor('tu-ok')).toEqual({ toolUseId: 'tu-ok', text: 'file body', isError: false });
    expect(() => tools.resultFor('nope')).toThrow(ReplayMissingResult);
  });

  it('wrap keeps name/description/parameters and routes execute by the dispatch toolCallId', async () => {
    const real: RawToolOptions = { name: 'Read', description: 'reads', parameters: { type: 'object' }, execute: () => 'LIVE' };
    const [wrapped] = new ReplayTools(entries).wrap([real]);
    expect(wrapped.name).toBe('Read');
    expect(wrapped.description).toBe('reads');
    expect(wrapped.parameters).toBe(real.parameters);
    await expect(wrapped.execute({}, ctx('tu-ok'))).resolves.toBe('file body');
  });

  it('S6: a fenced result with a trailer hands back the fenced body alone, so the dispatcher re-mints fence and trailer', async () => {
    const recorded = [
      entry(0, { type: 'tool_use', toolUseId: 'tu-f', name: 'mcp_invoke', input: {} }),
      entry(1, { type: 'tool_result', toolUseId: 'tu-f', blocks: [{ type: 'text', text: `${fenceUntrustedText('server body')}\n[Vestra] note` }], isError: false, taint: 'external' }),
    ];
    const [wrapped] = new ReplayTools(recorded).wrap([{ name: 'mcp_invoke', description: '', parameters: {}, execute: () => '' }]);
    await expect(wrapped.execute({}, ctx('tu-f'))).resolves.toBe('server body');
  });

  it('an isError result is delivered the way the dispatcher maps to isError:true — by throwing its text', async () => {
    const [wrapped] = new ReplayTools(entries).wrap([{ name: 'Grep', description: '', parameters: {}, execute: () => '' }]);
    await expect(wrapped.execute({}, ctx('tu-err'))).rejects.toThrow('boom [error:exec_failed]');
  });

  it('stubsFor synthesizes one tool per recorded name so a keyless replay needs no product tools', () => {
    const stubs = new ReplayTools(entries).stubsFor();
    expect(stubs.map((t) => t.name).sort()).toEqual(['Grep', 'Read']);
  });
});

/**
 * W3-3 — the parent runaway guard fixture. 05 is SYNTHESIZED (per the fixtures
 * README): the same WebSearch call fails identically 8 times, the engine trips,
 * appends the terminal directive as a user-role entry, REFUSES both grace
 * rounds' calls at the gate (the recorded denial results carry the directive
 * text and are produced by the gate, never by a tool), and force-completes.
 * On a build without the parent guard the loop asks for an 11th round —
 * ReplayExhausted — and never writes the directive entry: the fixture pins the
 * feature. The recorded directive entry is engine-authored, so replaySession
 * must NOT drive it as a second user turn (the severed-marker rule).
 */
describe('W3-3 — parent runaway guard (fixture 05)', () => {
  const RUNAWAY_FIXTURE = '05-runaway-identical-failures.jsonl';

  it('replays to equality: trip at 8 identical failures, ONE directive entry, denied grace rounds, force-complete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = await loadFixture(FIX + RUNAWAY_FIXTURE);
    const { journal, mismatches, transport, events } = await replaySession(FIX + RUNAWAY_FIXTURE, {
      reconstructionCheck: 'throw',
    });
    expect(mismatches).toEqual([]);
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    // Exactly the recorded rounds ran: 8 failing + 2 denied grace — the guard,
    // not the recording, stopped the loop (round 11 would throw ReplayExhausted).
    expect(transport.remaining).toBe(0);
    expect(transport.calls).toBe(10);
    // The directive is present EXACTLY once, authored by the replayed engine.
    const directives = journal.filter(
      (e) =>
        e.payload.type === 'user' &&
        e.payload.blocks.some((b) => b.type === 'text' && b.text === SUBAGENT_RUNAWAY_DIRECTIVE),
    );
    expect(directives.length).toBe(1);
    // ONE parent-line trip WARN fired during the replay.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[NativeHarness][runaway-watchdog]')).length).toBe(1);
    // The turn still ended through the normal terminal path.
    const ends = events.filter((e) => e.kind === 'turn_end');
    expect(ends.length).toBe(1);
    expect(ends[0]!.kind === 'turn_end' && ends[0]!.outcome.kind).toBe('completed');
  });
});

/**
 * W4-1 — the tainted WebFetch fixture. 06 is SYNTHESIZED (per the fixtures
 * README): one WebFetch call whose recorded result is FENCE-WRAPPED and whose
 * tool_result entry carries `taint:'external'`. The page content ends with an
 * instruction-shaped sentence (see fixture 06 seq 5 — described here, never
 * quoted) which the fence marks as third-party data. The replay answerer hands
 * the tool the RAW bytes (stripUntrustedFence) and the declaring stub makes the
 * dispatcher RE-MINT the fence + taint, so equality proves the whole rail:
 * a build without it journals the raw text with no `taint` field and FAILS both
 * the byte compare and the field compare. Like 04, the declaration rides the
 * explicit `opts.tools` seam; the default stubs stay undeclared so 01-05 replay
 * byte-identically.
 */
describe('W4-1 — tainted WebFetch result (fixture 06)', () => {
  const TAINT_FIXTURE = '06-tainted-webfetch.jsonl';
  /** Declaring shell for the recorded WebFetch; replaySession wraps it, so
   *  execute() is replaced by the recorded-result answerer — name/schema/marker matter. */
  const declaringTools = (): RawToolOptions[] => [
    {
      name: 'WebFetch',
      description: 'replay WebFetch (untrustedContent)',
      parameters: z.object({}).passthrough(),
      untrustedContent: true,
      execute: async () => 'replaced-by-wrap',
    },
  ];

  it('replays to equality: the dispatcher re-mints the fence + taint, reconstruction green', async () => {
    const recorded = await loadFixture(FIX + TAINT_FIXTURE);
    const { journal, mismatches, transport } = await replaySession(FIX + TAINT_FIXTURE, {
      reconstructionCheck: 'throw',
      tools: declaringTools(),
    });
    expect(mismatches).toEqual([]);
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    expect(transport.remaining).toBe(0);
    // The replayed result really is fenced + tainted — minted by THIS run's
    // dispatcher, not merely carried through (the answerer stripped the frame).
    const result = journal.find((e) => e.payload.type === 'tool_result')!;
    const p = result.payload as { taint?: string; blocks: Array<{ type: string; text: string }> };
    expect(p.taint).toBe('external');
    expect(p.blocks[0]!.text.startsWith(UNTRUSTED_CONTENT_OPEN)).toBe(true);
    expect(p.blocks[0]!.text.endsWith(UNTRUSTED_CONTENT_CLOSE)).toBe(true);
  });

  it('the recorded fenced result round-trips through the answerer strip (raw bytes reach the tool)', async () => {
    const entries = await loadFixture(FIX + TAINT_FIXTURE);
    const tools = new ReplayTools(entries);
    const recordedText = tools.resultFor('toolu_06WebFetchTaint00001').text;
    expect(recordedText.startsWith(UNTRUSTED_CONTENT_OPEN)).toBe(true);
    // The strip is the exact inverse of the mint: re-fencing the stripped bytes
    // reproduces the recorded bytes (what the equality test above relies on).
    const raw = stripUntrustedFence(recordedText);
    expect(raw.startsWith(UNTRUSTED_CONTENT_OPEN)).toBe(false);
    expect(fenceUntrustedText(raw)).toBe(recordedText);
  });
});

describe('fixture 07 — tainted fetch then send (W4-2 shadow injection screen)', () => {
  const SCREEN_FIXTURE = '07-tainted-fetch-then-send.jsonl';

  /** Declaring shells for both recorded tools (production declares Composio wholesale). */
  const screenShells = (): RawToolOptions[] => [
    {
      name: 'WebFetch',
      description: 'replay WebFetch (untrustedContent)',
      parameters: z.object({}).passthrough(),
      untrustedContent: true,
      execute: async () => 'replaced-by-wrap',
    },
    {
      name: 'mcp__composio__GMAIL_SEND_EMAIL',
      description: 'replay composio send (untrustedContent)',
      parameters: z.object({}).passthrough(),
      untrustedContent: true,
      execute: async () => 'replaced-by-wrap',
    },
  ];

  /** A recording seam assembled from the REAL pure pieces, exactly as the product
   *  factory composes them (journal snapshot -> span collection -> family gate),
   *  with the server POST replaced by a sink. */
  function makeRecordingSeam(): {
    requests: Array<{ toolName: string; family: string; spans: InjectionTaintSpan[] }>;
    factory: (journal: Journal) => { maybeScreen(call: ToolCall): Promise<void> };
  } {
    const requests: Array<{ toolName: string; family: string; spans: InjectionTaintSpan[] }> = [];
    return {
      requests,
      factory: (journal: Journal) => ({
        async maybeScreen(call: ToolCall): Promise<void> {
          const entries = await journal.snapshot();
          const spans = collectTurnTaintSpans(entries);
          if (spans.length === 0) return; // the no-taint path pays nothing
          const family = classifySideEffect(call, { workspaceRoot: '' });
          if (!isSideEffectingFamily(family)) return;
          requests.push({ toolName: call.toolName, family, spans });
        },
      }),
    };
  }

  it('replays to equality with NO seam — the shadow rail changes no recorded bytes', async () => {
    const recorded = await loadFixture(FIX + SCREEN_FIXTURE);
    const { journal, mismatches, transport } = await replaySession(FIX + SCREEN_FIXTURE, {
      reconstructionCheck: 'throw',
      tools: screenShells(),
    });
    expect(mismatches).toEqual([]);
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    expect(transport.remaining).toBe(0);
  });

  it('with the seam: exactly ONE screen request — the send, carrying the fetch span — and equality still holds', async () => {
    const recorded = await loadFixture(FIX + SCREEN_FIXTURE);
    const { requests, factory } = makeRecordingSeam();
    const { journal, mismatches } = await replaySession(FIX + SCREEN_FIXTURE, {
      reconstructionCheck: 'throw',
      tools: screenShells(),
      injectionScreen: factory,
    });
    // SHADOW: the active seam leaves the journal byte-identical to the recording.
    expect(mismatches).toEqual([]);
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    // The WebFetch (readonly, and pre-taint) never screens; the send does, once.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolName).toBe('mcp__composio__GMAIL_SEND_EMAIL');
    expect(requests[0]!.family).toBe('external_send');
    expect(requests[0]!.spans).toHaveLength(1);
    expect(requests[0]!.spans[0]).toMatchObject({
      toolUseId: 'toolu_07WebFetchTaint00001',
      toolName: 'WebFetch',
      origin: 'declared',
    });
    // The span's excerpt is the page content with the canonical frame stripped.
    expect(requests[0]!.spans[0]!.excerpt.startsWith('Retreat notes, October draft.')).toBe(true);
    expect(requests[0]!.spans[0]!.excerpt).not.toContain(UNTRUSTED_CONTENT_OPEN);
  });

  it('fixture 02 (no taint) under the same seam: ZERO screen requests — the common path pays nothing', async () => {
    const { requests, factory } = makeRecordingSeam();
    const { mismatches } = await replaySession(FIX + '02-read-grep-tools.jsonl', {
      reconstructionCheck: 'throw',
      injectionScreen: factory,
    });
    expect(mismatches).toEqual([]);
    expect(requests).toEqual([]);
  });
});

/**
 * The OpenAI-Responses arm of the rail.
 *
 * The rail exists to prove one invariant: the wire the loop sends equals what the
 * journal re-derives. `ReplayTransport.historyFromJournal` used to answer
 * `journalToAnthropicMessages(entries)` unconditionally, so EVERY recording — whatever
 * model authored it — was projected through the Anthropic dialect. With no
 * `openai_responses` fixture checked in, the rail had zero coverage of the dialect the
 * only divergence this system has ever recorded lives in, and a gpt recording added to
 * it would have compared the wrong two things and passed regardless.
 *
 * Fixture 08 is a real staging `gpt-5.6-luna` / `openai_responses` recording (redacted):
 * two tool-only rounds (Read, Bash) whose encrypted reasoning rides the tool_use entries
 * (§4.3a), then a text-bearing round whose reasoning rides the assistant entry (PR4 P2).
 * Both shapes matter: a tool-only round journals a TEXT-EMPTY assistant entry, which the
 * projection deliberately emits nothing for — the wire's pushAssistant skips it too.
 */
describe('keyless replay — OpenAI Responses dialect', () => {
  const GPT = FIX + '08-openai-responses-reasoning-tool-rounds.jsonl';

  it('projects a gpt recording through the RESPONSES dialect, not the Anthropic one', async () => {
    const entries = await loadFixture(GPT);
    const transport = new ReplayTransport(entries);
    expect(transport.api).toBe('openai_responses');
    const items = transport.historyFromJournal(entries) as Array<Record<string, unknown>>;
    // Responses input items — the Anthropic projection can emit none of these.
    expect(items.map((i) => i.type ?? `role:${String(i.role)}`)).toEqual([
      'role:user',
      // round 1 — tool-only: the text-empty assistant entry emits NOTHING; its
      // reasoning rides the tool_use and is echoed before the function_call.
      'reasoning',
      'function_call',
      'function_call_output',
      // round 2 — the same shape.
      'reasoning',
      'function_call',
      'function_call_output',
      // round 3 — text-bearing: HEAD reasoning on the assistant entry, then the message.
      'reasoning',
      'role:assistant',
    ]);
    // and NOT the Anthropic shape (a MessageParam has `role` + array `content`).
    expect(items.some((i) => Array.isArray(i.content))).toBe(false);
  });

  it('an Anthropic recording still projects through the Anthropic dialect (unchanged)', async () => {
    const entries = await loadFixture(FIX + '02-read-grep-tools.jsonl');
    const transport = new ReplayTransport(entries);
    expect(transport.api).toBe('anthropic_messages');
    const msgs = transport.historyFromJournal(entries) as Array<Record<string, unknown>>;
    expect(msgs.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(msgs.some((m) => Array.isArray(m.content))).toBe(true);
    // No Responses item ever leaks into the Anthropic arm.
    expect(msgs.some((m) => m.type === 'function_call')).toBe(false);
  });

  it('hands the recorded reasoning back on the SAME split a live Responses stream uses', async () => {
    const entries = await loadFixture(GPT);
    const transport = new ReplayTransport(entries);
    // Round 1 is tool-only: its reasoning rode the tool_use, so it comes back keyed to
    // that call_id — never as a head (callId:null) item.
    transport.callModel({} as never);
    const round1 = transport.capturedReasoning();
    expect(round1).toHaveLength(1);
    expect(round1[0]!.callId).toBe('call_wkloDuhGHBDy8rq1as7DD53z');
    expect(round1[0]!.encryptedContent).toBeTruthy();
  });

  /**
   * The in-memory push methods. A replay is always journaled, so the round loop rebuilds
   * history from the journal and never folds a round in through pushAssistant — but the
   * engine-authored in-turn paths (empty-recovery seat + nudge, the severed-stream seal,
   * a mid-turn steer, vision look) push onto `history` on the journal path too. On a
   * Responses recording those must emit Responses items: an Anthropic MessageParam
   * pushed into a Responses history is exactly the wire/journal desync this rail exists
   * to catch, and it would corrupt the very array the check compares.
   */
  it('pushes RESPONSES input shapes on a gpt recording (the engine-authored in-turn paths)', async () => {
    const entries = await loadFixture(GPT);
    const t = new ReplayTransport(entries);
    const h = t.emptyHistory();

    t.pushUser(h, 'hello');
    // A tool-only turn pushes NO assistant message (the PR11 shape) — only the call.
    t.pushAssistant(h, [
      { type: 'tool_use', toolUseId: 'call_x', toolName: 'Read', toolInput: { path: '/a' } },
    ] as ContentBlock[]);
    t.pushToolResult(h, { toolUseId: 'call_x', text: 'file body', isError: false } as never);
    // A text-bearing turn pushes the message, then its calls.
    t.pushAssistant(h, [
      { type: 'thinking', thinking: 'dropped — no Responses input form', signature: 's' },
      { type: 'text', text: 'done' },
    ] as ContentBlock[]);

    const items = h as Array<Record<string, unknown>>;
    expect(items.map((i) => i.type ?? `role:${String(i.role)}`)).toEqual([
      'role:user',
      'function_call',
      'function_call_output',
      'role:assistant',
    ]);
    expect(items[0]).toEqual({ role: 'user', content: 'hello' });
    expect(items[1]).toMatchObject({ call_id: 'call_x', name: 'Read', arguments: '{"path":"/a"}' });
    expect(items[2]).toMatchObject({ call_id: 'call_x', output: 'file body' });
    expect(items[3]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('pushUser carries images through the Responses content-part shape', async () => {
    const entries = await loadFixture(GPT);
    const t = new ReplayTransport(entries);
    const h = t.emptyHistory();
    t.pushUser(h, 'what is this', [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', url: 'https://cdn/x.png' },
    ] as never);
    const [msg] = h as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msg.role).toBe('user');
    // image BEFORE text, and the CDN url is preferred over inline base64.
    expect(msg.content.map((c) => c.type)).toEqual(['input_image', 'input_text']);
    expect(msg.content[0]!.image_url).toBe('https://cdn/x.png');
  });

  it('an Anthropic recording still pushes Anthropic MessageParams (unchanged)', async () => {
    const entries = await loadFixture(FIX + '02-read-grep-tools.jsonl');
    const t = new ReplayTransport(entries);
    const h = t.emptyHistory();
    t.pushUser(h, 'hello');
    t.pushAssistant(h, [{ type: 'text', text: 'hi' }] as ContentBlock[]);
    t.pushToolResult(h, { toolUseId: 'toolu_x', text: 'r', isError: false } as never);
    const items = h as Array<Record<string, unknown>>;
    expect(items.map((i) => i.role)).toEqual(['user', 'assistant', 'user']);
    expect(items.some((i) => i.type === 'function_call' || i.type === 'function_call_output')).toBe(false);
  });

  it('replays to a journal semantically identical to the recording, with zero reconstruction mismatches', async () => {
    const recorded = await loadFixture(GPT);
    const { journal, mismatches, transport } = await replaySession(GPT, { reconstructionCheck: 'throw' });
    expect(mismatches).toEqual([]);
    expect(stripVolatile(journal)).toEqual(stripVolatile(recorded));
    expect(transport.remaining).toBe(0);
  });
});

/**
 * The HITL PAUSE arm of the rail.
 *
 * `interaction` entries were dropped by the harvester as "product-plane", so no fixture
 * had ever carried a pause — and a recording of a paused turn replayed as a turn that
 * never paused. That mattered: `suspendPending` drops a tool_use bound to an unresolved
 * interaction from the projection, so the pause plane is the one thing that changes what
 * the WIRE is allowed to contain. Fixture 09 is the real staging `gpt-5.6-luna` turn
 * behind two of the four recorded `wire_reconstruction_desync` rows: two AskUserQuestion
 * rounds (the first rejected for invalid args), a pause on the second, the human's
 * answer, then a resumed round.
 *
 * The rail re-enacts both halves from the recording itself — the pause through a policy
 * that answers `needs_human` for exactly the calls the recording bound an interaction to,
 * the resume through `reconcileInteractions` with the recorded outcome — and drives the
 * continue as a NEW run off the SAME journal, the way a warm `_driveContinuation` does.
 */
describe('keyless replay — the HITL pause plane', () => {
  const ASK = FIX + '09-openai-responses-hitl-ask-pause.jsonl';

  it('replays the pause AND the resume off one journal, with zero reconstruction mismatches', async () => {
    const { journal, mismatches, transport } = await replaySession(ASK, { reconstructionCheck: 'throw' });
    expect(mismatches).toEqual([]);
    expect(transport.remaining).toBe(0); // every recorded round served, including the resumed one
    const shape = journal.map((e) => {
      const p = e.payload as { type: string; toolUseId?: string; resolved?: boolean; data?: { toolUseId?: string } };
      return [p.type, p.toolUseId ?? p.data?.toolUseId ?? '', p.resolved ?? '', e.agentId].join('|');
    });
    expect(shape).toEqual([
      'user|||native',
      'assistant|||native',
      'usage|||native',
      // Round 1: the ask the model got wrong — dispatched, answered with the arg error.
      'tool_use|call_KC9JIhB3PJMPyefA3Ih8Awkq||native',
      'tool_result|call_KC9JIhB3PJMPyefA3Ih8Awkq||native',
      'assistant|||native',
      'usage|||native',
      // Round 2: the valid ask PAUSES — the tool_use is journaled, its result is NOT,
      // and a pending interaction binds them.
      'tool_use|call_GPdiCZScosLm3NIkfVuGW3N0||native',
      'interaction|call_GPdiCZScosLm3NIkfVuGW3N0|false|native',
      // The resume materializes the human's answer IN PLACE, then settles the row.
      'tool_result|call_GPdiCZScosLm3NIkfVuGW3N0||system',
      'interaction||true|system',
      // …and the continue turn drives with NO new user entry.
      'assistant|||native',
      'usage|||native',
      'user|||native',
      'assistant|||native',
      'usage|||native',
    ]);
  });

  it('the projection SUSPENDS the paused tool_use while it is pending, and restores it once answered', async () => {
    const entries = await loadFixture(ASK);
    const transport = new ReplayTransport(entries);
    const upTo = (seq: number): string[] =>
      (transport.historyFromJournal(
        suspendPending(entries.filter((e) => e.seq <= seq)).filter(isContextEntry),
      ) as Array<Record<string, unknown>>).map((i) => (i.type as string) ?? `role:${String(i.role)}`);

    // While the ask is pending (through the interaction entry): the paused tool_use and
    // the reasoning bound to it are GONE — the wire may not carry an unanswered call.
    expect(upTo(10)).toEqual([
      'role:user', 'role:user', 'reasoning', 'function_call', 'function_call_output',
    ]);
    // Once the answer is materialized it comes back, with its result. Those two states —
    // 5 items and 8 — are the `projectedLength` and `incrementalLength` of the row
    // recorded for this very task, which is what made the pause look like the cause.
    expect(upTo(12)).toEqual([
      'role:user', 'role:user', 'reasoning', 'function_call', 'function_call_output',
      'reasoning', 'function_call', 'function_call_output',
    ]);
  });

  it('pushAssistant echoes the served round reasoning, exactly as OpenAIResponsesTransport does', async () => {
    const entries = await loadFixture(ASK);
    const t = new ReplayTransport(entries);
    t.callModel({} as never); // serve round 1 → its reasoning is now pending its §4.3a echo
    const h = t.emptyHistory();
    t.pushAssistant(h, [
      { type: 'tool_use', toolUseId: 'call_KC9JIhB3PJMPyefA3Ih8Awkq', toolName: 'AskUserQuestion', toolInput: {} },
    ] as ContentBlock[]);
    // The reasoning rides IMMEDIATELY BEFORE its own call — without this the rail pushed
    // one item where production pushes two, so every in-memory push path (the
    // empty-recovery seat above all) replayed a SHORTER wire than production builds.
    expect((h as Array<Record<string, unknown>>).map((i) => i.type)).toEqual(['reasoning', 'function_call']);
    // DRAINED: pushing the very same call again must NOT echo the blob a second time —
    // a re-sent `encrypted_content` is what the callModel preflight dedups against, and a
    // carry that survives its push would leak the round's reasoning into a later turn.
    const h2 = t.emptyHistory();
    t.pushAssistant(h2, [
      { type: 'tool_use', toolUseId: 'call_KC9JIhB3PJMPyefA3Ih8Awkq', toolName: 'AskUserQuestion', toolInput: {} },
    ] as ContentBlock[]);
    expect((h2 as Array<Record<string, unknown>>).map((i) => i.type)).toEqual(['function_call']);
  });
});
