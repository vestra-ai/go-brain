/**
 * TOOL_DEFER_V1 — the Anthropic lane's deferred tool-loading contract.
 *
 * Tools render first in Anthropic's prompt, so every schema sits in the cached
 * prefix of every turn whether or not the model calls it. Deferral registers a
 * schema without making it resident: `defer_loading: true` withholds it from the
 * context prefix until the model finds it through the tool-search tool, at which
 * point the API expands a `tool_reference` and the tool becomes callable.
 *
 * Three axes, per the flag-gated-change rule: OFF byte-identical; ON = the browser
 * ring deferred on a capable model; ON-base = everything that is not the browser
 * ring stays exactly where it was.
 *
 * TWO OF THESE TESTS GUARD HARD 400s that are invisible until production, because
 * the request only fails once the flag is actually on against the real API:
 *   - "At least one tool must have defer_loading=false" (the all-deferred fallback)
 *   - a tool may not carry BOTH `defer_loading` and `cache_control` (the anchor)
 *
 * The third failure mode is quieter and has no API error at all: deferring on a
 * model whose API does not implement tool search. That is why eligibility is
 * asserted against a REAL ineligible seed row rather than a fixture.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { applyToolDeferral, withToolsTailBreakpoint, TOOL_SEARCH_TOOL } from '../anthropic-tool-defer.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { GeminiTransport } from '../gemini-transport.js';
import { OpenAIResponsesTransport } from '../openai-responses-transport.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

const noop = (): string => '';

/** Mock client capturing the body handed to messages.stream (byte-identical idiom). */
function makeMockClient() {
  const calls: Array<{ body: any }> = [];
  const stream = vi.fn((body: any) => {
    calls.push({ body });
    return {
      async *[Symbol.asyncIterator]() { /* no events */ },
      async finalMessage() {
        return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as unknown;
      },
    } as any;
  });
  return { client: { messages: { stream } } as any, calls };
}

const raw = (name: string, deferrable = false): RawToolOptions => ({
  name,
  description: `desc for ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: noop,
  ...(deferrable ? { deferrable: true } : {}),
});

/** A catalog shaped like the real one: residents around a deferrable browser ring. */
const CATALOG = (): RawToolOptions[] => [
  raw('Read'),
  raw('Bash'),
  raw('mcp__browser-control__computer_screenshot', true),
  raw('mcp__browser-control__computer_click', true),
  raw('mcp__composio__gmail_send'),
];

/**
 * End-to-end: RawToolOptions → buildTools → callModel, returning the tools array
 * exactly as the request serializer would see it.
 */
function wireTools(tools: RawToolOptions[], model = 'claude-opus-4-8'): any[] {
  const { client, calls } = makeMockClient();
  const t = new AnthropicMessagesTransport({ client });
  const built = t.buildTools(tools);
  t.callModel({
    model,
    system: 'SYSTEM',
    tools: built,
    history: [{ role: 'user', content: 'hi' }] as unknown,
    maxTokens: 8192,
  } as any);
  return calls[0].body.tools;
}

const names = (tools: any[]): string[] => tools.map((t) => t.name);
const deferred = (tools: any[]): string[] => tools.filter((t) => t.defer_loading === true).map((t) => t.name);
const withCache = (tools: any[]): string[] => tools.filter((t) => t.cache_control !== undefined).map((t) => t.name);

afterEach(() => { delete process.env.TOOL_DEFER_V1; });

describe('TOOL_DEFER_V1 — OFF axis (byte-identical)', () => {
  it('emits NO defer_loading key at all — not even `false`', () => {
    const tools = wireTools(CATALOG());
    // A `defer_loading: false` would be semantically identical and byte-different
    // on every tool of every request, which is exactly what OFF must not do.
    expect(tools.every((t) => !('defer_loading' in t))).toBe(true);
  });

  it('appends no tool-search tool — the catalog is the catalog', () => {
    expect(names(wireTools(CATALOG()))).toEqual([
      'Read', 'Bash',
      'mcp__browser-control__computer_screenshot',
      'mcp__browser-control__computer_click',
      'mcp__composio__gmail_send',
    ]);
  });

  it('the tools-tail cache breakpoint stays on the LAST tool', () => {
    expect(withCache(wireTools(CATALOG()))).toEqual(['mcp__composio__gmail_send']);
  });

  it('a deferrable-marked catalog is byte-identical to an unmarked one', () => {
    // `deferrable` is inert with the flag off — the marker must not leak to the wire.
    const marked = JSON.stringify(wireTools(CATALOG()));
    const unmarked = JSON.stringify(wireTools(CATALOG().map(({ deferrable: _d, ...t }) => t as RawToolOptions)));
    expect(marked).toBe(unmarked);
  });
});

describe('TOOL_DEFER_V1 — ON axis (feature)', () => {
  it('defers exactly the deferrable ring and prepends the tool-search tool', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG());
    expect(tools[0]).toMatchObject({ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' });
    expect(deferred(tools)).toEqual([
      'mcp__browser-control__computer_screenshot',
      'mcp__browser-control__computer_click',
    ]);
  });

  it('400-GUARD: the cache breakpoint never lands on a deferred tool', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG());
    // Anthropic rejects a tool carrying both defer_loading and cache_control.
    expect(tools.filter((t) => t.defer_loading === true && t.cache_control !== undefined)).toEqual([]);
    // …and it still lands somewhere, or the tools segment stops caching entirely.
    expect(withCache(tools)).toEqual(['mcp__composio__gmail_send']);
  });

  it('the search tool is itself never deferred (deferring it is the documented 400)', () => {
    process.env.TOOL_DEFER_V1 = '1';
    expect(wireTools(CATALOG())[0].defer_loading).toBeUndefined();
    expect(TOOL_SEARCH_TOOL).not.toHaveProperty('defer_loading');
  });

  it('ADDITIVE-ONLY: deferral never drops a tool — the mechanism has no removal', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const before = names(wireTools(CATALOG()).filter((t) => t.name !== 'tool_search_tool_regex'));
    delete process.env.TOOL_DEFER_V1;
    // Every tool present OFF is still present ON, in the same relative order.
    expect(before).toEqual(names(wireTools(CATALOG())));
  });
});

describe('TOOL_DEFER_V1 — ON axis, ineligible model (computed eligibility)', () => {
  // claude-mythos-preview carries no supportsToolSearch: it is absent from
  // Anthropic's published table and nobody has probed it. Deliberately NOT
  // claude-sonnet-5 any more — that one was probed capable on 2026-08-12 and now
  // seeds ON, so using it here would assert the opposite of production.
  const INELIGIBLE = 'claude-mythos-preview';

  it('a model without supportsToolSearch gets the deferral STRIPPED, not a 400', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG(), INELIGIBLE);
    expect(tools.every((t) => !('defer_loading' in t))).toBe(true);
    expect(names(tools)).not.toContain('tool_search_tool_regex');
  });

  it('an ineligible model ON is byte-identical to the same model OFF', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const on = JSON.stringify(wireTools(CATALOG(), INELIGIBLE));
    delete process.env.TOOL_DEFER_V1;
    expect(on).toBe(JSON.stringify(wireTools(CATALOG(), INELIGIBLE)));
  });

  it('an unknown model id fails CLOSED (no seed row ⇒ no deferral)', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG(), 'some-model-we-never-heard-of');
    expect(tools.every((t) => !('defer_loading' in t))).toBe(true);
  });
});

describe('TOOL_DEFER_V1 — claude-sonnet-5 is eligible (live-probed 2026-08-12)', () => {
  // The default model, and therefore the id that decides whether this feature does
  // anything at all in production. It shipped seeded OFF while the published
  // compatibility table omitted it; a direct probe returned 200 / end_turn with
  // defer_loading + tool_search_tool_regex_20251119, so the omission was doc lag.
  it('defers the ring and prepends the search tool, like any capable model', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG(), 'claude-sonnet-5');
    expect(tools[0]).toMatchObject({ type: 'tool_search_tool_regex_20251119' });
    expect(deferred(tools)).toEqual([
      'mcp__browser-control__computer_screenshot',
      'mcp__browser-control__computer_click',
    ]);
  });

  it('still writes the cache breakpoint to a NON-deferred tool (the 400-guard holds here too)', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const tools = wireTools(CATALOG(), 'claude-sonnet-5');
    expect(tools.filter((t) => t.defer_loading === true && t.cache_control !== undefined)).toEqual([]);
    expect(withCache(tools)).toEqual(['mcp__composio__gmail_send']);
  });

  it('is untouched with the flag OFF — eligibility alone defers nothing', () => {
    // Eligibility is necessary, not sufficient. With the flag off this model must
    // still serialize byte-identically to before the seed changed.
    const tools = wireTools(CATALOG(), 'claude-sonnet-5');
    expect(tools.every((t) => !('defer_loading' in t))).toBe(true);
    expect(names(tools)).not.toContain('tool_search_tool_regex');
  });
});

describe('TOOL_DEFER_V1 — ON base behavior (non-ring surface unchanged)', () => {
  it('resident tools keep their exact name/description/input_schema', () => {
    process.env.TOOL_DEFER_V1 = '1';
    const on = wireTools(CATALOG()).find((t) => t.name === 'Read');
    delete process.env.TOOL_DEFER_V1;
    const off = wireTools(CATALOG()).find((t) => t.name === 'Read');
    expect(on).toEqual(off);
  });

  it('a catalog with nothing deferrable is untouched by the flag', () => {
    const plain = (): RawToolOptions[] => [raw('Read'), raw('Bash')];
    process.env.TOOL_DEFER_V1 = '1';
    const on = JSON.stringify(wireTools(plain()));
    delete process.env.TOOL_DEFER_V1;
    expect(on).toBe(JSON.stringify(wireTools(plain())));
  });
});

describe('applyToolDeferral — the all-deferred fallback (400-GUARD)', () => {
  const defTool = (name: string): Anthropic.ToolUnion =>
    ({ name, description: 'd', input_schema: { type: 'object' }, defer_loading: true }) as any;

  it('sends every tool NORMALLY when the immediate set would be empty', () => {
    // "At least one tool must have defer_loading=false. All tools cannot be
    // deferred." Falling back beats failing the turn — and a model with nothing
    // resident could not act anyway.
    const out = applyToolDeferral([defTool('a'), defTool('b')], 'claude-opus-4-8');
    expect(out.every((t) => !('defer_loading' in t))).toBe(true);
    expect(out.map((t: any) => t.name)).toEqual(['a', 'b']);
  });

  it('keeps the deferral when at least one tool stays resident', () => {
    const resident = { name: 'r', description: 'd', input_schema: { type: 'object' } } as any;
    const out = applyToolDeferral([defTool('a'), resident], 'claude-opus-4-8');
    expect(out[0]).toBe(TOOL_SEARCH_TOOL);
    expect(out.filter((t: any) => t.defer_loading === true).map((t: any) => t.name)).toEqual(['a']);
  });

  it('returns the input array by reference when nothing is deferred (OFF fast path)', () => {
    const input = [{ name: 'r', description: 'd', input_schema: { type: 'object' } }] as any;
    expect(applyToolDeferral(input, 'claude-opus-4-8')).toBe(input);
  });
});

describe('other lanes — deferral has no protocol analogue, so nothing may change', () => {
  // GLM / Kimi / DeepSeek (chat-completions), Gemini and OpenAI-Responses have no
  // defer_loading concept. `deferrable` is an Anthropic-lane hint that must not
  // leak into any of their tool payloads, flag on or off.
  const lanes: Array<[string, () => { buildTools(r: RawToolOptions[]): unknown }]> = [
    ['chat-completions', () => new ChatCompletionsTransport()],
    ['gemini', () => new GeminiTransport()],
    ['openai-responses', () => new OpenAIResponsesTransport()],
  ];

  for (const [lane, make] of lanes) {
    it(`${lane}: flag ON is byte-identical to flag OFF`, () => {
      delete process.env.TOOL_DEFER_V1;
      const off = JSON.stringify(make().buildTools(CATALOG()));
      process.env.TOOL_DEFER_V1 = '1';
      expect(JSON.stringify(make().buildTools(CATALOG()))).toBe(off);
    });

    it(`${lane}: never emits defer_loading`, () => {
      process.env.TOOL_DEFER_V1 = '1';
      expect(JSON.stringify(make().buildTools(CATALOG()))).not.toContain('defer_loading');
    });
  }
});

describe('withToolsTailBreakpoint — anchor selection', () => {
  const t = (name: string, defer = false): Anthropic.ToolUnion =>
    ({ name, description: 'd', input_schema: { type: 'object' }, ...(defer ? { defer_loading: true } : {}) }) as any;
  const EPHEMERAL = { type: 'ephemeral' } as Anthropic.CacheControlEphemeral;

  it('anchors on the last tool when none are deferred (previous behavior)', () => {
    const out = withToolsTailBreakpoint([t('a'), t('b')], EPHEMERAL);
    expect(withCache(out as any[])).toEqual(['b']);
  });

  it('skips BACKWARD past a deferred tail to the last carrier-eligible tool', () => {
    const out = withToolsTailBreakpoint([t('a'), t('b'), t('x', true), t('y', true)], EPHEMERAL);
    expect(withCache(out as any[])).toEqual(['b']);
  });

  it('does not mutate the caller\'s array or objects', () => {
    const input = [t('a'), t('b')];
    const out = withToolsTailBreakpoint(input, EPHEMERAL);
    expect(out).not.toBe(input);
    expect((input[1] as any).cache_control).toBeUndefined();
  });
});
