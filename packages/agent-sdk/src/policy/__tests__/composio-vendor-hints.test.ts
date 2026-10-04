/**
 * VENDOR HINTS ARE THE CLASSIFIER (founder ruling 2026-08-27: "1 is good").
 *
 * Composio tags every tool with MCP hints — readOnlyHint / destructiveHint /
 * updateHint / createHint — and at the catalog the agent actually runs
 * (`version=latest`) they are precise: GMAIL_MOVE_TO_TRASH is an update
 * (recoverable), GMAIL_DELETE_MESSAGE is destructive, GOOGLEDRIVE_EMPTY_TRASH is
 * destructive with no "delete" in its name, JIRA_REMOVE_WATCHER_FROM_ISSUE is an
 * update with a "remove" in its name. Our name rule was wrong in both
 * directions; the vendor's word is right in both.
 *
 * The order, one place (sensitivity-floor `composioVerdict`), consumed by the
 * floor and the classifier alike so they cannot drift:
 *   1. vendor says read-only (head-verb belt)      → readonly
 *   2. the NAME says payment                        → payment   (the vendor has
 *      no payment hint — STRIPE_CREATE_REFUND is "destructive", a charge is
 *      "create" — so money keeps its own rule and beats every tag)
 *   3. vendor answered: destructive?                → dangerous_delete
 *                       else                        → the send/read/mutation
 *                                                     remainder, by name
 *   4. vendor silent (unknown tool, no lookup)      → today's name rule, byte-identical
 * An opaque executor that carries EVERY hint (LINEAR_RUN_QUERY_OR_MUTATION,
 * SUPABASE_BETA_RUN_SQL_QUERY) is destructive: "can destroy" wins "can read".
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  decideToolGate,
  classifySideEffect,
  sensitivityFloorAsks,
  describePermissionAsk,
  composioVerdict,
  vendorReadOnlyVeto,
  collectComposioSlugs,
  type ComposioToolHint,
  type ComposioToolHints,
} from '../../index.js';
import { composioSlugsNeedingHints } from '../composio-vendor-hints.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';

const WS = '/app/workspace';
const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const WORKBENCH = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';
const CONNECTED = new Set(['posthog', 'gmail', 'stripe', 'github', 'googledrive', 'googlecalendar', 'jira', 'linear', 'composio']);

// Real slugs with their REAL latest-catalog tags (census 2026-08-27).
const LIST_OR_DELETE = 'POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS'; // readOnly
const DETAILS = 'POSTHOG_RETRIEVE_PERSON_DETAILS_BY_ID';                     // readOnly
const STRIPE_READ = 'STRIPE_RETRIEVE_CHARGE';                                // readOnly
const EMPTY_TRASH = 'GOOGLEDRIVE_EMPTY_TRASH';                               // destructive — no delete word
const CLEAR_CAL = 'GOOGLECALENDAR_CLEAR_CALENDAR';                           // destructive+update — no delete word
const TRASH = 'GMAIL_MOVE_TO_TRASH';                                         // update (recoverable)
const GMAIL_DELETE = 'GMAIL_DELETE_MESSAGE';                                 // destructive
const WATCHER = 'JIRA_REMOVE_WATCHER_FROM_ISSUE';                            // update — "remove" in the name
const REMOVE_TOKEN = 'GITHUB_CREATE_A_REMOVE_TOKEN_FOR_AN_ORGANIZATION';     // create — "remove" in the name
const LINEAR_RUN = 'LINEAR_RUN_QUERY_OR_MUTATION';                           // every hint at once
const STRIPE_REFUND = 'STRIPE_CREATE_REFUND';                                // destructive (and a payment verb)
const STRIPE_CANCEL = 'STRIPE_CANCEL_SUBSCRIPTION';                          // destructive+update
const SEND = 'GMAIL_SEND_EMAIL';                                             // create
const HEAD_DELETE = 'GITHUB_DELETE_REPO';                                    // (fixture: mis-tagged read-only)
const UNTAGGED_DELETE = 'AIRTABLE_DELETE_RECORD';                            // vendor silent

const hint = (o: Partial<ComposioToolHint>): ComposioToolHint =>
  ({ readOnly: false, destructive: false, update: false, create: false, ...o });
const VENDOR: ComposioToolHints = new Map<string, ComposioToolHint>([
  [LIST_OR_DELETE, hint({ readOnly: true })],
  [DETAILS, hint({ readOnly: true })],
  [STRIPE_READ, hint({ readOnly: true })],
  [EMPTY_TRASH, hint({ destructive: true })],
  [CLEAR_CAL, hint({ destructive: true, update: true })],
  [TRASH, hint({ update: true })],
  [GMAIL_DELETE, hint({ destructive: true })],
  [WATCHER, hint({ update: true })],
  [REMOVE_TOKEN, hint({ create: true })],
  [LINEAR_RUN, hint({ readOnly: true, destructive: true, update: true, create: true })],
  [STRIPE_REFUND, hint({ destructive: true })],
  [STRIPE_CANCEL, hint({ destructive: true, update: true })],
  [SEND, hint({ create: true })],
  [HEAD_DELETE, hint({ readOnly: true })],
]);

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const direct = (slug: string): ToolCall => tool(`mcp__composio__${slug}`, {});
const multi = (...slugs: string[]): ToolCall =>
  tool(META, { tools: slugs.map((s) => ({ tool_slug: s, arguments: {} })) });
const workbench = (code: string): ToolCall => tool(WORKBENCH, { code_to_execute: code });

const classify = (call: ToolCall, hints?: ComposioToolHints) =>
  classifySideEffect(call, { workspaceRoot: WS, composioToolHints: hints });
const floors = (call: ToolCall, hints?: ComposioToolHints) =>
  sensitivityFloorAsks(call, { workspaceRoot: WS, composioToolHints: hints });

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  const ctx: ToolGateContext = {
    mode: 'default', cwd: WS, connectedComposioToolkits: CONNECTED,
    permissionRules: { allow: [], ask: [], deny: [] }, ...extra,
  };
  return decideToolGate(call, ctx);
}

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

// ── the classifier, both directions ───────────────────────────────────────────
describe('classifySideEffect — the vendor\'s word is the classification', () => {
  it('reads named with DELETE are reads (the prod-1ce8193f class)', () => {
    expect(classify(multi(DETAILS, LIST_OR_DELETE))).toBe('dangerous_delete'); // vendor silent: today
    expect(classify(multi(DETAILS, LIST_OR_DELETE), VENDOR)).toBe('readonly');
    expect(classify(direct(STRIPE_READ), VENDOR)).toBe('readonly');
  });

  it('destruction with no DELETE in the name is a delete (today it runs silently)', () => {
    expect(classify(direct(EMPTY_TRASH))).toBe('external_mutation');           // today's silent hole
    expect(classify(direct(EMPTY_TRASH), VENDOR)).toBe('dangerous_delete');
    expect(classify(direct(CLEAR_CAL), VENDOR)).toBe('dangerous_delete');
    expect(classify(multi(DETAILS, EMPTY_TRASH), VENDOR)).toBe('dangerous_delete');
  });

  it('a "remove" that the vendor calls an update is not a delete (false-ask class #2)', () => {
    expect(classify(direct(WATCHER))).toBe('dangerous_delete');                // today: "Permanently delete 1 item from your Jira"
    expect(classify(direct(WATCHER), VENDOR)).toBe('external_mutation');
    expect(classify(direct(REMOVE_TOKEN))).toBe('dangerous_delete');           // github is a delete toolkit, REMOVE verb
    expect(classify(direct(REMOVE_TOKEN), VENDOR)).toBe('external_mutation');
  });

  it('recoverable is not destructive: move-to-trash stays a plain change', () => {
    expect(classify(direct(TRASH))).toBe('external_mutation');
    expect(classify(direct(TRASH), VENDOR)).toBe('external_mutation');
  });

  it('an opaque executor carrying every hint is destructive — "can destroy" beats "can read"', () => {
    expect(classify(direct(LINEAR_RUN), VENDOR)).toBe('dangerous_delete');
  });

  it('money keeps its own rule and beats every tag', () => {
    expect(classify(direct(STRIPE_REFUND), VENDOR)).toBe('payment');           // destructive-tagged, still a payment
    expect(classify(direct(STRIPE_REFUND))).toBe('payment');
    expect(classify(direct(STRIPE_READ))).toBe('payment');                     // vendor silent: today's false payment
    expect(classify(direct(STRIPE_CANCEL))).toBe('external_mutation');
    expect(classify(direct(STRIPE_CANCEL), VENDOR)).toBe('dangerous_delete');
  });

  it('the send/read/mutation remainder is still decided by name — the vendor has no send hint', () => {
    expect(classify(direct(SEND), VENDOR)).toBe('external_send');
    expect(classify(direct(SEND))).toBe('external_send');
  });

  it('vendor silent on a slug ⇒ today\'s name rule, even when a map is present', () => {
    expect(classify(direct(UNTAGGED_DELETE), VENDOR)).toBe('dangerous_delete');
    expect(classify(multi(UNTAGGED_DELETE, DETAILS), VENDOR)).toBe('dangerous_delete');
  });

  it('the read-only belt: a head-verb delete tagged read-only is a contradiction and keeps asking', () => {
    expect(classify(direct(HEAD_DELETE), VENDOR)).toBe('dangerous_delete');
    expect(vendorReadOnlyVeto(HEAD_DELETE, VENDOR)).toBe(false);
    expect(vendorReadOnlyVeto(LIST_OR_DELETE, VENDOR)).toBe(true);
    expect(vendorReadOnlyVeto(LIST_OR_DELETE, undefined)).toBe(false);
  });

  it('a workbench script proxying a destructive-tagged read-named tool', () => {
    expect(classify(workbench(`run_composio_tool("${EMPTY_TRASH}", {})`), VENDOR)).toBe('dangerous_delete');
    expect(classify(workbench(`run_composio_tool("${LIST_OR_DELETE}", {})`), VENDOR)).toBe('readonly');
  });
});

// ── one verdict, two consumers ────────────────────────────────────────────────
describe('composioVerdict — the floor and the classifier read the same table', () => {
  const CASES: Array<[string, string]> = [
    [LIST_OR_DELETE, 'readonly'], [STRIPE_READ, 'readonly'], [EMPTY_TRASH, 'dangerous_delete'],
    [CLEAR_CAL, 'dangerous_delete'], [TRASH, 'remainder'], [GMAIL_DELETE, 'dangerous_delete'],
    [WATCHER, 'remainder'], [REMOVE_TOKEN, 'remainder'], [LINEAR_RUN, 'dangerous_delete'],
    [STRIPE_REFUND, 'payment'], [STRIPE_CANCEL, 'dangerous_delete'], [SEND, 'remainder'],
    [HEAD_DELETE, 'dangerous_delete'], [UNTAGGED_DELETE, 'dangerous_delete'],
  ];
  for (const [slug, verdict] of CASES) {
    it(`${slug} → ${verdict}, and the legacy floor asks iff it is a payment or a delete`, () => {
      expect(composioVerdict(slug, VENDOR)).toBe(verdict);
      expect(floors(direct(slug), VENDOR)).toBe(verdict === 'payment' || verdict === 'dangerous_delete');
    });
  }
  it('with no vendor map every verdict is today\'s name rule', () => {
    expect(composioVerdict(EMPTY_TRASH, undefined)).toBe('remainder');
    expect(composioVerdict(WATCHER, undefined)).toBe('dangerous_delete');
    expect(composioVerdict(STRIPE_READ, undefined)).toBe('payment');
    expect(floors(direct(EMPTY_TRASH))).toBe(false);
    expect(floors(direct(WATCHER))).toBe(true);
  });
});

// ── the gate: what the user sees ──────────────────────────────────────────────
describe('decideToolGate — asks about destruction, stops asking about reads and updates', () => {
  it('Relaxed: emptying the Drive trash now asks; a Jira watcher removal now runs', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(direct(EMPTY_TRASH), { accessLevel: 'relaxed' }).decision).toBe('allow');                 // today's silent hole
    expect(gate(direct(EMPTY_TRASH), { accessLevel: 'relaxed', composioToolHints: VENDOR }).decision).toBe('needs_human');
    expect(gate(direct(WATCHER), { accessLevel: 'relaxed' }).decision).toBe('needs_human');
    expect(gate(direct(WATCHER), { accessLevel: 'relaxed', composioToolHints: VENDOR }).decision).toBe('allow');
  });

  it('Relaxed: the PostHog lookup runs; a real Gmail delete still asks; the trash move runs', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(multi(DETAILS, LIST_OR_DELETE), { accessLevel: 'relaxed', composioToolHints: VENDOR }).decision).toBe('allow');
    expect(gate(multi(GMAIL_DELETE), { accessLevel: 'relaxed', composioToolHints: VENDOR }).decision).toBe('needs_human');
    expect(gate(direct(TRASH), { accessLevel: 'relaxed', composioToolHints: VENDOR }).decision).toBe('allow');
  });

  it('Autopilot: a refund still asks (money), the Stripe read no longer does', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(direct(STRIPE_REFUND), { accessLevel: 'autopilot', composioToolHints: VENDOR }).decision).toBe('needs_human');
    expect(gate(direct(STRIPE_READ), { accessLevel: 'autopilot', composioToolHints: VENDOR }).decision).toBe('allow');
  });

  it('flag-off legacy floor: the same verdicts', () => {
    expect(gate(direct(EMPTY_TRASH), { composioToolHints: VENDOR }).decision).toBe('needs_human');
    expect(gate(direct(WATCHER), { composioToolHints: VENDOR }).decision).toBe('allow');
    expect(gate(direct(LIST_OR_DELETE), { composioToolHints: VENDOR }).decision).toBe('allow');
  });
});

// ── the card ──────────────────────────────────────────────────────────────────
describe('describePermissionAsk — counts the vendor\'s deletes, not the name\'s', () => {
  it('a real delete batched with a DELETE-named read says 1 email, not 2', () => {
    const call = multi(GMAIL_DELETE, LIST_OR_DELETE);
    expect(describePermissionAsk(call, { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' }).headline).toMatch(/delete 2 emails/);
    const withHints = describePermissionAsk(call, { family: 'dangerous_delete', floor: 'hard', level: 'relaxed', composioToolHints: VENDOR });
    expect(withHints.headline).toMatch(/delete 1 email\b/);
    expect(withHints.actionLabel).toBe('Delete 1 email');
  });

  it('emptying the trash is described as a delete of the app\'s items', () => {
    const ask = describePermissionAsk(multi(EMPTY_TRASH), { family: 'dangerous_delete', floor: 'hard', level: 'relaxed', composioToolHints: VENDOR });
    expect(ask.headline).toMatch(/delete 1 item from your Google Drive/);
  });
});

// ── what the sandbox must resolve ─────────────────────────────────────────────
describe('composioSlugsNeedingHints — every real tool the call names, once', () => {
  it('reads included now: the vendor decides, so every slug is worth its word', () => {
    expect(composioSlugsNeedingHints(multi(DETAILS, LIST_OR_DELETE))).toEqual([DETAILS, LIST_OR_DELETE]);
    expect(composioSlugsNeedingHints(direct(SEND))).toEqual([SEND]);
    expect(composioSlugsNeedingHints(workbench(`run_composio_tool("${EMPTY_TRASH}", {})`))).toEqual([EMPTY_TRASH]);
  });

  it('dedupes, and skips Composio\'s own meta layer (no vendor catalog entry to ask for)', () => {
    expect(composioSlugsNeedingHints(multi(DETAILS, DETAILS))).toEqual([DETAILS]);
    expect(composioSlugsNeedingHints(tool('mcp__composio__COMPOSIO_SEARCH_TOOLS', {}))).toEqual([]);
    expect(composioSlugsNeedingHints(tool('mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS', {}))).toEqual([]);
    expect(composioSlugsNeedingHints(tool('mcp__composio__MY_CONNECTIONS', {}))).toEqual([]);
  });

  it('nothing for non-Composio calls or unreadable payloads', () => {
    expect(composioSlugsNeedingHints(tool('Bash', { command: 'rm -rf /' }))).toEqual([]);
    expect(composioSlugsNeedingHints(tool('mcp__other__delete_row', {}))).toEqual([]);
    expect(composioSlugsNeedingHints(tool(META, { tools: 'not-a-list' }))).toEqual([]);
    expect(composioSlugsNeedingHints(workbench('run_composio_tool(slug_var, {})'))).toEqual([]);
  });

  it('collectComposioSlugs is the single slug walk the classifier itself uses', () => {
    expect(collectComposioSlugs(multi(DETAILS, LIST_OR_DELETE))).toEqual([DETAILS, LIST_OR_DELETE]);
    expect(collectComposioSlugs(tool('Read', {}))).toEqual([]);
  });
});
