/**
 * A model row's reasoning-replay capability (part of ModelCapabilities.thinking).
 * Kept in its own module because model-capabilities.ts is at its size ratchet.
 */
export interface ReasoningReplayCapability {
  /**
   * Chat Completions lane: the model READS its earlier `reasoning_content` back when
   * an assistant message carries it, so the lane sends it (the sealed message as
   * streamed). Probed 2026-09-23 on Fireworks with a two-call tool loop: DeepSeek V4
   * Flash / V4.1 Flash / V4 Pro and GLM 5.2 accept it and it reaches the prompt
   * (prompt_tokens 489→505; a 2,000-char sentinel → 1,490). xAI Grok 4.6 accepts it
   * and ignores it (787 either way), so it stays ABSENT there — ABSENT means the
   * field is stripped from the request, never sent.
   */
  replaysReasoning?: true;
}
