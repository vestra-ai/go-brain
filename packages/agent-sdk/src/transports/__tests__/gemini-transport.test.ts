import { describe, it, expect } from 'vitest';
import { GeminiTransport, resolveGeminiRate, GEMINI_SEVERANCE_SPEC } from '../gemini-transport.js';
import type { GeminiStreamChunk } from '../gemini-messages.js';
import type { StreamEvent } from '../../engine/transport.js';
import { resolveFamilyRate } from '../../engine/native-pricing.js';
import { GEMINI_SEVERED_STREAM_MESSAGE, isSeveredStream } from '../../engine/severed-recognizer.js';

async function* scripted(chunks: GeminiStreamChunk[]): AsyncIterable<GeminiStreamChunk> {
  for (const c of chunks) yield c;
}

describe('GeminiTransport', () => {
  it('identifies as the gemini wire dialect', () => {
    const t = new GeminiTransport();
    expect(t.api).toBe('gemini');
    expect(t.provider).toBe('google');
  });

  it('PR5 — buildTools produces functionDeclaration params with NO additionalProperties (Gemini 400s on it)', () => {
    const t = new GeminiTransport();
    const decls = t.buildTools([
      { name: 'Read', description: 'read', parameters: { file_path: { type: 'string' } }, execute: async () => '' } as never,
    ]) as Array<{ name: string; parameters: Record<string, unknown> }>;
    expect(decls).toHaveLength(1);
    const json = JSON.stringify(decls[0].parameters);
    expect(json).not.toContain('additionalProperties');
    expect(json).not.toContain('$schema');
    expect(decls[0].parameters.type).toBe('object');
  });

  it('readStream yields thinking, text, tool_use, then exactly one done', async () => {
    const t = new GeminiTransport({
      streamFactory: () =>
        scripted([
          { candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: 'Answer' }] } }] },
          {
            candidates: [{ content: { parts: [{ functionCall: { name: 'fn', args: {} } }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
          },
        ]),
    });
    const stream = t.callModel({ model: 'gemini-2.5-pro', system: 's', tools: [], history: [], maxTokens: 100 });
    const events: StreamEvent[] = [];
    for await (const e of t.readStream(stream)) events.push(e);

    expect(events.find((e) => e.kind === 'thinking')).toMatchObject({ text: 'reasoning' });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'Answer' });
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ toolUse: { name: 'fn' } });
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
  });

  it('throws a classifiable error on a stream with no terminal chunk', async () => {
    const t = new GeminiTransport({
      streamFactory: () => scripted([{ candidates: [{ content: { parts: [{ text: 'x' }] } }] }]),
    });
    const stream = t.callModel({ model: 'gemini-2.5-pro', system: '', tools: [], history: [], maxTokens: 50 });
    const run = async () => {
      for await (const _e of t.readStream(stream)) void _e;
    };
    await expect(run()).rejects.toThrow(/without a terminal chunk/);
  });

  // L5 (#3332 site e, SILENT_DEATHS_V1) — a torn SSE frame is a stream error for THIS round,
  // never a frame to skip: skipping can run a tool on args with a functionCall part missing.
  // Driven through the REAL fetch path (streamSSE) with a body that tears one frame and then
  // finishes cleanly, so a skipped frame would complete the round and show no throw.
  describe('a torn SSE frame', () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fn","args":{"a":\n', // torn mid-object
      'data: {"candidates":[{"content":{"parts":[{"text":"."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n',
    ];
    const withBody = async (run: () => Promise<void>): Promise<void> => {
      const realFetch = globalThis.fetch;
      const saved = process.env.SILENT_DEATHS_V1;
      const enc = new TextEncoder();
      globalThis.fetch = (async () =>
        new Response(new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } }), { status: 200 })) as unknown as typeof fetch;
      try { await run(); } finally {
        globalThis.fetch = realFetch;
        if (saved === undefined) delete process.env.SILENT_DEATHS_V1;
        else process.env.SILENT_DEATHS_V1 = saved;
      }
    };
    const drain = async (): Promise<StreamEvent[]> => {
      const t = new GeminiTransport();
      const stream = t.callModel({ model: 'gemini-2.5-pro', system: '', tools: [], history: [], maxTokens: 50 });
      const out: StreamEvent[] = [];
      for await (const e of t.readStream(stream)) out.push(e);
      return out;
    };

    it('flag on: throws the severance sentinel (the rail re-issues the round), with the torn bytes attached', async () => {
      await withBody(async () => {
        process.env.SILENT_DEATHS_V1 = 'true';
        let caught: unknown;
        try { await drain(); } catch (err) { caught = err; }
        // Mutation: skip the frame → the clean terminal chunk closes the round and nothing throws.
        expect(caught).toMatchObject({ message: GEMINI_SEVERED_STREAM_MESSAGE, tornFrame: expect.stringContaining('functionCall') });
        // The shared recognizer classifies it as a severance (so the round is re-issued, not failed).
        expect(isSeveredStream(caught, GEMINI_SEVERANCE_SPEC)).toBe(true);
      });
    });

    it('flag off: the frame is skipped and the round completes, exactly as today', async () => {
      await withBody(async () => {
        delete process.env.SILENT_DEATHS_V1;
        const out = await drain();
        expect(out.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('')).toBe('hi.');
      });
    });
  });

  it('computes cost from the per-model rate table', () => {
    const t = new GeminiTransport();
    // pro: $1.25/M in, $10/M out → 1M in + 1M out = 11.25
    expect(t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.5-pro')).toBeCloseTo(11.25);
    // flash is cheaper than pro
    const flash = t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gemini-2.5-flash');
    const pro = t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gemini-2.5-pro');
    expect(flash).toBeLessThan(pro);
  });

  it('BILL-04 + C5: cached prompt tokens bill at the discounted cache rate; the producer subtracts them (EXCLUSIVE convention)', async () => {
    // promptTokenCount INCLUDES cachedContentTokenCount on the wire: 1M input of which 900k cached.
    const t = new GeminiTransport({
      streamFactory: () =>
        scripted([
          {
            candidates: [{ content: { parts: [{ text: 'A' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1_000_000, cachedContentTokenCount: 900_000, candidatesTokenCount: 0 },
          },
        ]),
    });
    const stream = t.callModel({ model: 'gemini-2.5-pro', system: '', tools: [], history: [], maxTokens: 100 });
    let done: StreamEvent | undefined;
    for await (const e of t.readStream(stream)) if (e.kind === 'done') done = e;
    const usage = (done as Extract<StreamEvent, { kind: 'done' }>).usage;
    expect(usage.inputTokens).toBe(100_000);
    expect(usage.cacheReadInputTokens).toBe(900_000);
    const withCache = t.computeCostUsd(usage, 'gemini-2.5-pro');
    const noCache = t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gemini-2.5-pro');
    expect(withCache).toBeLessThan(noCache); // cache is genuinely discounted, not full input
    // uncached 100k @ $1.25/M + cached 900k @ $0.3125/M = 0.125 + 0.28125 = 0.40625
    expect(withCache).toBeCloseTo(0.40625, 6);
  });

  it('resolveGeminiRate resolves the REGISTRY id and each provisional family token to an explicit row (non-fallback, provenance)', () => {
    // The registry's only google row is 'gemini-3.8-flash' (it rides the
    // Interactions dialect but shares THIS rate card); 'pro' / 'flash' now serve
    // unseeded ids only, so they are exercised by an id of the family, not a row.
    for (const [id, match] of [
      ['gemini-3.8-flash', '3.8-flash'],
      ['gemini-2.5-pro', 'pro'],
      ['gemini-2.5-flash', 'flash'],
    ] as const) {
      const r = resolveGeminiRate(id);
      expect(r.isFallback, `${id} must NOT hit the conservative pro-tier fallback`).toBe(false);
      expect(r.matched).toBe(match);
      expect(r.price.inPerM).toBeGreaterThan(0);
      expect(r.price.cachedPerM).toBeGreaterThan(0);
      expect(r.price.outPerM).toBeGreaterThan(0);
      // Provisional is allowed; ABSENT provenance is not (audit BILL-04).
      expect(typeof r.price.verifiedAt).toBe('string');
      expect(r.price.sources.length).toBeGreaterThan(0);
    }
  });

  it('flash-lite is matched before flash (most-specific-first), not swallowed by the flash row', () => {
    const r = resolveGeminiRate('gemini-2.5-flash-lite');
    expect(r.isFallback).toBe(false);
    expect(r.matched).toBe('flash-lite');
    expect(r.price.inPerM).toBe(0.1);
  });

  it('an unknown gemini tier fails to the conservative pro stand-in (isFallback true, never $0)', () => {
    const r = resolveGeminiRate('gemini-9-brandnew');
    expect(r.isFallback).toBe(true);
    expect(r.matched).toBeNull();
    expect(r.price.inPerM).toBeGreaterThan(0);
  });

  it('REGRESSION: a gemini turn bills off GEMINI_RATES, never the Anthropic Sonnet DEFAULT ($3/$15)', () => {
    const t = new GeminiTransport();
    // gemini-2.5-pro input rate is $1.25/M — the transport's own rate card, NOT the
    // native-pricing Sonnet DEFAULT ($3/M) a google id would hit if cost derivation
    // ever routed through native-pricing.rateFor instead of transport.computeCostUsd.
    const geminiInUsd = t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gemini-2.5-pro');
    expect(geminiInUsd).toBeCloseTo(1.25, 6);
    const sonnetDefaultInUsd = resolveFamilyRate('some-future-anthropic-model').rate.in; // 3
    expect(geminiInUsd).not.toBeCloseTo(sonnetDefaultInUsd, 6);
    // flash is a distinct, cheaper explicit row (not the same fallback constant).
    const flashInUsd = t.computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gemini-2.5-flash');
    expect(flashInUsd).toBeCloseTo(0.3, 6);
    expect(flashInUsd).toBeLessThan(geminiInUsd);
  });

  it('BILL-10: thinking (thoughts) tokens are folded into output and billed (not dropped)', async () => {
    const t = new GeminiTransport({
      streamFactory: () =>
        scripted([
          {
            candidates: [{ content: { parts: [{ text: 'A' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
          },
        ]),
    });
    const stream = t.callModel({ model: 'gemini-2.5-pro', system: '', tools: [], history: [], maxTokens: 100 });
    let done: StreamEvent | undefined;
    for await (const e of t.readStream(stream)) if (e.kind === 'done') done = e;
    // output = candidates(100) + thoughts(50) = 150; the bug billed only 100 (thoughts at $0).
    expect((done as Extract<StreamEvent, { kind: 'done' }>).usage?.outputTokens).toBe(150);
  });
});
