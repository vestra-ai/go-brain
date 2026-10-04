/**
 * The registry carries TWO distinct input-token bounds, and they must never be
 * conflated:
 *   - `preferredMaxInputTokens` — where we PREFER to compact (context hygiene,
 *     latency, headroom). A compaction hint; carries no pricing meaning.
 *   - `premiumInputThreshold`  — the provider's DOCUMENTED re-pricing boundary,
 *     read by openai-pricing.ts for the whole-request rate swap.
 * A 1M-window model can carry the first without the second (Anthropic bills the
 * full 1M window at standard rate); the compaction trigger, the subagent ceiling,
 * and the flag docs read only the first.
 */
import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';

const ANTHROPIC_1M = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-fable-5', 'claude-mythos-preview', 'claude-mythos-5', 'claude-opus-4-7', 'claude-opus-4-6',
];

describe('model-capabilities — preferredMaxInputTokens vs premiumInputThreshold', () => {
  it('every Anthropic 1M row declares a 200k preferred ceiling and NO re-pricing boundary', () => {
    for (const id of ANTHROPIC_1M) {
      const caps = resolveCapabilities(id);
      expect(caps.preferredMaxInputTokens, id).toBe(200_000);
      expect(caps.premiumInputThreshold, id).toBeUndefined();
    }
  });

  it('xAI grok rows keep the documented 200k re-pricing boundary AND a matching preferred ceiling', () => {
    for (const id of ['grok-4.5', 'grok-4.6']) {
      const caps = resolveCapabilities(id);
      expect(caps.premiumInputThreshold, id).toBe(200_000);
      expect(caps.preferredMaxInputTokens, id).toBe(200_000);
    }
  });

  it('GPT-5.x / GPT-6 1M rows keep the documented 272k re-pricing boundary AND a matching preferred ceiling', () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
      const caps = resolveCapabilities(id);
      expect(caps.premiumInputThreshold, id).toBe(272_000);
      expect(caps.preferredMaxInputTokens, id).toBe(272_000);
    }
  });

  it('200k-window and OSS-lane rows declare neither bound (the window ceiling alone applies)', () => {
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'glm-5.2', 'deepseek-v4-pro', 'gpt-5.4']) {
      const caps = resolveCapabilities(id);
      expect(caps.preferredMaxInputTokens, id).toBeUndefined();
      expect(caps.premiumInputThreshold, id).toBeUndefined();
    }
  });
});
