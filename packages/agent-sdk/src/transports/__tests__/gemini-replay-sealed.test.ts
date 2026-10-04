import { describe, it, expect } from 'vitest';
import { GeminiTransport } from '../gemini-transport.js';
import { journalToGeminiContents, type GeminiStreamChunk } from '../gemini-messages.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { ProviderReplay, StreamEvent } from '../../engine/transport.js';
import { stripOrphanedGeminiToolParts, type GeminiContent } from '../../engine/request-validity.js';

/** Google's documented skip-validator value, pinned literally (probed 200 on 2026-09-23). */
const SENTINEL = 'skip_thought_signature_validator';

/**
 * The generateContent lane's model turn is SEALED: captured verbatim from the
 * stream on every round and sent back byte-for-byte. The shape below is the one
 * Gemini 3 streamed for a parallel tool round (probed 2026-09-23): the FIRST call
 * carries the thoughtSignature, the second carries none, both carry a provider
 * `id`, and the turn ends with an empty text part. Rebuilding it from our blocks
 * (no signature field) 400s: "Function call is missing a thought_signature".
 */
const PARALLEL_ROUND: GeminiStreamChunk[] = [
  { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }, thoughtSignature: 'SIG_1' }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_time', args: { city: 'Tokyo' }, id: 'call_2' } }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 66, candidatesTokenCount: 32, thoughtsTokenCount: 64 },
  },
];
const SEALED_PARTS = [
  { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }, thoughtSignature: 'SIG_1' },
  { functionCall: { name: 'get_time', args: { city: 'Tokyo' }, id: 'call_2' } },
  { text: '' },
];

async function* scripted(chunks: GeminiStreamChunk[]): AsyncIterable<GeminiStreamChunk> {
  for (const c of chunks) yield c;
}

/** A transport that records every request body and answers each call with the next script. */
function recording(...rounds: GeminiStreamChunk[][]) {
  const bodies: Array<{ contents: GeminiContent[] }> = [];
  let i = 0;
  const t = new GeminiTransport({
    streamFactory: (_model, body) => {
      bodies.push(body as { contents: GeminiContent[] });
      return scripted(rounds[i++] ?? [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]);
    },
  });
  return { t, bodies };
}

async function drain(t: GeminiTransport, stream: unknown): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of t.readStream(stream)) out.push(e);
  return out;
}

function toolUses(events: StreamEvent[]) {
  return events.flatMap((e) => (e.kind === 'tool_use' ? [e.toolUse] : []));
}

function doneReplay(events: StreamEvent[]): ProviderReplay | undefined {
  const d = events.find((e) => e.kind === 'done');
  return d?.kind === 'done' ? d.replay : undefined;
}

/** What the engine hands pushAssistant for a tool round (text + tool_use blocks). */
function blocksOf(events: StreamEvent[]) {
  return toolUses(events).map((tu) => ({ type: 'tool_use', toolUseId: tu.id, toolName: tu.name, toolInput: tu.input }) as never);
}

const MODEL = 'gemini-3.8-flash';
const call = (t: GeminiTransport, history: unknown) => t.callModel({ model: MODEL, system: '', tools: [], history, maxTokens: 100 });

let seq = 0;
function entry(payload: JournalEntry['payload']): JournalEntry {
  seq += 1;
  return {
    uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
    agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '2026-09-23T00:00:00.000Z', payload,
  };
}

describe('GeminiTransport — the model turn is sealed (finding 1)', () => {
  it('the done event carries every streamed part verbatim, with callIds aligned to the functionCall parts', async () => {
    const { t } = recording(PARALLEL_ROUND);
    const events = await drain(t, call(t, t.emptyHistory()));
    const ids = toolUses(events).map((tu) => tu.id);
    expect(doneReplay(events)).toEqual({ dialect: 'gemini', content: { parts: SEALED_PARTS, callIds: ids } });
  });

  it('the in-memory push (subagent / no-journal path) sends the turn back as streamed — the next request keeps the signature', async () => {
    const { t, bodies } = recording(PARALLEL_ROUND);
    const h = t.emptyHistory();
    t.pushUser(h, 'weather in Paris, time in Tokyo');
    const events = await drain(t, call(t, h));
    t.pushAssistant(h, blocksOf(events), doneReplay(events));
    for (const tu of toolUses(events)) t.pushToolResult(h, { toolUseId: tu.id, text: `${tu.name} ok`, isError: false });
    await drain(t, call(t, h));
    // The body the SECOND request put on the wire (after the media/marker pass).
    const model = bodies[1].contents.find((c) => c.role === 'model')!;
    expect(model.parts).toEqual(SEALED_PARTS);
  });

  it('with no replay (a foreign or legacy round) the blocks fallback pushes the calls, the first carrying the sentinel', () => {
    const t = new GeminiTransport();
    const h = t.emptyHistory() as GeminiContent[];
    t.pushAssistant(h, [
      { type: 'tool_use', toolUseId: 'x', toolName: 'Read', toolInput: { p: 1 } } as never,
      { type: 'tool_use', toolUseId: 'y', toolName: 'Read', toolInput: { p: 2 } } as never,
    ]);
    expect(h).toEqual([{ role: 'model', parts: [
      { functionCall: { name: 'Read', args: { p: 1 } }, thoughtSignature: SENTINEL },
      { functionCall: { name: 'Read', args: { p: 2 } } },
    ] }]);
  });
});

describe('GeminiTransport — results pair to their call BY ID (finding 3)', () => {
  it('parallel results each carry their OWN call\'s name and provider id', async () => {
    const { t } = recording(PARALLEL_ROUND);
    const h = t.emptyHistory() as GeminiContent[];
    const events = await drain(t, call(t, h));
    t.pushAssistant(h, blocksOf(events), doneReplay(events));
    const [a, b] = toolUses(events);
    t.pushToolResult(h, { toolUseId: a.id, text: 'sunny', isError: false });
    t.pushToolResult(h, { toolUseId: b.id, text: '9pm', isError: false });
    expect(h.slice(1).flatMap((c) => c.parts)).toEqual([
      { functionResponse: { name: 'get_weather', response: { output: 'sunny' }, id: 'call_1' } },
      { functionResponse: { name: 'get_time', response: { output: '9pm' }, id: 'call_2' } },
    ]);
  });

  it('on the blocks path too: the FIRST result is not labeled with the LAST call\'s name', () => {
    const t = new GeminiTransport();
    const h = t.emptyHistory() as GeminiContent[];
    t.pushAssistant(h, [
      { type: 'tool_use', toolUseId: 'id-a', toolName: 'search', toolInput: {} } as never,
      { type: 'tool_use', toolUseId: 'id-b', toolName: 'fetch', toolInput: {} } as never,
    ]);
    t.pushToolResult(h, { toolUseId: 'id-a', text: 'A', isError: false });
    t.pushToolResult(h, { toolUseId: 'id-b', text: 'B', isError: false });
    expect(h.slice(1).flatMap((c) => c.parts).map((p) => p.functionResponse?.name)).toEqual(['search', 'fetch']);
  });
});

describe('journalToGeminiContents — the sealed channel (finding 1, journal side)', () => {
  const journal = (callIds: string[], withSecond = true): JournalEntry[] => [
    entry({ type: 'user', blocks: [{ type: 'text', text: 'go' }] }),
    entry({ type: 'assistant', blocks: [], api: 'gemini', provider: 'google', geminiContent: { parts: SEALED_PARTS, callIds } }),
    entry({ type: 'tool_use', toolUseId: callIds[0], name: 'get_weather', input: { city: 'Paris' }, thoughtSignature: 'SIG_1' }),
    ...(withSecond ? [entry({ type: 'tool_use', toolUseId: callIds[1], name: 'get_time', input: { city: 'Tokyo' } })] : []),
    entry({ type: 'tool_result', toolUseId: callIds[0], blocks: [{ type: 'text', text: 'sunny' }] }),
    ...(withSecond ? [entry({ type: 'tool_result', toolUseId: callIds[1], blocks: [{ type: 'text', text: '9pm' }] })] : []),
  ];

  it('replays the turn byte-for-byte (the empty text part too) and never double-folds its tool_use entries', () => {
    const contents = journalToGeminiContents(journal(['g-1', 'g-2']));
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: SEALED_PARTS },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { output: 'sunny' }, id: 'call_1' } },
          { functionResponse: { name: 'get_time', response: { output: '9pm' }, id: 'call_2' } },
        ],
      },
    ]);
  });

  it('a channel from another dialect is never trusted (cross-issuer guard)', () => {
    const entries = journal(['g-1', 'g-2']);
    (entries[1].payload as { api: string }).api = 'gemini_interactions';
    const model = journalToGeminiContents(entries).find((c) => c.role === 'model')!;
    expect(model.parts.some((p) => p.text === '')).toBe(false);
  });

  it('a pruned SIGNED call leaves alone, and its unsigned sibling takes the documented sentinel', () => {
    // g-2's tool_use/result survive; g-1 (the signed call) was pruned upstream.
    const entries = journal(['g-1', 'g-2']).filter(
      (e) => !((e.payload.type === 'tool_use' || e.payload.type === 'tool_result') && e.payload.toolUseId === 'g-1'),
    );
    const model = journalToGeminiContents(entries).find((c) => c.role === 'model')!;
    expect(model.parts.filter((p) => p.functionCall)).toEqual([
      { functionCall: { name: 'get_time', args: { city: 'Tokyo' }, id: 'call_2' }, thoughtSignature: SENTINEL },
    ]);
  });

  it('a pruned UNSIGNED call leaves alone and the real signature is untouched', () => {
    const model = journalToGeminiContents(journal(['g-1', 'g-2'], false)).find((c) => c.role === 'model')!;
    expect(model.parts.filter((p) => p.functionCall)).toEqual([SEALED_PARTS[0]]);
  });
});

describe('stripOrphanedGeminiToolParts — signature-aware (finding 2)', () => {
  it('stripping the ONE signed call of a parallel run gives the first surviving call the sentinel', () => {
    // The PR6 (no channel) shape: Gemini 3 signed only the first call. Only the
    // second was answered, so the first is an orphan and leaves.
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'go' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} }, thoughtSignature: 'SIG' },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'b', response: { output: 'ok' } } }] },
    ];
    expect(stripOrphanedGeminiToolParts(contents)[1].parts).toEqual([
      { functionCall: { name: 'b', args: {} }, thoughtSignature: SENTINEL },
    ]);
  });

  it('stripping an UNSIGNED call leaves the signed survivor exactly as it was', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} }, thoughtSignature: 'SIG' },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: { output: 'ok' } } }] },
    ];
    expect(stripOrphanedGeminiToolParts(contents)[0].parts).toEqual([
      { functionCall: { name: 'a', args: {} }, thoughtSignature: 'SIG' },
    ]);
  });
});
