/**
 * NativeConfig.onWireTools (speed gap 1) — the prologue hands the product the tools
 * array the run's first request carries, once, so the [CACHE_TIER] fingerprint is of the
 * real wire and costs no second schema conversion. Pinned on both rails: the array is
 * the one `wireTools()` returns (by reference off the client rail), the model rides
 * along, and a throwing observer never costs the run its tools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { HarnessContext } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { attachToolSearch } from '../tool-search-session.js';
import type { ProviderTool } from '../transport.js';

const tool = (name: string, marks: Partial<RawToolOptions> = {}): RawToolOptions => ({
  name,
  description: `${name} does one thing.`,
  parameters: z.object({ target: z.string() }),
  execute: async () => 'ok',
  ...marks,
});
const catalog = (): RawToolOptions[] => [tool('Bash'), tool('Read'), tool('mcp__browser-control__computer_click', { deferrable: true })];

const ctx = (model: string, onWireTools?: NativeConfigLike['onWireTools']): HarnessContext<NativeConfigLike> =>
  ({ taskId: 't', sessionId: 's', cwd: '/tmp', model, signal: new AbortController().signal, config: { onWireTools } }) as never;

const FLAGS = ['TOOL_SEARCH_V1', 'TOOL_DEFER_V1', 'TOOL_DEFER_WIDE_V1'] as const;
const saved = new Map(FLAGS.map((f) => [f, process.env[f]]));
afterEach(() => {
  for (const [f, v] of saved) {
    if (v === undefined) delete process.env[f];
    else process.env[f] = v;
  }
});

describe('attachToolSearch — the wire observer', () => {
  it('server rail (Anthropic): called once, with the very array wireTools() returns, and the model', async () => {
    process.env.TOOL_DEFER_V1 = 'true';
    const seen: Array<[readonly ProviderTool[], string]> = [];
    const s = await attachToolSearch(
      ctx('claude-sonnet-5-5', (wire, model) => seen.push([wire, model])),
      catalog(), undefined, new AnthropicMessagesTransport(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(s.wireTools());
    expect(seen[0]![1]).toBe('claude-sonnet-5-5');
  });

  it('client rail: called once with the first request\'s shaped array (deferred schemas withheld)', async () => {
    process.env.TOOL_SEARCH_V1 = 'true';
    const seen: Array<readonly ProviderTool[]> = [];
    const s = await attachToolSearch(ctx('gpt-6-1-sol', (wire) => seen.push(wire)), catalog(), undefined, new OpenAIResponsesTransport());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(s.wireTools());
    expect(JSON.stringify(seen[0])).not.toContain('computer_click');
  });

  it('absent observer: nothing to call, the session is unchanged', async () => {
    const s = await attachToolSearch(ctx('claude-sonnet-5-5'), catalog(), undefined, new AnthropicMessagesTransport());
    expect(s.wireTools()).toHaveLength(3);
  });

  it('a throwing observer is contained: the run still gets its tools', async () => {
    const boom = vi.fn(() => { throw new Error('observer bug'); });
    const s = await attachToolSearch(ctx('claude-sonnet-5-5', boom), catalog(), undefined, new AnthropicMessagesTransport());
    expect(boom).toHaveBeenCalledTimes(1);
    expect(s.tools.map((t) => t.name)).toEqual(['Bash', 'Read', 'mcp__browser-control__computer_click']);
  });
});
