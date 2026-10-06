/**
 * The small model for side passes (the notes pass and the fold). It is called only off the reply path.
 * It runs on the model client P1 hands every lane (brain.anthropic, the one buildBrain was given), never
 * a client of its own, so the bench and the tests put their fake in one place. Unit tests of the passes
 * use a scripted SideModel (test-kit.ts scriptedSide); the wiring tests use a scripted client (scriptedClient).
 */
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
    ): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }>;
  };
}

export function anthropicSideModel(client: SideClient, model: string, log: Log): SideModel {
  return {
    async complete(req) {
      const started = Date.now();
      const res = await client.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          // The rules are the same every call, so they are cached.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.user }],
        },
        req.signal ? { signal: req.signal } : {},
      );
      log.info(
        { purpose: req.purpose, model, inputTok: res.usage?.input_tokens ?? 0, outputTok: res.usage?.output_tokens ?? 0, ms: Date.now() - started },
        'side model',
      );
      return res.content.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
    },
  };
}
