import Anthropic from '@anthropic-ai/sdk';

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

/** The real client. maxRetries 0: the desk retries a failed turn; the loop never waits on its own. */
export function anthropicClient(apiKey: string): AnthropicLike {
  return new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicLike;
}
