/**
 * The small model for side passes (the notes pass and the fold). It is called only off the reply path.
 * It runs on the model client P1 hands every lane (brain.anthropic, the one buildBrain was given), never
 * a client of its own, so the bench and the tests put their fake in one place. Unit tests of the passes
 * use a scripted SideModel (test-kit.ts scriptedSide); the wiring tests use a scripted client (scriptedClient).
 */
import { OverBudget, type Budget } from '../budget.js';
import { computeAnthropicCostUsd, estimateCostUsd } from '../composer/anthropic-helpers.js';
import type { Log } from '../log.js';

export interface SideRequest {
  purpose: 'notes' | 'fold';
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}
export interface SideModel {
  complete(req: SideRequest): Promise<string>;
}

/** The request body the side passes send. */
export interface SideBody {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }>;
  messages: Array<{ role: 'user'; content: string }>;
}
/** The slice of the model client this file uses: `messages.create`. P1's `AnthropicLike` (brain.anthropic) has it. */
export interface SideClient {
  messages: {
    create(
      params: SideBody,
      opts?: { signal?: AbortSignal },
    ): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
      };
    }>;
  };
}

/**
 * With a budget: each call holds its upper-bound cost first, and over today's cap it is not made (OverBudget, which the
 * passes treat as a skip). The hold settles to the call's real cost, or stays as spent when the call failed with no usage.
 */
export function anthropicSideModel(client: SideClient, model: string, log: Log, budget?: Pick<Budget, 'reserve'>): SideModel {
  return {
    async complete(req) {
      const body: SideBody = {
        model,
        max_tokens: req.maxTokens,
        // The rules are the same every call, so they are cached.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      };
      const hold = budget ? budget.reserve({ purpose: req.purpose, model, usd: estimateCostUsd(model, body, req.maxTokens) }) : null;
      if (budget && !hold) throw new OverBudget();
      let billed: number | null = null;
      try {
        const started = Date.now();
        const res = await client.messages.create(body, req.signal ? { signal: req.signal } : {});
        log.info(
          { purpose: req.purpose, model, inputTok: res.usage?.input_tokens ?? 0, outputTok: res.usage?.output_tokens ?? 0, ms: Date.now() - started },
          'side model',
        );
        const u = res.usage;
        if (u) {
          billed = computeAnthropicCostUsd(
            {
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
              cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              ...(u.cache_creation ? { cache_creation: u.cache_creation } : {}),
            },
            model,
          );
        }
        return res.content.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
      } finally {
        await hold?.settle(billed);
      }
    },
  };
}
