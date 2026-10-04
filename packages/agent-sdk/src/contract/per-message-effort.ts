/**
 * A model row's per-message effort capability (part of ModelCapabilities.thinking).
 * Kept in its own module because model-capabilities.ts is at its size ratchet.
 */
export interface PerMessageEffortCapability {
  /**
   * The model takes a mid-conversation effort change: a `{role:'system', content:[],
   * output_config:{effort}}` message under the `mid-conversation-output-config-2026-07-01`
   * beta sets the effort from the next user turn on, WITHOUT the messages-cache reset that a
   * top-level effort change causes. Anthropic's docs (checked 2026-10-04) list Fable 5.1,
   * Mythos 5.1, Opus 5.5, Opus 5 and Sonnet 5.5, with thinking on only, on the Claude API and
   * Google Cloud. Every other model answers that message with a 400 ("output_config.effort
   * requires a model that supports per-turn effort"), Fable 5 included. ABSENT means it does not.
   */
  perMessageEffort?: true;
}
