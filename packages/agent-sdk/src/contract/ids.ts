/**
 * Harness identifiers — the engines that can drive an agent loop.
 *
 * Additive by design: a new arm appends an id here. 'codex' is intentionally
 * NOT included (out of scope, 2026-05-29).
 *
 * 'claude_code' (2026-09-14) is the unmodified Claude Code CLI running in the
 * user's own box on the user's own Claude plan. It is deliberately a NEW id: the
 * legacy 'claude' id is on historical task rows that must keep launching native.
 */
export const HARNESS_IDS = ['claude', 'openai', 'native', 'openai_responses', 'claude_code'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}
