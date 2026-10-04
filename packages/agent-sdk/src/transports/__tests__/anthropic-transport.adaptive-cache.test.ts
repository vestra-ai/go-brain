/**
 * anthropic-transport.adaptive-cache — K4C-3 adaptive (token-aware +
 * compaction-aware) cache_control breakpoint placement.
 *
 * K4C-2 made placement DATA-DRIVEN (lookback/intermediate from the registry
 * cache policy). K4C-3 makes it ADAPTIVE:
 *
 *  (D1) token-aware  — never spend the INTERMEDIATE slot on a span below the
 *       model's `minCacheableTokens` floor (Anthropic refuses to cache a
 *       sub-floor prefix → the breakpoint caches nothing readable, a wasted
 *       slot). The rolling breakpoint is STILL placed regardless (it's the
 *       incremental-growth anchor and costs nothing extra).
 *
 *  (D2) compaction-aware — when the engine hints the projected history leads
 *       with a compaction summary, anchor a breakpoint at the stable
 *       post-compaction prefix (the summary head) so it re-caches once and
 *       reuses, reusing the INTERMEDIATE slot to stay within the 4-breakpoint
 *       budget (anchor REPLACES the tail-intermediate — never both).
 *
 * These are REQUEST-SHAPE assertions (a captured mock client). Byte-identity for
 * the no-condition case is asserted by the K4C-2 cache.test suite + the cases
 * here that drive above-floor / no-hint histories.
 */

import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicMessagesTransport } from '../anthropic-transport.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';

/** A capturing mock Anthropic client — records the params handed to messages.stream. */
function makeCapturingClient(): { client: Anthropic; captured: () => Anthropic.MessageCreateParams } {
  let last: Anthropic.MessageCreateParams | undefined;
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      /* no events — request-shape only */
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

/** Indices of the messages that carry a cache_control breakpoint. */
function breakpointMsgIdxs(params: Anthropic.MessageCreateParams): number[] {
  const msgs = params.messages as Anthropic.MessageParam[];
  const out: number[] = [];
  msgs.forEach((m, i) => {
    if (Array.isArray(m.content) && (m.content as unknown[]).some(hasBreakpoint)) out.push(i);
  });
  return out;
}

/** Count message-region breakpoints (rolling + any intermediate/anchor). */
function msgBpCount(params: Anthropic.MessageCreateParams): number {
  return breakpointMsgIdxs(params).length;
}

const TEXT = (text: string): Anthropic.TextBlockParam => ({ type: 'text', text });

const callWith = (history: Anthropic.MessageParam[], extra: Record<string, unknown> = {}) => {
  const { client, captured } = makeCapturingClient();
  const transport = new AnthropicMessagesTransport({ client });
  transport.callModel({ model: 'claude-sonnet-4-6', system: 'SYS', tools: [], history, maxTokens: 8192, ...extra });
  return captured();
};

const POLICY = resolveCapabilities('claude-sonnet-4-6').cache; // floor 1024, lookback 20, intermediate 15

/**
 * A long trailing run of SINGLE-block messages, each carrying `perBlockText` so
 * we can drive the intermediate-cached span above or below the token floor while
 * keeping the BLOCK span fixed (>lookback). `blocks` blocks after a tiny opener.
 */
function longHistory(blocks: number, perBlockText: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [{ role: 'user', content: [TEXT('opener')] }];
  for (let i = 0; i < blocks; i++) {
    out.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: [TEXT(perBlockText)] });
  }
  return out;
}

describe('K4C-3 D1 — token-aware INTERMEDIATE placement', () => {
  it('a >lookback trailing run whose intermediate-cached span is ABOVE the floor still gets the intermediate (rolling + 1)', () => {
    // 25 single-text blocks (>20 lookback). Each block is large enough that the
    // span from the start to the intermediate point clears the 1024-token floor.
    const big = 'x'.repeat(5000); // ~1250 tokens per block by the char heuristic
    const params = callWith(longHistory(25, big));
    expect(msgBpCount(params)).toBe(2); // rolling + intermediate
    expect(countBreakpoints(params)).toBeLessThanOrEqual(POLICY.breakpointBudget);
  });

  it('a >lookback trailing run whose CUMULATIVE prefix (tools+system+messages) is BELOW the floor gets NO intermediate (rolling only)', () => {
    // The floor applies to the WHOLE cacheable prefix rendered before a breakpoint:
    // tools → system → messages[0..bp]. Drive a genuinely sub-CUMULATIVE prefix:
    // EMPTY system + NO tools (base ~0) + 25 tiny single-text blocks (>20 lookback by
    // COUNT, but ~50 tokens of messages) → cumulative far below 1024 → the
    // intermediate would cache nothing readable → skip it. Only the rolling remains.
    const params = callWith(longHistory(25, 'a'), { system: '', tools: [] });
    // Sanity: with an empty system + no tools, the cumulative prefix IS the message
    // span, which is genuinely sub-floor — so the skip exercises the corrected gate.
    expect(estimateTokens('opener' + ' a'.repeat(25))).toBeLessThan(POLICY.minCacheableTokens);
    expect(msgBpCount(params)).toBe(1); // rolling only — intermediate skipped
  });

  it('the floor is CUMULATIVE: the SAME sub-message history gets the intermediate once a LARGE system lifts the prefix over the floor', () => {
    // Identical tiny-message history as the SKIP case, but a large system prompt so
    // the cumulative prefix (system + messages) clears the floor. This proves the
    // gate counts the base prefix (tools+system), not the message span alone — the
    // exact regression the review caught. The real native arm always has a large
    // system+tools, so its intermediate is preserved.
    const bigSystem = 'INSTRUCTION STACK '.repeat(400); // ~1600 tokens — over the floor
    const params = callWith(longHistory(25, 'a'), { system: bigSystem, tools: [] });
    expect(estimateTokens(bigSystem)).toBeGreaterThan(POLICY.minCacheableTokens);
    expect(msgBpCount(params)).toBe(2); // rolling + intermediate (base lifts it over)
  });

  it('the rolling breakpoint is ALWAYS placed (it is the incremental-growth anchor), even on a sub-floor short history', () => {
    const params = callWith([{ role: 'user', content: [TEXT('tiny')] }]);
    expect(msgBpCount(params)).toBe(1); // rolling on the only message
    expect(breakpointMsgIdxs(params)).toEqual([0]);
  });

  it('placement helper is robust — a normal above-floor call never throws (smoke check)', () => {
    // The transport is Anthropic-only in practice; this test only asserts that a
    // normal callWith does not throw. It cannot drive a non-Anthropic policy shape
    // from this call-site, so it does not actually exercise a 0-floor/0-budget path.
    expect(() => callWith(longHistory(25, 'a'))).not.toThrow();
  });
});

describe('K4C-3 D2 — compaction-aware anchoring (cachePrefixHint)', () => {
  /**
   * A leading-summary history that has REGROWN past the lookback window: a large
   * summary head (above the floor) followed by many post-summary turns so the
   * rolling breakpoint's ≤lookback reach can't touch the summary head.
   */
  function regrownAfterSummary(): Anthropic.MessageParam[] {
    const summary = 'SUMMARY '.repeat(800); // ~1400 tokens — above the floor
    const out: Anthropic.MessageParam[] = [{ role: 'user', content: [TEXT(summary)] }];
    for (let i = 0; i < 25; i++) {
      out.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: [TEXT(`turn ${i} body`)] });
    }
    return out;
  }

  it('with the hint set, an ANCHOR breakpoint lands at the summary head (message 0) and total ≤ budget', () => {
    const params = callWith(regrownAfterSummary(), { cachePrefixHint: { summaryLeading: true } });
    const idxs = breakpointMsgIdxs(params);
    // The anchor rides the stable prefix (the summary head clears the floor at
    // message 0), plus the rolling breakpoint on the tail.
    expect(idxs).toContain(0);
    expect(idxs.at(-1)).toBe((params.messages as Anthropic.MessageParam[]).length - 1); // rolling on tail
    expect(idxs.length).toBe(2); // anchor + rolling — the anchor REUSES the intermediate slot
    expect(countBreakpoints(params)).toBeLessThanOrEqual(POLICY.breakpointBudget);
  });

  it('anchor REPLACES the tail-intermediate (never both): exactly 2 message breakpoints even on a long regrown history', () => {
    const params = callWith(regrownAfterSummary(), { cachePrefixHint: { summaryLeading: true } });
    // Without the replace rule this >lookback history would place an intermediate
    // AND the anchor AND the rolling = 3. The anchor reuses the slot → 2.
    expect(msgBpCount(params)).toBe(2);
  });

  it('WITHOUT the hint, a leading-summary history is treated as ordinary history (byte-identical to K4C-2)', () => {
    const history = regrownAfterSummary();
    const withHint = callWith(history, { cachePrefixHint: { summaryLeading: true } });
    const noHint = callWith(history);
    // No-hint must NOT anchor message 0 — it follows the ordinary intermediate rule.
    expect(breakpointMsgIdxs(noHint)).not.toContain(0);
    // And it differs from the hinted shape (proves the hint is the only trigger).
    expect(breakpointMsgIdxs(noHint)).not.toEqual(breakpointMsgIdxs(withHint));
  });

  it('the hint is a pure no-op when the summary head is BELOW the floor (nothing worth anchoring → no anchor)', () => {
    // A tiny leading "summary" that doesn't clear the floor: anchoring it would
    // cache nothing → no anchor placed, falls back to ordinary placement.
    const out: Anthropic.MessageParam[] = [{ role: 'user', content: [TEXT('tiny summary')] }];
    for (let i = 0; i < 25; i++) out.push({ role: 'assistant', content: [TEXT('t')] });
    const params = callWith(out, { cachePrefixHint: { summaryLeading: true } });
    expect(breakpointMsgIdxs(params)).not.toContain(0); // nothing worth anchoring
  });
});
