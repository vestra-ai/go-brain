/**
 * OpenAI Responses + Chat Completions subagents send the model's round back AS SENT
 * (findings 4 and 5, subagent side).
 *
 * The subagent loops rebuilt the round from text + tool_use blocks and took the
 * reasoning from the transport INSTANCE — shared with the parent and every parallel
 * sibling, so the carry could be another conversation's. The scoped journal kept no
 * reasoning at all, so a scoped re-entry replayed none. These drive the REAL
 * transports through both subagent loops and read the request bodies they put on
 * the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import type OpenAI from 'openai';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

const dir = join(tmpdir(), `subagent-openai-sealed-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId: string) => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});
const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
};
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';
const echoTool = (): RawToolOptions => ({
  name: 'echo',
  description: 'echo',
  parameters: z.object({ msg: z.string() }),
  execute: async (input) => `echo:${(input as { msg: string }).msg}`,
});
const seg: SubagentPathSegment = { depth: 1, agentToolUseId: 'T1', agentSlug: 'researcher', agentName: 'Researcher' };

// ── OpenAI Responses ────────────────────────────────────────────────────────
type Item = Record<string, unknown>;
const R1: Item = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'two echoes' }], content: [], encrypted_content: 'ENC_1' };
const MSG: Item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'Echoing.' }] };
const FC_A: Item = { id: 'fc_a', type: 'function_call', status: 'completed', call_id: 'call_a', name: 'echo', arguments: '{"msg":"a"}' };
const FC_B: Item = { id: 'fc_b', type: 'function_call', status: 'completed', call_id: 'call_b', name: 'echo', arguments: '{"msg": "b"}' };
const ROUND_1 = [R1, MSG, FC_A, FC_B];
const FINAL: Item[] = [{ id: 'msg_2', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'done' }] }];

function* responsesRound(output: Item[]): Generator<OpenAI.Responses.ResponseStreamEvent> {
  let i = 0;
  for (const item of output) {
    if (item.type === 'function_call') yield { type: 'response.output_item.added', output_index: i, item } as never;
    if (item.type === 'message') yield { type: 'response.output_text.delta', delta: (item.content as Array<{ text: string }>)[0].text } as never;
    yield { type: 'response.output_item.done', output_index: i++, item } as never;
  }
  yield { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 5, output_tokens: 5 } } } as never;
}

function recordingResponses(...rounds: Item[][]) {
  const bodies: Array<{ input: Item[] }> = [];
  let i = 0;
  const client = {
    responses: { stream: (body: { input: Item[] }) => { bodies.push(wire(body)); return responsesRound(rounds[i++] ?? FINAL); } },
  } as unknown as OpenAI;
  return { transport: new OpenAIResponsesTransport({ client }), bodies };
}

describe.each([
  ['the shared round core', true],
  ['the legacy nested loop', false],
])('OpenAI Responses subagent via %s', (_label, sharedLoop) => {
  it('the next request carries the round as returned, and the scoped journal keeps it for re-entry', async () => {
    const { transport, bodies } = recordingResponses(ROUND_1, FINAL);
    const j = make(`r-${sharedLoop}`);
    await runSubagentLoop({
      transport, model: 'gpt-6-sol', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: [seg], sharedLoop,
    });

    // Round 2: the whole round back in the provider's order — the reasoning with its
    // id and summary, the commentary message with its phase, the raw arguments.
    expect(bodies).toHaveLength(2);
    expect(bodies[1].input.slice(1, 5)).toEqual(ROUND_1);
    expect(bodies[1].input.slice(5).map((i) => i.call_id)).toEqual(['call_a', 'call_b']);

    // The scoped journal carries the sealed output even though the subagent is the
    // child (finding 5: it used to journal no reasoning at all).
    const all = await readAll(j);
    const asst = all.find((e) => e.payload.type === 'assistant')!.payload as Extract<JournalEntry['payload'], { type: 'assistant' }>;
    expect(asst.responsesOutput).toEqual({ items: ROUND_1, issuer: 'openai' });

    // Scoped re-entry projects the same round back (the scope journals no user prompt).
    const reentry = wire(transport.historyFromJournal(all) as Item[]);
    expect(reentry.slice(0, 4)).toEqual(ROUND_1);
    expect(reentry.slice(4, 6).map((i) => i.call_id)).toEqual(['call_a', 'call_b']);
  });
});

// ── Chat Completions ────────────────────────────────────────────────────────
type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
const c = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Chunk => ({ choices: [{ index: 0, delta, ...extra }] }) as never;
const CHAT_ROUND_1: Chunk[] = [
  c({ role: 'assistant', reasoning_content: 'two echoes' }),
  c({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"msg": "a"}' } }] }),
  c({}, { finish_reason: 'tool_calls' }),
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } } as never,
];
const CHAT_FINAL: Chunk[] = [c({ content: 'done' }), c({}, { finish_reason: 'stop' }), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } } as never];
const SEALED_CHAT: { role: 'assistant'; reasoning_content: string; tool_calls: Array<Record<string, unknown>> } = {
  role: 'assistant',
  reasoning_content: 'two echoes',
  tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"msg": "a"}' } }],
};

describe.each([
  ['the shared round core', true],
  ['the legacy nested loop', false],
])('Chat Completions subagent via %s', (_label, sharedLoop) => {
  it('sends the streamed message back (reasoning for a model that reads it) and journals it for re-entry', async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    let i = 0;
    const client = {
      chat: { completions: { stream: (body: { messages: unknown[] }) => { bodies.push(wire(body) as never); return (async function* () { for (const x of [CHAT_ROUND_1, CHAT_FINAL][i++] ?? CHAT_FINAL) yield x; })(); } } },
    } as unknown as OpenAI;
    const transport = new ChatCompletionsTransport({ client });
    const j = make(`c-${sharedLoop}`);
    await runSubagentLoop({
      transport, model: 'glm-5.2', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: [seg], sharedLoop,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.find((m) => m.role === 'assistant')).toEqual(SEALED_CHAT);
    const all = await readAll(j);
    const asst = all.find((e) => e.payload.type === 'assistant')!.payload as Extract<JournalEntry['payload'], { type: 'assistant' }>;
    expect(asst.chatMessage).toEqual(SEALED_CHAT);
  });
});

describe('P3.5b pending-round re-push — the sealed round, trimmed to the calls that ran', () => {
  let seq = 0;
  const entry = (payload: JournalEntry['payload']): JournalEntry => {
    seq += 1;
    return {
      uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'u',
      agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z',
      agentPath: [seg], payload,
    };
  };
  const resume = (transport: OpenAIResponsesTransport | ChatCompletionsTransport, model: string, seedEntries: JournalEntry[]) =>
    runSubagentLoop({
      transport, model, system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 2, childId: 'c', onEvent: () => {},
      resume: { seedEntries, continuePending: true }, sharedLoop: true,
    });

  it('Responses: a pause at the LATER call re-sends the round as returned (reasoning, message, A, B), A\'s result, then B\'s', async () => {
    const { transport, bodies } = recordingResponses(FINAL);
    await resume(transport, 'gpt-6-sol', [
      entry({ type: 'assistant', blocks: [], api: 'openai_responses', provider: 'openai', responsesOutput: { items: ROUND_1, issuer: 'openai' } }),
      entry({ type: 'tool_use', toolUseId: 'call_a', name: 'echo', input: { msg: 'a' } }),
      entry({ type: 'tool_result', toolUseId: 'call_a', blocks: [{ type: 'text', text: 'echo:a' }] }),
      entry({ type: 'tool_use', toolUseId: 'call_b', name: 'echo', input: { msg: 'b' } }),
    ]);
    expect(bodies[0].input.slice(1, 5)).toEqual(ROUND_1); // [0] is the user prompt
    expect(bodies[0].input.slice(5).map((i) => [i.type, i.call_id])).toEqual([
      ['function_call_output', 'call_a'], ['function_call_output', 'call_b'],
    ]);
  });

  it('Responses: a pause at the FIRST call re-sends the round without B — B never ran, so it never goes back', async () => {
    const { transport, bodies } = recordingResponses(FINAL);
    await resume(transport, 'gpt-6-sol', [
      entry({ type: 'assistant', blocks: [], api: 'openai_responses', provider: 'openai', responsesOutput: { items: ROUND_1, issuer: 'openai' } }),
      entry({ type: 'tool_use', toolUseId: 'call_a', name: 'echo', input: { msg: 'a' } }),
    ]);
    expect(bodies[0].input.slice(1)).toEqual([R1, MSG, FC_A, { type: 'function_call_output', call_id: 'call_a', output: 'echo:a' }]);
  });

  it('Chat: the sealed message is trimmed to the call that ran, reasoning kept', async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const client = {
      chat: { completions: { stream: (body: unknown) => { bodies.push(wire(body) as never); return (async function* () { for (const x of CHAT_FINAL) yield x; })(); } } },
    } as unknown as OpenAI;
    const two = { ...SEALED_CHAT, tool_calls: [...SEALED_CHAT.tool_calls, { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } }] };
    await resume(new ChatCompletionsTransport({ client }), 'glm-5.2', [
      entry({ type: 'assistant', blocks: [], api: 'openai_chat_completions', provider: 'openai', chatMessage: two }),
      entry({ type: 'tool_use', toolUseId: 'call_a', name: 'echo', input: { msg: 'a' } }),
    ]);
    expect(bodies[0].messages.slice(2)).toEqual([SEALED_CHAT, { role: 'tool', tool_call_id: 'call_a', content: 'echo:a' }]);
  });
});
