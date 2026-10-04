import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from '../model-capabilities.js';
import { priceForModel } from '../openai-pricing.js';

// DeepSeek V4: BOTH builds ride Fireworks (US hosting). Pro returned from the
// 08-13 official-API cutover on 2026-08-17 — Google's Limited Use policy bars
// sending Google user data to DeepSeek's API, and Fireworks now publishes the
// 0813 GA build. The direct 'deepseek' provider lane no longer exists; these
// tests are the guard that it never quietly comes back.
describe('model-capabilities — DeepSeek V4 (Fireworks-served, both builds)', () => {
  it('resolves deepseek-v4-pro to the fireworks chat-completions lane', () => {
    const caps = resolveCapabilities('deepseek-v4-pro');
    expect(caps.provider).toBe('fireworks');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(1_048_576);
    // Fireworks serverless output cap (app.fireworks displayed value).
    expect(caps.maxOutputTokens).toBe(131_072);
    expect(caps.thinking.mode).toBe('reasoning');
    expect(caps.cache.breakpointBudget).toBe(0);
  });

  it('resolves deepseek-v4-flash to the fireworks chat-completions lane', () => {
    const caps = resolveCapabilities('deepseek-v4-flash');
    expect(caps.provider).toBe('fireworks');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.thinking.mode).toBe('reasoning');
  });

  it('resolves deepseek-v4.1-flash to its own fireworks row, never the V4 Flash row', () => {
    const caps = resolveCapabilities('deepseek-v4.1-flash');
    expect(caps.id).toBe('deepseek-v4.1-flash');
    expect(caps.provider).toBe('fireworks');
    expect(caps.api).toBe('openai_chat_completions');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.thinking.mode).toBe('reasoning');
    expect(resolveCapabilities('deepseek-v4-flash').id).toBe('deepseek-v4-flash');
  });

  it('infers provider "fireworks" for an unknown deepseek id (no direct lane exists)', () => {
    // An unknown DeepSeek id must never route to the removed 'deepseek' lane
    // (defaultChatClientFor throws on it) nor the Anthropic Messages transport.
    const caps = resolveCapabilities('deepseek-v9-experimental');
    expect(caps.provider).toBe('fireworks');
    expect(caps.supportsImageInput).toBe(false);
  });
});

describe('openai-pricing — DeepSeek V4 (Fireworks serverless Standard)', () => {
  it('prices deepseek-v4-pro at the invoiced Fireworks rate (1320/44/3960 nanos, 2026-10-03)', () => {
    const p = priceForModel('deepseek-v4-pro');
    expect(p.inputPerMTok).toBe(1.32);
    expect(p.cachedInputPerMTok).toBe(0.044);
    expect(p.outputPerMTok).toBe(3.96);
  });

  it('prices deepseek-v4.1-flash at the invoiced Fireworks rate (300/6/1200 nanos since 2026-10-01)', () => {
    const p = priceForModel('deepseek-v4.1-flash');
    expect(p.inputPerMTok).toBe(0.3);
    expect(p.cachedInputPerMTok).toBe(0.006);
    expect(p.outputPerMTok).toBe(1.2);
  });

  it('prices deepseek-v4-flash at V4.1 Flash\'s card (it rides that wire since 2026-09-26)', () => {
    const p = priceForModel('deepseek-v4-flash');
    expect(p.inputPerMTok).toBe(0.3);
    expect(p.cachedInputPerMTok).toBe(0.006);
    expect(p.outputPerMTok).toBe(1.2);
  });
});
