/**
 * CONFORMANCE SEAL — the DeepSeek tool-loop reasoning replay, END TO END.
 *
 * Incident 2026-08-13 (task 1e823211): every link of the replay chain existed
 * and was unit-pinned, yet the chain was starved at a seam (the transport never
 * emitted a terminal thinking_block, so the engine folded no thinking, so the
 * stash promoted nothing) and DeepSeek 400'd every tool-using turn:
 *   "The reasoning_content in the thinking mode must be passed back to the API."
 *
 * Link pins can't catch a starved seam BETWEEN links — only a walk of the whole
 * chain can. This test drives the REAL transport surface exactly the way the
 * round engine does across one tool loop:
 *
 *   readStream(round 1: reasoning + tool_call)     — the wire, as DeepSeek sends it
 *     → collect thinking_block + tool_use          — what the engine collects
 *   pushAssistant(thinking + text + tool_use)      — what the engine folds
 *   pushToolResult(result)
 *   callModel(round 2)                             — the follow-up request
 *     → ASSERT the assistant message carries reasoning_content   (a model that reads it)
 *     → ASSERT it does NOT for a model that ignores it           (Grok)
 *
 * If ANY seam in that chain stops carrying the reasoning, this test fails —
 * regardless of which link the regression hides in.
 */
import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ContentBlock } from '../../contract/blocks.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import type { ProviderReplay } from '../../engine/transport.js';

type Msg = Record<string, unknown>;

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { choices: [{ delta, ...extra }] } as never;
}

/** Round-1 stream: DeepSeek thinks, then calls a tool. */
function round1Stream() {
  return (async function* () {
    yield chunk({ reasoning_content: 'I should check the repo status ' });
    yield chunk({ reasoning_content: 'with the bash tool.' });
    yield chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"command":"git status"}' } }] });
    yield chunk({}, { finish_reason: 'tool_calls' });
    yield { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } } as never;
  })();
}

function captureClient() {
  const stream = vi.fn().mockReturnValue((async function* () {})());
  return { stream, client: { chat: { completions: { stream, create: vi.fn() } } } as unknown as OpenAI };
}

/** Walk the engine's exact sequence for one tool loop on `model`. */
async function walkToolLoop(model: string, stream1 = round1Stream()): Promise<Msg[]> {
  const { stream, client } = captureClient();
  const t = new ChatCompletionsTransport({ client });

  // Round 1 — read the wire the way the round engine does, collecting the
  // SAME event kinds it folds into the assistant blocks, and the round's sealed
  // message off its `done` event.
  const blocks: ContentBlock[] = [];
  let replay: ProviderReplay | undefined;
  for await (const ev of t.readStream(stream1 as never)) {
    if (ev.kind === 'thinking_block') blocks.push({ type: 'thinking', thinking: ev.thinking });
    if (ev.kind === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        toolUseId: ev.toolUse.id,
        toolName: ev.toolUse.name,
        toolInput: ev.toolUse.input,
      } as ContentBlock);
    }
    if (ev.kind === 'done') replay = ev.replay;
  }

  const history = t.emptyHistory();
  t.pushUser(history, 'what changed in my repo?');
  t.pushAssistant(history, blocks, replay);
  const callId = (blocks.find((b) => b.type === 'tool_use') as { toolUseId: string }).toolUseId;
  t.pushToolResult(history, { toolUseId: callId, toolName: 'Bash', text: 'clean tree', isError: false } as never);

  // Round 2 — the follow-up request.
  t.callModel({ model, system: 'sys', tools: [], history, maxTokens: 100 });
  const body = stream.mock.calls[0][0] as { messages: Msg[] };
  return body.messages;
}

/** The capable rows (thinking.replaysReasoning) — live-probed 2026-09-23. */
const READS_REASONING = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.2'];

describe('chat tool-loop reasoning replay — end-to-end conformance (09-23: gated on the model, not a dead lane)', () => {
  // The old gate sent reasoning_content only on the `deepseek` provider, removed
  // 2026-08-17 — so no model got its reasoning back, on the unverified belief that
  // Fireworks' schema rejects the field. It does not: Fireworks accepts it and the
  // model reads it (probed 2026-09-23). xAI Grok accepts and ignores it.
  it.each(READS_REASONING)('%s: the follow-up carries the round as streamed — reasoning_content, provider id, raw arguments', async (model) => {
    const messages = await walkToolLoop(model);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toEqual({
      role: 'assistant',
      reasoning_content: 'I should check the repo status with the bash tool.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"git status"}' } }],
    });
    // The tool result still rides behind it — the loop shape is unchanged.
    expect(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
  });

  it('a model that does not read it back (Grok) gets the field stripped, the rest as streamed', async () => {
    const messages = await walkToolLoop('grok-4.6');
    expect(JSON.stringify(messages)).not.toContain('reasoning_content');
    expect(messages.find((m) => m.role === 'assistant')?.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"git status"}' } },
    ]);
  });

  it('a torn argument string goes back as "{}" (GLM 5.2 400s invalid JSON), and an id-less call gets ONE minted id on the call and its result', async () => {
    const messages = await walkToolLoop('glm-5.2', (async function* () {
      yield chunk({ reasoning_content: 'hm' });
      yield chunk({ tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{"command": "git st' } }] });
      yield chunk({}, { finish_reason: 'tool_calls' });
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } } as never;
    })());
    const call = (messages.find((m) => m.role === 'assistant')?.tool_calls as Array<{ id: string; function: { arguments: string } }>)[0];
    expect(call.function.arguments).toBe('{}');
    expect(call.id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(messages.find((m) => m.role === 'tool')?.tool_call_id).toBe(call.id);
  });

  it('a journal-re-derived MULTI-TOOL round keeps reasoning on its assistant message (strike 2026-08-13, task fd760456)', async () => {
    // The engine re-projects history FROM THE JOURNAL after every tool batch
    // (native-harness), and a parallel-tool round journals interleaved
    // tool_use/tool_result pairs in completion order. The in-memory walk above
    // can stay green while THIS path synthesizes reasoning-less assistant messages
    // — which is exactly how the 2026-08-13 strikes 400'd on code that carried
    // the in-memory fix. Seal the journal seam end to end — for a legacy round
    // (no channel: the thinking blocks are its reasoning) and a sealed one.
    const { stream, client } = captureClient();
    const t = new ChatCompletionsTransport({ client });
    let seq = 0;
    const entry = (payload: Record<string, unknown>) => {
      seq += 1;
      return {
        uuid: `u${seq}`,
        parentUuid: seq === 1 ? null : `u${seq - 1}`,
        seq,
        taskId: 't',
        rootTaskId: 't',
        spawnDepth: 0,
        workspaceId: 'w',
        agentId: 'native',
        principal: { kind: 'agent', agentId: 'native' },
        timestamp: '2026-08-13T15:27:00.000Z',
        payload,
      } as never;
    };
    const sealed = {
      role: 'assistant',
      reasoning_content: 'now read the hit',
      tool_calls: [{ id: 'call_d', type: 'function', function: { name: 'Read', arguments: '{"path": "a"}' } }],
    };
    const history = t.historyFromJournal([
      entry({ type: 'user', blocks: [{ type: 'text', text: 'research it' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'fan out searches' }] }),
      entry({ type: 'tool_use', toolUseId: 'call_a', name: 'Read', input: {} }),
      entry({ type: 'tool_result', toolUseId: 'call_a', blocks: [{ type: 'text', text: 'ra' }] }),
      entry({ type: 'tool_use', toolUseId: 'call_b', name: 'WebSearch', input: { q: '1' } }),
      entry({ type: 'tool_result', toolUseId: 'call_b', blocks: [{ type: 'text', text: 'rb' }] }),
      entry({ type: 'tool_use', toolUseId: 'call_c', name: 'WebSearch', input: { q: '2' } }),
      entry({ type: 'tool_result', toolUseId: 'call_c', blocks: [{ type: 'text', text: 'rc' }] }),
      entry({ type: 'assistant', blocks: [{ type: 'thinking', thinking: 'now read the hit' }], api: 'openai_chat_completions', chatMessage: sealed }),
      entry({ type: 'tool_use', toolUseId: 'call_d', name: 'Read', input: { path: 'a' } }),
      entry({ type: 'tool_result', toolUseId: 'call_d', blocks: [{ type: 'text', text: 'rd' }] }),
    ]);
    t.callModel({ model: 'deepseek-v4-pro', system: 'sys', tools: [], history, maxTokens: 100 });
    const body = stream.mock.calls[0][0] as { messages: Msg[] };
    const assistants = body.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ reasoning_content: 'fan out searches' });
    expect((assistants[0].tool_calls as unknown[]).length).toBe(3);
    // The sealed round goes back as sent, its tool_use entry not folded a second time.
    expect(assistants[1]).toEqual(sealed);
    expect(body.messages.filter((m) => m.role === 'tool').length).toBe(4);
  });
});
