import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GeminiInteractionsTransport, geminiAuthHeaders } from '../gemini-interactions-transport.js';
import type { GeminiInteractionsTransportOptions } from '../gemini-interactions-transport.js';
import type { MediaBlockForWire } from '../gemini-interactions-messages.js';
import { StreamStalledError, withStallGuard } from '../../engine/stream-stall-guard.js';
import { GEMINI_SENTINEL_THOUGHT_SIGNATURE } from '../gemini-interactions-validity.js'
import type { GeminiInteractionsEvent, GeminiInteractionsRequest, GeminiInteractionsStep } from '../gemini-interactions-wire.js';
import type { StreamEvent, Transport } from '../../engine/transport.js';
import { GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE, isSeveredStream } from '../../engine/severed-recognizer.js';
import { GEMINI_SEVERANCE_SPEC } from '../gemini-transport.js';
import { EMPTY_RECOVERY_NUDGE, EMPTY_RECOVERY_SEAT, withEmptyRecoverySeat } from '../../engine/empty-recovery.js';

const TOOL_ROUND: GeminiInteractionsEvent[] = [
  { event_type: 'interaction.created', interaction: { id: 'v1_int', status: 'in_progress' } },
  { event_type: 'step.start', index: 0, step: { type: 'thought' } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'I should read the file' } } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-A' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Let me ' } },
  { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'look.' } },
  { event_type: 'step.stop', index: 1 },
  { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'fc_1', name: 'Read', arguments: {} } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"file_path":' } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: ' "/a.txt"' } },
  { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '}' } },
  { event_type: 'step.stop', index: 2 },
  {
    event_type: 'interaction.completed',
    interaction: {
      id: 'v1_int', status: 'requires_action',
      usage: { total_input_tokens: 11, total_cached_tokens: 0, total_output_tokens: 90, total_thought_tokens: 245, total_tokens: 346 },
    },
  },
];

/** TOOL_ROUND's steps as the provider sent them — the wire shape, deltas folded in. */
const TOOL_ROUND_STEPS = [
  { type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'I should read the file' }] },
  { type: 'model_output', content: [{ type: 'text', text: 'Let me look.' }] },
  { type: 'function_call', id: 'fc_1', name: 'Read', arguments: { file_path: '/a.txt' } },
];

/** The replay a drained round's `done` event carried. */
function doneReplay(events: StreamEvent[]) {
  const done = events.find((e) => e.kind === 'done');
  return done?.kind === 'done' ? done.replay : undefined;
}

async function* scripted(events: GeminiInteractionsEvent[]): AsyncIterable<GeminiInteractionsEvent> {
  for (const e of events) yield e;
}

/** A transport whose factory records the body it was handed and replays `events`. */
function recording(events: GeminiInteractionsEvent[]) {
  const bodies: GeminiInteractionsRequest[] = [];
  const t = new GeminiInteractionsTransport({
    streamFactory: (body) => { bodies.push(body); return scripted(events); },
  });
  return { t, bodies };
}

/** A signed-thought tool round parameterised by signature + call id (one per history). */
function signedRound(signature: string, callId: string, text: string): GeminiInteractionsEvent[] {
  return [
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: `about ${callId}` } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'function_call', id: callId, name: 'Read', arguments: { p: callId } } },
    { event_type: 'step.stop', index: 2 },
    { event_type: 'interaction.completed', interaction: { id: 'i', status: 'requires_action', usage: { total_input_tokens: 1, total_output_tokens: 1 } } },
  ];
}

/** One transport instance serving several rounds — the script is chosen by model id,
 *  so the assertions do not depend on the order the streams are drained in. */
function byModel(scripts: Record<string, GeminiInteractionsEvent[]>) {
  return new GeminiInteractionsTransport({ streamFactory: (body) => scripted(scripts[body.model]!) });
}

const BASE = { system: 'you are a helper', tools: [], history: [] as GeminiInteractionsStep[], maxTokens: 4096 };

async function drain(t: GeminiInteractionsTransport, stream: unknown): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of t.readStream(stream)) out.push(e);
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GeminiInteractionsTransport — identity + tools', () => {
  it('identifies as the gemini_interactions dialect on the google provider', () => {
    const t = new GeminiInteractionsTransport();
    expect(t.api).toBe('gemini_interactions');
    expect(t.provider).toBe('google');
    expect(t.defaultModel()).toBe('gemini-3.8-flash');
  });

  it('buildTools emits the FLAT function shape with a sanitized schema (no additionalProperties / $schema)', () => {
    const tools = new GeminiInteractionsTransport().buildTools([
      // A Zod schema — what production passes. toToolJsonSchema emits $schema +
      // additionalProperties from it, so the strip assertions below pin real work.
      { name: 'Read', description: 'read', parameters: z.object({ file_path: z.string() }), execute: async () => '' } as never,
    ]) as Array<{ type: string; name: string; description?: string; parameters: Record<string, unknown> }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].name).toBe('Read');
    expect((tools[0].parameters.properties as Record<string, unknown>).file_path).toBeDefined();
    const json = JSON.stringify(tools[0].parameters);
    expect(json).not.toContain('additionalProperties');
    expect(json).not.toContain('$schema');
  });
});

describe('GeminiInteractionsTransport — the request body', () => {
  it('is stateless + streaming, carries system_instruction, tools, and max_output_tokens', async () => {
    const { t, bodies } = recording(TOOL_ROUND);
    const tools = t.buildTools([{ name: 'Read', description: 'r', parameters: {}, execute: async () => '' } as never]);
    await drain(t, t.callModel({ ...BASE, model: 'nonesuch-model-9', tools, history: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }] }));
    expect(bodies).toHaveLength(1);
    const b = bodies[0];
    expect(b.model).toBe('nonesuch-model-9');
    expect(b.store).toBe(false);
    expect(b.stream).toBe(true);
    expect(b.system_instruction).toBe('you are a helper');
    expect(b.tools).toHaveLength(1);
    expect(b.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }]);
    expect(b.generation_config).toEqual({ max_output_tokens: 4096 }); // non-reasoning id → no thinking fields
    expect(b).not.toHaveProperty('previous_interaction_id');
  });

  it('a reasoning row (gemini-3.8-flash) carries thinking_level + summaries in generation_config', async () => {
    const { t, bodies } = recording(TOOL_ROUND);
    await drain(t, t.callModel({ ...BASE, model: 'gemini-3.8-flash' }));
    expect(bodies[0].generation_config).toEqual({ max_output_tokens: 4096, thinking_level: 'medium', thinking_summaries: 'auto' });
  });

  it('omits system_instruction when empty and tools when none', async () => {
    const { t, bodies } = recording(TOOL_ROUND);
    await drain(t, t.callModel({ ...BASE, model: 'm', system: '' }));
    expect(bodies[0]).not.toHaveProperty('system_instruction');
    expect(bodies[0]).not.toHaveProperty('tools');
  });

  it('maps outputFormat to response_format (JSON schema constrained decoding)', async () => {
    const { t, bodies } = recording(TOOL_ROUND);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    await drain(t, t.callModel({ ...BASE, model: 'm', outputFormat: { schema } as never }));
    expect(bodies[0].response_format).toEqual({ type: 'text', mime_type: 'application/json', schema });
  });

  it('IGNORES the four cache fields — the body is byte-identical with or without them', async () => {
    const a = recording(TOOL_ROUND);
    await drain(a.t, a.t.callModel({ ...BASE, model: 'm' }));
    const b = recording(TOOL_ROUND);
    await drain(b.t, b.t.callModel({
      ...BASE, model: 'm', cacheKey: 'session-1', noCacheWrite: true, systemFleetPrefixChars: 3,
      cachePrefixHint: { kind: 'compaction_summary' } as never,
    }));
    expect(JSON.stringify(b.bodies[0])).toBe(JSON.stringify(a.bodies[0]));
  });
});

describe('GeminiInteractionsTransport — the stream', () => {
  it('yields thinking_start, thinking, text live; then tool_use (provider id, parsed args); then exactly one done', async () => {
    const { t } = recording(TOOL_ROUND);
    const events = await drain(t, t.callModel({ ...BASE, model: 'm' }));
    expect(events.map((e) => e.kind)).toEqual(['thinking_start', 'thinking', 'text', 'text', 'tool_use', 'done']);
    expect(events[4]).toEqual({ kind: 'tool_use', toolUse: { id: 'fc_1', name: 'Read', input: { file_path: '/a.txt' } } });
    // The done event carries the round's turn exactly as the provider sent it.
    expect(events[5]).toEqual({
      kind: 'done', stopReason: null,
      usage: { inputTokens: 11, outputTokens: 335, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 245 },
      replay: { dialect: 'gemini_interactions', steps: TOOL_ROUND_STEPS },
    });
  });

  it('exposes the turn verbatim via capturedGeminiSteps() AFTER the stream, and clears it on the next call', async () => {
    const { t } = recording(TOOL_ROUND);
    expect(t.capturedGeminiSteps()).toBeUndefined();
    await drain(t, t.callModel({ ...BASE, model: 'm' }));
    expect(t.capturedGeminiSteps()).toEqual(TOOL_ROUND_STEPS);
    t.callModel({ ...BASE, model: 'm' });
    expect(t.capturedGeminiSteps()).toBeUndefined();
  });

  it('a stream with no terminal event throws the registered severance sentinel', async () => {
    const { t } = recording([{ event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } }]);
    await expect(drain(t, t.callModel({ ...BASE, model: 'm' }))).rejects.toThrow(GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE);
  });
});

describe('GeminiInteractionsTransport — in-memory history', () => {
  it('pushUser / pushToolResult / pushAssistant produce floored steps; the tool result pairs by call_id with the call name', () => {
    const t = new GeminiInteractionsTransport();
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    t.pushUser(h, 'hello', [{ type: 'image', data: 'QQ', mediaType: 'image/png' } as never]);
    t.pushAssistant(h, [
      { type: 'text', text: 'reading' },
      { type: 'tool_use', toolUseId: 'fc_9', toolName: 'Read', toolInput: { p: '/a' } } as never,
    ]);
    t.pushToolResult(h, { toolUseId: 'fc_9', text: '', isError: false });
    expect(h).toEqual([
      { type: 'user_input', content: [{ type: 'image', data: 'QQ', mime_type: 'image/png' }, { type: 'text', text: 'hello' }] },
      // No captured channel on this push (a capture miss, or a foreign turn): the
      // sentinel opens the TURN so the live loop never sends the bare 400 shape.
      { type: 'thought', signature: GEMINI_SENTINEL_THOUGHT_SIGNATURE },
      { type: 'model_output', content: [{ type: 'text', text: 'reading' }] },
      { type: 'function_call', id: 'fc_9', name: 'Read', arguments: { p: '/a' } },
      { type: 'function_result', call_id: 'fc_9', name: 'Read', result: [{ type: 'text', text: '(no output)' }] },
    ]);
  });

  it('pushAssistant sends the done event\'s turn back VERBATIM', async () => {
    const { t } = recording(TOOL_ROUND);
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    const events = await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
    t.pushAssistant(h, [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', toolUseId: 'fc_1', toolName: 'Read', toolInput: { file_path: '/a.txt' } } as never,
    ], doneReplay(events));
    expect(h).toEqual(TOOL_ROUND_STEPS);
  });

  it('two rounds on ONE instance never cross: each push carries its own round\'s replay', async () => {
    // agent-tool.ts hands a child on the parent's model the PARENT's transport object,
    // so parallel Gemini children share this instance. Interleave them: call A, call B,
    // read A, read B, push A, push B.
    const t = byModel({
      'model-a': signedRound('sig-A', 'fc_a', 'A speaks'),
      'model-b': signedRound('sig-B', 'fc_b', 'B speaks'),
    });
    const hA = t.emptyHistory() as GeminiInteractionsStep[];
    const hB = t.emptyHistory() as GeminiInteractionsStep[];
    const sA = t.callModel({ ...BASE, model: 'model-a', history: hA });
    const sB = t.callModel({ ...BASE, model: 'model-b', history: hB });
    const eA = await drain(t, sA);
    const eB = await drain(t, sB);
    t.pushAssistant(hA, [
      { type: 'text', text: 'A speaks' },
      { type: 'tool_use', toolUseId: 'fc_a', toolName: 'Read', toolInput: { p: 'fc_a' } } as never,
    ], doneReplay(eA));
    t.pushAssistant(hB, [
      { type: 'text', text: 'B speaks' },
      { type: 'tool_use', toolUseId: 'fc_b', toolName: 'Read', toolInput: { p: 'fc_b' } } as never,
    ], doneReplay(eB));
    expect(hA[0]).toEqual({ type: 'thought', signature: 'sig-A', summary: [{ type: 'text', text: 'about fc_a' }] });
    expect(hB[0]).toEqual({ type: 'thought', signature: 'sig-B', summary: [{ type: 'text', text: 'about fc_b' }] });
    expect(JSON.stringify(hA)).not.toContain('sig-B');
    expect(JSON.stringify(hB)).not.toContain('sig-A');
  });

  it('the empty-recovery seat keeps its TEXT: a bare thought never replaces it', async () => {
    // A thinking-on empty round leaves a channel of [thought(sig)] and nothing else.
    // The seat push carries zero tool blocks, so an id-only match was vacuously true
    // and the seat text was silently swapped for the previous round's bare thought —
    // leaving the recovery re-call ending in `…, thought, user_input(nudge)`.
    const { t } = recording([
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-empty' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 0 } } },
    ]);
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    t.pushUser(h, 'do the thing');
    await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
    expect(t.capturedGeminiSteps()).toEqual([{ type: 'thought', signature: 'sig-empty' }]);
    // The REAL production seam (round-stream.ts → buildRoundRequest), which overlays
    // the seat + nudge onto a COPY of the history.
    const overlaid = withEmptyRecoverySeat(t, h) as GeminiInteractionsStep[];
    expect(overlaid.slice(1)).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: EMPTY_RECOVERY_SEAT }] },
      { type: 'user_input', content: [{ type: 'text', text: EMPTY_RECOVERY_NUDGE }] },
    ]);
    expect(JSON.stringify(overlaid)).not.toContain('sig-empty');
  });

  it('historyFromJournal is the journal projection (empty in → empty out)', () => {
    expect(new GeminiInteractionsTransport().historyFromJournal([])).toEqual([]);
  });
});

describe('GeminiInteractionsTransport — money + errors', () => {
  it('cost is additive on the EXCLUSIVE convention: 1M uncached + 1M cached + 1M out on 3.8 Flash = $4.575', () => {
    const t = new GeminiInteractionsTransport();
    expect(t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }, 'gemini-3.8-flash')).toBeCloseTo(4.575, 6);
    const summary = t.buildModelUsage({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 }, 'gemini-3.8-flash');
    expect(summary['gemini-3.8-flash']).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, webSearchRequests: 0 });
    expect(summary['gemini-3.8-flash'].costUSD).toBeGreaterThan(0);
  });

  it('classifies a 429 RESOURCE_EXHAUSTED body as rate_limited and an in-stream GATEWAY_TIMEOUT as model_unavailable', () => {
    const t = new GeminiInteractionsTransport();
    const http = Object.assign(new Error('Gemini Interactions 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}'), { status: 429, code: 'RESOURCE_EXHAUSTED' });
    expect(t.classifyError(http).kind).toBe('rate_limited');
    const inStream = Object.assign(new Error('Deadline expired'), { code: 'GATEWAY_TIMEOUT' });
    expect(t.classifyError(inStream).kind).toBe('model_unavailable');
  });

  it('classifyTermination delegates to the shared classifier (refusal / max_tokens / completed)', () => {
    const t = new GeminiInteractionsTransport();
    const base = { costUsd: 0.01, numTurns: 1, durationMs: 10, modelUsage: {}, summaryText: 'done' };
    expect(t.classifyTermination({ ...base, stopReason: 'refusal' }).kind).toBe('refused');
    expect(t.classifyTermination({ ...base, stopReason: null }).kind).toBe('completed');
  });
});

describe('GeminiInteractionsTransport — the wire (stubbed fetch)', () => {
  const SSE = [
    'data: {"event_type":"interaction.created","interaction":{"id":"i","status":"in_progress"}}',
    '',
    'data: {"event_type":"step.start","index":0,"step":{"type":"model_output","content":[]}}',
    'data: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"pong"}}',
    'data: {"torn json',
    'data: {"event_type":"step.stop","index":0}',
    'data: {"event_type":"interaction.completed","interaction":{"id":"i","status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":1}}}',
    'data: [DONE]',
    '',
  ].join('\n');

  function stubFetch(status = 200, body: string = SSE) {
    const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('POSTs {base}/v1beta/interactions with a bearer to the credential proxy when GEMINI_AUTH_TOKEN is set', async () => {
    vi.stubEnv('GEMINI_BASE_URL', 'https://lane.test/api/proxy/google');
    vi.stubEnv('GEMINI_AUTH_TOKEN', 'sandbox-token');
    vi.stubEnv('GEMINI_API_KEY', 'never-used-when-a-token-is-set');
    const fetchMock = stubFetch();
    const t = new GeminiInteractionsTransport();
    const events = await drain(t, t.callModel({ ...BASE, model: 'm' }));
    expect(events.map((e) => e.kind)).toEqual(['text', 'done']); // torn frame skipped, [DONE] ignored
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://lane.test/api/proxy/google/v1beta/interactions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sandbox-token');
    expect(headers['x-goog-api-key']).toBeUndefined();
    expect(headers.accept).toBe('text/event-stream');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm', store: false, stream: true });
  });

  it('sends x-goog-api-key to Google direct when only GEMINI_API_KEY is set (local dev / the smoke)', async () => {
    // ONLY: a pulled staging token or base URL in the developer's shell would otherwise
    // route this to the proxy and redden the test. Both readers are truthiness checks
    // (geminiAuthHeaders, and streamSSE's `GEMINI_BASE_URL || DEFAULT`), so '' is unset.
    vi.stubEnv('GEMINI_AUTH_TOKEN', '');
    vi.stubEnv('GEMINI_BASE_URL', '');
    vi.stubEnv('GEMINI_API_KEY', 'AIza-real');
    const fetchMock = stubFetch();
    const t = new GeminiInteractionsTransport();
    await drain(t, t.callModel({ ...BASE, model: 'm' }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-real');
    expect(headers.authorization).toBeUndefined();
  });

  it('a non-2xx response throws with status + the lifted canonical code (classifiable)', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'k');
    stubFetch(429, '{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}');
    const t = new GeminiInteractionsTransport();
    let thrown: unknown;
    try { await drain(t, t.callModel({ ...BASE, model: 'm' })); } catch (e) { thrown = e; }
    expect((thrown as { status?: number }).status).toBe(429);
    expect((thrown as { code?: string }).code).toBe('RESOURCE_EXHAUSTED');
    expect(t.classifyError(thrown).kind).toBe('rate_limited');
  });

  // L5 (#3332 site e, SILENT_DEATHS_V1) on the LIVE Gemini lane: a torn SSE frame is a stream
  // error for THIS round, never a frame to skip. Here the torn frame is a second function call,
  // so a skip runs the round with that call silently gone. Driven through the REAL fetch path
  // with a body that tears one frame and then finishes cleanly.
  describe('a torn SSE frame', () => {
    const TORN = [
      'data: {"event_type":"interaction.created","interaction":{"id":"i","status":"in_progress"}}',
      'data: {"event_type":"step.start","index":0,"step":{"type":"function_call","id":"fc_1","name":"Read","arguments":{}}}',
      'data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\\"file_path\\": \\"/a.txt\\"}"}}',
      'data: {"event_type":"step.stop","index":0}',
      'data: {"event_type":"step.start","index":1,"step":{"type":"function_call","id":"fc_2","name":"Bash","argum', // torn mid-object
      'data: {"event_type":"interaction.completed","interaction":{"id":"i","status":"requires_action","usage":{"total_input_tokens":3,"total_output_tokens":1}}}',
      '',
    ].join('\n');

    it('flag on: throws the severance sentinel before any tool_use (the rail re-issues the round), with the torn bytes attached', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'k');
      vi.stubEnv('SILENT_DEATHS_V1', 'true');
      stubFetch(200, TORN);
      const t = new GeminiInteractionsTransport();
      const seen: StreamEvent[] = [];
      let caught: unknown;
      try {
        for await (const e of t.readStream(t.callModel({ ...BASE, model: 'm' }))) seen.push(e);
      } catch (err) { caught = err; }
      // Mutation: skip the frame → the clean terminal event closes the round, Read runs, nothing throws.
      expect(caught).toMatchObject({ message: GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE, tornFrame: expect.stringContaining('function_call') });
      expect(seen.filter((e) => e.kind === 'tool_use')).toEqual([]);
      // The shared recognizer classifies it as a severance (so the round is re-issued, not failed).
      expect(isSeveredStream(caught, GEMINI_SEVERANCE_SPEC)).toBe(true);
    });

    it('flag off: the frame is skipped and the round completes with the second call gone, exactly as today', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'k');
      vi.stubEnv('SILENT_DEATHS_V1', '');
      stubFetch(200, TORN);
      const t = new GeminiInteractionsTransport();
      const events = await drain(t, t.callModel({ ...BASE, model: 'm' }));
      const calls = events.flatMap((e) => (e.kind === 'tool_use' ? [e.toolUse.name] : []));
      expect(calls).toEqual(['Read']);
      expect(events.at(-1)?.kind).toBe('done');
    });
  });

  it('geminiAuthHeaders: token beats key; neither → no auth header (the proxy will 401, never a wrong-lane key)', () => {
    expect(geminiAuthHeaders({ GEMINI_AUTH_TOKEN: 't', GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toEqual({ authorization: 'Bearer t' });
    expect(geminiAuthHeaders({ GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toEqual({ 'x-goog-api-key': 'k' });
    expect(geminiAuthHeaders({} as NodeJS.ProcessEnv)).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO_UNDERSTANDING_V1 §7 — media on the live push, and the uri entering the
// wire at request build (never the journal, never the in-memory history).
// ─────────────────────────────────────────────────────────────────────────────
describe('GeminiInteractionsTransport — native media', () => {
  const MEDIA = {
    type: 'media' as const, kind: 'video' as const, filename: 'clip.mp4', path: 'files/clip.mp4',
    mediaType: 'video/mp4', sizeBytes: 0, contentSha: 'sha-live',
  };

  it('pushUser(h, text, images, media) → the user_input carries the media item; without media the step is byte-identical to today', () => {
    const t = new GeminiInteractionsTransport();
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    t.pushUser(h, 'watch this', [{ type: 'image', data: 'QQ', mediaType: 'image/png' } as never], [MEDIA as never]);
    expect(h).toEqual([
      { type: 'user_input', content: [
        { type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: { path: 'files/clip.mp4', sha: 'sha-live', mimeType: 'video/mp4', sizeBytes: 0, displayName: 'clip.mp4' } },
        { type: 'image', data: 'QQ', mime_type: 'image/png' },
        { type: 'text', text: 'watch this' },
      ] },
    ]);

    // The no-media call is untouched: same steps as before this feature existed.
    const bare = new GeminiInteractionsTransport();
    const hb = bare.emptyHistory() as GeminiInteractionsStep[];
    bare.pushUser(hb, 'watch this', [{ type: 'image', data: 'QQ', mediaType: 'image/png' } as never]);
    expect(hb).toEqual([
      { type: 'user_input', content: [{ type: 'image', data: 'QQ', mime_type: 'image/png' }, { type: 'text', text: 'watch this' }] },
    ]);
    // …and passing an EMPTY media list is the same thing.
    const hz = bare.emptyHistory() as GeminiInteractionsStep[];
    bare.pushUser(hz, 'watch this', [{ type: 'image', data: 'QQ', mediaType: 'image/png' } as never], []);
    expect(hz).toEqual(hb);
  });

  it('the uri enters at request build: the body the wire sees carries files/<id>, the history still carries the marker', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'gemini-tx-ws-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'gemini-tx-cache-'));
    try {
      await mkdir(join(workspaceDir, 'files'), { recursive: true });
      await writeFile(join(workspaceDir, 'files', 'clip.mp4'), 'bytes');
      // A seeded cache entry resolves with ZERO network — the wiring, not the client.
      await writeFile(join(cacheDir, 'sha-live.json'), JSON.stringify({
        name: 'files/xyz', uri: 'https://g/v1beta/files/xyz', mimeType: 'video/mp4',
        expiresAt: '2099-01-01T00:00:00.000Z', sizeBytes: 5,
      }));

      const bodies: GeminiInteractionsRequest[] = [];
      const t = new GeminiInteractionsTransport({
        streamFactory: (body) => { bodies.push(body); return scripted(TOOL_ROUND); },
        mediaDeps: {
          workspaceDir,
          files: { baseUrl: 'https://proxy.test/g', headers: () => ({}), cacheDir, fetch: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
        },
      });
      const h = t.emptyHistory() as GeminiInteractionsStep[];
      t.pushUser(h, 'watch this', undefined, [MEDIA as never]);
      await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));

      const sent = bodies[0].input[0] as { content: unknown[] };
      expect(sent.content).toEqual([
        { type: 'video', mime_type: 'video/mp4', uri: 'https://g/v1beta/files/xyz' },
        { type: 'text', text: 'watch this' },
      ]);
      // The history the journal is built from is UNTOUCHED: no uri, marker intact.
      expect(JSON.stringify(h)).not.toContain('files/xyz');
      expect(JSON.stringify(h)).toContain('vestraMediaRef');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('no mediaDeps (flag off / legacy construction) → the wire carries the placeholder, never a uri:"" item or the marker', async () => {
    const bodies: GeminiInteractionsRequest[] = [];
    const t = new GeminiInteractionsTransport({ streamFactory: (body) => { bodies.push(body); return scripted(TOOL_ROUND); } });
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    t.pushUser(h, 'watch this', undefined, [MEDIA as never]);
    await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
    const sent = bodies[0].input[0] as { content: unknown[] };
    expect(sent.content).toEqual([
      { type: 'text', text: '[video unavailable: clip.mp4 — native media input is off; it is at files/clip.mp4]' },
      { type: 'text', text: 'watch this' },
    ]);
    expect(JSON.stringify(bodies[0])).not.toContain('vestraMediaRef');
  });

  it('a history with NO media block is byte-identical on the wire whether mediaDeps are present or not', async () => {
    const run = async (mediaDeps?: GeminiInteractionsTransportOptions['mediaDeps']) => {
      const bodies: GeminiInteractionsRequest[] = [];
      const t = new GeminiInteractionsTransport({
        streamFactory: (body) => { bodies.push(body); return scripted(TOOL_ROUND); },
        ...(mediaDeps ? { mediaDeps } : {}),
      });
      const h = t.emptyHistory() as GeminiInteractionsStep[];
      t.pushUser(h, 'hello', [{ type: 'image', data: 'QQ', mediaType: 'image/png' } as never]);
      await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
      return bodies[0];
    };
    const withDeps = await run({
      workspaceDir: '/nope',
      files: { baseUrl: 'https://proxy.test/g', headers: () => ({}), cacheDir: '/nope', fetch: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
    });
    expect(JSON.stringify(withDeps)).toBe(JSON.stringify(await run()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The media keep-alive. The stall guard races the FIRST it.next() of readStream
// against a 180s idle bound, and a media turn's whole request build — sha256,
// chunked upload, up to 120s of ACTIVE polling — sits inside that first next().
// A working upload must therefore be audible, not silent.
// ─────────────────────────────────────────────────────────────────────────────

/** A round with NO thought step, so every thinking event in the output is the keep-alive's. */
const TEXT_ROUND: GeminiInteractionsEvent[] = [
  { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
  { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'ok' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'interaction.completed', interaction: { id: 'i', status: 'completed', usage: { total_input_tokens: 1, total_output_tokens: 1 } } },
];

describe('GeminiInteractionsTransport — the media keep-alive', () => {
  const MEDIA_BLOCK = {
    type: 'media' as const, kind: 'video' as const, filename: 'clip.mp4', path: 'files/clip.mp4',
    mediaType: 'video/mp4', sizeBytes: 0, contentSha: 'sha-slow',
  };

  /** A workspace with one real clip and a Files upstream gated on `open`. */
  async function slowLane(open: Promise<void>) {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'gemini-slow-ws-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'gemini-slow-cache-'));
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await writeFile(join(workspaceDir, 'files', 'clip.mp4'), 'bytes');
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        await open; // the upload session does not open until the test says so
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=S' } });
      }
      return new Response(
        JSON.stringify({ file: { name: 'files/s', uri: 'https://g/v1beta/files/s', mimeType: 'video/mp4', state: 'ACTIVE', expirationTime: '2099-01-01T00:00:00.000Z' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const mediaDeps = {
      workspaceDir,
      files: { baseUrl: 'https://proxy.test/g', headers: () => ({}), cacheDir, fetch: fetchImpl, openChunk: async (_p: string, a: number, b: number) => new Uint8Array(b - a) },
    };
    return { mediaDeps, cleanup: async () => { await rm(workspaceDir, { recursive: true, force: true }); await rm(cacheDir, { recursive: true, force: true }); } };
  }

  it('a 45s upload yields thinking_start once and a delta every 20s, all BEFORE the first interaction event', async () => {
    let release!: () => void;
    const open = new Promise<void>((r) => { release = r; });
    const lane = await slowLane(open);
    try {
      // Fake time advances only through the injected sleep; the upload's session
      // opens once 45s of it has passed.
      let elapsedMs = 0;
      const t = new GeminiInteractionsTransport({
        streamFactory: () => scripted(TEXT_ROUND),
        mediaDeps: lane.mediaDeps,
        mediaKeepAliveMs: 20_000,
        sleep: async (ms) => {
          elapsedMs += ms;
          if (elapsedMs >= 45_000) release();
          await new Promise((r) => setTimeout(r, 1));
        },
      });
      const h = t.emptyHistory() as GeminiInteractionsStep[];
      t.pushUser(h, 'watch this', undefined, [MEDIA_BLOCK]);
      const events = await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));

      const starts = events.filter((e) => e.kind === 'thinking_start');
      const deltas = events.filter((e): e is Extract<StreamEvent, { kind: 'thinking' }> => e.kind === 'thinking');
      expect(starts).toHaveLength(1);
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      for (const d of deltas) expect(d.text).toBe('Preparing clip.mp4 for the video model');
      // Every keep-alive event precedes the first event the interaction produced.
      const firstStreamEvent = events.findIndex((e) => e.kind === 'text');
      const lastKeepAlive = events.map((e) => e.kind).lastIndexOf('thinking');
      expect(firstStreamEvent).toBeGreaterThan(lastKeepAlive);
    } finally {
      await lane.cleanup();
    }
  });

  it('no media marker ⇒ ZERO extra events: the stream is byte-identical to today', async () => {
    const t = new GeminiInteractionsTransport({
      streamFactory: () => scripted(TEXT_ROUND),
      mediaKeepAliveMs: 1,
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)); },
    });
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    t.pushUser(h, 'no media here');
    const events = await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
    expect(events.some((e) => e.kind === 'thinking_start' || e.kind === 'thinking')).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['text', 'done']);
  });

  it('a resolution that settles inside the first tick says nothing at all', async () => {
    const lane = await slowLane(Promise.resolve());
    try {
      const t = new GeminiInteractionsTransport({
        streamFactory: () => scripted(TEXT_ROUND),
        mediaDeps: lane.mediaDeps,
        mediaKeepAliveMs: 5_000,
        sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2_000))); },
      });
      const h = t.emptyHistory() as GeminiInteractionsStep[];
      t.pushUser(h, 'watch this', undefined, [MEDIA_BLOCK]);
      const events = await drain(t, t.callModel({ ...BASE, model: 'm', history: h }));
      expect(events.map((e) => e.kind)).toEqual(['text', 'done']);
    } finally {
      await lane.cleanup();
    }
  }, 10_000);

  // The point of the whole mechanism, on the real guard rather than on a claim.
  it('under withStallGuard: a slow UPLOAD does not stall the stream, while a slow first EVENT still does', async () => {
    const lane = await slowLane(new Promise<void>((r) => { const x = setTimeout(r, 400); x.unref?.(); }));
    try {
      const withMedia = new GeminiInteractionsTransport({
        streamFactory: () => scripted(TEXT_ROUND),
        mediaDeps: lane.mediaDeps,
        mediaKeepAliveMs: 40,
      });
      const h = withMedia.emptyHistory() as GeminiInteractionsStep[];
      withMedia.pushUser(h, 'watch this', undefined, [MEDIA_BLOCK]);
      const guarded: StreamEvent[] = [];
      for await (const e of withStallGuard(withMedia.readStream(withMedia.callModel({ ...BASE, model: 'm', history: h })), { stallMs: 150 })) {
        guarded.push(e);
      }
      expect(guarded.some((e) => e.kind === 'text')).toBe(true);

      // The SAME 150ms bound, the same 400ms wait, but nothing to say about it.
      const silent = new GeminiInteractionsTransport({
        streamFactory: async function* () {
          await new Promise((r) => { const x = setTimeout(r, 400); x.unref?.(); });
          yield* scripted(TEXT_ROUND);
        },
      });
      const hs = silent.emptyHistory() as GeminiInteractionsStep[];
      silent.pushUser(hs, 'no media here');
      await expect(
        (async () => {
          for await (const _e of withStallGuard(silent.readStream(silent.callModel({ ...BASE, model: 'm', history: hs })), { stallMs: 150 })) {
            /* drain */
          }
        })(),
      ).rejects.toBeInstanceOf(StreamStalledError);
    } finally {
      await lane.cleanup();
    }
  }, 10_000);
});

describe('GeminiInteractionsTransport — watchOptions ride pushUser without a cast', () => {
  it('a MediaBlockForWire carrying watchOptions maps to resolution + processing', () => {
    const t = new GeminiInteractionsTransport();
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    // Typed as MediaBlockForWire, NOT `as never`: this is the type-level assertion.
    const block: MediaBlockForWire = {
      type: 'media', kind: 'video', filename: 'clip.mp4', path: 'files/clip.mp4',
      mediaType: 'video/mp4', sizeBytes: 0,
      watchOptions: { resolution: 'low', startSec: 12, endSec: 40 },
    };
    t.pushUser(h, '', undefined, [block]);
    expect((h[0] as { content: unknown[] }).content[0]).toMatchObject({
      type: 'video', mime_type: 'video/mp4', uri: '',
      resolution: 'low',
      processing: { start_offset: '12s', end_offset: '40s' },
    });
  });

  // M8 — the path PR 3 actually takes. The `watch` tool holds a Transport, not the
  // concrete class, so the options have to survive the INTERFACE's own signature.
  it('the options survive a call made through a Transport-typed reference', () => {
    const t: Transport = new GeminiInteractionsTransport();
    const h = t.emptyHistory() as GeminiInteractionsStep[];
    const block: MediaBlockForWire = {
      type: 'media', kind: 'audio', filename: 'note.mp3', path: 'files/note.mp3',
      mediaType: 'audio/mpeg', sizeBytes: 0,
      watchOptions: { resolution: 'high', startSec: 3 },
    };
    t.pushUser(h, 'listen', undefined, [block]);
    expect((h[0] as { content: unknown[] }).content[0]).toMatchObject({
      type: 'audio', mime_type: 'audio/mpeg', uri: '',
      resolution: 'high',
      processing: { start_offset: '3s' },
    });
  });
});
