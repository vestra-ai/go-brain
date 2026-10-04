/**
 * COMPACTION_V2 — `noCacheWrite`, the transport half.
 *
 * THE DEFECT: `callModel` places a rolling `cache_control` on the LAST message of
 * every non-empty history, unconditionally. The compaction summarize hands it the
 * ENTIRE span the compaction is about to delete, so every compaction paid the 1.25x
 * write premium on a ~200k prefix that can never be read again — and, worse, that
 * write competes with the LIVE task prefix for cache residency, so compaction has
 * been sabotaging the very cache it exists to protect.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT (see the comment at the seam in
 * anthropic-transport.ts, added by #2603): `applyToolDeferral` and
 * `withToolsTailBreakpoint` answer different questions and MUST stay separable.
 * A "skip caching" branch wrapped around both would quietly UN-DEFER the catalog —
 * putting every deferred schema back into the context of the very call trying to
 * stay small, with no error and no failing test. The last describe block below is
 * that regression, pinned with TOOL_DEFER_V1 ON.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';

afterEach(() => {
  delete process.env.TOOL_DEFER_V1;
});

function makeMockClient() {
  const calls: Array<{ body: any }> = [];
  const stream = vi.fn((body: any) => {
    calls.push({ body });
    return {
      async *[Symbol.asyncIterator]() {},
      async finalMessage() {
        return { stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } } as unknown;
      },
    } as any;
  });
  return { client: { messages: { stream } } as any, calls };
}

/** A long-ish multi-turn history — the shape a summarize call actually sends. */
function span() {
  return [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'summarize the conversation above now' },
  ];
}

function baseParams() {
  return {
    model: 'claude-sonnet-5',
    system: 'COMPACTION SYSTEM PROMPT',
    tools: [] as unknown[],
    history: span() as unknown,
    maxTokens: 4096,
  };
}

/** Every cache_control marker anywhere in a request body. */
function cacheControls(body: any): unknown[] {
  const found: unknown[] = [];
  const walk = (v: any): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.cache_control !== undefined) found.push(v.cache_control);
    Object.values(v).forEach(walk);
  };
  walk(body);
  return found;
}

describe('noCacheWrite — the transport honors it', () => {
  it('places NO cache_control anywhere when set', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({ ...baseParams(), noCacheWrite: true } as any);

    expect(cacheControls(calls[0].body)).toEqual([]);
  });

  it('WITHOUT it, the same call caches — proving the assertion above is not vacuous', () => {
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({ ...baseParams() } as any);

    const controls = cacheControls(calls[0].body);
    expect(controls.length).toBeGreaterThan(0);
    // Specifically the two writes the summarize was paying for: the system tail and
    // the rolling breakpoint on the LAST message (which caches the whole span).
    expect(calls[0].body.system[0].cache_control).toBeDefined();
    const messages = calls[0].body.messages;
    expect(cacheControls(messages[messages.length - 1]).length).toBeGreaterThan(0);
  });

  it('ships the SAME bytes — only the markers differ', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });
    t.callModel({ ...baseParams() } as any);
    t.callModel({ ...baseParams(), noCacheWrite: true } as any);

    const [cached, uncached] = calls.map((c) => c.body);
    expect(uncached.system.map((b: any) => b.text).join('')).toBe(
      cached.system.map((b: any) => b.text).join(''),
    );
    expect(uncached.messages).toHaveLength(cached.messages.length);
    expect(uncached.model).toBe(cached.model);
    expect(uncached.max_tokens).toBe(cached.max_tokens);
  });

  it('suppresses the tools-tail write too, when the call carries tools', () => {
    const { client, calls } = makeMockClient();
    const tools = [
      { name: 'A', description: 'a', input_schema: { type: 'object' } },
      { name: 'B', description: 'b', input_schema: { type: 'object' } },
    ];
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(), tools, noCacheWrite: true,
    } as any);

    expect(cacheControls(calls[0].body.tools)).toEqual([]);
    expect(calls[0].body.tools).toHaveLength(2); // the tools themselves still ship
  });

  it('absent ⇒ byte-identical to a call that never heard of the field', () => {
    const { client, calls } = makeMockClient();
    const t = new AnthropicMessagesTransport({ client });
    t.callModel({ ...baseParams() } as any);
    t.callModel({ ...baseParams(), noCacheWrite: false } as any);
    t.callModel({ ...baseParams(), noCacheWrite: undefined } as any);

    expect(JSON.stringify(calls[1].body)).toBe(JSON.stringify(calls[0].body));
    expect(JSON.stringify(calls[2].body)).toBe(JSON.stringify(calls[0].body));
  });
});

describe('noCacheWrite NEVER un-defers the catalog (the #2603 invariant)', () => {
  /**
   * `applyToolDeferral` keys off `defer_loading`, which `buildTools` stamps — so a
   * direct callModel test must supply it already stamped. One tool stays RESIDENT
   * on purpose: deferring the whole catalog is a 400, and the function undefers
   * everything in that case, which would make the assertions below vacuous.
   */
  const deferredCatalog = () => [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    ...Array.from({ length: 5 }, (_, i) => ({
      name: `browser_action_${i}`,
      description: 'a browser tool',
      input_schema: { type: 'object' },
      defer_loading: true,
    })),
  ];

  const deferredCount = (body: any): number =>
    (body.tools as any[]).filter((t) => t.defer_loading === true).length;
  const hasSearchTool = (body: any): boolean =>
    (body.tools as any[]).some((t) => typeof t.type === 'string' && t.type.startsWith('tool_search_tool'));

  it('deferral still applies under noCacheWrite — residency is not a caching decision', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const { client, calls } = makeMockClient();
    // Baseline: deferral active, caching on.
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(), tools: deferredCatalog(),
    } as any);
    // Same call, caching suppressed.
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(), tools: deferredCatalog(), noCacheWrite: true,
    } as any);

    // NOT vacuous: deferral demonstrably did something on the baseline call.
    expect(deferredCount(calls[0].body)).toBe(5);
    expect(hasSearchTool(calls[0].body)).toBe(true);

    // ...and it does the identical thing with caching suppressed. If this ever reads
    // 0 on the right while the left reads 5, the guard has swallowed
    // applyToolDeferral and the whole browser ring is back in the summarizer's
    // context — silently, with no error.
    expect(deferredCount(calls[1].body)).toBe(5);
    expect(hasSearchTool(calls[1].body)).toBe(true);
    expect(calls[1].body.tools).toHaveLength(calls[0].body.tools.length);
  });

  it('and it still writes NO cache_control while deferral is active', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const { client, calls } = makeMockClient();
    new AnthropicMessagesTransport({ client }).callModel({
      ...baseParams(), tools: deferredCatalog(), noCacheWrite: true,
    } as any);

    expect(deferredCount(calls[0].body)).toBe(5); // deferral ran
    expect(cacheControls(calls[0].body)).toEqual([]); // and nothing cached
  });
});
