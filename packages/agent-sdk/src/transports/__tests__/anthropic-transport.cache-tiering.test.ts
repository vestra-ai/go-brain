/**
 * anthropic-transport.cache-tiering — CACHE_TIERING_V1 fleet/session system split.
 *
 * `systemFleetPrefixChars` marks where the fleet-static prefix of the system
 * string ends. When in range AND the fleet slice clears the model's cacheable
 * floor, the SAME system bytes ship as TWO text blocks split at that boundary,
 * each carrying a cache_control breakpoint — the fleet block's bytes are
 * identical across every user/task of a deploy, so the org-scoped cache shares
 * it fleet-wide while the per-user/session remainder varies behind it.
 *
 * Contracts pinned here:
 *  (1) byte conservation — block texts CONCATENATE to exactly the input system;
 *  (2) budget rebalance — the split spends the message-side secondary slot
 *      (rolling only), keeping the total within `policy.breakpointBudget`;
 *  (3) absent/out-of-range/sub-floor hint — single block, byte-identical to the
 *      untiered request (the flag-off axis).
 */

import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';

function makeCapturingClient(): { client: Anthropic; captured: () => Anthropic.MessageCreateParams } {
  let last: Anthropic.MessageCreateParams | undefined;
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      /* request-shape only */
    },
    async finalMessage() {
      return { stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Message;
    },
  };
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        last = params;
        return fakeStream;
      },
    },
  } as unknown as Anthropic;
  return {
    client,
    captured: () => {
      if (!last) throw new Error('messages.stream was never called');
      return last;
    },
  };
}

const TEXT = (text: string): Anthropic.TextBlockParam => ({ type: 'text', text });

function hasBreakpoint(b: unknown): boolean {
  return typeof b === 'object' && b !== null && Boolean((b as { cache_control?: unknown }).cache_control);
}

function countBreakpoints(params: Anthropic.MessageCreateParams): number {
  let n = 0;
  for (const t of (params.tools ?? []) as unknown[]) if (hasBreakpoint(t)) n += 1;
  const system = params.system as unknown;
  if (Array.isArray(system)) for (const b of system as unknown[]) if (hasBreakpoint(b)) n += 1;
  for (const m of params.messages as Anthropic.MessageParam[]) {
    if (Array.isArray(m.content)) for (const b of m.content as unknown[]) if (hasBreakpoint(b)) n += 1;
  }
  return n;
}

function msgBpCount(params: Anthropic.MessageCreateParams): number {
  const msgs = params.messages as Anthropic.MessageParam[];
  return msgs.filter((m) => Array.isArray(m.content) && (m.content as unknown[]).some(hasBreakpoint)).length;
}

function systemBlocks(params: Anthropic.MessageCreateParams): Anthropic.TextBlockParam[] {
  return (params.system ?? []) as Anthropic.TextBlockParam[];
}

const callWith = (extra: Record<string, unknown> = {}, history?: Anthropic.MessageParam[]) => {
  const { client, captured } = makeCapturingClient();
  const transport = new AnthropicMessagesTransport({ client });
  transport.callModel({
    model: 'claude-sonnet-4-6',
    system: SYSTEM,
    tools: [],
    history: history ?? [{ role: 'user', content: [TEXT('hi')] }],
    maxTokens: 8192,
    ...extra,
  });
  return captured();
};

const POLICY = resolveCapabilities('claude-sonnet-4-6').cache; // floor 1024, budget 4

// A system whose fleet slice comfortably clears the 1024-token floor.
const FLEET = 'FLEET-STATIC '.repeat(500); // 6500 chars ≈ 1625 tokens
const SESSION = '\n\nSESSION-TAIL ' + 'user/session layers '.repeat(100);
const SYSTEM = FLEET + SESSION;

/** >lookback trailing run whose spans clear the floor (drives the secondary slot). */
function longHistory(): Anthropic.MessageParam[] {
  const big = 'x'.repeat(5000);
  const out: Anthropic.MessageParam[] = [{ role: 'user', content: [TEXT('opener')] }];
  for (let i = 0; i < 25; i++) {
    out.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: [TEXT(big)] });
  }
  return out;
}

describe('CACHE_TIERING_V1 — fleet/session system split', () => {
  it('splits the system into two blocks at the boundary, both breakpointed, bytes conserved', () => {
    expect(estimateTokens(FLEET)).toBeGreaterThan(POLICY.minCacheableTokens); // premise
    const params = callWith({ systemFleetPrefixChars: FLEET.length });
    const blocks = systemBlocks(params);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(FLEET);
    expect(blocks[1]!.text).toBe(SESSION);
    expect(blocks[0]!.text + blocks[1]!.text).toBe(SYSTEM); // (1) byte conservation
    expect(hasBreakpoint(blocks[0])).toBe(true);
    expect(hasBreakpoint(blocks[1])).toBe(true);
    expect(countBreakpoints(params)).toBeLessThanOrEqual(POLICY.breakpointBudget);
  });

  it('rebalances the budget: with tools present (the real arm shape), a tiered long-history call gets rolling ONLY; untiered keeps rolling + secondary', () => {
    // Tools present → prefix spends 3 of 4 when tiered (system×2 + tools tail).
    const TOOL = { name: 't', description: 'd', input_schema: { type: 'object' } };
    const tiered = callWith({ systemFleetPrefixChars: FLEET.length, tools: [TOOL] }, longHistory());
    const untiered = callWith({ tools: [TOOL] }, longHistory());
    expect(msgBpCount(untiered)).toBe(2); // rolling + intermediate — pre-tiering arithmetic
    expect(msgBpCount(tiered)).toBe(1); // (2) rolling only — the split spent the slot
    expect(countBreakpoints(tiered)).toBe(POLICY.breakpointBudget); // 2 system + 1 tools + 1 rolling = exactly 4
    expect(countBreakpoints(untiered)).toBeLessThanOrEqual(POLICY.breakpointBudget);
  });

  it('with NO tools, the freed slot keeps the secondary even when tiered (2 system + rolling + intermediate = 4)', () => {
    const tiered = callWith({ systemFleetPrefixChars: FLEET.length }, longHistory());
    expect(msgBpCount(tiered)).toBe(2); // budget allows it — nothing to sacrifice
    expect(countBreakpoints(tiered)).toBeLessThanOrEqual(POLICY.breakpointBudget);
  });

  it('absent hint → single system block: the untiered request is byte-identical to before', () => {
    const params = callWith({});
    const blocks = systemBlocks(params);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(SYSTEM);
    expect(hasBreakpoint(blocks[0])).toBe(true);
  });

  it('out-of-range boundaries degrade to the single block (0, ≥ length)', () => {
    for (const boundary of [0, SYSTEM.length, SYSTEM.length + 50]) {
      const params = callWith({ systemFleetPrefixChars: boundary });
      expect(systemBlocks(params)).toHaveLength(1);
      expect(systemBlocks(params)[0]!.text).toBe(SYSTEM);
    }
  });

  it('a sub-floor fleet slice is NOT worth a breakpoint → single block', () => {
    const boundary = 100; // ~25 tokens — far below the 1024 floor
    expect(estimateTokens(SYSTEM.slice(0, boundary))).toBeLessThan(POLICY.minCacheableTokens);
    const params = callWith({ systemFleetPrefixChars: boundary });
    expect(systemBlocks(params)).toHaveLength(1);
  });

  it('tiering composes with the compaction anchor rules without exceeding the budget', () => {
    // Tiered + tools + summary-leading hint: the prefix spends 3 of 4, so the
    // anchor must NOT be added on top of the rolling breakpoint.
    const TOOL = { name: 't', description: 'd', input_schema: { type: 'object' } };
    const summary = 'SUMMARY '.repeat(800);
    const history: Anthropic.MessageParam[] = [{ role: 'user', content: [TEXT(summary)] }];
    for (let i = 0; i < 25; i++) history.push({ role: 'assistant', content: [TEXT(`turn ${i}`)] });
    const params = callWith(
      { systemFleetPrefixChars: FLEET.length, cachePrefixHint: { summaryLeading: true }, tools: [TOOL] },
      history,
    );
    expect(msgBpCount(params)).toBe(1); // rolling only — no anchor slot left
    expect(countBreakpoints(params)).toBe(POLICY.breakpointBudget);
  });
});
