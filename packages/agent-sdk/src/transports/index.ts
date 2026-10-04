/**
 * @vestra/agent-sdk/transports — the CONCRETE provider transports (batteries).
 *
 * This non-root entry value-imports the provider network clients
 * (`@anthropic-ai/sdk` + `openai`), so importing it pulls those SDKs. The pure
 * root (`@vestra/agent-sdk`) and the engine (`@vestra/agent-sdk/engine`) stay
 * provider-VALUE-free — they reference the `Transport` interface only. Inject a
 * transport from here (or your own) into the engine at call time.
 */
export * from './openai-endpoints.js';
// LANE_FALLBACK_V1: the second route's hold and per-provider declaration (the sandbox's per-session memory reads the hold).
export * from './lane-fallback.js';
// The per-tool strict gate, exported so a caller that assembles a Responses request
// BESIDE the transport (the browser tool-choice eval) makes the same strict decision
// the transport makes. The schema conversion it sits next to is reached through
// `withNarrationParam` instead: that is the seam every real lane goes through, so an
// eval that stops short of it measures a tool list the box never sends.
export * from './openai-tool-schema.js';
export * from './anthropic-transport.js';
// The per-request tools shaping callModel applies (deferral + tools-tail breakpoint), exported
// so a host fingerprinting the wire (the sandbox's [CACHE_TIER] line) reuses it, not a copy.
export { applyToolDeferral, withToolsTailBreakpoint } from './anthropic-tool-defer.js';
export * from './openai-responses-transport.js';
export * from './openai-responses-messages.js';
export * from './openai-responses-pricing.js';
export * from './openai-responses-termination.js';
export * from './chat-completions-transport.js';
export * from './chat-completions-messages.js';
export * from './gemini-transport.js';
export * from './gemini-messages.js';
export * from './thinking-support.js';
export * from './gemini-interactions-wire.js';
export * from './gemini-interactions-validity.js';
export * from './gemini-interactions-messages.js';
export * from './gemini-interactions-accumulator.js';
export * from './gemini-interactions-transport.js';
export * from './gemini-files.js';
export * from './media-local.js';
// WARM_CONNECTIONS_V1: the runner's shared pool is process state, so a host's tests reset it
// through the same module instance its transports use.
export { resetSharedWarmPoolForTests, renewWarmConnections } from './warm-connections.js';
