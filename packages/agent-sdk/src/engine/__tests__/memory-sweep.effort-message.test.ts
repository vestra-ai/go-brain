/**
 * SWEEP_EFFORT_MESSAGE_V1 (MED-4 of the #4381 review): on a row that takes a per-message effort
 * change, the memory sweep rides the loop's EXACT last request plus one effort-only message,
 * so it reads the loop's cache in full AND reasons at 'low'.
 *
 * The wire shape is Anthropic's (docs checked 2026-10-04, beta
 * `mid-conversation-output-config-2026-07-01`): `{role:'system', content:[],
 * output_config:{effort:'low'}}` before the user turn it applies to. A top-level effort change
 * resets the messages cache; this message does not, so the top-level effort must stay the loop's.
 *
 * The proof is at the wire, through the real NativeHarness, a real Journal and the real
 * Anthropic transport with a capturing client: a reasoning tool round, a reasoning final round,
 * then the sweep. Per supported row the sweep's body is the loop's last body field for field
 * (system, tools, thinking, the top-level effort), the loop's messages are an exact prefix of the
 * sweep's, and the tail is [the final reply, the effort message, the sweep prompt]. The effort
 * message carries no breakpoint and the beta rides that call only. Rows without the capability
 * get no message and keep SWEEP_PREFIX_PARITY_V1's rule; flag off is the parity sweep unchanged.
 *
 * Fixtures only: a live drill on these rows spends the staging Anthropic key, which needs the
 * founder's word.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { MEMORY_SWEEP_PROMPT, SWEEP_PARITY_MAX_TOKENS, sweepTakesEffortMessage } from '../memory-sweep.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { NativeConfig } from '../native-config.js';
import { AnthropicMessagesTransport, MID_CONVERSATION_OUTPUT_CONFIG_BETA } from '../../transports/anthropic-transport.js';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../../contract/model-capabilities.js';

const FLAGS = ['SWEEP_PREFIX_PARITY_V1', 'SWEEP_EFFORT_MESSAGE_V1'] as const;
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

/** The rows Anthropic's docs list for a per-message effort change (Mythos 5.1 has no row here). */
const CAPABLE = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'] as const;
const EFFORT_MESSAGE = { role: 'system', content: [], output_config: { effort: 'low' } };

interface Wire {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ANSWER = 'Priya is your cofounder at Acme.';
const FACT = 'FACT [relationship] (user_direct) Priya is the cofounder of Acme.\n';

function* thinkingBlock(index: number, thinking: string, signature: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } };
  yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } };
  yield { type: 'content_block_stop', index };
}
function* textBlock(index: number, text: string) {
  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
  yield { type: 'content_block_stop', index };
}
function* toolBlock(index: number) {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'tu_1', name: 'search_notes', input: {} } };
  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"q":"acme"}' } };
  yield { type: 'content_block_stop', index };
}
function stream(events: Iterable<unknown>, content: unknown[], stopReason: string) {
  const list = [...events];
  return {
    async *[Symbol.asyncIterator]() {
      yield* list;
    },
    async finalMessage() {
      return { stop_reason: stopReason, usage: { input_tokens: 400, output_tokens: 40 }, content };
    },
  };
}
/** A tool round, a final round, the sweep: built fresh per run (a stream is read once). */
const script = () => [
  stream([...thinkingBlock(0, 'find the note', 'SIG-ONE'), ...toolBlock(1)], [
    { type: 'thinking', thinking: 'find the note', signature: 'SIG-ONE' },
    { type: 'tool_use', id: 'tu_1', name: 'search_notes', input: { q: 'acme' } },
  ], 'tool_use'),
  stream([...thinkingBlock(0, 'answer it', 'SIG-TWO'), ...textBlock(1, ANSWER)], [
    { type: 'thinking', thinking: 'answer it', signature: 'SIG-TWO' },
    { type: 'text', text: ANSWER },
  ], 'end_turn'),
  stream([...textBlock(0, FACT)], [{ type: 'text', text: FACT }], 'end_turn'),
];

/** The fleet-static part of the system prompt, long enough for Anthropic to tier it. */
const FLEET = 'You are a careful assistant who keeps notes. '.repeat(260);
const SESSION = 'This session belongs to one person; their notes are private.';
const searchNotes: RawToolOptions = {
  name: 'search_notes',
  description: 'Search the notes for a phrase.',
  parameters: z.object({ q: z.string() }),
  execute: async () => 'Note 12: Priya, cofounder at Acme, prefers short updates.',
};

/** One real turn on `model` (two loop rounds, then the sweep); every request as it left. */
async function runTurn(model: string): Promise<Wire[]> {
  const wires: Wire[] = [];
  const responses = script();
  let i = 0;
  const transport = new AnthropicMessagesTransport({
    client: {
      messages: {
        stream: (body: Record<string, unknown>, opts: unknown) => {
          wires.push({ body: clone(body), headers: clone((opts as { headers?: Record<string, string> } | undefined)?.headers ?? {}) });
          const next = responses[i++];
          if (!next) throw new Error('more model calls than the script holds');
          return next;
        },
      },
    } as never,
  });
  const taskId = `t-sweep-effort-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId, workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `sweep-effort-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-04T00:00:00.000Z'),
  });
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [searchNotes], onAuthHalt: async () => {} };
    },
  };
  const cfg = {
    onAttached: () => {}, maxTurns: 6, transport, toolHost, journal,
    systemPrompt: FLEET + SESSION, systemFleetPrefixChars: FLEET.length,
    runtimeConfig: { userId: 'user-1' }, namiOffloopSweep: true,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId, sessionId: 's-sweep-effort', cwd: '/tmp', model, signal: new AbortController().signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'Find my note about Acme and tell me who Priya is.' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  const end = events.find((e) => e.kind === 'turn_end') as Extract<HarnessEvent, { kind: 'turn_end' }> | undefined;
  expect(end?.outcome.kind, `${model}: the turn completes`).toBe('completed');
  // Two loop rounds, then the sweep (no suggestion, no compaction in this run).
  expect(wires).toHaveLength(3);
  return wires;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function stripMarkers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMarkers);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, stripMarkers(x)]));
  return v;
}
const withoutHistoryAndCap = (b: Record<string, unknown>) => {
  const { messages: _m, max_tokens: _c, ...rest } = b;
  return rest;
};
const messagesOf = (w: Wire) => w.body.messages as Array<Record<string, unknown>>;

describe('SWEEP_EFFORT_MESSAGE_V1 on: the sweep is the loop request plus one effort message, per supported row', () => {
  it.each(CAPABLE)('%s', async (model) => {
    for (const f of FLAGS) process.env[f] = 'true';
    const [, loop, sweep] = await runTurn(model);

    // Every field outside the history and the cap is the loop's, the top-level effort included:
    // a top-level change is the cache reset this message exists to avoid.
    expect(withoutHistoryAndCap(sweep.body)).toEqual(withoutHistoryAndCap(loop.body));
    expect((sweep.body.output_config as { effort: string }).effort).toBe(resolveCapabilities(model).thinking.effort);
    expect(sweep.body.max_tokens).toBe(SWEEP_PARITY_MAX_TOKENS);

    // The loop's messages are an exact prefix (signed thinking and all), then exactly the tail.
    const lm = messagesOf(loop);
    const sm = messagesOf(sweep);
    expect(JSON.stringify(lm)).toContain('SIG-ONE');
    expect(stripMarkers(sm.slice(0, lm.length))).toEqual(stripMarkers(lm));
    const tail = sm.slice(lm.length);
    expect(tail).toHaveLength(3);
    expect(tail[0]!.role).toBe('assistant');
    expect(JSON.stringify(tail[0])).toContain(ANSWER);
    // Mutation: drop the transport's insertion (or the row's capability) → no such message.
    expect(tail[1]).toEqual(EFFORT_MESSAGE); // exact: no cache_control on it
    expect(tail[2]!.role).toBe('user');
    expect(JSON.stringify(tail[2])).toContain(MEMORY_SWEEP_PROMPT.slice(0, 60));
    expect(JSON.stringify(tail[2])).toContain('cache_control'); // the rolling breakpoint stays on the last message

    // The beta rides the sweep call only.
    expect(loop.headers['anthropic-beta']).toBeUndefined();
    expect(sweep.headers['anthropic-beta']).toBe(MID_CONVERSATION_OUTPUT_CONFIG_BETA);
  });
});

describe('rows without the capability: no message, SWEEP_PREFIX_PARITY_V1 as before', () => {
  it.each(['claude-fable-5', 'claude-opus-4-8'])('%s (high effort): the floored request, no message, no beta', async (model) => {
    for (const f of FLAGS) process.env[f] = 'true';
    const [, , sweep] = await runTurn(model);
    expect(JSON.stringify(sweep.body.messages)).not.toContain('"role":"system"');
    expect(sweep.headers['anthropic-beta']).toBeUndefined();
    // The break-even rule still holds here: today's floored request.
    expect((sweep.body.output_config as { effort: string }).effort).toBe('low');
    expect(sweep.body.max_tokens).toBe(2048);
  });

  it('claude-sonnet-4-6 (medium effort): parity pays off, it rides the loop request with no message', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    const [, loop, sweep] = await runTurn('claude-sonnet-4-6');
    expect(withoutHistoryAndCap(sweep.body)).toEqual(withoutHistoryAndCap(loop.body));
    expect(JSON.stringify(sweep.body.messages)).not.toContain('"role":"system"');
    expect(sweep.headers['anthropic-beta']).toBeUndefined();
  });
});

describe('flag off: the parity sweep exactly as before', () => {
  it('claude-opus-5-5 (medium, parity pays off): the same request minus the message and the beta', async () => {
    process.env.SWEEP_PREFIX_PARITY_V1 = 'true';
    const [, , off] = await runTurn('claude-opus-5-5');
    process.env.SWEEP_EFFORT_MESSAGE_V1 = 'true';
    const [, , on] = await runTurn('claude-opus-5-5');
    const onMessages = messagesOf(on).filter((m) => m.role !== 'system');
    expect({ ...on.body, messages: onMessages }).toEqual(off.body);
    expect(off.headers).toEqual({});
  });

  it('claude-fable-5-1 (high): the floored request, as SWEEP_PREFIX_PARITY_V1 alone sends it', async () => {
    process.env.SWEEP_PREFIX_PARITY_V1 = 'true';
    const [, , sweep] = await runTurn('claude-fable-5-1');
    expect((sweep.body.output_config as { effort: string }).effort).toBe('low');
    expect(sweep.body.max_tokens).toBe(2048);
    expect(JSON.stringify(sweep.body.messages)).not.toContain('"role":"system"');
  });

  it('SWEEP_EFFORT_MESSAGE_V1 without SWEEP_PREFIX_PARITY_V1: nothing changes (it rides parity only)', async () => {
    process.env.SWEEP_EFFORT_MESSAGE_V1 = 'true';
    const [, , sweep] = await runTurn('claude-opus-5-5');
    expect((sweep.body.output_config as { effort: string }).effort).toBe('low');
    expect(sweep.body.max_tokens).toBe(2048);
    expect(JSON.stringify(sweep.body.messages)).not.toContain('"role":"system"');
  });
});

describe('the capability is a registry field, never a name pattern', () => {
  it('exactly the four documented rows carry it', () => {
    const carrying = KNOWN_MODEL_IDS.filter((id) => resolveCapabilities(id).thinking.perMessageEffort === true).sort();
    expect(carrying).toEqual([...CAPABLE].sort());
    for (const id of KNOWN_MODEL_IDS) expect(sweepTakesEffortMessage(id), id).toBe(carrying.includes(id));
  });

  it('every row that carries it is an Anthropic row that thinks', () => {
    for (const id of CAPABLE) {
      const caps = resolveCapabilities(id);
      expect(caps.provider).toBe('anthropic');
      expect(['always_on', 'adaptive']).toContain(caps.thinking.mode);
    }
  });
});
