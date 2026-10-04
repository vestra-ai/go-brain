/**
 * A Gemini subagent sends the model's turn back AS SENT (finding 1, subagent side).
 *
 * Gemini 3 signs only the first call of a parallel run and 400s a request whose
 * functionCall turn lost that signature — on every retry, so the child wedges for
 * good. The subagent loops used to rebuild the turn from text + tool_use blocks
 * (no signature field), and the scoped journal kept no signature either, so both
 * the next in-memory round and a scoped re-entry sent unsigned calls. These drive
 * the REAL GeminiTransport through both subagent loops and read the request bodies
 * it would put on the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
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
import type { GeminiContent } from '../request-validity.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import type { GeminiStreamChunk } from '../../transports/gemini-messages.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';
import type { GeminiInteractionsEvent, GeminiInteractionsRequest } from '../../transports/gemini-interactions-wire.js';
import { runSubagentLoop } from '../subagent-runner.js';

const dir = join(tmpdir(), `subagent-gemini-sealed-${process.pid}`);
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

/** Gemini 3's parallel tool round as streamed (probed 2026-09-23). */
const PARALLEL_ROUND: GeminiStreamChunk[] = [
  { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'echo', args: { msg: 'a' }, id: 'call_1' }, thoughtSignature: 'SIG_1' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'echo', args: { msg: 'b' }, id: 'call_2' } }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } },
];
const SEALED_PARTS = [
  { functionCall: { name: 'echo', args: { msg: 'a' }, id: 'call_1' }, thoughtSignature: 'SIG_1' },
  { functionCall: { name: 'echo', args: { msg: 'b' }, id: 'call_2' } },
  { text: '' },
];
const FINAL: GeminiStreamChunk[] = [
  { candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
];

async function* scripted(chunks: GeminiStreamChunk[]): AsyncIterable<GeminiStreamChunk> {
  for (const c of chunks) yield c;
}

function recording(...rounds: GeminiStreamChunk[][]) {
  const bodies: Array<{ contents: GeminiContent[] }> = [];
  let i = 0;
  const transport = new GeminiTransport({
    streamFactory: (_m, body) => {
      bodies.push(structuredClone(body) as { contents: GeminiContent[] });
      return scripted(rounds[i++] ?? FINAL);
    },
  });
  return { transport, bodies };
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';
const echoTool = (): RawToolOptions => ({
  name: 'echo',
  description: 'echo',
  parameters: z.object({ msg: z.string() }),
  execute: async (input) => `echo:${(input as { msg: string }).msg}`,
});
const seg: SubagentPathSegment = { depth: 1, agentToolUseId: 'T1', agentSlug: 'researcher', agentName: 'Researcher' };

const modelTurns = (contents: GeminiContent[]) => contents.filter((c) => c.role === 'model');

describe.each([
  ['the shared round core', true],
  ['the legacy nested loop', false],
])('Gemini subagent via %s', (_label, sharedLoop) => {
  it('the next request carries the round as streamed, and the scoped journal keeps it for re-entry', async () => {
    const { transport, bodies } = recording(PARALLEL_ROUND, FINAL);
    const j = make(`t-${sharedLoop}`);
    await runSubagentLoop({
      transport, model: 'gemini-3.8-flash', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: [seg], sharedLoop,
    });

    // Round 2's body: the model turn went back byte-for-byte (the signature, the
    // provider ids, the trailing empty text part), and each result names its call.
    expect(bodies).toHaveLength(2);
    expect(modelTurns(bodies[1].contents)[0].parts).toEqual(SEALED_PARTS);
    const responses = bodies[1].contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    expect(responses.map((p) => p.functionResponse!.id)).toEqual(['call_1', 'call_2']);

    // The scoped journal: the assistant entry carries the sealed channel even on a
    // tool-only round, and the signed call's tool_use entry carries its signature.
    const all = await readAll(j);
    const asst = all.find((e) => e.payload.type === 'assistant')!.payload as Extract<JournalEntry['payload'], { type: 'assistant' }>;
    expect(asst.geminiContent?.parts).toEqual(SEALED_PARTS);
    const signed = all.filter((e) => e.payload.type === 'tool_use').map((e) => (e.payload as { thoughtSignature?: string }).thoughtSignature);
    expect(signed).toEqual(['SIG_1', undefined]);

    // Scoped re-entry projects the same turn back.
    const reentry = transport.historyFromJournal(all) as GeminiContent[];
    expect(modelTurns(reentry)[0].parts).toEqual(SEALED_PARTS);
  });
});

describe('Gemini subagent — P3.5b pending-round re-push', () => {
  let seq = 0;
  const entry = (payload: JournalEntry['payload']): JournalEntry => {
    seq += 1;
    return {
      uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'u',
      agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z',
      agentPath: [seg], payload,
    };
  };

  const resume = async (seed: JournalEntry[]) => {
    const { transport, bodies } = recording(FINAL);
    await runSubagentLoop({
      transport, model: 'gemini-3.8-flash', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 2, childId: 'c', onEvent: () => {},
      resume: { seedEntries: seed, continuePending: true }, sharedLoop: true,
    });
    const contents = bodies[0].contents;
    const responses = contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    return { contents, ids: responses.map((p) => p.functionResponse!.id) };
  };
  const THREE = [
    ...SEALED_PARTS.slice(0, 2),
    { functionCall: { name: 'echo', args: { msg: 'c' }, id: 'call_3' } },
    { text: '' },
  ];

  it('a sequential pause at the FIRST call re-pushes the sealed turn TRIMMED to it — B never ran, so B never goes back', async () => {
    // [A,B] ran sequentially and paused at A: B's tool_use was never journaled.
    const { contents, ids } = await resume([
      entry({ type: 'assistant', blocks: [], api: 'gemini', provider: 'google', model: 'gemini-3.8-flash', geminiContent: { parts: SEALED_PARTS, callIds: ['g-1', 'g-2'] } }),
      entry({ type: 'usage', costUsd: 0, model: 'gemini-3.8-flash', source: 'subagent', inputTokens: 1, outputTokens: 1 } as never),
      entry({ type: 'tool_use', toolUseId: 'g-1', name: 'echo', input: { msg: 'a' }, thoughtSignature: 'SIG_1' }),
    ]);
    expect(modelTurns(contents)).toEqual([{ role: 'model', parts: [SEALED_PARTS[0], { text: '' }] }]);
    expect(ids).toEqual(['call_1']);
  });

  it('a pause at a LATER call re-pushes the whole round as one unit: sealed turn (signature on A), A\'s settled result, then B', async () => {
    // [A,B,C] ran sequentially: A resolved, the pause landed on B, C never ran.
    const { contents, ids } = await resume([
      entry({ type: 'assistant', blocks: [], api: 'gemini', provider: 'google', model: 'gemini-3.8-flash', geminiContent: { parts: THREE, callIds: ['g-1', 'g-2', 'g-3'] } }),
      entry({ type: 'tool_use', toolUseId: 'g-1', name: 'echo', input: { msg: 'a' }, thoughtSignature: 'SIG_1' }),
      entry({ type: 'tool_result', toolUseId: 'g-1', blocks: [{ type: 'text', text: 'echo:a' }] }),
      entry({ type: 'tool_use', toolUseId: 'g-2', name: 'echo', input: { msg: 'b' } }),
    ]);
    expect(modelTurns(contents)).toEqual([{ role: 'model', parts: [...SEALED_PARTS.slice(0, 2), { text: '' }] }]);
    expect(ids).toEqual(['call_1', 'call_2']);
    expect(JSON.stringify(contents)).toContain('echo:a');
  });

  it('an Interactions round paused at its first call re-pushes only the calls that ran', async () => {
    const bodies: GeminiInteractionsRequest[] = [];
    const transport = new GeminiInteractionsTransport({
      streamFactory: async function* (body) {
        bodies.push(structuredClone(body));
        yield { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 1 } } };
      },
    });
    await runSubagentLoop({
      transport, model: 'gemini-3.8-flash', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 2, childId: 'c', onEvent: () => {}, sharedLoop: true,
      resume: {
        continuePending: true,
        seedEntries: [
          entry({ type: 'assistant', blocks: [], api: 'gemini_interactions', provider: 'google', geminiSteps: [
            { type: 'thought', signature: 'SIG_T' },
            { type: 'function_call', id: 'fc_a', name: 'echo', arguments: { msg: 'a' } },
            { type: 'function_call', id: 'fc_b', name: 'echo', arguments: { msg: 'b' } },
          ] }),
          entry({ type: 'tool_use', toolUseId: 'fc_a', name: 'echo', input: { msg: 'a' } }),
        ],
      },
    });
    expect(bodies[0].input.slice(1).map((s) => [s.type, (s as { id?: string; call_id?: string }).id ?? (s as { call_id?: string }).call_id ?? (s as { signature?: string }).signature])).toEqual([
      ['thought', 'SIG_T'], ['function_call', 'fc_a'], ['function_result', 'fc_a'],
    ]);
  });
});

describe('Gemini Interactions subagent — the steps ride the done event into the scoped journal (finding 5)', () => {
  it('the child journals its round\'s steps and the next request resends the real signed thought', async () => {
    const round: GeminiInteractionsEvent[] = [
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'SIG_T' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'fc_1', name: 'echo', arguments: { msg: 'a' } } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: { total_input_tokens: 1, total_output_tokens: 1 } } },
    ];
    const final: GeminiInteractionsEvent[] = [
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'done' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 1 } } },
    ];
    const bodies: GeminiInteractionsRequest[] = [];
    let i = 0;
    const transport = new GeminiInteractionsTransport({
      streamFactory: async function* (body) { bodies.push(structuredClone(body)); for (const e of [round, final][i++] ?? final) yield e; },
    });
    const j = make('t-ix');
    await runSubagentLoop({
      transport, model: 'gemini-3.8-flash', system: 'sys', userPrompt: 'go', tools: [echoTool()],
      harness: allowHarness, onPause, maxTurns: 5, childId: 'c', onEvent: () => {},
      journal: j, subagentPath: [seg], sharedLoop: true,
    });
    expect(bodies[1].input.slice(1, 3)).toEqual([
      { type: 'thought', signature: 'SIG_T' },
      { type: 'function_call', id: 'fc_1', name: 'echo', arguments: { msg: 'a' } },
    ]);
    const all = await readAll(j);
    const asst = all.find((e) => e.payload.type === 'assistant')!.payload as Extract<JournalEntry['payload'], { type: 'assistant' }>;
    expect(asst.geminiSteps).toEqual([
      { type: 'thought', signature: 'SIG_T' },
      { type: 'function_call', id: 'fc_1', name: 'echo', arguments: { msg: 'a' } },
    ]);
    // Scoped re-entry resends the REAL signature, not the sentinel.
    const reentry = JSON.stringify(transport.historyFromJournal(all));
    expect(reentry).toContain('SIG_T');
    expect(reentry).not.toContain('skip_thought_signature_validator');
  });
});
