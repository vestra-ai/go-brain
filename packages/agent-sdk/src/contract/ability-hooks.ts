/**
 * K6-P2 B6 — per-ability HOOK DECLARATIONS (the authoring contract).
 *
 * An ability/skill may declare shell-command hooks in its SKILL.md frontmatter
 * using the EXACT Claude Code shape:
 *
 *   hooks:
 *     PreToolUse:
 *       - matcher: "Bash"
 *         hooks:
 *           - type: command
 *             command: "${ABILITY_ROOT}/scripts/guard.sh"
 *             timeout: 5
 *
 * `command` references a script in the ability dir via `${ABILITY_ROOT}` (our
 * analogue of Claude Code's `${CLAUDE_PLUGIN_ROOT}`). The declaration is PARSED
 * here into a typed structure; the SANDBOX layer turns each `{command,timeout}`
 * into a kernel `HookCallback` that execs it (the kernel never execs — purity).
 *
 * TRUST (the Vestra differentiator): this module only PARSES. WHETHER a parsed
 * hook is registered is decided by the trust gate in the sandbox layer
 * (`mayRegisterAbilityHooks`) — ONLY scope='system'/trusted abilities register;
 * a library/marketplace/user ability's hooks are parsed but skipped (the K6.5
 * seam). The per-hook `attenuation` field below is the inert K6.5 seam for
 * per-hook capability attenuation ("authority = attenuating-data") — neither
 * Claude Code nor Hermes offers it.
 *
 * PURITY: this module imports only sibling types. No provider SDK, no fs, no exec.
 */

/**
 * The hook events an ability may declare on. A SUBSET of the kernel's
 * {@link import('@bash/kernel').HookEvent} union — intentionally EXCLUDES the
 * Subagent* events: an ability may not intercept subagent lifecycle (parity with
 * Claude Code's "an agent definition may not declare hooks" rule, enforced in the
 * sandbox layer). Casing matches Claude Code exactly so a hand-authored block
 * round-trips byte-for-byte.
 */
export type AbilityHookEvent =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd';

/** The events an ability is ALLOWED to declare (registration whitelist). The
 *  Subagent* events are deliberately absent — see {@link AbilityHookEvent}. */
export const ABILITY_HOOK_EVENTS: readonly AbilityHookEvent[] = [
  'PreToolUse',
  // X1: dispatched only under HOOK_PARITY_V1 (engine/hook-parity.ts); a declared one is
  // registered but inert while the flag is off.
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'Stop',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
] as const;

/**
 * One declared shell-command hook. Mirrors Claude Code's
 * `{ type: 'command', command, timeout? }`. `command` may contain `${ABILITY_ROOT}`,
 * resolved at exec time to the ability's materialized dir.
 *
 * `attenuation` is the INERT K6.5 seam: per-hook capability attenuation. Unused in
 * B6 — the parser preserves it when present so K6.5 can attenuate a hook's
 * authority per the "authority = attenuating-data" axiom. Declaring it changes
 * NOTHING today.
 */
export interface AbilityHookCommand {
  type: 'command';
  command: string;
  /** Timeout in SECONDS (Claude Code convention). Optional. */
  timeout?: number;
  /**
   * K6.5 SEAM (inert in B6). Opaque per-hook capability attenuation — the set of
   * capabilities this hook's authority is narrowed to. Carried through parse →
   * register so K6.5 can enforce it without a schema change. Never read in B6.
   */
  attenuation?: unknown;
}

/**
 * X6 (harness to nine): a hook that hands the agent words instead of running a script. `prompt`
 * adds its text at the event (before the turn, after a batch of tools, at the stop); `agent`
 * adds the same text phrased as a job for a helper the agent spawns with the Agent tool. Parsed
 * always; registered only under PROMPT_HOOKS_V1 (the sandbox layer), so an unflagged box ignores
 * them as it always has.
 */
export interface AbilityPromptHook {
  type: 'prompt' | 'agent';
  prompt: string;
}

/** A matcher group: an optional matcher regex + the commands. Mirrors Claude
 *  Code's `{ matcher?, hooks: [...] }`. */
export interface AbilityHookGroup {
  /** Regex tested against the dispatch key (tool_name for tool events). Absent = always. */
  matcher?: string;
  hooks: AbilityHookCommand[];
  /** X6: the group's prompt and agent hooks, beside its commands. Absent = none. */
  prompts?: AbilityPromptHook[];
}

/** The full per-ability hook config: event → ordered matcher groups. The Claude
 *  Code `hooks:` block, typed. */
export type AbilityHookConfig = Partial<Record<AbilityHookEvent, AbilityHookGroup[]>>;

/** Quick membership test used by the parser + the sandbox registrar. */
export function isAbilityHookEvent(s: string): s is AbilityHookEvent {
  return (ABILITY_HOOK_EVENTS as readonly string[]).includes(s);
}

/**
 * The `${ABILITY_ROOT}`-anchored paths a declared command references.
 *
 * ONE definition, deliberately, because two consumers must agree byte-for-byte:
 *  - the sandbox registrar (`declaredScriptsExist`), which refuses to register a
 *    hook whose script is not on disk — a missing script exits 2 under dash, the
 *    BLOCK code, so it would DENY the tool rather than fall through; and
 *  - the CI guard over the committed seed
 *    (apps/reconciler/tests/unit/ability-hook-declarations.test.ts).
 * A second, subtly different regex in either place would let one accept a path the
 * other rejects — silently disabling a working hook, or shipping a broken one.
 *
 * Stops at shell metacharacters and quotes, because `command` is a shell string:
 * `node ${ABILITY_ROOT}/x.mjs; echo hi` references `/x.mjs`, not `/x.mjs;`.
 * PURE: string in, strings out. A command with no reference yields `[]`.
 */
export function abilityHookScriptRefs(command: string): string[] {
  if (typeof command !== 'string' || command.length === 0) return [];
  return [...command.matchAll(/\$\{ABILITY_ROOT\}(\/[^\s'"`;|&()<>]+)/g)].map((m) => m[1] as string);
}

/**
 * Parse a raw `hooks:` value (from skill/ability metadata jsonb or YAML) into a
 * typed {@link AbilityHookConfig}. TOTAL + lenient: unknown events are dropped,
 * malformed groups/commands are dropped, a non-object input yields `undefined`.
 * Never throws.
 *
 * The result contains ONLY well-formed `{ type:'command', command:string }`
 * commands on KNOWN, ALLOWED events. An event present but with no surviving
 * commands is omitted. An entirely-empty result yields `undefined` so a caller
 * can treat "no hooks" as falsy.
 *
 * NOTE: this does NOT enforce trust or the subagent rule — those are sandbox-layer
 * concerns (the kernel/shared layer is provider- and policy-neutral).
 */
export function parseAbilityHooks(raw: unknown): AbilityHookConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: AbilityHookConfig = {};
  for (const [event, groupsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAbilityHookEvent(event)) continue;
    const groups = parseGroups(groupsRaw);
    if (groups.length > 0) out[event] = groups;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseGroups(raw: unknown): AbilityHookGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: AbilityHookGroup[] = [];
  for (const g of raw) {
    if (g === null || typeof g !== 'object') continue;
    const rec = g as Record<string, unknown>;
    const commands = parseCommands(rec.hooks);
    const prompts = parsePrompts(rec.hooks);
    if (commands.length === 0 && prompts.length === 0) continue; // nothing usable: dropped
    const group: AbilityHookGroup = { hooks: commands };
    if (prompts.length > 0) group.prompts = prompts;
    if (typeof rec.matcher === 'string' && rec.matcher.length > 0) group.matcher = rec.matcher;
    groups.push(group);
  }
  return groups;
}

/** X6: the well-formed `{ type: 'prompt' | 'agent', prompt }` entries, in order. */
function parsePrompts(raw: unknown): AbilityPromptHook[] {
  if (!Array.isArray(raw)) return [];
  const out: AbilityPromptHook[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    if (rec.type !== 'prompt' && rec.type !== 'agent') continue;
    if (typeof rec.prompt !== 'string' || rec.prompt.trim().length === 0) continue;
    out.push({ type: rec.type, prompt: rec.prompt });
  }
  return out;
}

function parseCommands(raw: unknown): AbilityHookCommand[] {
  if (!Array.isArray(raw)) return [];
  const cmds: AbilityHookCommand[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    // Only the 'command' hook type is supported (the only type that maps to a
    // sandbox-exec callback). Anything else is dropped.
    if (rec.type !== 'command') continue;
    if (typeof rec.command !== 'string' || rec.command.length === 0) continue;
    const cmd: AbilityHookCommand = { type: 'command', command: rec.command };
    if (typeof rec.timeout === 'number' && rec.timeout > 0) cmd.timeout = rec.timeout;
    // Preserve the inert K6.5 attenuation seam verbatim when present.
    if (rec.attenuation !== undefined) cmd.attenuation = rec.attenuation;
    cmds.push(cmd);
  }
  return cmds;
}
