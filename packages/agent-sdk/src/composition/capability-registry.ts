/**
 * capability-registry.ts — Phase 4 (§1.7) protected-core toolset narrowing.
 *
 * SCOPE CORRECTION (coordinator review, 2026-07-01): an earlier version of
 * this module also carried an abstract capability-MODULE registry
 * (`CAPABILITY_ORDER`/`PROTECTED_CAPABILITIES`/`resolveExcludedCapabilities`/
 * `assembledCapabilities`) for a top-level Harness-Profile's
 * `excludedCapabilities` list. That machinery had ZERO live callers — no
 * product surface today lets an operator declare excluded capabilities for a
 * profile, so the "protected-core" guarantee it validated was never actually
 * exercised outside its own test file. Rather than ship tested-but-inert
 * validation logic that reads as live enforcement, it was removed. If a real
 * capability-exclusion config surface is built later, re-add it then, wired
 * to that real input.
 *
 * WHAT'S ACTUALLY LIVE: only the `agent` protected-core slot, enforced at
 * AC-R6's per-role TOOLSET-NARROWING filter (agent-tool.ts's `runOneChild`) —
 * see {@link narrowToolsetPreservingProtected}. `filesystem` is deliberately
 * NOT protected at this layer: AC-R6's whole point is letting a role's
 * declared `toolset` be as narrow as it needs (e.g. a pure-research role with
 * no file access at all), so force-including filesystem tools here would
 * undermine that. `agent` (subagent delegation) is different: recursion
 * eligibility is a STRUCTURAL decision the caller already made (via
 * role/depthRemaining/agentDepth) BEFORE a type's toolset is consulted, so a
 * toolset that simply forgot to list `Agent` must not silently strip
 * recursion the caller already granted.
 */

/**
 * The concrete built-in tool name(s) protected from AC-R6 toolset narrowing.
 * Currently just `Agent` — see the module header for why `filesystem` tools
 * are intentionally NOT included here.
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent']);

/**
 * Narrow `builtTools` to `allowedNames`. `preserveProtected: true` keeps every
 * tool in {@link PROTECTED_TOOL_NAMES} that `builtTools` already contains (AC-R6's
 * minimal-necessary-tools narrowing + the `agent` protected-core slot): a type's
 * declared toolset can omit `'Agent'` from its list without losing recursion
 * capability, and can never SILENTLY lose it via narrowing.
 *
 * Under the orchestration walls (spec D2) a toolset means what it says, so
 * `preserveProtected: false` drops `Agent` unless the toolset lists it —
 * delegation is granted by the agent TYPE (`delegates`), never smuggled in by a
 * protected slot.
 */
export function narrowToolset<T extends { name: string }>(
  builtTools: readonly T[],
  allowedNames: readonly string[],
  opts: { preserveProtected: boolean },
): T[] {
  const allowed = new Set(allowedNames);
  return builtTools.filter(
    (t) => allowed.has(t.name) || (opts.preserveProtected && PROTECTED_TOOL_NAMES.has(t.name)),
  );
}

/** The pre-walls shorthand; every flag-off call site keeps using it unchanged. */
export function narrowToolsetPreservingProtected<T extends { name: string }>(
  builtTools: readonly T[],
  allowedNames: readonly string[],
): T[] {
  return narrowToolset(builtTools, allowedNames, { preserveProtected: true });
}
