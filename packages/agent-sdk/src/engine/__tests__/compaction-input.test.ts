/**
 * B1 — what the compaction trigger MEASURES and what the summarize SENDS (compaction-input.ts).
 *
 * gpt-6-luna, 09-27/28: the chars/4 estimate ran at 60-65% of the real input (it never sees
 * replayed encrypted reasoning), so the 244.8K trigger first fired at 330-410K real; and
 * the summarize then sent the whole span, reasoning included, ~443K per attempt, every one
 * above OpenAI's 272K long-context line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  boundSummarizeSpan,
  recordRoundInput,
  reportedInputSince,
  summarizeInputBudget,
  withoutReplayedReasoning,
} from '../compaction-input.js';
import { summarizeSpan, type CompactionDeps } from '../compaction-run.js';
import { FakeTransport, type NormalizedUsage, type StreamEvent } from '../transport.js';
import { journalToOpenAIResponsesInput, OPENAI_RESPONSES_API } from '../../transports/openai-responses-messages.js';
import { estimateTokens, projectTokenCount } from '../../kernel/index.js';
import { COMPACTION_USER } from '../../contract/compaction-prompt.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { RunContext } from '../run-context.js';
import type { FrozenElision } from '../context-elision.js';

beforeEach(() => {
  process.env.COMPACTION_V2 = '1';
});
afterEach(() => {
  delete process.env.COMPACTION_V2;
});

let seq = 0;
function entry(payload: JournalPayload): JournalEntry {
  const n = seq++;
  return {
    uuid: `e-${n}`,
    parentUuid: null,
    seq: n,
    taskId: 't',
    rootTaskId: 't',
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    principal: { kind: 'system' },
    timestamp: '2026-09-29T00:00:00.000Z',
    payload,
  };
}
const text = (t: string) => [{ type: 'text' as const, text: t }];
const user = (t: string) => entry({ type: 'user', blocks: text(t) });
const assistant = (t: string) =>
  entry({ type: 'assistant', blocks: text(t), api: OPENAI_RESPONSES_API, provider: 'openai', model: 'gpt-6-luna' });
const toolUse = (id: string) => entry({ type: 'tool_use', toolUseId: id, name: 'Bash', input: { command: 'ls' } });
const toolResult = (id: string, t: string) => entry({ type: 'tool_result', toolUseId: id, blocks: text(t) });

const rcWith = (last: RunContext['lastRoundInput'], elision: FrozenElision | null = null): RunContext =>
  ({ lastRoundInput: last, elision }) as unknown as RunContext;
/** A frozen elision map whose two cuts are `result` / `image` (only the cut is read). */
const mapCutAt = (result: number, image = result) =>
  ({ cut: { resultCutTokens: result, imageCutTokens: image } }) as unknown as FrozenElision;
const NO_CUT = { result: 0, image: 0 };

// ─── The trigger's input ────────────────────────────────────────────────────────

describe('recordRoundInput — the provider count is the WHOLE prompt', () => {
  it('sums uncached input, cache reads and cache writes, and notes the elision cut it was sent under', () => {
    const rc = rcWith(null, mapCutAt(73_440, 146_880));
    const usage: NormalizedUsage = { inputTokens: 9_000, outputTokens: 7_459, cacheReadInputTokens: 229_000, cacheCreationInputTokens: 1_000 };
    recordRoundInput(rc, usage, 'gpt-6-luna', 41);
    expect(rc.lastRoundInput).toEqual({
      model: 'gpt-6-luna',
      inputTokens: 239_000,
      outputTokens: 7_459,
      atSeq: 41,
      elisionCut: { result: 73_440, image: 146_880 },
    });
  });
});

describe('reportedInputSince — the count, plus what was appended, while it still describes the context', () => {
  const messages = () => {
    seq = 0;
    return [user('the ask'), assistant('round one'), toolUse('tu-1'), toolResult('tu-1', 'x'.repeat(4_000))];
  };

  it('adds the estimate of what was appended since — the round\'s own tool_use is already in its output', () => {
    const m = messages();
    const rc = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: NO_CUT });
    const reported = reportedInputSince(rc, m, false, 'gpt-6-luna');
    expect(reported).toEqual({
      inputTokens: 238_000,
      outputTokens: 7_459,
      // The tool_result only: the call's arguments were counted in outputTokens.
      appendedTokens: projectTokenCount([m[3]], { countImages: true }).messages,
    });
  });

  it('is stale after a MODEL switch (another tokenizer; a cross-issuer switch drops the reasoning it counted)', () => {
    const rc = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: NO_CUT });
    expect(reportedInputSince(rc, messages(), false, 'claude-opus-5-5')).toBeUndefined();
  });

  it('SURVIVES a new user turn\'s elision map with the same or a higher cut (it only shrank the wire)', () => {
    // prepareElision mints a new map every user turn; identity must not blind the count.
    const counted = { result: 73_440, image: 146_880 };
    const same = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: counted }, mapCutAt(73_440, 146_880));
    const higher = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: NO_CUT }, mapCutAt(73_440));
    expect(reportedInputSince(same, messages(), false, 'gpt-6-luna')).toBeDefined();
    expect(reportedInputSince(higher, messages(), false, 'gpt-6-luna')).toBeDefined();
  });

  it('is stale when an elision cut went DOWN (less elided, the wire grew under the count)', () => {
    const counted = { result: 146_880, image: 146_880 };
    const resultDown = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: counted }, mapCutAt(73_440, 146_880));
    const imageDown = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: counted }, mapCutAt(146_880, 73_440));
    const released = rcWith({ model: 'gpt-6-luna', inputTokens: 238_000, outputTokens: 7_459, atSeq: 1, elisionCut: counted }, null);
    expect(reportedInputSince(resultDown, messages(), false, 'gpt-6-luna')).toBeUndefined();
    expect(reportedInputSince(imageDown, messages(), false, 'gpt-6-luna')).toBeUndefined();
    expect(reportedInputSince(released, messages(), false, 'gpt-6-luna')).toBeUndefined();
  });

  it('is stale once a COMPACTION lands after it (it counted a context that is gone)', () => {
    seq = 10;
    const compacted = [user('SUMMARY'), assistant('kept round')];
    const rc = rcWith({ model: 'gpt-6-luna', inputTokens: 400_000, outputTokens: 7_459, atSeq: 5, elisionCut: NO_CUT });
    expect(reportedInputSince(rc, compacted, true, 'gpt-6-luna')).toBeUndefined();
  });

  it('is absent until a round has settled', () => {
    expect(reportedInputSince(rcWith(null), messages(), false, 'gpt-6-luna')).toBeUndefined();
  });
});

// ─── The summarize request ──────────────────────────────────────────────────────

/** Projects through the REAL OpenAI Responses projection and records what was sent. */
class ResponsesWireTransport extends FakeTransport {
  sentEntries: JournalEntry[][] = [];
  sentHistories: unknown[] = [];
  constructor() {
    super([
      { kind: 'text', text: 'SUMMARY' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } } as StreamEvent,
    ]);
  }
  override historyFromJournal(entries: JournalEntry[]): unknown {
    this.sentEntries.push(entries);
    return journalToOpenAIResponsesInput(entries);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): unknown {
    this.sentHistories.push(p.history);
    return super.callModel(p);
  }
}

function depsFor(transport: FakeTransport, model: string): CompactionDeps {
  return {
    ctx: { taskId: 't', model, config: { runtimeConfig: { sessionId: 's', userId: 'u' } } },
    transport,
    dispatcher: { dispatch: async () => [] },
    compactionBase: () => ({}),
    runSignal: () => new AbortController().signal,
  } as unknown as CompactionDeps;
}

const BLOB = 'E'.repeat(40_000); // one encrypted reasoning item

/** A luna round as the live loop journals it: the sealed output AND the per-call reasoning. */
function lunaRound(i: number): JournalEntry[] {
  const a = entry({
    type: 'assistant',
    blocks: text(`step ${i}`),
    api: OPENAI_RESPONSES_API,
    provider: 'openai',
    model: 'gpt-6-luna',
    reasoning: [{ id: `rs-head-${i}`, encryptedContent: BLOB }],
    responsesOutput: {
      issuer: 'openai',
      items: [
        { type: 'reasoning', id: `rs-${i}`, summary: [], encrypted_content: BLOB },
        { type: 'message', id: `msg-${i}`, role: 'assistant', content: [{ type: 'output_text', text: `step ${i}` }] },
        { type: 'function_call', id: `fc-${i}`, call_id: `call-${i}`, name: 'Bash', arguments: '{}' },
      ],
    },
  });
  const use = entry({
    type: 'tool_use',
    toolUseId: `call-${i}`,
    name: 'Bash',
    input: {},
    reasoning: [{ id: `rs-call-${i}`, encryptedContent: BLOB }],
  });
  return [a, use, toolResult(`call-${i}`, `output ${i}`)];
}

describe('the summarize request carries no replayed reasoning', () => {
  it('strips the sealed reasoning items and the per-record reasoning; the calls and results survive', async () => {
    seq = 0;
    const span = [user('the ask'), ...lunaRound(0), ...lunaRound(1)];
    const transport = new ResponsesWireTransport();

    await summarizeSpan(depsFor(transport, 'gpt-6-luna'), span);

    const sent = transport.sentHistories[0] as Array<{ type?: string }>;
    expect(sent.some((item) => item.type === 'reasoning')).toBe(false);
    expect(sent.filter((item) => item.type === 'function_call')).toHaveLength(2);
    expect(sent.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
    expect(JSON.stringify(sent)).not.toContain(BLOB);
  });

  it('flag OFF: the request is byte-identical, reasoning and all', async () => {
    delete process.env.COMPACTION_V2;
    seq = 0;
    const span = [user('the ask'), ...lunaRound(0)];
    const transport = new ResponsesWireTransport();

    await summarizeSpan(depsFor(transport, 'gpt-6-luna'), span);

    expect((transport.sentHistories[0] as Array<{ type?: string }>).some((i) => i.type === 'reasoning')).toBe(true);
  });

  it('an output that held only reasoning is dropped whole; the round rebuilds from its entries', () => {
    seq = 0;
    const onlyReasoning = entry({
      type: 'assistant',
      blocks: text('thinking out loud'),
      api: OPENAI_RESPONSES_API,
      provider: 'openai',
      responsesOutput: { issuer: 'openai', items: [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: BLOB }] },
    });
    const [stripped] = withoutReplayedReasoning([onlyReasoning]);
    expect('responsesOutput' in stripped.payload).toBe(false);
    expect(journalToOpenAIResponsesInput([user('ask'), stripped])).toEqual([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'thinking out loud' },
    ]);
  });
});

describe('the summarize request stays under the pricing line', () => {
  /** A luna span far past the line: the ask, then 60 rounds of ~4K-token tool output. */
  function hugeSpan(): JournalEntry[] {
    seq = 0;
    const out: JournalEntry[] = [user('THE ASK: audit every file')];
    for (let i = 0; i < 60; i++) {
      out.push(assistant(`step ${i}`), toolUse(`tu-${i}`), toolResult(`tu-${i}`, `r${i} `.repeat(4_000)));
    }
    return out;
  }
  const estimateOf = (entries: JournalEntry[]) => projectTokenCount(entries, { countImages: true }).messages;

  it('gpt-6-luna: the oldest rounds go, the ASK stays, and the request fits the budget', async () => {
    const span = hugeSpan();
    const budget = summarizeInputBudget('gpt-6-luna')!;
    expect(budget).toBe(181_333); // 272K / 1.5, the estimate's undercount on dense output
    expect(estimateOf(span)).toBeGreaterThan(budget);
    const transport = new ResponsesWireTransport();

    await summarizeSpan(depsFor(transport, 'gpt-6-luna'), span);

    // The last sent entry is the synthetic instruction; everything before it is the span.
    const sent = transport.sentEntries[0].slice(0, -1);
    expect(sent[0].uuid).toBe(span[0].uuid); // the head — the ask — survives
    expect(sent[1].payload.type).toBe('assistant'); // the cut lands on a round
    const system = transport.systems[0];
    expect(estimateOf(sent) + estimateTokens(system) + estimateTokens(COMPACTION_USER)).toBeLessThanOrEqual(budget);
    expect(system).toContain('oldest entries after the opening message were left out');
  });

  it('a model with no pricing line (Anthropic) is sent whole, and an under-budget span is untouched', async () => {
    expect(summarizeInputBudget('claude-opus-5-5')).toBeUndefined();
    const span = hugeSpan();
    expect(boundSummarizeSpan(span, undefined, 1_000)).toEqual({ span, omitted: 0 });
    seq = 0;
    const small = [user('ask'), assistant('a'), toolUse('tu'), toolResult('tu', 'r')];
    expect(boundSummarizeSpan(small, 181_333, 1_000)).toEqual({ span: small, omitted: 0 });
  });

  it('a kept result whose call was left out (a paused call answered later) goes with it — never sent orphaned', () => {
    seq = 0;
    const span: JournalEntry[] = [
      user('THE ASK'),
      assistant('asks the person'),
      toolUse('tu-paused'), // paused on a human; its result lands rounds later
      assistant('big round'),
      toolUse('tu-big'),
      toolResult('tu-big', 'b '.repeat(200_000)), // pushes the oldest rounds out
      assistant('later'),
      toolUse('tu-late'),
      toolResult('tu-paused', 'the person answered'), // kept by position, its call is not
      toolResult('tu-late', 'ok'),
    ];
    const bounded = boundSummarizeSpan(span, 20_000, 1_000);
    const ids = bounded.span.map((e) => e.uuid);
    expect(ids[0]).toBe(span[0].uuid);
    expect(ids).not.toContain(span[8].uuid); // the orphan result is left out
    expect(ids).toContain(span[9].uuid); // a paired result stays
    const calls = new Set(bounded.span.flatMap((e) => (e.payload.type === 'tool_use' ? [e.payload.toolUseId] : [])));
    for (const e of bounded.span) {
      if (e.payload.type === 'tool_result') expect(calls.has(e.payload.toolUseId)).toBe(true);
    }
    expect(bounded.omitted).toBe(span.length - bounded.span.length);
  });

  it('bounded by construction: a head that alone overflows still goes, alone', () => {
    seq = 0;
    const span = [user('A'.repeat(1_000_000)), assistant('a'), toolUse('tu'), toolResult('tu', 'r')];
    const bounded = boundSummarizeSpan(span, 181_333, 1_000);
    expect(bounded.span).toEqual([span[0]]);
    expect(bounded.omitted).toBe(3);
  });
});
