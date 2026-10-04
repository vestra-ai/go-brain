/**
 * Pure capability predicate: is `id` present in the granted-capabilities set?
 *
 * Mirrors StateManager.hasCapability (which is exactly `this._capabilities.has(id)`)
 * as a free function so harness adapters (ClaudeHarness now, OpenAIHarness in P5)
 * can gate plan-gated tools without depending on the StateManager singleton.
 */
export function checkCapability(id: string, capabilities: ReadonlySet<string>): boolean {
  return capabilities.has(id);
}
