/**
 * K6 P3 C0 — Permission types for the Vestra Kernel permission ladder.
 *
 * These mirror the Claude Agent SDK v0.3.177 permission type shapes exactly so
 * that cross-arm verbs (addRules / setMode / etc.) remain name-stable.  The
 * shapes are intentionally a SUBSET of what the SDK defines:
 *
 *   - Included: PermissionMode, PermissionBehavior, PermissionRuleValue,
 *     PermissionUpdate (all 6 variants), PermissionUpdateDestination.
 *   - Omitted from PermissionUpdate: no fields beyond what P3 will write.
 *   - PermissionResult / PermissionDecisionClassification: SDK-internal types
 *     not needed by P3 — omitted to avoid leaking SDK internals.
 *
 * P3 writes only to `session` and `localSettings` destinations; the full
 * destination union is kept so type-level assignments stay compatible.
 */

// =============================================================================
// PermissionMode
// =============================================================================

/**
 * Controls how the kernel handles tool approvals for a session.
 *
 * Mirrors SDK `PermissionMode` exactly (v0.3.177):
 *   - `'default'`           — ask before each tool use.
 *   - `'acceptEdits'`       — auto-approve file edits; ask for others.
 *   - `'bypassPermissions'` — skip all permission checks.
 *   - `'plan'`              — plan mode: agent proposes, human approves.
 *   - `'dontAsk'`           — don't ask; record but don't block.
 *   - `'auto'`              — SDK-managed heuristic (documented gap: not
 *                             exposed in the Vestra UI; accepted in the type
 *                             so rule-engine code round-trips SDK values).
 *
 * The existing `PermissionMode` in `types/session.ts` omits `'plan'` and
 * `'auto'`.  This type is the canonical, SDK-aligned version; the session
 * type will be migrated in a follow-up (non-breaking: it is a strict subset).
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  /**
   * `'auto'` is included for SDK round-trip fidelity.  Vestra does not expose
   * it in the UI and P3 will not write it; treat it as unsupported internally.
   */
  | 'auto';

// =============================================================================
// PermissionBehavior
// =============================================================================

/**
 * The verdict a permission rule carries.
 *
 * Mirrors SDK `PermissionBehavior` (v0.3.177).
 *   - `'allow'` — automatically approve the tool call.
 *   - `'deny'`  — automatically block it.
 *   - `'ask'`   — prompt the human (equivalent to the `needs_human` GateResult
 *                 decision, but stored as a persisted rule).
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// =============================================================================
// PermissionRuleValue
// =============================================================================

/**
 * A single rule entry — the decomposition of a Bash(npm run test:*) pattern.
 *
 * Mirrors SDK `PermissionRuleValue` (v0.3.177).
 *   - `toolName`    — the tool the rule applies to (e.g. `'Bash'`, `'Write'`).
 *   - `ruleContent` — optional glob/pattern applied within the tool
 *                     (e.g. `'npm run test:*'`, `'/app/workspace/**'`).
 *
 * P3 reads this shape from PERMISSION_RESPONSE payloads and writes it to
 * PermissionUpdate rules arrays.
 */
export interface PermissionRuleValue {
  /** The tool name this rule applies to (e.g. `'Bash'`, `'Write'`, `'Edit'`). */
  toolName: string;
  /**
   * Optional pattern / glob qualifying what within the tool is allowed/denied.
   * For Bash: a shell glob that matches the command.
   * For Write/Edit: a path glob.
   * Omit to match all invocations of the tool.
   */
  ruleContent?: string;
}

// =============================================================================
// PermissionUpdateDestination
// =============================================================================

/**
 * Where a PermissionUpdate is persisted.
 *
 * Mirrors SDK `PermissionUpdateDestination` (v0.3.177).
 *   - `'userSettings'`    — global user settings (Claude Desktop / CLI).
 *   - `'projectSettings'` — project-level `.claude/settings.json`.
 *   - `'localSettings'`   — local `.claude/settings.local.json` (gitignored).
 *   - `'session'`         — in-memory for the current session only.
 *   - `'cliArg'`          — applied via CLI flags (SDK-internal; P3 never writes).
 *
 * P3 writes to `session` (always) and optionally `localSettings` when the
 * user approves persisting a rule.  Other destinations are valid types but
 * P3 will not produce them in practice.
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  /** SDK-internal; P3 never produces this destination. */
  | 'cliArg';

// =============================================================================
// PermissionUpdate — discriminated union
// =============================================================================

/**
 * A single permission mutation the kernel or a gate result may request.
 *
 * Mirrors SDK `PermissionUpdate` (v0.3.177) — a discriminated union on `type`.
 * All six SDK variants are included for full fidelity; P3 primarily uses
 * `addRules` (to grant allow/deny for a tool pattern), `replaceRules` (to
 * reset the rule set), and `setMode` (to change the session mode).
 *
 * Omissions vs. the full SDK type:
 *   - `PermissionDecisionClassification` (SDK-internal interrupt-flow field
 *     on PermissionResult) is not represented here — P3 does not consume it.
 */
export type PermissionUpdate =
  | {
      /** Append new rules without touching existing ones. */
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      /** Replace the full rule list for a tool at this destination. */
      type: 'replaceRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      /** Remove matching rules from the rule list. */
      type: 'removeRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      /** Switch the session (or settings) permission mode. */
      type: 'setMode';
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      /** Grant read/write access to additional directories. */
      type: 'addDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      /** Revoke directory access. */
      type: 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    };
