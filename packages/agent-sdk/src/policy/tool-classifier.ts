/**
 * Pure tool classifier — the gate decision for every tool call.
 *
 * Extracted from the Interaction Gateway so it lives in the SDK-agnostic
 * policy layer (imports only SDK siblings: ../contract/interaction.js,
 * ./engine-constants.js, ./composio-naming.js). Both classifyToolCall and
 * ttlForKind are pure: no I/O, no state, no side effects.
 */

import type { InteractionKind } from '../contract/interaction.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import {
  extractToolkitFromToolName,
  isComposioMetaTool,
} from './composio-naming.js';

/**
 * Result of classifying a tool call.
 *   - `auto_allow`: tool is safe to run without asking the user.
 *   - any `InteractionKind`: mint a pending interaction and wait.
 */
export type Classification = 'auto_allow' | InteractionKind;

// ──────────────────────────────────────────────────────────────────────────────
// Classifier
// ──────────────────────────────────────────────────────────────────────────────

export interface ClassifierContext {
  expensiveTools?: Set<string>;
  permissionGatedTools?: Set<string>;
  /**
   * Lowercased toolkit slugs the user has connected (e.g. 'gmail', 'slack').
   * Real Composio tools whose toolkit is NOT in this set classify as
   * composio_auth. Callers must lowercase entries — extractToolkitFromToolName
   * normalizes to lowercase and we compare against that.
   */
  connectedComposioToolkits?: Set<string>;
}

/**
 * Classify a tool call into auto-allow or an interactive kind.
 *
 * Pure — no I/O, no state, no side effects. Returns the "gate" decision; the
 * per-kind request builder runs AFTER this and gathers extra context.
 */
export function classifyToolCall(
  toolName: string,
  toolInput: unknown,
  context: ClassifierContext = {},
): Classification {
  if (toolName === 'AskUserQuestion') return 'ask_question';
  if (toolName === 'ExitPlanMode') return 'exit_plan';
  // No tool classifies as `custom` any more: the only remaining producer of a
  // `custom` interaction is connect_mcp's oauth-connect card, which calls
  // onPause('custom') directly from a SERVER-minted authUrl and never routes
  // through this classifier.

  // Composio auth gate runs BEFORE credit/permission gates so unconnected
  // toolkits surface the auth prompt first — connecting is a prerequisite,
  // and it would be confusing to charge credits or ask permission for a
  // tool the user can't even run yet.
  if (toolName.startsWith(COMPOSIO_TOOL_PREFIX) && !isComposioMetaTool(toolName)) {
    const toolkit = extractToolkitFromToolName(toolName);
    if (!context.connectedComposioToolkits?.has(toolkit)) {
      return 'composio_auth';
    }
    // Connected — fall through to credit/permission gates below.
  }

  if (context.expensiveTools?.has(toolName)) return 'credit_approval';
  if (context.permissionGatedTools?.has(toolName)) return 'tool_permission';

  void toolInput; // future gates may use it
  return 'auto_allow';
}

/**
 * Per-kind TTL — how long to wait for the user before the substrate row
 * expires. Server-side sweeper marks past-TTL rows as 'expired' and the
 * resume orchestrator pushes the agent a "user didn't respond" continuation.
 *
 * Composio auth: 15 min — the full OAuth round-trip (connect → provider login →
 * authorize → redirect back) routinely outlives a 2-min TTL. When it expires
 * mid-flow the server injects a deny/timed_out tool_result that tells the agent
 * "the user didn't respond, stop" — abandoning a connect the user is actively
 * completing. 15 min covers a real human OAuth flow.
 * Everything else: 10 min — answering a multi-choice question or filling
 * a form takes the user some real thought; don't be aggressive.
 */
export function ttlForKind(kind: InteractionKind): number {
  const ONE_MIN = 60_000;
  switch (kind) {
    case 'composio_auth': return 15 * ONE_MIN;
    default:              return 10 * ONE_MIN;
  }
}
