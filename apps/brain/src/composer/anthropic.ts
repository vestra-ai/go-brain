import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';

export interface StreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/**
 * The part of the Anthropic client Go uses: the composer streams; the lanes' side passes (P2's notes and fold) make
 * one plain call. buildBrain hands the same client to every lane as brain.anthropic, so tests and the bench inject a fake.
 */
export interface AnthropicLike {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): StreamLike;
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
}

/**
 * How long a connection to Anthropic stays open with nothing on it. Node's fetch drops one after 4 s, so a turn after a
 * quiet spell paid a new TCP and TLS handshake before its first word; a minute keeps it for the next ask in a chat.
 */
export const KEEP_ALIVE_MS = 60_000;

/** Connections that outlive a quiet spell. Fetch and the agent come from the same undici, so they always fit. */
export function keepAliveAgent(): Agent {
  return new Agent({ keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: KEEP_ALIVE_MS });
}

/** The real client. maxRetries 0: the desk retries a failed turn; the loop never waits on its own. */
export function anthropicClient(apiKey: string, o: { baseURL?: string } = {}): AnthropicLike {
  const dispatcher = keepAliveAgent();
  // The SDK's fetch option is typed to the platform's fetch; undici's is the same function with its own types.
  return new Anthropic({
    apiKey, maxRetries: 0, fetch: undiciFetch as never, fetchOptions: { dispatcher } as never, ...(o.baseURL ? { baseURL: o.baseURL } : {}),
  }) as unknown as AnthropicLike;
}
