/**
 * The Fireworks wire slug for each canonical model id, in ONE table.
 *
 * Fireworks serves models under `accounts/fireworks/models/<slug>` on its
 * OpenAI-compatible endpoint, but we keep SHORT canonical ids everywhere else
 * (registry, pricing key, picker, the ledger). Every caller that talks to
 * Fireworks rewrites to the wire slug with `fireworksWireId`: the agent's Chat
 * Completions transport, the server's flash lane, the Nami judge client and the
 * wiki editor. Before this table each of them kept its own copy, so a slug that
 * Fireworks pulled had to be found and fixed in every copy (2026-09-26: three
 * copies still named the retired V4 Flash build).
 *
 * An explicit entry where the slug differs from the canonical id; the fallback
 * prefixes the id so a new Fireworks id still routes.
 *
 * ONE RULE FOR BILLING: two ids that ride the same slug run the same model, so
 * they must price the same (openai-pricing's rows; fireworks-wire.test.ts holds
 * it). A retired id that now rides its successor's slug bills at its successor's
 * card, never at the card of the model it used to name.
 */
export const FIREWORKS_WIRE_ID: Readonly<Record<string, string>> = {
  // Pro returned to this lane 2026-08-17 (the direct-API lane was removed for
  // Google Limited Use compliance). Pinned to the 0813 GA build Fireworks
  // publishes (live-probed via /v1/models 2026-08-17). 404 since 2026-10-04 (live probe) while
  // still listed: the row is `available: false` (model-capabilities.ts) until a successor is picked.
  'deepseek-v4-pro': 'accounts/fireworks/models/deepseek-v4-pro-0813',
  // V4 Flash RETIRED BY FIREWORKS 2026-09-26 ~03:05Z: its 0731 build answers 404
  // "Model not found" (the account's billing line items carry no V4 Flash after
  // 09-26), while /v1/models still LISTS it, so a listing is no liveness proof.
  // The id stays known and resolvable for history and for anything that still
  // sends it, and it now rides V4.1 Flash, the flash model Fireworks serves.
  // Every server default moved to deepseek-v4.1-flash the same day.
  'deepseek-v4-flash': 'accounts/fireworks/models/deepseek-v4p1-flash',
  // V4.1 Flash has no dated build: /v1/models lists only the undated slug
  // (live-probed 2026-09-14; answered a live call 2026-09-30).
  'deepseek-v4.1-flash': 'accounts/fireworks/models/deepseek-v4p1-flash',
  // GLM's Fireworks slug spells the version as `5p2`, not `5.2`. 404 since 2026-10-04, like Pro.
  'glm-5.2': 'accounts/fireworks/models/glm-5p2',
};

/**
 * Builds Fireworks has pulled. No table entry may point at one; the test that
 * holds this fails the build if one comes back.
 */
export const RETIRED_FIREWORKS_WIRE_IDS: readonly string[] = [
  'accounts/fireworks/models/deepseek-v4-flash-0731', // 404 since 2026-09-26 ~03:05Z
];

/**
 * Builds whose chat template renders the tools AFTER the first system message, and a later
 * system message where it stands. On these a per-task block at the end of the system prompt
 * sits in front of the tools, so a user's new task re-reads its tools uncached; the Chat
 * Completions transport moves that block into a second system message behind them
 * (CHAT_TAIL_AFTER_TOOLS_V1). A property of the served build, so two ids that ride one slug
 * share it. Live-probed 2026-10-04 (a 17.6k-token request, the tail swapped for a new one):
 * deepseek-v4p1-flash cached 8.7k with the tail in the system prompt, 16.7k with it as a
 * second system message. Add a build only after the same probe.
 */
export const TOOLS_AFTER_SYSTEM_WIRE_IDS: readonly string[] = [
  'accounts/fireworks/models/deepseek-v4p1-flash',
];

/** Does this canonical id's Fireworks build render the tools after the system message? */
export function rendersToolsAfterSystem(id: string): boolean {
  return TOOLS_AFTER_SYSTEM_WIRE_IDS.includes(fireworksWireId(id));
}

/** The Fireworks wire slug for a canonical model id. */
export function fireworksWireId(id: string): string {
  return FIREWORKS_WIRE_ID[id] ?? `accounts/fireworks/models/${id}`;
}

/** Does this canonical id have an explicit Fireworks wire entry? */
export function hasFireworksWireEntry(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIREWORKS_WIRE_ID, id);
}
