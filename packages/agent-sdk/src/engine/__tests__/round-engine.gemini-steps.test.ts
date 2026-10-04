import { describe, it, expect, vi } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { JournalEntry, GeminiReplayStep } from '../../contract/journal.js';
import type { StreamEvent, Transport, NormalizedUsage, ProviderHistory, ProviderStream } from '../transport.js';
import type { Journal } from '../../kernel/index.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';

/**
 * The Gemini Interactions verbatim-replay channel (the twin of the Anthropic
 * `anthropicBlocks` channel): a transport that captured signed `thought` steps
 * off the stream hands them to the loop via `capturedGeminiSteps()`, and the
 * loop persists them on the assistant journal entry as `geminiSteps` so the
 * next request can resend them (stateless Interactions 400s without them).
 */
function scripted(events: StreamEvent[]): Transport {
  const t: Partial<Transport> = {
    api: 'gemini_interactions',
    provider: 'google',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => events as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const onPause = async (): Promise<string> => 'PAUSED';

const freshState = (): RoundState => ({
  assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false, inToolBatch: false,
  stopReason: null, lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});

function mainDeps(transport: Transport, over: Partial<RoundDeps> = {}): RoundDeps {
  return {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: {}, transport, rc: createRunContext('t'), harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness), tools: [], providerTools: [], system: 'sys',
    onPause, onAuthHalt: undefined, requestedModel: 'm', cachePrefixHint: undefined,
    history: transport.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [], ...over,
  } as RoundDeps;
}

async function drive(deps: RoundDeps, st: RoundState) {
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, st);
  let n = await gen.next();
  while (!n.done) { events.push(n.value); n = await gen.next(); }
  return { events, round: n.value };
}

const done: StreamEvent = { kind: 'done', stopReason: null, usage: { inputTokens: 1, outputTokens: 1 } };

function recordingJournal() {
  // `hasGeminiSteps` reads the KEY off the PAYLOAD, not off this record. The
  // channel's byte-identity promise is that the conditional spread OMITS the key
  // for every other dialect, and a recorder that writes `geminiSteps` on every
  // record can only ever report its own shape — an unconditional `geminiSteps,`
  // in the payload would read as absence too, pinning nothing.
  const appended: Array<{ type: string; hasGeminiSteps: boolean; geminiSteps?: unknown; api?: string | undefined }> = [];
  const journal = {
    append: vi.fn(async (e: { payload: { type: string; geminiSteps?: unknown; api?: string } }) => {
      appended.push({
        type: e.payload.type,
        hasGeminiSteps: Object.hasOwn(e.payload, 'geminiSteps'),
        geminiSteps: e.payload.geminiSteps,
        api: e.payload.api,
      });
      return { uuid: `u${appended.length}` } as unknown as JournalEntry;
    }),
  } as unknown as Journal;
  return { appended, journal };
}

describe('runOneRound — the Gemini Interactions replay channel', () => {
  it('persists capturedGeminiSteps() VERBATIM on the assistant entry, stamped with the dialect', async () => {
    const steps: GeminiReplayStep[] = [
      { type: 'thought', signature: 'sig-A', summary: 'read first' },
      { type: 'text', text: 'Let me look.' },
      { type: 'function_call', id: 'fc_1', name: 'nope_tool', arguments: { file_path: '/a' } },
    ];
    const transport = scripted([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool_use', toolUse: { id: 'fc_1', name: 'nope_tool', input: { file_path: '/a' } } },
      done,
    ]);
    transport.capturedGeminiSteps = () => steps;
    const { appended, journal } = recordingJournal();
    await drive(mainDeps(transport, { cfg: { journal } }), freshState());
    const asst = appended.find((e) => e.type === 'assistant');
    expect(asst?.hasGeminiSteps).toBe(true);
    expect(asst?.geminiSteps).toEqual(steps);
    expect(asst?.api).toBe('gemini_interactions');
  });

  it('a transport without the hook, or a turn without thoughts, leaves the field ABSENT (byte-identical payload)', async () => {
    // Both halves of the `geminiSteps && geminiSteps.length` gate: no hook at all,
    // a hook that declines the turn, and a hook that hands back an empty capture.
    // Each must leave the KEY off the payload — that omission IS the byte-identity
    // guarantee for every other dialect.
    const bare = scripted([{ kind: 'text', text: 'hi' }, done]);
    const a = recordingJournal();
    await drive(mainDeps(bare, { cfg: { journal: a.journal } }), freshState());
    const aAsst = a.appended.find((e) => e.type === 'assistant')!;
    expect(aAsst.hasGeminiSteps).toBe(false);
    expect(aAsst.geminiSteps).toBeUndefined();

    const noThoughts = scripted([{ kind: 'text', text: 'hi' }, done]);
    noThoughts.capturedGeminiSteps = () => undefined;
    const b = recordingJournal();
    await drive(mainDeps(noThoughts, { cfg: { journal: b.journal } }), freshState());
    const bAsst = b.appended.find((e) => e.type === 'assistant')!;
    expect(bAsst.hasGeminiSteps).toBe(false);
    expect(bAsst.geminiSteps).toBeUndefined();

    const emptyCapture = scripted([{ kind: 'text', text: 'hi' }, done]);
    emptyCapture.capturedGeminiSteps = () => [];
    const c = recordingJournal();
    await drive(mainDeps(emptyCapture, { cfg: { journal: c.journal } }), freshState());
    const cAsst = c.appended.find((e) => e.type === 'assistant')!;
    expect(cAsst.hasGeminiSteps).toBe(false);
    expect(cAsst.geminiSteps).toBeUndefined();
  });
});

describe('runOneRound — the done event\'s replay is the channel (sealed, every round)', () => {
  function recordAll() {
    const payloads: Array<Record<string, unknown>> = [];
    const journal = {
      append: vi.fn(async (e: { payload: Record<string, unknown> }) => {
        payloads.push(e.payload);
        return { uuid: `u${payloads.length}` } as unknown as JournalEntry;
      }),
    } as unknown as Journal;
    return { payloads, journal };
  }
  const content = {
    parts: [{ functionCall: { name: 'nope_tool', args: {}, id: 'call_1' }, thoughtSignature: 'SIG' }, { text: '' }],
    callIds: ['g-1'],
  };

  it('a generateContent round journals its model turn verbatim as geminiContent', async () => {
    const transport = scripted([
      { kind: 'tool_use', toolUse: { id: 'g-1', name: 'nope_tool', input: {}, thoughtSignature: 'SIG' } },
      { ...done, replay: { dialect: 'gemini', content } },
    ]);
    (transport as { api: string }).api = 'gemini';
    const { payloads, journal } = recordAll();
    await drive(mainDeps(transport, { cfg: { journal } }), freshState());
    const asst = payloads.find((p) => p.type === 'assistant')!;
    expect(asst.geminiContent).toEqual(content);
    expect(Object.hasOwn(asst, 'anthropicBlocks')).toBe(false);
    expect(Object.hasOwn(asst, 'geminiSteps')).toBe(false);
  });

  it('an Interactions round journals the done event\'s steps, not a stale transport stash', async () => {
    const steps: GeminiReplayStep[] = [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }];
    const transport = scripted([{ kind: 'text', text: 'hi' }, { ...done, replay: { dialect: 'gemini_interactions', steps } }]);
    transport.capturedGeminiSteps = () => [{ type: 'thought', signature: 'stale' }];
    const { payloads, journal } = recordAll();
    await drive(mainDeps(transport, { cfg: { journal } }), freshState());
    expect(payloads.find((p) => p.type === 'assistant')!.geminiSteps).toEqual(steps);
  });

  it('the no-journal path hands the replay to pushAssistant (it was rebuilt from blocks before)', async () => {
    const replay = { dialect: 'gemini' as const, content };
    const transport = scripted([
      { kind: 'tool_use', toolUse: { id: 'g-1', name: 'nope_tool', input: {} } },
      { ...done, replay },
    ]);
    const pushed: unknown[] = [];
    transport.pushAssistant = (_h, _b, r) => { pushed.push(r); };
    await drive(mainDeps(transport), freshState());
    expect(pushed).toEqual([replay]);
  });
});

describe('runOneRound — the OpenAI Responses / Chat Completions sealed channels', () => {
  function recordAll() {
    const payloads: Array<Record<string, unknown>> = [];
    const journal = {
      append: vi.fn(async (e: { payload: Record<string, unknown> }) => {
        payloads.push(e.payload);
        return { uuid: `u${payloads.length}` } as unknown as JournalEntry;
      }),
    } as unknown as Journal;
    return { payloads, journal };
  }
  const items = [
    { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'E' },
    { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'nope_tool', arguments: '{}' },
  ];

  it('a Responses round journals its output verbatim as responsesOutput, and no per-call reasoning', async () => {
    const transport = scripted([
      { kind: 'tool_use', toolUse: { id: 'call_1', name: 'nope_tool', input: {} } },
      { ...done, replay: { dialect: 'openai_responses', output: { items, issuer: 'openai' } } },
    ]);
    (transport as { api: string }).api = 'openai_responses';
    const { payloads, journal } = recordAll();
    await drive(mainDeps(transport, { cfg: { journal } }), freshState());
    const asst = payloads.find((p) => p.type === 'assistant')!;
    expect(asst.responsesOutput).toEqual({ items, issuer: 'openai' });
    expect(Object.hasOwn(asst, 'reasoning')).toBe(false);
    expect(Object.hasOwn(payloads.find((p) => p.type === 'tool_use')!, 'reasoning')).toBe(false);
  });

  it('a Chat Completions round journals its streamed message as chatMessage', async () => {
    const message = { role: 'assistant' as const, content: 'hi', reasoning_content: 'r' };
    const transport = scripted([{ kind: 'text', text: 'hi' }, { ...done, replay: { dialect: 'openai_chat_completions', message } }]);
    (transport as { api: string }).api = 'openai_chat_completions';
    const { payloads, journal } = recordAll();
    await drive(mainDeps(transport, { cfg: { journal } }), freshState());
    expect(payloads.find((p) => p.type === 'assistant')!.chatMessage).toEqual(message);
  });
});
