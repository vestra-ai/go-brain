/**
 * OpenAI Responses — the model's output goes back EXACTLY as the provider returned it.
 *
 * The 09-23 audit found the round rebuilt from our own stream accumulator: only
 * reasoning with encrypted_content kept (summary replayed as []), messages merged
 * (id + `phase` lost), every other item type dropped, the order rebuilt, arguments
 * re-stringified ("{}" for a torn one), and the reasoning carried on the transport
 * INSTANCE — which the parent and its parallel subagents share, so one conversation's
 * reasoning landed in another's history. These pin the sealed channel instead: the
 * final response's own `output`, on the `done` event, replayed verbatim.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import { journalToOpenAIResponsesInput } from '../openai-responses-messages.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { ProviderReplay, StreamEvent } from '../../engine/transport.js';

type Ev = OpenAI.Responses.ResponseStreamEvent;
type Item = Record<string, unknown>;

const R1: Item = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan it' }], content: [], encrypted_content: 'FINAL_E1' };
const MSG_COMMENTARY: Item = {
  id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', phase: 'commentary',
  content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'Checking both.' }],
};
const FC_A: Item = { id: 'fc_A', type: 'function_call', status: 'completed', call_id: 'call_A', name: 'get_weather', arguments: '{"city":"Paris"}' };
const MSG_BETWEEN: Item = {
  id: 'msg_2', type: 'message', status: 'completed', role: 'assistant', phase: 'commentary',
  content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'And the other.' }],
};
// A torn argument string: the dispatch reads "{}", the wire must keep what was sent.
const FC_B: Item = { id: 'fc_B', type: 'function_call', status: 'completed', call_id: 'call_B', name: 'get_weather', arguments: '{"city": "Tok' };
const UNKNOWN: Item = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q' } };
const R2_TRAILING: Item = { id: 'rs_2', type: 'reasoning', summary: [], content: [], encrypted_content: 'FINAL_E2' };
const OUTPUT = [R1, MSG_COMMENTARY, FC_A, MSG_BETWEEN, FC_B, UNKNOWN, R2_TRAILING];

/** The round as streamed: output_item.done events (with the PRE-final reasoning blob), then the terminal. */
function* round(output: Item[], terminal: 'completed' | 'incomplete' = 'completed'): Generator<Ev> {
  let idx = 0;
  for (const item of output) {
    const streamed = item.type === 'reasoning' ? { ...item, encrypted_content: 'STREAMED_NOT_FINAL' } : item;
    if (item.type === 'function_call') {
      yield { type: 'response.output_item.added', output_index: idx, item: streamed } as unknown as Ev;
    }
    yield { type: 'response.output_item.done', output_index: idx++, item: streamed } as unknown as Ev;
  }
  yield {
    type: `response.${terminal}`,
    response: {
      status: terminal, output,
      ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as unknown as Ev;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const replayOf = (events: StreamEvent[]): ProviderReplay | undefined =>
  (events.find((e) => e.kind === 'done') as Extract<StreamEvent, { kind: 'done' }>).replay;
const toolBlocks = (events: StreamEvent[]): ContentBlock[] =>
  events
    .filter((e): e is Extract<StreamEvent, { kind: 'tool_use' }> => e.kind === 'tool_use')
    .map((e) => ({ type: 'tool_use', toolUseId: e.toolUse.id, toolName: e.toolUse.name, toolInput: e.toolUse.input }) as unknown as ContentBlock);
/** What the wire sees: JSON drops the internal symbol marker. */
const wire = (items: unknown[]): unknown[] => JSON.parse(JSON.stringify(items)) as unknown[];

const client = {} as unknown as OpenAI;

describe('capture — the final response\'s own output, every round (finding 1)', () => {
  it('the done event carries response.completed.output verbatim: every item, every field, in order', async () => {
    const t = new OpenAIResponsesTransport({ client });
    const replay = replayOf(await drain(t.readStream(round(OUTPUT))));
    expect(replay).toEqual({ dialect: 'openai_responses', output: { items: OUTPUT } });
    // The final blob, not the one the output_item.done event carried (probed: they differ).
    expect(JSON.stringify(replay)).not.toContain('STREAMED_NOT_FINAL');
  });

  it('a truncated (response.incomplete) reasoning-only round is captured too', async () => {
    const t = new OpenAIResponsesTransport({ client });
    const replay = replayOf(await drain(t.readStream(round([R1], 'incomplete'))));
    expect(replay).toEqual({ dialect: 'openai_responses', output: { items: [R1] } });
  });
});

describe('replay — pushAssistant sends the round back as sent (findings 1, 2, 3, 6)', () => {
  it('order, message ids and phase, reasoning summaries, unknown item types and raw arguments survive', async () => {
    const t = new OpenAIResponsesTransport({ client });
    const events = await drain(t.readStream(round(OUTPUT)));
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    t.pushAssistant(h, toolBlocks(events), replayOf(events));
    expect(wire(h)).toEqual(OUTPUT);
    // The torn arguments went to dispatch as {} but the wire keeps the provider's string.
    expect(events.find((e) => e.kind === 'tool_use' && e.toolUse.id === 'call_B')).toMatchObject({ toolUse: { input: {} } });
  });

  it('a reasoning-only round replays as the reasoning item — never an invented "(no content)" message', async () => {
    const t = new OpenAIResponsesTransport({ client });
    const events = await drain(t.readStream(round([R1], 'incomplete')));
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    t.pushAssistant(h, [{ type: 'thinking', thinking: 'plan it' } as ContentBlock], replayOf(events));
    expect(wire(h)).toEqual([R1]);
    expect(JSON.stringify(h)).not.toContain('(no content)');
  });
});

describe('isolation — parallel subagents on ONE transport instance (finding 4)', () => {
  it('each round replays only its own reasoning; a sibling\'s blob never reaches another history', async () => {
    const shared = new OpenAIResponsesTransport({ client });
    const A_REASON: Item = { id: 'rs_A', type: 'reasoning', summary: [], content: [], encrypted_content: 'ENC_OF_CONVERSATION_A' };
    const B_REASON: Item = { id: 'rs_B', type: 'reasoning', summary: [], content: [], encrypted_content: 'ENC_OF_CONVERSATION_B' };
    const A_TEXT: Item = { ...MSG_COMMENTARY, id: 'msg_A', phase: 'final_answer' };
    // A reads its stream, then sibling B reads its own, THEN A folds its round in —
    // the interleave a parent + parallel children produce on the shared instance.
    const B_TEXT: Item = { ...MSG_COMMENTARY, id: 'msg_B', phase: 'final_answer' };
    const a = await drain(shared.readStream(round([A_REASON, A_TEXT])));
    const b = await drain(shared.readStream(round([B_REASON, B_TEXT])));
    const hA: OpenAI.Responses.ResponseInputItem[] = [];
    shared.pushAssistant(hA, [{ type: 'text', text: 'Checking both.' } as ContentBlock], replayOf(a));
    const hB: OpenAI.Responses.ResponseInputItem[] = [];
    shared.pushAssistant(hB, [{ type: 'text', text: 'Checking both.' } as ContentBlock], replayOf(b));
    // Before 09-23 A's push drained the instance carry — B's reasoning (read last).
    expect(JSON.stringify(hA)).not.toMatch(/CONVERSATION_B|STREAMED_NOT_FINAL/);
    expect(wire(hA)).toEqual([A_REASON, A_TEXT]);
    expect(wire(hB)).toEqual([B_REASON, B_TEXT]);
  });

  it('the no-replay fallback carries no reasoning at all (nothing is held on the instance)', async () => {
    const shared = new OpenAIResponsesTransport({ client });
    await drain(shared.readStream(round([{ ...R1, encrypted_content: 'ENC_OF_A_SIBLING' }])));
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    shared.pushAssistant(h, [{ type: 'text', text: 'hi' } as ContentBlock]);
    expect(JSON.stringify(h)).not.toContain('"reasoning"');
    expect(h).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('each stream is stamped with the issuer IT was opened against, not the last callModel', async () => {
    const opened: string[] = [];
    const scripts: Record<string, Item[]> = { openai: [R1, FC_A], meta: [{ ...R1, id: 'rs_meta', encrypted_content: 'META_BLOB' }] };
    const t = new OpenAIResponsesTransport({
      createClient: (provider) =>
        ({ responses: { stream: () => { opened.push(provider); return round(scripts[provider] ?? []); } } }) as unknown as OpenAI,
    });
    const base = { system: 's', tools: [], history: [], maxTokens: 100 };
    const sOpenAI = t.callModel({ ...base, model: 'gpt-6-sol' });
    const sMeta = t.callModel({ ...base, model: 'muse-spark-1.3-contributor' });
    const rOpenAI = replayOf(await drain(t.readStream(sOpenAI)));
    const rMeta = replayOf(await drain(t.readStream(sMeta)));
    expect(opened).toEqual(['openai', 'meta']);
    expect(rOpenAI).toMatchObject({ output: { issuer: 'openai' } });
    expect(rMeta).toMatchObject({ output: { issuer: 'meta' } });
  });
});

describe('preflight — a sealed item goes out as it came, bar what cannot be decrypted', () => {
  function capture(model: string, history: unknown[], disable = false): Item[] {
    let sent: Item[] = [];
    const t = new OpenAIResponsesTransport({
      client: { responses: { stream: (body: { input: Item[] }) => { sent = wire(body.input) as Item[]; return round([]); } } } as unknown as OpenAI,
    });
    if (disable) t.disableReasoningReplay();
    t.callModel({ model, system: 's', tools: [], history, maxTokens: 100 });
    return sent;
  }
  const sealedHistory = (issuer: string) => {
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    new OpenAIResponsesTransport({ client }).pushAssistant(h, [], { dialect: 'openai_responses', output: { items: [R1, FC_A], issuer } });
    h.push({ type: 'function_call_output', call_id: 'call_A', output: '18C' });
    return h;
  };

  it('keeps the reasoning id (store:false accepts it — probed 2026-09-23) and puts no marker field on the wire', () => {
    const sent = capture('gpt-6-sol', sealedHistory('openai'));
    expect(sent.slice(0, 2)).toEqual([R1, FC_A]);
    expect(JSON.stringify(sent)).not.toContain('_issuer');
  });

  it('drops a foreign issuer\'s reasoning (undecryptable) and nothing else', () => {
    const sent = capture('gpt-6-sol', sealedHistory('meta'));
    expect(sent.map((i) => i.type)).toEqual(['function_call', 'function_call_output']);
  });

  it('a foreign issuer\'s message / function_call ids never reach this endpoint; the rest goes as sent', () => {
    const { id: _fc, ...fcNoId } = FC_A;
    const { id: _msg, ...msgNoId } = MSG_COMMENTARY;
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    new OpenAIResponsesTransport({ client }).pushAssistant(h, [], { dialect: 'openai_responses', output: { items: [R1, MSG_COMMENTARY, FC_A], issuer: 'meta' } });
    h.push({ type: 'function_call_output', call_id: 'call_A', output: '18C' });
    expect(capture('gpt-6-sol', h).slice(0, 2)).toEqual([msgNoId, fcNoId]);
    // Same issuer: ids kept.
    expect(capture('gpt-6-sol', sealedHistory('openai')).slice(0, 2)).toEqual([R1, FC_A]);
  });

  it('Muse (Meta) gets its own items back verbatim too — live-probed 2026-09-23: ids, status, reasoning blob, order → 200', () => {
    const own = [R1, MSG_COMMENTARY, FC_A];
    const h: OpenAI.Responses.ResponseInputItem[] = [];
    new OpenAIResponsesTransport({ client }).pushAssistant(h, [], { dialect: 'openai_responses', output: { items: own, issuer: 'meta' } });
    h.push({ type: 'function_call_output', call_id: 'call_A', output: '18C' });
    expect(capture('muse-spark-1.3-contributor', h)).toEqual([...own, { type: 'function_call_output', call_id: 'call_A', output: '18C' }]);
  });

  it('the invalid_encrypted_content kill switch drops sealed reasoning too', () => {
    const sent = capture('gpt-6-sol', sealedHistory('openai'), true);
    expect(sent.map((i) => i.type)).toEqual(['function_call', 'function_call_output']);
  });
});

describe('journal projection — the sealed channel is the round (findings 1, 2, 3, 6)', () => {
  let seq = 0;
  const entry = (payload: JournalPayload): JournalEntry => {
    seq += 1;
    return {
      uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
      agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z', payload,
    };
  };

  it('replays the channel in order, does not double-fold its calls, and pairs the results', () => {
    const items = journalToOpenAIResponsesInput([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({
        type: 'assistant', blocks: [{ type: 'text', text: 'Checking both.\nAnd the other.' }],
        api: 'openai_responses', provider: 'openai', model: 'gpt-6-sol',
        responsesOutput: { items: OUTPUT, issuer: 'openai' },
      }),
      entry({ type: 'tool_use', toolUseId: 'call_A', name: 'get_weather', input: { city: 'Paris' } }),
      entry({ type: 'tool_use', toolUseId: 'call_B', name: 'get_weather', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'call_A', blocks: [{ type: 'text', text: '18C' }] }),
      entry({ type: 'tool_result', toolUseId: 'call_B', blocks: [{ type: 'text', text: '26C' }] }),
    ]);
    expect(wire(items)).toEqual([
      { role: 'user', content: 'go' },
      ...OUTPUT,
      { type: 'function_call_output', call_id: 'call_A', output: '18C' },
      { type: 'function_call_output', call_id: 'call_B', output: '26C' },
    ]);
  });

  it('a call whose tool_use was pruned upstream leaves (it has no result); the rest stays as sent', () => {
    const items = journalToOpenAIResponsesInput([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [], api: 'openai_responses', responsesOutput: { items: [R1, FC_A, MSG_BETWEEN, FC_B], issuer: 'openai' } }),
      entry({ type: 'tool_use', toolUseId: 'call_A', name: 'get_weather', input: { city: 'Paris' } }),
      entry({ type: 'tool_result', toolUseId: 'call_A', blocks: [{ type: 'text', text: '18C' }] }),
    ]);
    expect(wire(items)).toEqual([
      { role: 'user', content: 'go' },
      R1, FC_A, MSG_BETWEEN,
      { type: 'function_call_output', call_id: 'call_A', output: '18C' },
    ]);
  });

  it('a channel from another dialect is never read (cross-issuer guard)', () => {
    const items = journalToOpenAIResponsesInput([
      entry({ type: 'assistant', blocks: [{ type: 'text', text: 'hi' }], api: 'openai_chat_completions', responsesOutput: { items: OUTPUT } }),
    ]);
    expect(items).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('LEGACY head reasoning on a text-empty turn no longer invents a "(no content)" follower (the parrot, finding 3)', () => {
    const items = journalToOpenAIResponsesInput([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry({ type: 'assistant', blocks: [], api: 'openai_responses', reasoning: [{ id: 'rs_old', encryptedContent: 'OLD' }] }),
      entry({ type: 'user', blocks: [{ type: 'text', text: 'and?' }] }),
    ]);
    expect(JSON.stringify(items)).not.toContain('(no content)');
    expect(items.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role: string }).role)).toEqual(['user', 'reasoning', 'user']);
  });
});
