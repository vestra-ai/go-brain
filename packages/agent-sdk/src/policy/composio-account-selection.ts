/**
 * Composio multi-account selection (design §7) — the ONE pure primitive both
 * gating surfaces compose: the native decideToolGate floor and the Claude-SDK
 * PreToolUse hook. Validates/auto-fills the per-item `account` field INSIDE
 * COMPOSIO_MULTI_EXECUTE_TOOL's tools[] payload — the router's only selection
 * surface (raw per-service tools are not on the router).
 *
 *  - roster undefined  → pass (legacy mode: flag off / old server) — byte-identical.
 *  - 1 ACTIVE account  → auto-fill `account` (the account ID; the wire carries
 *                        ids) when the item has none — zero ceremony (acceptance #4).
 *  - ≥2 ACTIVE accounts→ the item must name an active account by id or alias
 *                        (alias match trimmed, case-insensitive — the router
 *                        resolves aliases natively, so a valid alias passes
 *                        through unchanged); missing/unknown → block with the
 *                        roster named (acceptance #3).
 *  - unconnected / zero-active toolkits → pass: connectivity belongs to the
 *    auth gate (unchanged), and the router's structured 400 (code 4300) is the
 *    loud backstop for anything that slips a stale roster.
 *
 * PURE + TOTAL: no I/O, no state, never throws, never mutates the input call.
 * The roster entry type is a structural mirror of @bash/shared's AccountSummary
 * (the SDK must not import product packages — same doctrine as the inline
 * ToolPermissionReason mirror in contract/interaction.ts).
 */
import type { ToolCall } from '../contract/harness.js';
// F1: the slug-field tolerance and the toolkit split live in composio-naming.ts
// ONLY — the side-effect classifier and this gate read the SAME tools[] payload
// through the same two helpers, so a Composio payload change lands in one place.
import { innerSlugOf, toolkitOfInnerSlug } from './composio-naming.js';

export interface AccountRosterEntry {
  id: string;
  alias: string | null;
  status: string;
}

export type AccountRoster = ReadonlyMap<string, readonly AccountRosterEntry[]>;

export type AccountSelectionVerdict =
  | { kind: 'pass' }
  | { kind: 'fill'; updatedInput: Record<string, unknown> }
  | { kind: 'block'; message: string };

const MULTI_EXECUTE_TOOL = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';

/** Internal control-flow carrier so one offending item aborts the whole map. */
class BlockSignal extends Error {}

/**
 * "gmail: \"work\" (ca_1), \"personal\" (ca_2)" — null aliases get positional labels.
 *
 * `accounts` is what gets SHOWN (the active slice at both block sites); `all` is
 * the numbering BASIS and defaults to it. Pass the toolkit's whole roster entry
 * to number an unaliased account by its position among ALL its siblings,
 * including expired/pending ones that are never shown: that is the convention
 * the server's `displayAccountName` uses for the label the user reads on screen
 * ("gmail #3"), and the one the runner's connected_accounts prompt layer uses.
 * Numbering over the active-only slice instead gives one account two names —
 * "Gmail #3" in the UI and the prompt, "gmail account 2" in this block message.
 */
export function describeAccountRoster(
  toolkit: string,
  accounts: readonly AccountRosterEntry[],
  all: readonly AccountRosterEntry[] = accounts,
): string {
  const parts = accounts.map((a) =>
    a.alias
      ? `"${a.alias}" (${a.id})`
      : `${toolkit} account ${all.findIndex((x) => x.id === a.id) + 1} (${a.id})`);
  return `${toolkit}: ${parts.join(', ')}`;
}

function blockMissing(
  toolkit: string,
  active: readonly AccountRosterEntry[],
  all: readonly AccountRosterEntry[],
): string {
  return (
    `Multiple ${toolkit} accounts are connected. Add an "account" field to each ` +
    `${toolkit} item in tools[] (object items only), naming the account id or its label. ` +
    `Connected: ${describeAccountRoster(toolkit, active, all)}. ` +
    `To look something up, add one item per account and go with the one that finds it. ` +
    `If it is genuinely unclear which account the user means, ask once and reuse the answer for this task. ` +
    `If the user wants an account that is not listed, it is not connected yet.`
  );
}

function blockUnknown(
  toolkit: string,
  value: string,
  active: readonly AccountRosterEntry[],
  all: readonly AccountRosterEntry[],
): string {
  return (
    `"${value}" does not match any connected ${toolkit} account. ` +
    `Connected: ${describeAccountRoster(toolkit, active, all)}. ` +
    `Pass one of these ids or labels. If the user wants a different ${toolkit} account, ` +
    `it is not connected yet.`
  );
}

export function resolveAccountSelection(
  call: ToolCall,
  roster: AccountRoster | undefined,
): AccountSelectionVerdict {
  try {
    if (!roster) return { kind: 'pass' };
    if (!call || call.toolName !== MULTI_EXECUTE_TOOL) return { kind: 'pass' };
    const input = call.toolInput;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'pass' };
    const tools = (input as Record<string, unknown>).tools;
    if (!Array.isArray(tools) || tools.length === 0) return { kind: 'pass' };

    let filled = false;
    const rewritten = tools.map((entry) => {
      const rawSlug = innerSlugOf(entry);
      if (rawSlug === null) return entry; // unreadable item: total-pass; router backstops
      const toolkit = toolkitOfInnerSlug(rawSlug);
      const accounts = roster.get(toolkit);
      if (!accounts) return entry; // unconnected toolkit: auth gate's job, unchanged
      const active = accounts.filter((a) => a.status === 'active');
      if (active.length === 0) return entry; // reconnect problem: auth surfaces own it

      const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
      // OWN property only: an `account` reached through the prototype chain is not
      // the model's choice, and treating one as a selection would route a
      // multi-account call to whatever the prototype carried — the exact silent
      // mis-routing the block exists to prevent. Absent own field ⇒ unselected.
      const accountValue =
        isObject && Object.prototype.hasOwnProperty.call(entry, 'account')
          ? (entry as Record<string, unknown>).account
          : undefined;

      if (accountValue === undefined || accountValue === null || accountValue === '') {
        if (active.length === 1) {
          if (!isObject) return entry; // a bare-string item on a single-account toolkit: router accepts it as-is
          filled = true;
          return { ...(entry as Record<string, unknown>), account: active[0].id };
        }
        throw new BlockSignal(blockMissing(toolkit, active, accounts));
      }

      if (active.length >= 2) {
        const value = typeof accountValue === 'string' ? accountValue : String(accountValue);
        const needle = value.trim().toLowerCase();
        const matches = active.some(
          (a) => a.id === value.trim() || (a.alias !== null && a.alias.trim().toLowerCase() === needle),
        );
        if (!matches) throw new BlockSignal(blockUnknown(toolkit, value, active, accounts));
      }
      return entry;
    });

    if (filled) {
      return { kind: 'fill', updatedInput: { ...(input as Record<string, unknown>), tools: rewritten } };
    }
    return { kind: 'pass' };
  } catch (err) {
    if (err instanceof BlockSignal) return { kind: 'block', message: err.message };
    return { kind: 'pass' }; // total: an unexpected shape must never wedge the gate
  }
}
