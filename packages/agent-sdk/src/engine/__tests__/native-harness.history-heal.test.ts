/**
 * The floor under a rejected history, through a whole NativeHarness turn.
 *
 * Live prod task 28edef30 (2026-09-28): the provider rejected the re-derived history
 * with 400 invalid_request_error, the journal replayed the same shape every turn, and
 * the task failed four times over three hours. These pin the heal: ONE retry of the
 * same model call on the safe view, only for that rejection, only before any output,
 * loud either way, and a second rejection ends the turn exactly as before.
 *
 * The transport is the fake one, but everything it touches is real: the errors are the
 * Anthropic SDK's own (APIError.generate, the path its client takes on an HTTP error),
 * classified by the Anthropic lane's classifier, and the histories are the Anthropic
 * projection of the real journal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type ProviderStream, type ProviderHistory } from '../transport.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { classifyAnthropicError } from '../native-termination.js';
import { HISTORY_HEALED_EVENT } from '../history-heal.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { OnAuthHalt, RawToolOptions } from '../../tools/tool-types.js';

afterEach(() => vi.restoreAllMocks());

const REJECTED = 'messages.3: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_03';
const rejection = (message = REJECTED) =>
  APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers({ 'request-id': 'req_011CT' }));
/** Prod 09-16's wedge: a signed thinking block the API no longer accepts on replay. */
const THINKING_REPLAY = 'messages.5.content.0: thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.';

/** One scripted model call: a normal stream, or events followed by a throw (none = a pre-output 400). */
type Step = StreamEvent[] | { before: StreamEvent[]; error: unknown; onThrow?: () => void };

const done: StreamEvent = { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
/** A round that calls the noop tool, so the next round's history ends in a well-formed tool round. */
const toolRound: StreamEvent[] = [
  { kind: 'tool_use', toolUse: { id: 'toolu_09', name: 'noop', input: {} } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
];

class NoopToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'noop',
      description: 'a tool that keeps the turn going for a second round',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'noop ran',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

class ScriptedAnthropicTransport extends FakeTransport {
  readonly histories: Anthropic.MessageParam[][] = [];
  constructor(private readonly steps: Step[]) {
    super([]);
  }
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return journalToAnthropicMessages(entries);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): ProviderStream {
    this.histories.push(JSON.parse(JSON.stringify(p.history)) as Anthropic.MessageParam[]);
    return this.steps[Math.min(this.histories.length - 1, this.steps.length - 1)];
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const step = stream as Step;
    if (Array.isArray(step)) {
      yield* step;
      return;
    }
    yield* step.before;
    step.onThrow?.();
    throw step.error;
  }
  override classifyError(err: unknown): TurnOutcome {
    return classifyAnthropicError(err);
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});

/** A task with one finished tool round behind it, so the safe view has something to render. */
async function seededJournal(taskId: string): Promise<Journal> {
  const j = new Journal({
    taskId, workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `history-heal-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-09-28T04:41:00.000Z'),
  });
  const payloads: JournalPayload[] = [
    { type: 'user', blocks: [{ type: 'text', text: 'make a showreel from these shots' } as never] },
    { type: 'assistant', blocks: [{ type: 'text', text: 'checking the music' } as never] },
    { type: 'tool_use', toolUseId: 'toolu_03', name: 'Bash', input: { command: 'ls music' } },
    { type: 'tool_result', toolUseId: 'toolu_03', blocks: [{ type: 'text', text: 'bands printed' } as never], isError: false },
    { type: 'assistant', blocks: [{ type: 'text', text: 'the music is ready' } as never] },
  ];
  for (const payload of payloads) await j.append({ ...base(taskId), payload });
  return j;
}

async function runTurn(taskId: string, steps: Step[], controller = new AbortController()) {
  const journal = await seededJournal(taskId);
  const transport = new ScriptedAnthropicTransport(steps);
  const cfg = {
    onAttached: () => {}, maxTurns: 5, transport, journal, toolHost: new NoopToolHost(), abilities: [], signal: controller.signal,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId, sessionId: 's-heal', cwd: '/tmp', model: 'fake-model', signal: controller.signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'now cut it to 30 seconds' };
  })();
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
  expect(ends).toHaveLength(1);
  const heals = events.filter((e) => e.kind === 'raw' && e.event === HISTORY_HEALED_EVENT).map((e) => (e as { data: Record<string, unknown> }).data);
  const healLogs = err.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[history-heal]'));
  return { outcome: ends[0].outcome, transport, heals, healLogs };
}

const toolBlocks = (msgs: Anthropic.MessageParam[]) =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use' || b.type === 'tool_result');

describe('history heal — one retry on a safe view when the provider rejects the history', () => {
  it('a rejected history is retried once on the safe view and the turn completes, loudly', async () => {
    const { outcome, transport, heals, healLogs } = await runTurn('t-heal', [
      { before: [], error: rejection() },
      [{ kind: 'text', text: 'cut to 30 seconds' }, done],
    ]);
    expect(outcome.kind).toBe('completed');
    expect(transport.histories).toHaveLength(2); // the rejected call + exactly one retry
    // The first request carried the structured tool round; the retry carries it as text.
    expect(toolBlocks(transport.histories[0])).toHaveLength(2);
    expect(toolBlocks(transport.histories[1])).toHaveLength(0);
    const retried = JSON.stringify(transport.histories[1]);
    expect(retried).toContain('[Earlier call: Bash {\\"command\\":\\"ls music\\"}]');
    expect(retried).toContain('[Earlier Bash result: bands printed]');
    expect(retried).toContain('now cut it to 30 seconds');
    // Loud: the log names the typed error, the request id and the rejected request's shape.
    expect(healLogs).toHaveLength(1);
    expect(healLogs[0]).toContain('invalid_request_error');
    expect(healLogs[0]).toContain('request_id=req_011CT');
    expect(healLogs[0]).toContain('tu=[toolu_03]');
    // And durable: one raw event for the relay's error_events row.
    expect(heals).toEqual([expect.objectContaining({
      taskId: 't-heal', healed: true, view: 'text_only', errorType: 'invalid_request_error', requestId: 'req_011CT',
    })]);
  });

  it('a credit or context 400 is not a history problem: no heal, the turn ends as it always did', async () => {
    for (const [message, kind] of [
      ['Your credit balance is too low to access the Anthropic API.', 'billing_error'],
      ['prompt is too long: 250000 tokens > 200000 maximum', 'context_exceeded'],
    ] as const) {
      const { outcome, transport, heals, healLogs } = await runTurn(`t-${kind}`, [
        { before: [], error: rejection(message) },
        [{ kind: 'text', text: 'never reached' }, done],
      ]);
      expect(outcome.kind).toBe(kind);
      expect(transport.histories).toHaveLength(1);
      expect(heals).toEqual([]);
      expect(healLogs).toEqual([]);
    }
  });

  it('a second rejection ends the turn model_error exactly as before, and says the heal failed', async () => {
    const { outcome, transport, heals, healLogs } = await runTurn('t-twice', [
      { before: [], error: rejection() },
      { before: [], error: rejection() },
      [{ kind: 'text', text: 'never reached' }, done],
    ]);
    expect(outcome.kind).toBe('model_error');
    expect(transport.histories).toHaveLength(2); // bounded: one heal per model call
    expect(heals).toEqual([expect.objectContaining({ healed: false })]);
    expect(healLogs).toHaveLength(2);
  });

  it('a rejection after a tool round keeps that round structured (the model answers those results)', async () => {
    const { outcome, transport, heals } = await runTurn('t-tail', [
      toolRound,
      { before: [], error: rejection() },
      [{ kind: 'text', text: 'done' }, done],
    ]);
    expect(outcome.kind).toBe('completed');
    expect(transport.histories).toHaveLength(3);
    // The seeded past round is text; the latest round (toolu_09 and its result) stays structured.
    expect(toolBlocks(transport.histories[2]).map((b) => (b.type === 'tool_use' ? b.id : (b as Anthropic.ToolResultBlockParam).tool_use_id))).toEqual(['toolu_09', 'toolu_09']);
    expect(heals).toEqual([expect.objectContaining({ healed: true, view: 'tail_kept' })]);
  });

  it('a rejected signed-thinking replay (prod 09-16) heals too, on the text-only view, latest round included', async () => {
    const { outcome, transport, heals, healLogs } = await runTurn('t-thinking', [
      toolRound,
      { before: [], error: rejection(THINKING_REPLAY) },
      [{ kind: 'text', text: 'done' }, done],
    ]);
    expect(outcome.kind).toBe('completed');
    expect(transport.histories).toHaveLength(3);
    // The same shape a model_error keeps structured goes wholly to text: the signed block
    // can sit in the latest assistant message, and that message is not sent again.
    expect(toolBlocks(transport.histories[2])).toHaveLength(0);
    expect(JSON.stringify(transport.histories[2])).toContain('[Earlier noop result: noop ran]');
    expect(heals).toEqual([expect.objectContaining({ healed: true, view: 'text_only' })]);
    expect(healLogs).toHaveLength(1);
  });

  it('a second thinking-replay rejection ends the turn request_invalid, exactly as before', async () => {
    const { outcome, transport, heals } = await runTurn('t-thinking-twice', [
      toolRound,
      { before: [], error: rejection(THINKING_REPLAY) },
      { before: [], error: rejection(THINKING_REPLAY) },
      [{ kind: 'text', text: 'never reached' }, done],
    ]);
    expect(outcome.kind).toBe('request_invalid');
    expect(transport.histories).toHaveLength(3);
    expect(heals).toEqual([expect.objectContaining({ healed: false, view: 'text_only' })]);
  });

  it('a stop during the retry is a stop: no "rejected too" line, no heal_rejected row', async () => {
    const controller = new AbortController();
    const aborted = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    const { outcome, transport, heals, healLogs } = await runTurn('t-stop', [
      { before: [], error: rejection() },
      { before: [], error: aborted, onThrow: () => controller.abort() },
    ], controller);
    expect(transport.histories).toHaveLength(2);
    expect(outcome.kind).toBe('user_aborted');
    expect(heals).toEqual([]);
    expect(healLogs.some((l) => l.includes('rejected too'))).toBe(false);
  });

  it('output already streamed: no retry (it would double-emit), the turn ends model_error', async () => {
    const { outcome, transport, heals } = await runTurn('t-streamed', [
      { before: [{ kind: 'text', text: 'Cutting it n' }], error: rejection() },
      [{ kind: 'text', text: 'never reached' }, done],
    ]);
    expect(outcome.kind).toBe('model_error');
    expect(transport.histories).toHaveLength(1);
    expect(heals).toEqual([]);
  });
});
