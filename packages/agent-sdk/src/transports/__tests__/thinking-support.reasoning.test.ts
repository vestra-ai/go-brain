import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAnthropicThinking, resolveOpenAIReasoning } from '../thinking-support.js';

// Snapshot + restore the env keys this resolver reads, so cases don't leak.
const ENV_KEYS = [
  'OPENAI_REASONING',
  'OPENAI_REASONING_EFFORT',
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveOpenAIReasoning — OpenAI vocab (gpt-5.5)', () => {
  it('returns the registry default effort (high after the PR5 bump) for an OpenAI reasoning model', () => {
    const cfg = resolveOpenAIReasoning('gpt-5.5');
    expect(cfg).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('accepts each OpenAI-valid effort via env override (minimal→low clamp, low, medium, high)', () => {
    process.env.OPENAI_REASONING_EFFORT = 'low';
    expect(resolveOpenAIReasoning('gpt-5.5')?.effort).toBe('low');
    process.env.OPENAI_REASONING_EFFORT = 'high';
    expect(resolveOpenAIReasoning('gpt-5.5')?.effort).toBe('high');
  });

  it('clamps an env xhigh DOWN to high for a model with no max ceiling (gpt-5.5)', () => {
    process.env.OPENAI_REASONING_EFFORT = 'xhigh';
    expect(resolveOpenAIReasoning('gpt-5.5')?.effort).toBe('high');
  });

  it('clamps an env max DOWN to high for a model with no max ceiling (gpt-5.5)', () => {
    process.env.OPENAI_REASONING_EFFORT = 'max';
    expect(resolveOpenAIReasoning('gpt-5.5')?.effort).toBe('high');
  });

  it('returns null when OPENAI_REASONING is disabled', () => {
    process.env.OPENAI_REASONING = 'off';
    expect(resolveOpenAIReasoning('gpt-5.5')).toBeNull();
  });

  it('returns null for a non-reasoning model (claude-opus-4-8)', () => {
    expect(resolveOpenAIReasoning('claude-opus-4-8')).toBeNull();
  });
});

describe('resolveOpenAIReasoning — summary', () => {
  it('always sends summary:auto for an OpenAI model', () => {
    expect(resolveOpenAIReasoning('gpt-5.5')?.summary).toBe('auto');
  });
});

describe('resolveOpenAIReasoning — top tier (GPT-5.6 family, founder call 08-06)', () => {
  it('Luna defaults to the top tier on the agent lane (registry effort=max → wire xhigh)', () => {
    expect(resolveOpenAIReasoning('gpt-5.6-luna')).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('Sol stays at high by default but an env max now REACHES the wire (the old unconditional clamp silently defeated the documented opt-in)', () => {
    expect(resolveOpenAIReasoning('gpt-5.6-sol')?.effort).toBe('high');
    process.env.OPENAI_REASONING_EFFORT = 'max';
    expect(resolveOpenAIReasoning('gpt-5.6-sol')?.effort).toBe('xhigh');
  });

  it('env xhigh passes through on a max-ceiling model', () => {
    process.env.OPENAI_REASONING_EFFORT = 'xhigh';
    expect(resolveOpenAIReasoning('gpt-5.6-terra')?.effort).toBe('xhigh');
  });

  it('Terra keeps its medium default; the ceiling only raises what may be REQUESTED', () => {
    expect(resolveOpenAIReasoning('gpt-5.6-terra')?.effort).toBe('medium');
  });

  it('GPT-6 Astra defaults to high (Sol\'s) and an env max reaches the wire as xhigh (founder 09-05)', () => {
    expect(resolveOpenAIReasoning('gpt-6-astra')).toEqual({ effort: 'high', summary: 'auto' });
    process.env.OPENAI_REASONING_EFFORT = 'max';
    expect(resolveOpenAIReasoning('gpt-6-astra')?.effort).toBe('xhigh');
  });

  it('bare gpt-5.6 (Sol alias) shares the max ceiling', () => {
    process.env.OPENAI_REASONING_EFFORT = 'max';
    expect(resolveOpenAIReasoning('gpt-5.6')?.effort).toBe('xhigh');
  });
});

describe('reasoning-vocab widening — Claude byte-identical guard', () => {
  it('resolveOpenAIReasoning returns null for every Anthropic id (never touches Claude)', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5']) {
      expect(resolveOpenAIReasoning(id)).toBeNull();
    }
  });

  it('resolveAnthropicThinking for an adaptive Claude model pins display:summarized', () => {
    // Opus 4.8 is adaptive+effort:high → thinking:{type:'adaptive', display:'summarized'} +
    // outputConfig:{effort:'high'}, no beta. display is PINNED (07-08 incident: the
    // provider-side default for adaptive flipped to 'omitted' — signature, no text —
    // and every Anthropic model lost visible thinking on both surfaces overnight).
    const cfg = resolveAnthropicThinking('claude-opus-4-8', 64_000);
    expect(cfg).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: 'high' } });
  });

  it('display:summarized is pinned on EVERY thinking-bearing config this resolver can emit', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const cfg = resolveAnthropicThinking(id, 64_000);
      if (cfg?.thinking) expect(cfg.thinking.display, id).toBe('summarized');
    }
  });
});
