/**
 * Interaction — unified user-input primitive
 *
 * Every flow that requires a human in the loop (AskUserQuestion, Composio auth,
 * dangerous-tool permission, expensive-tool approval, plan-mode exit) funnels
 * through the SAME shape: the sandbox's canUseTool callback returns a Promise
 * that resolves when the user responds. This file defines the wire-format that
 * sandbox, server, and web all speak.
 *
 * See: docs/superpowers/specs/2026-04-20-input-station.md
 */

import type { Question } from './blocks.js';
import type { SubagentId } from './subagent-path.js';
import type { HarnessId } from './ids.js';

/**
 * The interactive flows. `auto_allow` is returned by the classifier for
 * tools that don't need the user — it's not an `InteractionKind` itself.
 * `custom` is the open extension point: a renderer key selects the FE component.
 * `hands_approval` is the computer-use action approval — minted SERVER-SIDE by
 * the hands gate (triggered_by 'server_gate'), never by the sandbox.
 * `plan_limit` (engines T5) is a used-up subscription plan — also server-minted
 * only; a box never registers it.
 */
export type InteractionKind =
  | 'ask_question'
  | 'composio_auth'
  | 'tool_permission'
  | 'credit_approval'
  | 'exit_plan'
  | 'custom'
  | 'hands_approval'
  | 'plan_limit';

/**
 * SDK 0.2.49 permission suggestion — a rule the user could add to auto-approve
 * this tool family in the future. When the user clicks "Always allow," we write
 * this via `addRules` / `setPermissionRules` so they never see the prompt again.
 */
export interface PermissionSuggestion {
  type: 'addRules';
  rules: Array<{
    toolName: string;
    ruleContent?: string;
  }>;
  behavior: 'allow' | 'deny';
  destination: 'session' | 'project' | 'user';
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-kind payloads
// ──────────────────────────────────────────────────────────────────────────────

export interface InteractionRequestBase {
  /** Unique per interaction. Used to route the response back to the right waiter. */
  id: string;
  taskId: string;
  /** ms since epoch. */
  createdAt: number;
  /** SDK tool_use_id, when the interaction is tied to a specific tool call.
   *  Lets the frontend replace the in-stream tool_use block with a nudge pill. */
  toolUseId?: string;
  kind: InteractionKind;
}

export interface AskQuestionRequest extends InteractionRequestBase {
  kind: 'ask_question';
  questions: Question[];
  /**
   * Done rail (08-22, additive): what the ask IS. 'handoff' = the user must DO
   * something or hand something over (a number, a file, a code); 'question' =
   * the agent asked a question. Drives the Needs-you card's kind badge
   * (needKindForInteraction). Absent on classic AskUserQuestion rows.
   */
  intent?: 'handoff' | 'question';
  /** Which door minted the row: the tool, or the task-end verdict. Absent = the gate path. */
  source?: 'request_user_input' | 'done_verdict';
  /**
   * Browser handoff (09-02, additive): WHERE the person acts. 'browser' = on the
   * page the agent is driving (sign in, scan a QR code, type a password, pass a
   * puzzle); 'phone' = on their phone (approve a sign-in notification). With
   * `intent` it picks the card the story renders; absent = today's cards.
   */
  surface?: 'browser' | 'phone';
  /** The page the handoff is about: the main-frame URL at mint time, http(s) only. */
  url?: string;
  /** A small JPEG data URI of that page at mint time (<= ~80 KB); absent when capture failed. */
  frame?: string;
  /** The tool's one-line context (already sent by request_user_input, now typed). */
  why?: string;
  /**
   * File answers (09-24, additive): HOW the person answers. 'file' = the card
   * leads with an attach button and the answer carries files; 'text' or absent
   * = today's typed answer. request_user_input mints it only for 'file'.
   */
  answer?: 'text' | 'file';
}

export interface ComposioAuthRequest extends InteractionRequestBase {
  kind: 'composio_auth';
  /** Lowercase toolkit slug, e.g. "gmail", "slack". */
  toolkit: string;
  /** Pre-formatted display name, e.g. "Gmail". */
  displayName: string;
  /** The OAuth URL. Optional: on some paths we discover it lazily. */
  authUrl?: string;
  /** Original tool the agent was trying to call, for display. */
  triggeringToolName?: string;
  /**
   * Multi-account (design §7): WHICH account this ask is about — a connected
   * account id (`ca_*`) when the account already exists (reconnect), or the
   * user's own label when it does not yet. Mirrors @bash/shared's
   * ComposioAuthRequestSchema verbatim (the zod side landed in PR 1).
   */
  accountHint?: string;
  /** An ask that deliberately wants a NEW account even though a sibling is ACTIVE. */
  mode?: 'add';
}

/**
 * A rich permission-card detail row — a label/value pair extracted from the REAL
 * call args (To/Subject/Message on a send, Amount/Customer/For on a payment, an
 * irreversibility Note on a delete). `tone` styles the VALUE on the card:
 * 'danger' = the red irreversibility note, 'quote' = a quoted preview (subject,
 * body, description). Computed deterministically at request assembly
 * (describePermissionAsk); a missing arg omits its row, never a placeholder.
 */
export interface ToolPermissionDetail {
  label: string;
  value: string;
  tone?: 'danger' | 'quote';
}

/**
 * Why a permission ask fired: the side-effect `family` the call classified into,
 * which `floor` produced the prompt, and the one-sentence why-`line`. `family`
 * drives the card's primary-button TONE (red ONLY for 'dangerous_delete' |
 * 'protected_remote' | 'payment'); `line` is the human sentence. The two union types mirror the policy
 * layer's SideEffectFamily / PermissionAskFloor INLINE — the wire contract must
 * not import the policy module (that would drag the engine into @bash/shared).
 */
export interface ToolPermissionReason {
  family:
    | 'readonly'
    | 'workspace_write'
    | 'external_send'
    | 'external_mutation'
    | 'dangerous_delete'
    | 'unknown'
    | 'protected_remote'
    | 'payment';
  floor: 'hard' | 'soft' | 'rule';
  line: string;
}

export interface ToolPermissionRequest extends InteractionRequestBase {
  kind: 'tool_permission';
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Plain-language one-liner of what the call will do ("Send an email from your
   * Gmail", "Delete 2 files"), computed deterministically at request assembly
   * (describePermissionAsk headline, falling back to describeToolCall). The card
   * leads with this; the raw tool input is demoted to a disclosure. Optional for
   * back-compat — older bundles omit it and the card falls back to "Allow this step?".
   */
  summary?: string;
  /**
   * Rich-card detail rows extracted from the real args (describePermissionAsk).
   * OPTIONAL / additive: an old web bundle ignores them; an old payload omits
   * them and the card renders exactly today's summary-only form. Never populated
   * with a placeholder — a row is present only when its arg was readable.
   */
  details?: ToolPermissionDetail[];
  /**
   * The primary-button label that NAMES the action ("Send email", "Delete 1
   * email", "Pay $500.00"). Absent ⇒ the card keeps today's "Allow once".
   */
  actionLabel?: string;
  /**
   * Why this ask fired (family + floor + why-line). Absent ⇒ no why-line and the
   * neutral (non-red) button tone. This enriched payload is the interface the
   * Home "Needs you" surface consumes too — coordinate through it, not shared FE files.
   */
  reason?: ToolPermissionReason;
  /**
   * Toolkit slug for the card's brand icon ("gmail", "github", …), set when a
   * single Composio app names the call (direct tool, or an executor meta-tool
   * whose inner actions all share one toolkit). Computed at request assembly
   * from the same unwrap the gate uses, so the icon can't disagree with the
   * decision. Absent for multi-app/opaque payloads and non-Composio tools —
   * the card keeps its generic glyph. Optional for back-compat.
   */
  appSlug?: string;
  /**
   * SDK-supplied suggestions the user can accept to auto-approve similar calls.
   * When empty/undefined, "Always allow" is hidden.
   */
  suggestions?: PermissionSuggestion[];
  /**
   * Platform API v1: the call is one of the company's own tools, waiting for the customer's yes
   * (policy/company-action.ts): a tool of its MCP server (`server` set) or a function its own code
   * answers (no `server`). The company's approval names it, never a wrapper, and leads with `headline`,
   * the first sentence of the tool's own description, when it declared one. Absent on every other ask.
   */
  company?: { tool: string; server?: string; headline?: string };
}

export interface CreditApprovalRequest extends InteractionRequestBase {
  kind: 'credit_approval';
  toolName: string;
  /** Best-effort estimated cost in USD for this invocation. */
  estimatedCostUsd: number;
  /** Current balance in USD at time of prompt. */
  balanceUsd: number;
}

export interface ExitPlanRequest extends InteractionRequestBase {
  kind: 'exit_plan';
  /** The plan text as authored by the agent. */
  plan: string;
  /** SDK 0.2.76 planFilePath, when written to disk. */
  planFilePath?: string;
}

/**
 * The renderer keys the Claude-arm `mcp__vestra-input__request_user_input` tool
 * (apps/sandbox/src/mcp/input-mcp.ts) may author, validated at that mint site by
 * validateRequestUserInputSpec.
 *
 * The native `request_user_input` tool and the FE components behind these keys
 * are GONE — the web renderer registry now implements only `oauth-connect`
 * (server-minted, connect_mcp). This list and its validator survive solely
 * because input-mcp.ts still imports them; they die with the Claude arm.
 */
export const INPUT_RENDERERS = ['text', 'secret', 'image-upload', 'aspect-ratio', 'form'] as const;
export type InputRendererKey = (typeof INPUT_RENDERERS)[number];

/**
 * Renderers a `form` field may use. `form` itself is excluded (a nested form's
 * own Submit would resolve the parent interaction) and so is `secret` (the
 * vault write path never composes into a form — see SecretInput).
 */
export const FORM_FIELD_RENDERERS = ['text', 'image-upload', 'aspect-ratio'] as const;

/**
 * Validate an agent-authored request_user_input spec against the renderer
 * contract. Returns `null` when valid, or a MODEL-VISIBLE corrective message
 * describing the problem + the contract so the model can immediately re-call
 * with a fixed spec. Shared by decideToolGate (native/openai arms) and the
 * vestra-input MCP tool (Claude arm) — the single mint-site guard.
 */
export function validateRequestUserInputSpec(input: unknown): string | null {
  const contract =
    `Valid renderers: ${INPUT_RENDERERS.join(', ')}. ` +
    `For renderer 'form', config must be { fields: [{ name, label, renderer, required?, config }] } ` +
    `where each field's renderer is one of: ${FORM_FIELD_RENDERERS.join(', ')} ` +
    `(fields select their renderer with the 'renderer' key — NOT 'type'). ` +
    `For a free-text answer use renderer 'text' with config { placeholder?, multiline? }.`;

  const spec = input as { renderer?: unknown; config?: unknown } | null | undefined;
  const renderer = spec?.renderer;
  if (typeof renderer !== 'string' || !(INPUT_RENDERERS as readonly string[]).includes(renderer)) {
    return `request_user_input: unknown renderer '${String(renderer)}'. ${contract}`;
  }
  if (renderer !== 'form') return null;

  const fields = (spec?.config as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return `request_user_input: renderer 'form' needs a non-empty config.fields array. ${contract}`;
  }
  for (const raw of fields) {
    const field = raw as { name?: unknown; label?: unknown; renderer?: unknown } | null;
    if (typeof field?.name !== 'string' || typeof field?.label !== 'string') {
      return `request_user_input: every form field needs a string 'name' and 'label'. ${contract}`;
    }
    if (
      typeof field.renderer !== 'string' ||
      !(FORM_FIELD_RENDERERS as readonly string[]).includes(field.renderer)
    ) {
      return (
        `request_user_input: form field '${field.name}' has invalid renderer ` +
        `'${String(field.renderer)}'. ${contract}`
      );
    }
  }
  return null;
}

export interface CustomInteractionRequest extends InteractionRequestBase {
  kind: 'custom';
  /** Renderer key matching a registered FE component. */
  renderer: string;
  /** User-facing card title. */
  title?: string;
  /** Card subtitle / description. */
  description?: string;
  /** Renderer-specific config. Treated as opaque by gateway/server/DB. */
  config: Record<string, unknown>;
  submitLabel?: string;
  allowSkip?: boolean;
  skipLabel?: string;
}

/**
 * Computer-use S3 — a held out-of-band approval for a mutating action, minted
 * server-side by the hands gate. The fields are the gate's PROJECTED report
 * fields (the raw side-channel report is untrusted and never rides an
 * interaction). `nonce` is the single-use action-bound token the RESOLVING
 * CLIENT must echo into `InteractionAllow.nonce` — the gate verifies it after
 * the resolve and treats a mismatch as declined.
 *
 * Two lanes ride this one shape (`lane` discriminates; ABSENT ⇒ 'browser' for
 * legacy rows):
 *   - `browser` — the browser gate's per-action ask, keyed on `url` (origin).
 *   - `os` (OS Hands P2.5a) — the per-APP Mac consent, keyed on `app` (bundle
 *     id) + `capability`. The one-time lane-on card carries `firstEngage:true`
 *     and NO per-action fields (it names no app; `tool`/`mode`/`tier`/`reasons`
 *     are absent). Because of that first-engage variant, the per-action fields
 *     are optional here even though every PER-APP/browser ask carries them.
 */
export interface HandsApprovalRequest extends InteractionRequestBase {
  kind: 'hands_approval';
  /** Which consent lane. Absent on legacy browser rows ⇒ treat as 'browser'. */
  lane?: 'os' | 'browser';
  /** OS lane one-time lane-on consent. Names no app; per-action fields absent. */
  firstEngage?: boolean;
  /** OS lane — the macOS bundle id being asked for, e.g. 'com.apple.mail'. */
  app?: string;
  /** OS lane — the disjoint consent capability: 'actuation' | 'pixels'. */
  capability?: string;
  tool?: string;
  mode?: string;
  label?: string;
  /** Browser lane — the origin the action targets (stands in for `app`). */
  url?: string;
  tier?: 'low' | 'medium' | 'high';
  reasons?: string[];
  nonce: string;
}

/** Engines T5 (spec 2026-09-28 §6.9): another plan the person could continue on. */
export interface PlanLimitOtherPlan {
  /** A subscription engine id ('codex', 'grok_build', ...). */
  engine: string;
  /** Connected AND not used up right now. False renders disabled: "Not connected. Connect it in Settings." */
  available: boolean;
  /** The fullest window's used percent, or null when unknown. Never 0 for unknown. */
  usedPct: number | null;
  windowKind: 'five_hour' | 'weekly' | 'weekly_model' | 'overage' | null;
}

/** Engines T5: a used-up plan. SERVER-MINTED ONLY (triggered_by 'server_gate'); a box never registers it. */
export interface PlanLimitRequest extends InteractionRequestBase {
  kind: 'plan_limit';
  /** The engine whose plan ran out ('claude_code'). */
  engine: string;
  /** ISO: when the plan works again, or null when nobody said. */
  resetsAt: string | null;
  /** ISO: when the task picks up by itself if nobody taps (resetsAt, or now + 60 min). */
  resumeAt: string;
  otherPlans: PlanLimitOtherPlan[];
  /**
   * Several accounts per engine (spec 2026-10-01 §5.5): how many connected accounts of `engine` the
   * person has. PRESENT ONLY when every one of them was used up when the card was minted; a card
   * shown while another account still had room (a fallback) carries none. The web titles the card
   * "All your … accounts" when it is more than 1. Absent while ENGINE_MULTI_ACCOUNT_V1 is off.
   */
  accountCount?: number;
}

/** The answer rides the ordinary outcome: { behavior: 'allow', updatedInput: { choice } }. */
export type PlanLimitChoice = 'wait' | 'native' | (string & {});

export type InteractionRequest =
  | AskQuestionRequest
  | ComposioAuthRequest
  | ToolPermissionRequest
  | CreditApprovalRequest
  | ExitPlanRequest
  | CustomInteractionRequest
  | HandsApprovalRequest
  | PlanLimitRequest;

// ──────────────────────────────────────────────────────────────────────────────
// Response
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The reason codes surfaced from the frontend back to the model. Kept small and
 * structured so the model can branch on them without parsing free text.
 */
export type InteractionDenyReason =
  /** User sent a fresh text message while this was pending. */
  | 'user_redirected'
  /** User explicitly clicked Deny / Cancel. */
  | 'user_declined'
  /** User clicked Skip — interaction was optional; agent proceeds with defaults. */
  | 'user_skipped'
  /** The browser/WS dropped before the user could answer. */
  | 'aborted'
  /** No-op timeout on the sandbox side (short-lived kinds only). */
  | 'timed_out'
  /** Substrate-v2 sentinel: gateway returned a halt signal so the SDK turn
   *  ends cleanly. Resume is delivered later via [SYSTEM_RESUME]. Callers
   *  inspect this to format their tool result correctly (paused, not aborted). */
  | 'awaiting_user_input';

export type InteractionAllow = {
  behavior: 'allow';
  /**
   * Optional replacement input for the tool call. For AskUserQuestion this
   * carries `{ questions, answers }`. For tool_permission it's typically the
   * original input (or a sanitized variant).
   */
  updatedInput?: unknown;
  /**
   * Optional permission rule to persist ("Always allow" behavior). Written via
   * the SDK's permission-update plumbing; frontend never touches disk.
   */
  addRule?: PermissionSuggestion;
  /**
   * Computer-use S3 — the `HandsApprovalRequest.nonce` echoed back by the
   * resolving client. Only meaningful on kind 'hands_approval': the gate
   * verifies it against the action-bound scope and treats a mismatch/absence
   * as declined.
   */
  nonce?: string;
};

export type InteractionDeny = {
  behavior: 'deny';
  reason: InteractionDenyReason;
  /** Human-readable message the model sees as tool result on deny. */
  message?: string;
};

export type InteractionOutcome = InteractionAllow | InteractionDeny;

export interface InteractionResponse {
  taskId: string;
  interactionId: string;
  outcome: InteractionOutcome;
}

// ──────────────────────────────────────────────────────────────────────────────
// Envelope events (sandbox ↔ server ↔ frontend)
// ──────────────────────────────────────────────────────────────────────────────

/** Sandbox → server → frontend. Carries a newly-created pending interaction. */
export interface InteractionRequiredPayload {
  taskId: string;
  request: InteractionRequest;
  /**
   * Which hook/path minted this interaction. Ridden on the emit so the server's
   * relay can write the durable `interactions` row with the correct `triggered_by`
   * even when the sandbox's own HTTP register drops. OPTIONAL for back-compat with
   * older sandbox bundles (the relay falls back from `request.kind`).
   */
  triggeredBy?: TriggeredBy;
  /**
   * Absolute expiry (epoch ms) the gateway chose at pause time (`Date.now() +
   * ttlForKind(kind)`). Ridden on the emit so the relay's durable register uses
   * the SAME TTL. OPTIONAL for back-compat (the relay falls back to its own
   * `ttlForKind`-derived value).
   */
  expiresAtMs?: number;
}

/** Frontend → server → sandbox. Carries the user's decision. */
export interface InteractionResponsePayload {
  taskId: string;
  interactionId: string;
  outcome: InteractionOutcome;
}

/**
 * K5: server → sandbox CONTINUE trigger (native/openai arms only). The continue
 * driver claims the resolution (continue_state CAS) and wakes the sandbox with this
 * so the kernel materializes the bound `toolUseId`'s result IN PLACE and continues —
 * NOT a [SYSTEM_RESUME] fresh user turn (that stays the Claude arm's path).
 */
export interface ContinueInteractionPayload {
  taskId: string;
  interactionId: string;
  toolUseId: string | null;
  kind: InteractionKind;
  outcome: InteractionOutcome;
  /**
   * P2.4 (subagent-deep-HITL) — OPTIONAL leaf `Agent` tool_use id of the child that
   * paused, carried from the resolved row's `subagent_id`. Forward-provisioning only:
   * WRITE-ONLY today — the sandbox routes a resolution by re-entering the paused child
   * from journal-keyed state, NOT from this field, so nothing consumes it sandbox-side
   * yet. Absent (main-agent) ⇒ omitted from the payload (spread-when-present), keeping
   * the wire byte-identical to today.
   */
  subagentId?: SubagentId;
  /**
   * HITL world-delta (T3) — ms between the pause (interaction `created_at`) and the
   * user's resolution (`resolved_at`), computed ONCE server-side. The native kernel
   * uses it to decide whether to inject a world-delta breadcrumb before the resume
   * drive (a resume can land seconds or DAYS later, possibly on a recycled runner).
   * OPTIONAL, spread-when-present: absent on synthesized rows / when `created_at` is
   * missing, keeping the wire byte-identical to today. `runnerRecycled` is NOT carried
   * here — the sandbox derives it locally from journal warmth (a cold rebuild = fresh
   * process), which the server cannot know.
   */
  elapsedMs?: number;
  /**
   * The engine the task is locked to, as the server launches it (resolveLaunchRuntime of
   * `tasks.runtime`). The box routes a continue by its journal's construction params; this is
   * the server's word to check them against, so an answer on an engine that keeps its own
   * transcript is refused, never sent to native, when those params were lost. Absent from an
   * older server: the box routes by the journal alone, as before.
   */
  runtime?: HarnessId;
  /**
   * Several accounts per engine (spec 2026-10-01): the account slot a claude_code continue runs
   * on, as `UserTurn.engineSlotId` names it for a fresh turn. The SERVER picks it per continue
   * (pickSlot) and sends it only to a runner that declared 'claude_code_slots'. Absent = 'primary'.
   */
  engineSlotId?: string;
  /**
   * The server owns the retry budget (CONTINUE_ATTEMPTS_CAP): true on the LAST delivery it will
   * make of this continue. A box whose continue fails on it ends the turn visibly instead of
   * waiting for a retry that will not come. Absent (any earlier delivery, or an older server):
   * a failed attempt stays quiet and the next delivery re-runs it.
   */
  finalAttempt?: true;
  /**
   * Platform API v1: a company task's context (memory mode, environment, client tools, output schema), the
   * value a USER_MESSAGE's `platform` carries. The box keeps it per task and notes it from each frame; a
   * continue carries no message, so a runner that restarted since the pause would run the continued turn
   * with none of it (its memory mode falling back to Vestra's). The box notes it the same way, before the
   * continue drives. Typed `unknown` here: the shape is @bash/shared/platform's CarriesTaskPlatformContext,
   * which the server's frame is typed by and the USER_MESSAGE shares (the box parses it).
   * Absent for every other task, and from an older server: the last value noted stands, as before.
   */
  platform?: unknown;
}

// ──────────────────────────────────────────────────────────────────────────────
// Triggered-by taxonomy (which hook/path minted this interaction)
// ──────────────────────────────────────────────────────────────────────────────

export type TriggeredBy =
  | 'can_use_tool'        // SDK canUseTool callback (ask_question, tool_permission, exit_plan)
  | 'pre_tool_use_hook'   // SDK PreToolUse hook (composio_auth)
  | 'mcp_tool'            // MCP tool implementation (request_user_input)
  | 'server_gate';        // Server-side gate (fal credit_approval) — orchestrator skips [SYSTEM_RESUME] for these because the gate's HTTP response IS the resume mechanism (caller is already awaiting it).
