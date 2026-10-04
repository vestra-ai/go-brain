/**
 * decideToolGate — THE ONE shared tool-gate decision module (K3-T5 + K6-P3-C2).
 *
 * Every gating path consults this single function: each arm's `gateTool`
 * (ClaudeHarness / NativeHarness / OpenAIHarness) and the live Claude
 * `canUseTool` (executor.ts).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRECEDENCE LADDER (C2) — the product. The ORDER is load-bearing: a
 * precedence bug silently UNDER-DENIES on an autonomous money-spending agent.
 *
 *   1. security (gateSecurity)   — dangerous Bash / sensitive-file writes denied
 *                                  FIRST, before anything else (security wins).
 *   1c. Bash's own chats          — a write as the owner into a chat Bash answers
 *                                  this task in (the config's `bashChats`) is
 *                                  denied, mode-independent (bash-chats.ts).
 *   2. capability (checkCapability) — plan-gated tool whose required capability
 *                                  is NOT granted → deny (unchanged).
 *   2b. takeover consent          — release_browser / os_takeover hard-ask
 *                                  (mode-independent; see the inline clause).
 *   2c. routine-run guard         — a turn started by a routine FIRE
 *                                  (ctx.routineRun set) denies routine-endpoint
 *                                  writes: POST/PUT/PATCH/DELETE on /api/routines
 *                                  (incl. /execute) and firing /api/webhooks/routine,
 *                                  in ANY Bash segment or HTTP tool-input URL.
 *                                  Mode-INDEPENDENT like 2b: it sits above the
 *                                  ladder, so bypassPermissions and allow rules can
 *                                  never re-enable the self-clone / self-fire loop.
 *                                  GET/list stays allowed; unset flag → no-op.
 *
 *   The steps below run ONLY when the P3 ladder is ARMED (ctx.mode set). With
 *   mode unset + no rules the function is byte-identical to the pre-C2 gate
 *   (it skips straight to the classifier) — today's behavior is preserved.
 *
 *   3. DENY rules      — any matching deny rule short-circuits to deny. A deny
 *                        beats EVERYTHING below — including bypassPermissions and
 *                        any allow rule.
 *   4. ASK rules       — any matching ask rule → ask the human (tool_permission),
 *                        UNLESS mode is 'dontAsk' (then it's a hard deny).
 *   5. PLAN MODE (C6)   — when mode is 'plan', a WRITE (write taxonomy — file
 *                        edits, mutating Bash, MCP/Composio create/update/delete/
 *                        send) is DENIED with a "present your plan + ExitPlanMode"
 *                        message. Plan is read-only and the MOST restrictive mode,
 *                        so its write-block sits ABOVE the floor (a write/send/
 *                        delete in plan is denied-and-steered, NOT asked per-call)
 *                        and ABOVE the ALLOW step (plan blocks a write even past an
 *                        allow rule). ExitPlanMode is NOT a write (it's the exit) →
 *                        falls through to the classifier's exit_plan interaction.
 *   5b. COMPANY ACTION  — a company's own MCP tool that its server does not mark
 *                        read-only and the version does not let run without
 *                        asking asks the human the same way (company-action.ts),
 *                        and so does a company function tool not marked either way.
 *   6. SENSITIVITY FLOOR — sends / payments / deletes ALWAYS ask, even under
 *                        bypassPermissions, even past an allow rule. The floor is
 *                        BELOW plan (plan denies first) but ABOVE the permissive
 *                        modes, so no permissive mode and no allow rule can
 *                        collapse it. (dontAsk hard-denies it.)
 *   7. MODE            — bypassPermissions auto-allows (it only reaches here past
 *                        security/cap/deny/ask/plan/FLOOR); acceptEdits auto-allows
 *                        file edits; plan's write-deny already ran at step 5 (a
 *                        plan-mode READ falls through here); dontAsk has already
 *                        turned ask/floor into deny; default/auto fall through.
 *   8. ALLOW rules     — a matching allow rule allows — but only AFTER plan, the
 *                        floor, and mode, so an allow rule can NEVER override plan,
 *                        the floor, or a deny.
 *   9. classifier (classifyToolCall) — Composio-auth / credit / safe.
 *  10. mode-default    — nothing decided → allow.
 *
 * Bash compound commands (`a && b | c ; d`) are SPLIT shell-aware before rule /
 * floor evaluation: a DENY/ASK/FLOOR matches if ANY segment matches; an ALLOW
 * requires EVERY segment to match. So `allow Bash(ls:*)` does NOT allow
 * `ls && rm -rf /`, and `deny Bash(rm:*)` DOES catch it.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * PURE + TOTAL: no I/O, no socket, no state singleton, no throw. Every branch
 * returns a GateResult. All context is INJECTED so the module never reaches a
 * global — callers (executor.ts, each arm's gateTool) resolve mode/rules/cwd and
 * hand them in. C3 (mode wiring) + C4 (rule loading) populate the new context
 * fields; here the LOGIC is built + unit-tested with injected mode/rules.
 *
 * The capability deny message is imported from the capability hook so the
 * model-visible reason is BYTE-IDENTICAL across the hook path and this gate.
 */

import type { GateResult, ToolCall } from '../contract/harness.js';
import type { PermissionMode, PermissionRuleValue } from '../contract/permission.js';
import { gateSecurity } from './security-gate.js';
import { checkCapability } from './capability-policy.js';
import { classifyToolCall, type ClassifierContext } from './tool-classifier.js';
import type { PathAnchors } from './permission-rule-engine.js';
import { sensitivityFloorAsks, type ComposioToolHints } from './sensitivity-floor.js';
import {
  classifySideEffect,
  classifyMetaExecutorTools,
  composioToolkitOf,
  type McpToolHints,
  type SideEffectFamily,
} from './side-effect-classifier.js';
import { hardFloors, levelAsks, type AccessLevel } from './access-level.js';
import type { AppAction, CompiledAccessConfig } from './access-config.js';
import { isWriteTool } from './write-tool-taxonomy.js';
import { accessLevelsEnabled } from './feature-flags.js';
import { BROWSER_CONTROL_DENY_MESSAGE, COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { toolkitDisplayName, isComposioExecutorMetaTool, unrunnableExecutorPayload } from './composio-naming.js';
import { innerViewMatches } from './inner-rule-views.js';
import { remoteCodePinOf, REMOTE_CODE_BLOCK_TAIL } from './remote-code-pins.js';
import { bashChatWriteDenial } from './bash-chats.js';
import { companyActionAsks, type CompanyAction } from './company-action.js';
import { anyRuleMatchesAnySegment, allowRuleCoversCall, bashPositions, getCommand } from './rule-match.js';
import {
  resolveAccountSelection,
  type AccountRoster,
} from './composio-account-selection.js';

/** The interaction kind a floor/ask routes through (the permission prompt). */
const TOOL_PERMISSION = 'tool_permission';

/**
 * The model-visible message when plan mode blocks a write (C6). Tells the model
 * the move: stop mutating, present the plan, call ExitPlanMode to proceed. The
 * model reads this as the tool result and ends the write attempt; ExitPlanMode is
 * the ONE exit (its approval flips the session out of 'plan').
 */
const PLAN_MODE_DENY_MESSAGE =
  'In plan mode — read-only. Do not modify files, run mutating commands, or take ' +
  'external actions. Present your plan to the user and call ExitPlanMode to proceed.';

/**
 * The deny message when `dontAsk` converts a would-be prompt (ask rule, floor,
 * level/config ask) into a hard deny. Plain words, not mode jargon — this copy
 * can surface on the user-facing denied card.
 */
const DONT_ASK_DENY_MESSAGE = 'Denied: this task is set to never ask for permission.';

/** Builtin file-edit tools `acceptEdits` auto-approves (mirrors SDK). Patch is a
 *  file-edit tool too; a Patch that DELETES/MOVES still floors first (the floor runs
 *  before this mode step), so auto-approving pure-write patches here is safe. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'Patch', 'NotebookEdit', 'MultiEdit']);

// Tools whose whole purpose is to mint a typed human interaction. They MUST
// reach the step-9 classifier (ask_question / exit_plan) even under
// bypassPermissions — auto-allowing them runs their never-throw execute() stub
// instead of pausing, silently swallowing the prompt (CLAUDE.md: "Special tools
// always intercepted: AskUserQuestion, ExitPlanMode").
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Injected context for a single gate decision. All optional — an empty context
 * still produces a valid GateResult (a plain safe tool → allow), and an UNSET
 * `mode` keeps the C2 ladder dormant (byte-identical to the pre-C2 gate).
 */
export interface ToolGateContext {
  /** Lowercased toolkit slugs the user has connected (getConnectedAppsSnapshot()). */
  connectedComposioToolkits?: Set<string>;
  /**
   * Multi-account roster (design §7): lowercase toolkit slug → account
   * summaries, threaded by NativePolicyPort from state/connected-apps. ABSENT
   * (legacy mode / flag off) ⇒ the selection guard is a no-op and the gate is
   * byte-identical. Present ⇒ MULTI_EXECUTE items are validated/auto-filled
   * BEFORE the ladder: a block denies mode-independently (like steps 2b/2c —
   * an unselected multi-account call is WRONG, not merely unpermitted; the
   * router would 400 on it), and a fill rides any eventual allow as updatedInput.
   */
  composioAccountRoster?: AccountRoster;
  /**
   * The VENDOR's MCP hints for this call's Composio slugs, resolved by the
   * sandbox (state/composio-tool-hints.ts) — the classification itself for
   * Composio tools (sensitivity-floor `composioVerdict`). Absent, or silent on
   * a slug ⇒ byte-identical name-rule gate (prod 1ce8193f: a PostHog search
   * named LIST_OR_DELETE asked as a permanent delete).
   */
  composioToolHints?: ComposioToolHints;
  /**
   * B6 (MCP_INVOKE_RESOLVED_GATE_V1): the declared annotations of the MCP tool an mcp_invoke
   * call runs, read from the session's MCP registry. Absent ⇒ the classifier's name rule.
   */
  mcpToolHints?: McpToolHints;
  /** Tools whose credit cost is at/over the user's gate threshold (shouldGateTool). */
  expensiveTools?: Set<string>;
  /** Capabilities granted by the user's plan manifest (state.getCapabilities()). */
  grantedCapabilities?: ReadonlySet<string>;
  /**
   * Per-tool capability requirements: toolName → required capability id (e.g.
   * `mcp__browser-control__*` → 'browser.control'). When present and the cap is
   * NOT in grantedCapabilities, the tool is denied with the plan-gate message.
   */
  capabilityRequirements?: Map<string, string>;
  /**
   * One-Grant law (R2): normalized (lowercased) bundleIds holding a LIVE
   * per-app ACTUATION grant, resolved by the caller at call time (never cached
   * across calls — revocation must bite on the next call). Only consulted for
   * os_takeover (step 2b): a grant lets the takeover hard-ask fall through to
   * the normal ladder; absent/undefined keeps the hard-ask (fail-closed).
   */
  osGrantedApps?: ReadonlySet<string>;
  /**
   * Routine-run provenance (automations v2 §4.3): set when the CURRENT turn was
   * started by a routine fire (the sandbox's per-task flag, set at turn dispatch
   * and threaded by NativePolicyPort per call). Arms the mode-independent
   * step-2c guard: routine-endpoint writes are denied for the whole fired turn,
   * so a fired agent can never execute/clone/edit routines or self-fire the
   * webhook route. Unset → the guard is a no-op (byte-identical gate).
   */
  routineRun?: { routineId: string };

  // ── K6 P3 C2 — the permission ladder. Unset → ladder dormant. ──────────────
  /**
   * Session permission mode. UNSET → the C2 ladder (deny/ask/floor/mode/allow)
   * is dormant and the gate behaves exactly as pre-C2 (security → capability →
   * classifier). When set, the full ladder runs. Default semantics when set but
   * the value doesn't auto-decide: fall through to the classifier ('default').
   */
  mode?: PermissionMode;
  /**
   * Persisted allow/ask/deny rules (Claude-Code tool-specifier DSL, parsed into
   * PermissionRuleValue by C4). Evaluated in the deny → ask → allow precedence.
   */
  permissionRules?: {
    allow: PermissionRuleValue[];
    ask: PermissionRuleValue[];
    deny: PermissionRuleValue[];
  };
  /** Absolute cwd, for resolving relative/`./` path-rule anchors (C3/C4 supply). */
  cwd?: string;
  /** Absolute $HOME, for resolving `~/` path-rule anchors (C3/C4 supply). */
  home?: string;
  /**
   * The LIVE persisted shell cwd for this session's terminal (the shell cwd
   * carries across Bash calls). Consumed by the sensitivity floor to resolve a
   * RELATIVE delete target — NOT by the rule anchors (those stay on `cwd`, the
   * workspace root). string = live cwd; null = the caller tried and could not
   * determine it (the floor asks on relative deletes); absent = caller does not track one.
   */
  shellCwd?: string | null;

  // ── permissions v2 — access levels (ACCESS_LEVELS_V1). ─────────────────────
  /**
   * The session's effective access level (careful/balanced/relaxed/autopilot).
   * When SET (and the flag is on), it REPLACES the sensitivity-floor step with a
   * hard-floor step and adds a soft "level asks" step below the allow rules — the
   * side-effect classifier decides which family a call is and the level decides
   * ask vs run. UNDEFINED (or flag off) → the level machinery is fully skipped and
   * the legacy sensitivity-floor path runs byte-identically. The Claude arm and
   * every pre-v2 caller leave it undefined.
   */
  accessLevel?: AccessLevel;
  /**
   * Deliver-guard (outbound duplicate-delivery prevention — incident 832d60fd).
   * The caller pre-binds its task id; `check` returns the model-visible deny
   * message for a duplicate delivery / expiring-signed-URL delivery, or null.
   * UNSET → the guard step is skipped entirely (byte-identical gate).
   */
  deliverGuard?: { check(call: ToolCall): string | null };

  /**
   * The session's compiled CUSTOM access config (permissions v2 B1b — the
   * "Custom" dial position). When SET (and the flag is on) it REPLACES the
   * preset `accessLevel` path wholesale — config presence wins over a level:
   * per-app `block` pins deny beside the deny rules, the hard asks (payment
   * always; dangerous deletes unless lifted; app `ask` pins) replace
   * `hardFloors`, and the soft step asks on any family outside the config's
   * silent set unless an app `allow` pin covers it. UNDEFINED (or flag off) →
   * the preset/legacy paths run byte-identically.
   */
  accessConfig?: CompiledAccessConfig;

  /**
   * L6 (master ruling 12): SERVER-PUSHED deny and ask rules (permission_rules plus company and
   * app rules) that ALSO see the tools a call runs (inner-rule-views.ts). Workspace-file rules
   * stay name-only (policy-port.impl.ts shadow). Absent = the pre-L6 gate, byte-identical.
   */
  innerViewRules?: { ask: PermissionRuleValue[]; deny: PermissionRuleValue[] };

  /**
   * Platform API v1 (L16 D5): the client tools this company task's catalog REGISTERED
   * (policy-port.impl.ts; platform-tools.ts skips any name Bash already uses). A company's own
   * tool is governed by the company's rules, never by the Vestra access level: the ladder skips
   * the level and custom-config asks for these names, while deny and ask rules still apply
   * above them. The classifier is not told (they stay workspace_write). Absent (every
   * person's task) ⇒ byte-identical gate.
   */
  clientToolNames?: ReadonlySet<string>;

  /**
   * Platform API v1 (Keshav, 2 Oct): this call, resolved by the box as a call to one of the company's own MCP
   * tools, with what its server declared and what the version allows, or (3 Oct) to one of its function tools,
   * with its own marks (company-action.ts). Step 5b asks on it.
   * Absent (any other call, every person's task) ⇒ byte-identical gate.
   */
  companyAction?: CompanyAction;
}

/**
 * X1: the ask a standing allow rule can never silence (step 4 ask rules, step 6 hard
 * floor incl. a custom config's hard asks, the legacy sensitivity floor). Marked so a
 * hook answering the card for the person (PermissionRequest) never silences it either:
 * a hook may silence a card only where an allow rule could. A fresh object per call.
 */
const UNSILENCEABLE_ASK = (): GateResult => ({ decision: 'needs_human', interactionKind: TOOL_PERMISSION, unsilenceable: true });

/** The step-2b name matches. ONE definition each, used by the gate below AND by
 *  `isLadderBypassedAsk` — so a consumer of the predicate can never drift from
 *  the clause that actually fires. */
const isReleaseBrowserTool = (toolName: string): boolean =>
  toolName === 'release_browser' || toolName.endsWith('__release_browser');
const isOsTakeoverTool = (toolName: string): boolean =>
  toolName === 'os_takeover' || toolName.endsWith('__os_takeover');

/**
 * Does this tool's permission ask get minted ABOVE the C2 ladder?
 *
 * Step 2b force-asks `release_browser` and `os_takeover` before the ladder is
 * entered, and ALLOW rules are step 8, INSIDE it. So for these tools a standing
 * allow rule cannot suppress the prompt: `release_browser` has no escape at all,
 * and `os_takeover`'s only escape is a per-app OS actuation grant held in a
 * different store keyed by app — writing a `permission_rules` row does not
 * create one.
 *
 * Exported for the W4-4 rule miner, which must not propose "stop asking about X"
 * for an X that would keep asking. A proposal it cannot deliver costs the user
 * two interruptions (the offer, then the revoke when the measurement finds the
 * rule saved nothing) and buys them nothing.
 */
export function isLadderBypassedAsk(toolName: string): boolean {
  return isReleaseBrowserTool(toolName) || isOsTakeoverTool(toolName);
}

/**
 * Could a standing ALLOW rule ever silence this call's permission ask?
 *
 * The "Always allow" button promises exactly one thing: tap it and this stops
 * asking. Several ladder steps sit ABOVE allow rules (step 8) and return before
 * they are ever consulted, so for those calls the promise cannot be kept — and a
 * button that cannot keep its promise is worse than no button, because the grant
 * IS written, IS listed in Settings, and still asks forever.
 *
 * Answered with the ladder's OWN helpers, deliberately not a restatement of its
 * name lists, and it lives HERE so it sits beside the steps it mirrors:
 *   step 2b  — `isLadderBypassedAsk` (force-asked above the ladder entirely)
 *   step 3   — a DENY rule (`anyRuleMatchesAnySegment`)
 *   step 4   — an ASK rule (same matcher)
 *   step 3b  — a config `block` cell
 *   step 6   — a config HARD ask (`resolveConfigPosture` → `configHardAsks`),
 *              e.g. a per-app `ask` pin, which the stamped floor cannot see
 *              because `permissionAskFloor` reads only (family, level)
 *
 * NOT covered, and covered by the caller instead: the preset hard floor
 * (payments + dangerous deletes), which `suppressAlwaysAllowSuggestion` has
 * always keyed off and which stays byte-identical there.
 *
 * ⚠️ KNOWN RESIDUAL: this mirrors the ladder, it does not RUN it, so a NEW step
 * added above step 8 must be added here too. The structural fix is to probe the
 * real ladder ("does adding the rule flip the verdict to allow?"), which needs
 * the gate's exact context at the mint site — see the PR body for that design.
 * A probe with a PARTIAL context is worse than this, not better: a missing deny
 * rule or config makes the probe MORE permissive, so it would answer "honest"
 * about a button that lies.
 *
 * Pure + total. Conservative on doubt: anything it cannot judge returns false
 * (suppress), because a missing button costs a click and a false one costs trust.
 */
/**
 * The ctx fields `allowRuleCanSilence` actually reads.
 *
 * Exported as a VALUE, and the parameter type below is derived FROM it, so the
 * list and the signature cannot drift: widening the predicate means adding a name
 * here, and TypeScript rejects a name that is not a key of `ToolGateContext`.
 *
 * Why a value and not just a type: the gateway builds these five by hand while
 * the port builds them via `buildToolGateContext`, and an equivalence test asserts
 * the two agree. That test ITERATES this array. Hand-writing five names in the
 * test would leave a sixth field unguarded the day someone widens the probe, and
 * the test would still be green — a lie about coverage it never had.
 */
export const ALLOW_RULE_CTX_FIELDS = [
  'permissionRules',
  'accessConfig',
  'cwd',
  'shellCwd',
  'home',
  'innerViewRules',
] as const;

/** One field of the ctx subset `allowRuleCanSilence` reads. */
export type AllowRuleCtxField = (typeof ALLOW_RULE_CTX_FIELDS)[number];

/**
 * The ctx subset a PRODUCER of this context must supply, with every key REQUIRED.
 *
 * Deliberately a mapped type rather than `Pick`. `Pick` is homomorphic: it copies
 * the optionality of `ToolGateContext`, where every field is optional — so a
 * producer that silently omits a field still satisfies it, and widening
 * `ALLOW_RULE_CTX_FIELDS` compiles clean while the new field arrives `undefined`
 * at the predicate. That is a wrong suppression verdict from a type hole rather
 * than a logic error, which is the exact class this whole line of work keeps
 * chasing.
 *
 * This form is NON-homomorphic, so the keys become required while the VALUES may
 * still be `undefined` (`accessConfig` legitimately is). Widen the field list and
 * every producer fails to compile until it supplies the new field.
 *
 * Used on the producer's RETURN type only. The CONSUMER below keeps `Pick`,
 * because a reader must stay callable with a context that merely has the fields.
 */
export type AllowRuleCtx = { [K in AllowRuleCtxField]: ToolGateContext[K] };

export function allowRuleCanSilence(
  call: ToolCall,
  ctx: Pick<ToolGateContext, AllowRuleCtxField>,
): boolean {
  try {
    // Fail closed on an input we cannot judge, per the contract above. The
    // gateway cannot currently produce a nameless call, but the next caller
    // carries no such guarantee, and a predicate whose header promises
    // fail-closed has to actually fail closed.
    if (typeof call?.toolName !== 'string' || call.toolName.length === 0) return false;

    // Step 2b — force-asked above the ladder; allow rules are never reached.
    if (isLadderBypassedAsk(call.toolName)) return false;

    const anchors: PathAnchors = {};
    if (ctx.cwd !== undefined) anchors.cwd = ctx.cwd;
    if (ctx.home !== undefined) anchors.home = ctx.home;

    // Steps 3 + 4 — DENY and ASK rules both return before ALLOW at step 8.
    const rules = ctx.permissionRules;
    if (rules && anyRuleMatchesAnySegment(call, rules.deny, anchors)) return false;
    if (rules && anyRuleMatchesAnySegment(call, rules.ask, anchors)) return false;
    if (innerViewMatches(call, ctx.innerViewRules?.deny, anchors)) return false;
    if (innerViewMatches(call, ctx.innerViewRules?.ask, anchors)) return false;

    // Steps 3b + 6 — a custom config blocks, or pins this cell to a HARD ask.
    const cfg = accessLevelsEnabled() ? ctx.accessConfig : undefined;
    if (cfg !== undefined) {
      const family = classifySideEffect(call, {
        workspaceRoot: ctx.cwd ?? '',
        shellCwd: ctx.shellCwd,
      });
      const posture = resolveConfigPosture(cfg, call, family);
      if (posture.blocked !== undefined || posture.hardAsk) return false;
    }

    return true;
  } catch {
    return false; // doubt ⇒ do not offer a promise we cannot verify
  }
}

/**
 * Decide whether a tool call is allowed, denied, or needs a human — the single
 * authoritative policy decision shared by every arm + the live canUseTool.
 */
export function decideToolGate(call: ToolCall, ctx: ToolGateContext): GateResult {
  // 1. Security FIRST — a dangerous Bash / sensitive-file write is denied before
  //    the capability, rule, floor, mode, or classifier gates ever run.
  //    C7: stamp reasonType='security' on the deny (security-gate produces a bare
  //    deny; we tag it here so PERMISSION_DENIED can classify it).
  const security = gateSecurity(call, { shellCwd: ctx.shellCwd, home: ctx.home });
  if (security) {
    return security.decision === 'deny'
      ? { ...security, reasonType: 'security' }
      : security;
  }

  // 1b. Deliver-guard — a call that would DOUBLE-DELIVER to a destination this
  //     turn already delivered to (or embeds an expiring signed URL in an
  //     outbound message) is denied HERE, beside the security step and ABOVE
  //     the mode ladder: the double-post incident (task 832d60fd) ran under
  //     bypassPermissions, where only the floor-level stages fire. Absent
  //     guard ⇒ byte-identical gate. See policy/deliver-ledger.ts.
  if (ctx.deliverGuard) {
    const dupMessage = ctx.deliverGuard.check(call);
    if (dupMessage) {
      return { decision: 'deny', message: dupMessage, reasonType: 'delivery' };
    }
  }

  // 1c. BASH'S OWN CHATS (2026-10-03, bash-chats.ts) — a task never writes as
  //     the owner into the chat Bash delivers its result in: the post would come
  //     back to Bash as the person's own words. Beside the deliver-guard and
  //     above the ladder, so no mode, level or allow rule reopens it. Absent
  //     `bashChats` (every task not born in a chat) ⇒ byte-identical gate.
  const bashChats = accessLevelsEnabled() ? ctx.accessConfig?.bashChats : undefined;
  if (bashChats) {
    const refused = bashChatWriteDenial(call, bashChats, ctx.composioToolHints);
    if (refused) return { decision: 'deny', message: refused, reasonType: 'own_chat' };
  }

  // 2. Capability gate — a plan-gated tool whose required capability is not in
  //    the granted manifest is denied with the SAME model-visible copy the live
  //    PreToolUse capability hook emits.
  const requiredCap = ctx.capabilityRequirements?.get(call.toolName);
  if (requiredCap && !checkCapability(requiredCap, ctx.grantedCapabilities ?? new Set())) {
    return { decision: 'deny', message: BROWSER_CONTROL_DENY_MESSAGE, reasonType: 'capability' };
  }

  // 2b. Hands takeover consent (lifecycle v2 + One-Grant R2). Sits above the
  //     ladder like the security gate (below the capability gate so an ungranted
  //     task still gets the capability deny). Intentionally FLAG-INDEPENDENT:
  //     the clause matches on tool name whether or not OS_HANDS_V1 is set (a
  //     defense that only works behind a flag is no defense); the tool's absence
  //     when dark is the registration gate's job.
  //
  //     release_browser pulls the browser away from another live task — a human
  //     approves EVERY call, unconditionally, regardless of mode, access level,
  //     or allow rules.
  if (isReleaseBrowserTool(call.toolName)) {
    return { decision: 'needs_human', interactionKind: 'tool_permission' };
  }
  //     os_takeover borrows the user's physical cursor/keyboard (OS hands).
  //     One-Grant law (R2): a persisted per-app actuation grant IS the takeover
  //     consent — the hard-ask below is only for UNGRANTED apps. The snapshot is
  //     caller-resolved (this gate stays pure); absent snapshot / absent app /
  //     any doubt ⇒ ask, exactly the pre-grant behavior (fail-closed). Only
  //     os_takeover is force-asked here: os_release_takeover (returning the
  //     hands) is the safe direction, and os_drag is gated by the LIVE GRANT in
  //     the sidecar — a per-call ask would double-prompt mid-takeover.
  if (isOsTakeoverTool(call.toolName)) {
    // Asymmetric name match (R2 hardening): the BROAD match above force-ASKS every
    // takeover shape (bare + any `*__os_takeover`), but only the CANONICAL names
    // may RIDE the grant — a foreign server's `mcp__evil__os_takeover` with a
    // granted app must still hard-ask, exactly the pre-grant behavior.
    const canonical =
      call.toolName === 'os_takeover' || call.toolName === 'mcp__os-hands__os_takeover';
    const app = (call.toolInput as Record<string, unknown> | undefined)?.['app'];
    if (canonical && typeof app === 'string' && ctx.osGrantedApps?.has(app.trim().toLowerCase())) {
      // Granted — fall through to the normal ladder (mode/allow rules decide).
    } else {
      return { decision: 'needs_human', interactionKind: 'tool_permission' };
    }
  }

  // 2c. ROUTINE-RUN guard (automations v2 §4.3). Mode-INDEPENDENT like 2b — it
  //     sits ABOVE the C2 ladder, so bypassPermissions and allow rules can never
  //     re-enable it. When the sandbox marked this turn as a routine FIRE
  //     (ctx.routineRun — the per-task flag set at turn dispatch), any Bash
  //     segment (per-segment split, whole-string fallback when unparseable) or
  //     HTTP tool-input URL that positively targets a routine write —
  //     POST/PUT/PATCH/DELETE on /api/routines (incl. /execute), or firing
  //     /api/webhooks/routine — is denied with instructive copy: /execute would
  //     clone this very task in a loop (the 2026-08-04 Thread Chaser incident).
  //     GET/list stays allowed; an unset flag makes this a no-op.
  if (ctx.routineRun !== undefined && routineRunTargetsWrite(call)) {
    return { decision: 'deny', message: ROUTINE_RUN_DENY_MESSAGE };
  }

  // 2c2. A BATCH THAT CANNOT RUN goes back to the agent. Mode-independent like
  //      2b/2c: a MULTI_EXECUTE payload with no usable list, or an item that
  //      names no tool, cannot execute, so no person is asked to approve it and
  //      no level or rule can wave it through; the agent is told what to fix.
  //      Prod 2026-09-20 (task 46f85398): such an item failed the classifier
  //      toward 'payment', and a routine sat 12.5 h on "Approve a payment" for
  //      a Notion write. A readable payload is untouched.
  const unrunnable = unrunnableExecutorPayload(call);
  if (unrunnable !== null) {
    return { decision: 'deny', message: unrunnable };
  }

  // 2d. MULTI-ACCOUNT SELECTION guard (design §7). Mode-independent like 2b/2c:
  //     a multi-account MULTI_EXECUTE item without a valid `account` is denied
  //     with the roster named (never silently routed — acceptance #3), and a
  //     single-account item is auto-filled (zero ceremony — acceptance #4).
  //     The fill attaches to whichever ALLOW the ladder/classifier returns.
  const selection = resolveAccountSelection(call, ctx.composioAccountRoster);
  if (selection.kind === 'block') {
    return { decision: 'deny', message: selection.message };
  }
  const accountFill = selection.kind === 'fill' ? selection.updatedInput : undefined;

  // ── C2 ladder: ARMED only when a mode is supplied. Unset → today's gate. ────
  if (ctx.mode !== undefined) {
    const ladder = runPermissionLadder(call, ctx);
    if (ladder) {
      // INVARIANT: no ladder step produces `updatedInput` today; if one ever
      // does, the account fill must win or be merged. The `=== undefined` guard
      // below currently reads as "always true" — it is here so a future ladder
      // step that DOES rewrite the input cannot silently drop the account, which
      // would route a MULTI_EXECUTE item at the wrong account rather than fail.
      return ladder.decision === 'allow' && accountFill !== undefined && ladder.updatedInput === undefined
        ? { ...ladder, updatedInput: accountFill }
        : ladder;
    }
  }

  // 9. Classifier — auto_allow → allow; any InteractionKind → needs_human.
  //    (permissionGatedTools is intentionally NOT threaded: that classifier
  //    field is dead — C2's ASK step + floor are the real tool_permission
  //    producers now, so the classifier never mints tool_permission here.)
  //    NB: ExitPlanMode classifies to exit_plan here — in plan mode it is exempt
  //    from the step-5 write-block (it's a read in the taxonomy) so it reaches
  //    this exit_plan interaction (the approve gateway that flips out of plan).
  const classifierContext: ClassifierContext = {};
  if (ctx.connectedComposioToolkits !== undefined) {
    classifierContext.connectedComposioToolkits = ctx.connectedComposioToolkits;
  }
  if (ctx.expensiveTools !== undefined) {
    classifierContext.expensiveTools = ctx.expensiveTools;
  }
  const classification = classifyToolCall(call.toolName, call.toolInput, classifierContext);
  if (classification === 'auto_allow') {
    // 10. mode-default: nothing above decided. The classifier's auto_allow stands.
    return accountFill !== undefined
      ? { decision: 'allow', updatedInput: accountFill }
      : { decision: 'allow' };
  }
  return { decision: 'needs_human', interactionKind: classification };
}

/**
 * The C2 ladder, steps 3–8. Returns a GateResult when a step DECIDES, or
 * `undefined` to fall through to the classifier (step 9). Pure + total.
 *
 * @returns deny / needs_human / allow when decided; undefined to continue.
 */
function runPermissionLadder(call: ToolCall, ctx: ToolGateContext): GateResult | undefined {
  const mode = ctx.mode;
  const rules = ctx.permissionRules;
  // C4: path-rule anchors (cwd = workspace, home = $HOME) for the rule matcher.
  // Absent (Claude path / no roots) → the engine's conservative tail-match.
  const anchors: PathAnchors = {};
  if (ctx.cwd !== undefined) anchors.cwd = ctx.cwd;
  if (ctx.home !== undefined) anchors.home = ctx.home;

  // Permissions v2 (ACCESS_LEVELS_V1): when a level is threaded and the flag is
  // on, the side-effect classifier's family (computed ONCE at the floor step,
  // below) drives BOTH the hard-floor step (which REPLACES the sensitivity floor)
  // and the soft level-asks step (below the allow rules). Off/unset → `family`
  // stays undefined and the legacy floor path runs byte-identically.
  //
  // B1b: a CUSTOM config (ctx.accessConfig) replaces the preset level wholesale
  // — config presence wins over accessLevel, and arms the ladder on its own. It
  // contributes at THREE ladder points (the per-app block beside the deny rules,
  // the hard asks at the floor step, the soft asks at 8b), so with a config
  // present the family + config POSTURE (block / hard-ask / soft-ask) are
  // computed ONCE up front (pure — the same inputs the preset path's floor-step
  // classification uses). A meta-EXECUTOR's posture is the OR over its inner
  // tools, each judged at its own family (see resolveConfigPosture).
  const cfg = accessLevelsEnabled() ? ctx.accessConfig : undefined;
  const levelActive = accessLevelsEnabled() && (ctx.accessLevel !== undefined || cfg !== undefined);
  // L16 D5: a company's registered client tool skips the level/config asks (steps 6 and 8b);
  // the deny and ask rules above still apply to it.
  const clientTool = ctx.clientToolNames?.has(call.toolName) === true;
  let family: SideEffectFamily | undefined;
  let posture: ConfigPosture | undefined;
  if (cfg !== undefined) {
    family = classifySideEffect(call, {
      workspaceRoot: ctx.cwd ?? '', shellCwd: ctx.shellCwd, composioToolHints: ctx.composioToolHints,
      mcpToolHints: ctx.mcpToolHints,
    });
    posture = resolveConfigPosture(cfg, call, family, ctx.composioToolHints);
  }

  // 3. DENY rules — beats everything below (bypass, allow, mode). For Bash, ANY
  //    segment matching a deny rule denies the whole chain. (reasonType: 'rule')
  if ((rules && anyRuleMatchesAnySegment(call, rules.deny, anchors)) || innerViewMatches(call, ctx.innerViewRules?.deny, anchors)) {
    return { decision: 'deny', message: 'Denied by a permission rule.', reasonType: 'rule' };
  }

  // 3b. CONFIG BLOCK (B1b) — `apps[toolkit][family] = 'block'` denies at
  //     deny-rule strength: it beats ask/allow rules, plan, the floor, and every
  //     mode (including bypassPermissions and an Always-allow grant). Block is real.
  //     The deny copy names the CELL that blocked — for a meta-executor that is
  //     the inner tool's own app + family, not the wrapper's.
  if (posture?.blocked !== undefined) {
    const cell = configBlockMessage(posture.blocked.toolkit, posture.blocked.family);
    return {
      decision: 'deny',
      message: posture.blocked.remoteCode ? `${cell} ${REMOTE_CODE_BLOCK_TAIL}` : cell,
      reasonType: 'rule',
    };
  }

  // 4. ASK rules — a matching ask rule prompts the human, UNLESS dontAsk (hard
  //    deny: don't ask means don't prompt — so a would-be prompt becomes a deny).
  //    The dontAsk hard-deny is mode-driven → reasonType: 'mode'.
  if ((rules && anyRuleMatchesAnySegment(call, rules.ask, anchors)) || innerViewMatches(call, ctx.innerViewRules?.ask, anchors)) {
    return mode === 'dontAsk'
      ? { decision: 'deny', message: DONT_ASK_DENY_MESSAGE, reasonType: 'mode' }
      : UNSILENCEABLE_ASK();
  }

  // 5. PLAN MODE (C6) — the read-only mode is the most restrictive, so its WRITE
  //    block runs BEFORE the sensitivity floor: in plan mode a write/send/delete
  //    must be DENIED-and-steered ("present your plan + ExitPlanMode"), NOT asked
  //    per-call by the floor (mirrors Claude Code — the model proposes, then
  //    ExitPlanMode prompts the user to approve proceeding). A WRITE (per the
  //    write taxonomy — file edits, mutating Bash, MCP/Composio create/update/
  //    delete/send) is denied; ExitPlanMode itself is NOT a write (it's the exit)
  //    → it falls through to the classifier's exit_plan interaction; reads fall
  //    through to the normal allow/classifier path. This is ABOVE the ALLOW step
  //    (step 7), so plan blocks a write EVEN when an allow rule would match it.
  if (mode === 'plan' && isWriteTool(call)) {
    return { decision: 'deny', message: PLAN_MODE_DENY_MESSAGE, reasonType: 'mode' };
  }

  // 5b. COMPANY ACTION — a company's own tool waits for the customer's yes unless its server marks it read-only or
  //     the version lets it run without asking. Below the deny rules (a deny wins), the ask rules (require_approval
  //     asks the same) and plan (the most restrictive mode steers to the plan), above the floor, the other modes and
  //     every allow rule, so nothing silences it.
  if (companyActionAsks(ctx.companyAction)) {
    return mode === 'dontAsk'
      ? { decision: 'deny', message: DONT_ASK_DENY_MESSAGE, reasonType: 'mode' }
      : UNSILENCEABLE_ASK();
  }

  // 6. SENSITIVITY FLOOR — payments / DANGEROUS deletes ALWAYS ask, even under
  //    bypassPermissions / acceptEdits, even past an allow rule (the allow step
  //    is BELOW). dontAsk hard-denies the floor rather than prompting. (Writes
  //    are NOT floored — they are mode-governed at step 7; see sensitivity-floor.)
  //    The gate cwd (config.workingDir, threaded by NativePolicyPort) doubles as
  //    the workspace root the rm narrowing judges delete targets against;
  //    shellCwd is the LIVE terminal cwd relative delete targets resolve from
  //    (it persists across Bash calls — deliberately a separate value: using
  //    the live cwd AS the root would judge `cd /etc && rm /etc/x` "inside").
  // Permissions v2: the HARD FLOOR replaces the sensitivity floor at THIS exact
  // ladder position (above mode + allow rules) when a level is active — payments
  // (every level) + dangerous deletes (below Autopilot) ask, and no allow rule can
  // silence them. Otherwise the legacy sensitivity floor runs byte-identically.
  // Either way, `dontAsk` turns the ask into a MODE-driven hard deny (reasonType
  // 'mode', unchanged).
  // B1b: with a config present, the POSTURE was computed up front and its HARD
  // asks replace `hardFloors`: payment always; an app `ask` pin (pinned ABOVE
  // the allow rules, so a grant never decays it); a dangerous delete unless
  // lifted globally (silentFamilies) or per-app (`allow` pin). For a
  // meta-executor the posture already ORs those per inner tool.
  if (levelActive) {
    family ??= classifySideEffect(call, {
      workspaceRoot: ctx.cwd ?? '', shellCwd: ctx.shellCwd, composioToolHints: ctx.composioToolHints,
      mcpToolHints: ctx.mcpToolHints,
    });
    const hardAsk = !clientTool && (posture !== undefined
      ? posture.hardAsk
      : hardFloors(family, ctx.accessLevel as AccessLevel));
    if (hardAsk) {
      return mode === 'dontAsk'
        ? { decision: 'deny', message: DONT_ASK_DENY_MESSAGE, reasonType: 'mode' }
        : UNSILENCEABLE_ASK();
    }
  } else if (sensitivityFloorAsks(call, {
    workspaceRoot: ctx.cwd, shellCwd: ctx.shellCwd, composioToolHints: ctx.composioToolHints,
  })) {
    // The floor ASKING is NOT a deny (no reasonType). Only dontAsk turning the
    // floor into a hard deny gets stamped — and that is a MODE-driven deny, so
    // reasonType: 'mode' (not 'floor'; 'floor' is reserved for a future direct
    // floor-deny path that does not exist today).
    return mode === 'dontAsk'
      ? { decision: 'deny', message: DONT_ASK_DENY_MESSAGE, reasonType: 'mode' }
      : UNSILENCEABLE_ASK();
  }

  // 6b. INTERACTIVE TOOLS — AskUserQuestion / ExitPlanMode exist ONLY to mint a
  //     human interaction. They must reach the step-9 classifier (→ ask_question /
  //     exit_plan → needs_human → onPause → pause) even under bypassPermissions,
  //     so this short-circuit sits BELOW the floor + plan-write-block (their
  //     security/plan semantics are unchanged — ExitPlanMode is a READ, never
  //     plan-blocked) and ABOVE the mode switch (so bypass can't auto-allow them
  //     into their never-throw execute() stub, silently swallowing the question —
  //     CLAUDE.md: "Special tools always intercepted"). Returning undefined falls
  //     through to step 8 (allow-rules — harmless, no rule names these) then the
  //     classifier. Native-arm-only: the Claude arm threads no mode, so its ladder
  //     is dormant and these tools already reach the classifier directly.
  if (INTERACTIVE_TOOLS.has(call.toolName)) return undefined;

  // 7. MODE — applied AFTER the floor so a permissive mode can't collapse it.
  //    (Plan mode's write-deny already ran at step 5, above the floor.)
  //
  //    LEVEL-ACTIVE RULE (permissions v2): when an access level is active, the
  //    LEVEL is authoritative for what runs silently — so the permissive modes'
  //    auto-allow short-circuits (bypassPermissions, acceptEdits) are SKIPPED and
  //    the call falls through to the allow rules + LEVEL ASKS step (8b) below. The
  //    sandbox's PRODUCTION default mode IS bypassPermissions; without this it
  //    would auto-allow at THIS step, above step 8b, swallowing every soft level
  //    ask and rendering Careful/Balanced inert in prod. (Modes stay internal —
  //    only `dontAsk` and `plan` still contribute when a level is active; the hard
  //    floor at step 6 sits above mode either way, so payments still ask.)
  switch (mode) {
    case 'bypassPermissions':
      // Reached here only past security/cap/deny/ask/plan/FLOOR → safe to auto-allow.
      if (!levelActive) return { decision: 'allow' };
      break; // level active → defer to allow rules + LEVEL ASKS
    case 'acceptEdits':
      // Auto-approve builtin file edits — REACHABLE: writes are NOT floored
      // (the floor is sends/payments/deletes only), so an edit-family call
      // arrives here and acceptEdits does its job: allow it without a prompt.
      if (!levelActive && EDIT_TOOLS.has(call.toolName)) return { decision: 'allow' };
      break;
    case 'plan':
    case 'dontAsk':
    case 'default':
    case 'auto':
    default:
      // No mode-level auto-decision; fall through to allow rules + classifier.
      break;
  }

  // 8. ALLOW rules — consulted LAST (after plan + floor + mode), so an allow rule
  //    can never override the floor, a deny, or plan mode. For Bash, EVERY segment
  //    must satisfy an allow rule (a chain is allowed only if all its parts are).
  if (rules && allowRuleCoversCall(call, rules.allow, anchors)) {
    return { decision: 'allow' };
  }

  // 8b. LEVEL ASKS (permissions v2 — the one genuinely new ladder step). The SOFT
  //     floor: a family outside the level's silent set asks. It sits BELOW the
  //     allow rules (step 8) BY DESIGN, so an Always-allow grant decays the prompt
  //     — the graduated-trust path that makes Careful/Balanced livable. `family`
  //     was classified at the hard-floor step above (interactive tools returned
  //     earlier, so they never reach here). dontAsk hard-denies, exactly like the
  //     floor.
  //     B1b: with a config present, `levelAsks` is replaced by the config
  //     posture's soft asks — ask iff a family is outside the silent set AND no
  //     app `allow` pin covers it (payment/dangerous_delete never reach here;
  //     the hard step owns them). For a meta-executor the posture already ORs
  //     the soft ask per inner tool at that tool's own family.
  if (levelActive && family !== undefined && !clientTool) {
    const softAsk = posture !== undefined
      ? posture.softAsk
      : levelAsks(family, ctx.accessLevel as AccessLevel);
    if (softAsk) {
      return mode === 'dontAsk'
        ? { decision: 'deny', message: DONT_ASK_DENY_MESSAGE, reasonType: 'mode' }
        : { decision: 'needs_human', interactionKind: TOOL_PERMISSION };
    }
  }

  // Nothing in the ladder decided — fall through to the classifier (step 9).
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// B1b — custom access-config evaluation (the gate's side of access-config.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The HARD asks of a custom config — replaces `hardFloors` when a config is
 * present, at the same ladder position (above mode + allow rules, so nothing
 * can silence them):
 *   - payment: always (never configurable — compile drops payment keys too).
 *   - an app `ask` pin: pins that family to a hard ask for that toolkit even
 *     when the global toggle runs it silent.
 *   - dangerous_delete: unless lifted globally (silentFamilies membership) or
 *     per-app (an `allow` pin on the call's toolkit).
 * Everything else defers to the soft step (8b).
 */
function configHardAsks(
  cfg: CompiledAccessConfig,
  family: SideEffectFamily,
  appAction: AppAction | undefined,
): boolean {
  if (family === 'payment' || family === 'unknown' || family === 'protected_remote') return true; // none is configurable
  if (appAction === 'ask') return true;
  if (family === 'dangerous_delete') {
    return !(cfg.silentFamilies.has('dangerous_delete') || appAction === 'allow');
  }
  return false;
}

/**
 * A config's full posture toward one call (B1b): does any applicable cell
 * BLOCK (deny-rule strength; `blocked` names the cell for the deny copy),
 * demand a HARD ask (above mode + allow rules), or demand a SOFT ask (below
 * allow rules — grant-decayable)?
 *
 * A normal Composio call reads its single cell `apps[toolkit][family]` — the
 * pre-existing semantics verbatim. An EXECUTOR meta-call evaluates EVERY inner
 * tool at that inner tool's OWN toolkit + family (exactly the cells the
 * equivalent direct calls would read) and ORs the results: the call blocks if
 * ANY inner blocks, asks if ANY inner asks. Per-inner evaluation is
 * load-bearing — a custom config is NOT monotone in the family severity order
 * (external_send can run silent while external_mutation asks), so folding the
 * payload to one strictest family and gating THAT family would let an asking
 * inner tool ride the silent family free.
 *
 * An unreadable executor payload falls to the single-family path: `family` is
 * already 'unknown' there (the classifier's fail-toward-asking floor), which
 * hard-asks. A MULTI_EXECUTE list that cannot run never gets here (step 2c2
 * denies it back to the agent); a workbench script can.
 *
 * Code in Composio's remote sandbox (the workbench, the remote shell) can reach
 * any app and names none the gate can trust, so EVERY app pin holds against it:
 * any block refuses it, else any ask hard-asks (remote-code-pins.ts). The same
 * holds for such a door named inside a batch. Pure + total.
 */
interface ConfigPosture {
  /** `remoteCode`: refused because code in the remote sandbox could reach the blocked app. */
  blocked?: { toolkit: string; family: SideEffectFamily; remoteCode?: true };
  hardAsk: boolean;
  softAsk: boolean;
}

function resolveConfigPosture(
  cfg: CompiledAccessConfig,
  call: ToolCall,
  family: SideEffectFamily,
  hints?: ComposioToolHints,
): ConfigPosture {
  if (isComposioExecutorMetaTool(call.toolName)) {
    const inner = classifyMetaExecutorTools(call, hints);
    if (inner !== null) {
      const posture: ConfigPosture = { hardAsk: false, softAsk: false };
      for (const { slug, toolkit, family: innerFamily } of inner) {
        const pin = cfg.apps.get(toolkit)?.[innerFamily];
        if (pin === 'block') {
          return { blocked: { toolkit, family: innerFamily }, hardAsk: false, softAsk: false };
        }
        const remote = remoteCodePinOf(cfg, COMPOSIO_TOOL_PREFIX + slug);
        if (remote?.action === 'block') {
          return { blocked: { toolkit: remote.toolkit, family: remote.family, remoteCode: true }, hardAsk: false, softAsk: false };
        }
        if (remote !== null || configHardAsks(cfg, innerFamily, pin)) posture.hardAsk = true;
        if (!cfg.silentFamilies.has(innerFamily) && pin !== 'allow') posture.softAsk = true;
      }
      return posture;
    }
    // Unreadable payload → fall through to the single-family path over 'unknown'.
  }
  const toolkit = composioToolkitOf(call.toolName);
  const action = toolkit === null ? undefined : cfg.apps.get(toolkit)?.[family];
  if (action === 'block' && toolkit !== null) {
    return { blocked: { toolkit, family }, hardAsk: false, softAsk: false };
  }
  const remote = remoteCodePinOf(cfg, call.toolName);
  if (remote?.action === 'block') {
    return { blocked: { toolkit: remote.toolkit, family: remote.family, remoteCode: true }, hardAsk: false, softAsk: false };
  }
  return {
    hardAsk: remote !== null || configHardAsks(cfg, family, action),
    softAsk: !cfg.silentFamilies.has(family) && action !== 'allow',
  };
}

/**
 * Plain-language labels for the config-block deny message. Composio calls only
 * ever classify to the external families (payment pins are dropped at compile),
 * but the map stays total so the message can never be undefined.
 */
const FAMILY_BLOCK_LABEL: Record<SideEffectFamily, string> = {
  readonly: 'reading',
  workspace_write: 'file edits',
  external_send: 'sending',
  external_mutation: 'changes',
  dangerous_delete: 'deletions',
  unknown: "actions I can't read",
  protected_remote: 'rewrites of shared code history',
  payment: 'payments',
};

/** The user-facing config-block deny, e.g. `Blocked by your settings: sending on Gmail.` */
function configBlockMessage(toolkit: string, family: SideEffectFamily): string {
  return `Blocked by your settings: ${FAMILY_BLOCK_LABEL[family]} on ${toolkitDisplayName(toolkit)}.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// routine-run guard (automations v2 §4.3) — step 2c
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The model-visible deny when the routine-run guard blocks a routine-endpoint
 * write from a routine-fired turn. Instructive and DISTINCT: it must read as a
 * deliberate policy decision, never a transient error, so the model does the
 * mission instead of retrying the call.
 */
export const ROUTINE_RUN_DENY_MESSAGE =
  'This run was started by the scheduler: the trigger already fired. ' +
  'Do the mission directly; never call routine endpoints from a routine run.';

/** `/api/routines` and everything under it (details, runs, the
 *  `/api/routines/webhook/:id` alias). The lookahead keeps an unrelated
 *  `/api/routinesX` path from matching. */
const ROUTINES_API_PATH = /\/api\/routines(?![\w-])/i;
/** The live webhook fire route `/api/webhooks/routine/:id` — POST fires it. */
const ROUTINE_WEBHOOK_PATH = /\/api\/webhooks\/routine(?![\w-])/i;
/** The execute endpoint. It exists ONLY to enqueue a fresh occurrence (the
 *  fork-bomb surface), so a Bash reference is denied regardless of stated
 *  method — there is nothing to read there. */
const ROUTINE_EXECUTE_PATH = /\/api\/routines\/[^\s"'`]*\/execute(?![\w-])/i;

/** Explicit method flags: curl `-X POST` / `-XPOST` / `--request POST` /
 *  `--request=POST`, wget/httpie `--method[=]POST`. Verb list is writes only —
 *  `-X GET` never matches. */
const EXPLICIT_WRITE_METHOD =
  /(?:^|[\s;|&])(?:-X\s*|--request[=\s]\s*|--method[=\s]\s*)["']?(?:POST|PUT|PATCH|DELETE)\b/i;
/** Body-bearing flags that imply a POST: curl -d, --data (and -raw/-binary/
 *  -urlencode/-ascii), --json, -F, --form, -T, --upload-file; wget --post-data
 *  and --post-file. */
const IMPLIED_POST_DATA_FLAG =
  /(?:^|[\s;|&])(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form(?:-string)?|-T|--upload-file|--post-data|--post-file|--body)(?=[=\s]|$)/;
/** A bare UPPERCASE write-verb token (httpie style: `http POST <url>`).
 *  Uppercase-only so prose ("post the summary") never matches. */
const BARE_WRITE_VERB = /\b(?:POST|PUT|PATCH|DELETE)\b/;

/**
 * Does ONE Bash command position positively target a routine-endpoint write?
 * Requires a routine URL in the SAME position, so the write indicators can
 * never fire on unrelated commands. GET/list reads (no write indicator) fall
 * through to the normal gate.
 */
function bashSegmentTargetsRoutineWrite(segment: string): boolean {
  const routines = ROUTINES_API_PATH.test(segment);
  const webhook = ROUTINE_WEBHOOK_PATH.test(segment);
  if (!routines && !webhook) return false;
  if (routines && ROUTINE_EXECUTE_PATH.test(segment)) return true;
  return (
    EXPLICIT_WRITE_METHOD.test(segment) ||
    IMPLIED_POST_DATA_FLAG.test(segment) ||
    BARE_WRITE_VERB.test(segment)
  );
}

/** Input keys that carry a request TARGET on HTTP-capable tools. Matching is
 *  key-scoped ON PURPOSE: a Write/Edit `content` body that merely MENTIONS the
 *  endpoint is not a url-ish key and never matches (conservative — deny only a
 *  positively identified routine-write URL). Keys are compared lowercased, so
 *  snake_case and camelCase forms both resolve. */
const URLISH_INPUT_KEYS = new Set([
  'url', 'uri', 'endpoint', 'href', 'link', 'address',
  'base_url', 'baseurl', 'request_url', 'requesturl', 'api_url', 'apiurl',
  'webhook_url', 'webhookurl', 'target_url', 'targeturl',
]);
const WRITE_METHOD_WORDS = new Set(['post', 'put', 'patch', 'delete']);

/** The sibling method declared beside a url-ish key, lowercased ('' = absent). */
function declaredMethod(obj: Record<string, unknown>): string {
  const raw = obj['method'] ?? obj['http_method'] ?? obj['httpMethod'] ?? obj['verb'];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Does the object carry a non-empty request body beside the URL? Implies a
 *  non-GET request when no method is declared. */
function hasRequestBody(obj: Record<string, unknown>): boolean {
  return ['body', 'data', 'json', 'payload', 'form'].some(
    (k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '',
  );
}

/**
 * Bounded recursive scan of a non-Bash tool input for a positively identified
 * routine-endpoint write: a routine URL under a url-ish key, judged with the
 * SAME object's declared method/body. Depth-bounded (meta-executor payloads
 * nest a few levels; anything deeper is not a plausible HTTP call shape).
 *
 *  - /api/routines/…/execute or /api/webhooks/routine: fire-only endpoints —
 *    denied unless the call positively reads (explicit GET/HEAD).
 *  - /api/routines (list/read/detail): denied only on a declared write method,
 *    or a body with no declared method (implied POST). Plain reads pass.
 */
function inputTargetsRoutineWrite(node: unknown, depth: number): boolean {
  if (depth > 6 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => inputTargetsRoutineWrite(n, depth + 1));
  const obj = node as Record<string, unknown>;
  const method = declaredMethod(obj);
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      if (!URLISH_INPUT_KEYS.has(key.toLowerCase())) continue;
      const webhookHit = ROUTINE_WEBHOOK_PATH.test(value);
      const routinesHit = ROUTINES_API_PATH.test(value);
      if (!routinesHit && !webhookHit) continue;
      if (webhookHit || ROUTINE_EXECUTE_PATH.test(value)) {
        if (method === 'get' || method === 'head') continue;
        return true;
      }
      if (WRITE_METHOD_WORDS.has(method) || (method === '' && hasRequestBody(obj))) return true;
    } else if (typeof value === 'object' && value !== null) {
      if (inputTargetsRoutineWrite(value, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Step 2c predicate: does this call, made from a routine-FIRED turn, positively
 * target a routine-endpoint write? Bash/PowerShell reuse the compound-command
 * split (deny if ANY position matches; unparseable → whole-string fallback, so
 * an unbalanced quote can't hide the write). Every other tool gets the
 * conservative url-keyed input scan. Pure + total.
 */
function routineRunTargetsWrite(call: ToolCall): boolean {
  if (call.toolName === 'Bash' || call.toolName === 'PowerShell') {
    const command = getCommand(call.toolInput);
    if (typeof command === 'string' && command.length > 0) {
      const { positions, parsedSafely } = bashPositions(command);
      if (positions.some((pos) => bashSegmentTargetsRoutineWrite(pos))) return true;
      return !parsedSafely && bashSegmentTargetsRoutineWrite(command);
    }
    return false;
  }
  return inputTargetsRoutineWrite(call.toolInput, 0);
}
