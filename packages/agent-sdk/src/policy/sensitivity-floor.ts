/**
 * THE SENSITIVITY FLOOR.
 *
 * A small, explicit taxonomy of the actions that must ALWAYS prompt a human —
 * even under `bypassPermissions`, even if an allow rule would otherwise match.
 * The floor sits in `decideToolGate` BEFORE the mode step, so `bypassPermissions`
 * / `acceptEdits` / an allow rule can NEVER collapse it.
 *
 * LOCKED SCOPE (founder directive 2026-06-17): "Allow everything except payments
 * and rm rf." The baseline floor carries EXACTLY two classes:
 *
 *   - PAYMENTS — stripe/paypal/… charge/transfer/refund/payout/withdraw.
 *   - DELETES  — Bash delete OPERATIONS (see the operation taxonomy below), mcp
 *                delete/remove/purge, cloud/VCS DELETE.
 *
 * EVERYTHING ELSE is allowed silently by default. In particular:
 *
 *   - SENDS (email / Slack / messages / posts / publishes) NO LONGER floor.
 *   - LOGINS are handled by the composio_auth classifier (an unconnected toolkit
 *     already prompts), so they are not counted here.
 *   - SHELL is the EXCEPTION to "allowed silently": under the default-ON gate
 *     (VESTRA_BASH_AST_GATE) a DANGEROUS delete floors in ANY command position.
 *     What counts as a delete is an OPERATION, never a spelling — a filesystem
 *     removal (rm/rmdir/unlink/shred), an HTTP DELETE, a `find … -delete`, a
 *     move onto /dev/null (see the operation taxonomy block below). Only the
 *     filesystem shape is narrowed: with a RECURSIVE flag, a glob target, or a
 *     target escaping the workspace it floors (rm narrowing, founder ruling
 *     2026-07-06), while a PLAIN in-workspace specific-file delete runs silently
 *     — including a FORCE-only `rm -f <in-workspace file>` (founder ruling
 *     2026-09-03: force alone never widens the target set). A command the
 *     analyzer cannot confidently enumerate (unbalanced quotes, a command word
 *     made by a substitution) floors when it carries a delete token, an HTTP
 *     DELETE tell, a recursive/force flag token, or an UNQUOTED glob metachar;
 *     subshells and `$(…)` are read position by position since 2026-09-25. A
 *     documented `rm` inside a heredoc body still never floors. With the
 *     kill-switch OFF (`VESTRA_BASH_AST_GATE=0`) the legacy head-only behavior
 *     applies (only an `rm`/`rmdir` at a command head floors). See the BASH
 *     POSITION COVERAGE block below.
 *
 * This is the BASELINE floor only. A stricter permission MODE the user opts into
 * is a separate mechanism (handled in `decideToolGate`'s mode step) and is NOT
 * governed by this module.
 *
 * WRITES ARE NOT FLOORED. File writes (Write/Edit/NotebookEdit/MultiEdit, Bash
 * `>`/`>>` redirection) are an agent's CORE WORK, not an irreversible external
 * action. Writes are MODE-GOVERNED instead: `acceptEdits` auto-allows edits,
 * `plan` routes them to a human, `bypassPermissions` / the classifier default
 * auto-allows. (Genuinely dangerous writes — `.env`, SSH keys, system files —
 * are still blocked at the SECURITY gate above the floor; that is unchanged.)
 *
 * BASH POSITION COVERAGE (VESTRA_BASH_AST_GATE, default ON). The floor
 * enumerates EVERY command position via the shared command analyzer, so a
 * DANGEROUS delete reachable through backgrounding, process substitution, a
 * path prefix, a wrapper (`xargs rm`), or an `sh -c` body all floor — while a
 * plain in-workspace specific-file delete is silent in every one of those
 * positions (rm narrowing; see isDangerousDelete for the exact dangerous/safe
 * boundary and its SAFETY INVARIANT: doubt → ask). When the analyzer cannot
 * confidently enumerate the command it asks on a delete token, an HTTP DELETE
 * tell, a recursive/force flag token, or an unquoted glob metachar (see
 * unparseableDeleteRisk — including the fragmented-rm class the security
 * regexes do NOT backstop). It still never false-floors a heredoc body that
 * DOCUMENTS "rm -rf" as prose (bodies are stripped first) and never
 * substring-matches inside a word (`perform`, `rm.txt`). With the gate OFF
 * the prior head-only behavior is preserved byte-identically.
 *
 * PAYMENTS / DELETES on Composio use an explicit PER-TOOLKIT taxonomy, not a
 * fragile regex — a list is not a charge. A future editor extends the lists in
 * THIS module (the single documented home).
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

import type { ToolCall } from '../contract/harness.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { splitShellSegments } from './shell-split.js';
import {
  analyzeCommand,
  normalizeHead,
  removeQuotes,
  expandsUnquoted,
  DESTRUCTIVE_SHELL_VERBS,
  SHELL_WORD_DELIMITERS,
  headUnresolvable,
  runsUnreadCode,
  type CommandNode,
} from './command-analyzer.js';
import { segmentMutatesHead } from './write-tool-taxonomy.js';
import { bashAstGateEnabled } from './feature-flags.js';
import { containsUnquotedGlob } from './unquoted-glob.js';
import { stripHeredocBodies } from './heredoc-bodies.js';
import { gitCommandFamily } from './git-command-catalog.js';
import { shellStdinCode } from './shell-stdin-code.js';

export { stripHeredocBodies };

// ═══════════════════════════════════════════════════════════════════════════
// Composio action taxonomy — explicit, NOT regex-guessed.
//
// Keyed by lowercase toolkit slug. SENDS are intentionally absent: the founder
// directive allows sends silently. Extend these as new PAYMENT / DELETE surfaces
// are added.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Toolkits whose actions are money movements. Values = explicit verbs that move
 * money. Exported so the side-effect classifier (access-level ladder) reuses the
 * SAME payment taxonomy the floor asks on — one list, no drift.
 */
export const COMPOSIO_PAYMENT_TOOLKITS: ReadonlySet<string> = new Set([
  'stripe',
  'paypal',
  'square',
  'wise',
  'coinbase',
  'plaid',
  'razorpay',
  'braintree',
  'adyen',
]);

/**
 * Toolkits whose DELETE/REMOVE/PURGE actions floor (cloud + VCS — destructive).
 * Exported for the side-effect classifier's `dangerous_delete` classification.
 */
export const COMPOSIO_DELETE_TOOLKITS: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'bitbucket',
  'aws',
  'gcp',
  'azure',
  'cloudflare',
  'digitalocean',
]);

/**
 * The REMOVAL subset of the analyzer's shared `DESTRUCTIVE_SHELL_VERBS` — the
 * shell verbs whose whole job is to make a file stop existing. Derived from the
 * union (not hand-listed beside it) so a future edit dropping one from the union
 * drops it here too, and the verb-union invariant test keeps catching that.
 *
 * dd/mkfs/chmod/chown/truncate stay OUT: they are governed by the security-gate
 * layer above the floor, not by "deletions always ask".
 *
 * Exported so the card describer (describe-tool) enumerates the SAME verbs the
 * guard judges — one list, no drift.
 */
export const FILESYSTEM_DELETE_VERBS: ReadonlySet<string> = new Set(
  ['rm', 'rmdir', 'unlink', 'shred'].filter((v) => DESTRUCTIVE_SHELL_VERBS.has(v)),
);

/** Money-movement verbs (matched as a word in the Composio action suffix). Exported for the classifier. */
export const PAYMENT_VERBS: readonly string[] = ['CHARGE', 'TRANSFER', 'REFUND', 'PAYOUT', 'WITHDRAW'];

/** Destructive verbs (matched as a word in the Composio action suffix). Exported for the classifier. */
export const DELETE_VERBS: readonly string[] = ['DELETE', 'REMOVE', 'PURGE'];

/**
 * The union of all FLOORED verbs — the fallback for UNKNOWN toolkits (no
 * explicit list) and the generic non-composio MCP path. Per the founder
 * directive this is PAYMENTS + DELETES only; SENDS are NOT floored. Any one of
 * these appearing as a whole `_`-delimited word in the action floors.
 */
const FLOOR_VERBS: readonly string[] = [...PAYMENT_VERBS, ...DELETE_VERBS];

// ═══════════════════════════════════════════════════════════════════════════
// public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the floor decision. Injected by the gate (decideToolGate) — the
 * floor itself stays pure.
 */
export interface SensitivityFloorOptions {
  /**
   * Absolute workspace root (the gate cwd, config.workingDir — `/app/workspace`
   * in the sandbox). Used by the rm narrowing to judge whether a delete's
   * absolute targets stay inside the workspace. Absent → absolute targets
   * cannot be vouched for and ask.
   */
  workspaceRoot?: string | undefined;
  /**
   * The LIVE persisted shell cwd for this session's terminal (TerminalSession
   * carries `cd` across Bash calls, so a relative delete in call 2 executes
   * wherever call 1 left the shell — NOT necessarily the workspace root).
   * Relative delete targets are resolved against THIS value and must land
   * under `workspaceRoot`.
   *   - string → the live cwd (peekSessionCwd, or the seed root when no
   *     session exists yet — nothing has cd'd).
   *   - null   → the gate TRIED to determine it and could not → relative
   *     deletes ask (doubt → ask).
   *   - ABSENT → the caller does not track a live cwd (direct/unit callers);
   *     relative targets are assumed to resolve under the gate cwd. The
   *     production port always supplies a string or null.
   */
  shellCwd?: string | null | undefined;
  /**
   * The VENDOR's MCP hints for this call's Composio slugs (`composioVerdict`).
   * Absent, or silent on a slug ⇒ the name rule stands byte-identically.
   */
  composioToolHints?: ComposioToolHints | undefined;
}

/**
 * Does this call cross the sensitivity floor (so it must ask a human)?
 *
 * Total — any unexpected shape degrades to `false` (allowed). The floor returns
 * `true` when a recognized PAYMENT or DANGEROUS-DELETE surface is hit. With the
 * Bash AST gate ON (default): a parseable delete asks only when it is DANGEROUS
 * (recursive/force flag, glob target, or a target escaping the workspace —
 * founder ruling 2026-07-06); an unparseable command asks when it carries a
 * delete token, a recursive/force flag token, or a glob metachar. With the gate
 * OFF the legacy head-only behavior holds byte-identically.
 */
export function sensitivityFloorAsks(call: ToolCall, opts?: SensitivityFloorOptions): boolean {
  try {
    if (!call || typeof call.toolName !== 'string') return false;
    const tool = call.toolName;

    // (Builtin write tools are NOT floored — writes are mode-governed; see the
    //  module header. Only payments + deletes floor.)

    // 1. Bash — enumerate every command position (AST gate ON, default) and
    //    floor a DELETE (rm/rmdir) position only when it is DANGEROUS (see
    //    isDangerousDelete). Heredoc bodies are stripped first, so a body
    //    documenting "rm -rf" never floors. Redirections `>`/`>>` are writes →
    //    NOT floored. (Gate OFF → legacy head-only scan; see bashFloors.)
    if (tool === 'Bash' || tool === 'PowerShell') {
      return bashFloors(getCommand(call.toolInput), opts?.workspaceRoot, opts?.shellCwd);
    }

    // 1b. Patch — a V4A envelope can `*** Delete File:` / `*** Move File:` (a move
    //     removes the source). Those are DELETES and must floor exactly like a Bash
    //     `rm`, even under bypassPermissions (founder-locked "deletes always ask").
    //     Pure-write patches (Update/Add only) do NOT floor — writes are mode-governed.
    if (tool === 'Patch') {
      return patchFloors(getPatchInput(call.toolInput));
    }

    // 2. Composio tools — explicit payment/delete toolkits + unknown-toolkit
    //    payment/delete verb fallback. Sends are NOT floored.
    if (tool.startsWith(COMPOSIO_TOOL_PREFIX)) {
      return composioFloors(tool, opts?.composioToolHints);
    }

    // 3. Generic (non-composio) MCP tools (`mcp__server__action`) — route the
    //    ACTION segment through the whole-word verb matcher over PAYMENT +
    //    DELETE verbs. `__delete` / `__charge` floor; `__publish` / `__send`
    //    (sends) and non-verbs do not.
    if (tool.startsWith('mcp__')) {
      return hasVerbWord(mcpActionSegment(tool), FLOOR_VERBS);
    }

    return false;
  } catch {
    // Total: never throw out of the floor. On error, default to NOT flooring so
    // a genuinely broken input can't wedge every tool.
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// internals
// ═══════════════════════════════════════════════════════════════════════════

function getCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).command;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** The `input` string of a `Patch` call (the V4A envelope), or null. */
function getPatchInput(input: unknown): string | null {
  if (input && typeof input === 'object' && 'input' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).input;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/**
 * A Patch floors when its envelope declares any `*** Delete File:` or `*** Move
 * File:` op (a move removes its source = a delete). Update/Add-only patches are
 * pure writes and do NOT floor. Matched on the structural marker at a line head
 * (the `m` flag), mirroring how `*** <Verb> File:` is parsed.
 */
// Exported so the side-effect classifier maps a delete/move Patch envelope to
// `dangerous_delete` (and a pure-write one to `workspace_write`) with the SAME
// structural check the floor uses.
export function patchFloors(input: string | null): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  return /^\*\*\*\s*(Delete|Move)\s+File:/m.test(input);
}

/**
 * A Bash command floors when ANY enumerated command position is a DANGEROUS
 * DELETE (see isDangerousDelete) — including positions the legacy head-only
 * scan missed: backgrounded (`… & rm -rf x`), process-substituted
 * (`<(rm -rf x)`), path-prefixed (`/bin/rm -rf x`), wrapper-invoked
 * (`xargs rm`), and `sh -c "rm -rf x"` bodies. A PLAIN in-workspace
 * specific-file delete runs silently (rm narrowing, founder ruling
 * 2026-07-06). Redirections (`>`/`>>`) are WRITES — not floored.
 *
 * Flag-gated (`VESTRA_BASH_AST_GATE`, default ON). OFF → delegate to
 * `legacyBashFloors` (byte-identical to the prior head-only behavior). ON →
 * consume the shared command analyzer; when it cannot confidently enumerate
 * the command (`parsedSafely: false`) the floor asks if the command carries a
 * delete token, a recursive/force flag token, or a glob metachar (see
 * unparseableDeleteRisk), or if a position it did read deletes (unparseableFloors).
 *
 * HEREDOC SAFETY: `stripHeredocBodies` runs FIRST so a documented `rm` inside a
 * here-document body (data written to a file, never executed) does not floor.
 *
 * The floor's BASELINE stays `rm`/`rmdir` (today's documented DELETE class): it
 * intersects the analyzer's shared `DESTRUCTIVE_SHELL_VERBS` union with that
 * baseline. dd/mkfs/chmod/… are governed by the separate security-gate layer,
 * not this floor.
 */
function bashFloors(
  command: string | null,
  workspaceRoot?: string,
  shellCwd?: string | null,
): boolean {
  if (command === null) return false;
  if (!bashAstGateEnabled()) return legacyBashFloors(command); // byte-identical when OFF
  const stripped = stripHeredocBodies(command); // documented rm in a heredoc body must not floor
  const analysis = analyzeCommand(stripped);
  const words = joinContinuedLines(stripped);
  const git = gitCommandFamily(analysis, words); // a force push, a gh delete, a git command it cannot read
  if ((git !== null && git !== 'external_mutation') || shellStdinCode(command).some((code) => bashFloors(code, workspaceRoot, shellCwd))) return true;
  if (!analysis.parsedSafely) return unparseableFloors(analysis.commands, words);
  if ((analysis.nested || analysis.assigns) && nestedKeepsOldVerdict(analysis.commands, words)) return true;
  // Resolve the effective cwd at EACH position (order-aware). A clean absolute
  // `cd` moves the cwd to a KNOWN place (so an in-workspace `cd /app/workspace/x`
  // then `rm scratch/y` is contained and silent), while any opaque cwd move —
  // relative/`$VAR`/no-arg cd, pushd/popd/builtin/eval/source/dot/brace-group —
  // leaves the cwd unknowable from that point on (moved → relative deletes ask).
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const cwds = cwdStatesPerPosition(analysis.commands, shellCwd);
  return analysis.commands.some((c, i) => positionFloors(c, root, cwds[i].moved, cwds[i].cwd));
}

/**
 * Does ONE enumerated command position perform a delete the floor asks about?
 * THE single site that answers it — `bashFloors` and the family classifier
 * (`classifyBashPosition`) both consume it, so the guard and the access-level
 * ladder can never disagree about what a position does.
 *
 * A filesystem removal is subject to the rm narrowing (a plain, specific,
 * in-workspace delete runs silently). Every OTHER delete shape floors
 * unconditionally: an HTTP DELETE leaves the machine entirely (there is no
 * workspace to contain it against), a `find -delete` removes a matched SET, and
 * a move onto /dev/null destroys its source.
 */
function positionFloors(
  c: CommandNode,
  root: string | null,
  cwdMoved: boolean,
  shellCwd: string | null | undefined,
): boolean {
  const shape = bashPositionDeleteShape(c);
  if (shape === 'filesystem') return isDangerousDelete(c, root, cwdMoved, shellCwd);
  if (shape !== null) return true;
  // An unresolvable executable (`$RM_CMD -rf /` — the head is a variable
  // expansion we cannot resolve statically) carrying a RECURSIVE flag: we
  // cannot know what will run, and recursion is the dangerous-delete tell.
  // An unquoted expansion anywhere in the word counts here too: it word-splits,
  // so `$D/x -rf /etc` with D="rm -rf /etc #" runs rm.
  const unknown = headUnresolvable(c) || expandsUnquoted(c.rawHead);
  return unknown && c.argv.some((t) => HIDDEN_VERB_RECURSION_FLAG.test(removeQuotes(t)));
}

/**
 * The `$`-head tell: RECURSIVE_FORCE_FLAG_TOKEN's recursive bundles without a
 * lone `--force`. On the readable path force alone never widens a delete
 * (founder ruling 2026-09-03), as the lone `-f` stopped being a tell on
 * 2026-08-10. Prod 2026-09-25: `"$WMR" video "$SRC" --force -o out.mp4` asked
 * "Delete files". The unparseable path keeps `--force` (a fragmented verb).
 */
const HIDDEN_VERB_RECURSION_FLAG = /^(?:--recursive|-[rR][rRf]|-f[rR])$/;

/**
 * The side-effect family a Bash/PowerShell command carries, for the access-level
 * classifier. A strict subset of the classifier's `SideEffectFamily`: bash never
 * sends or pays; the one remote it changes is git's (git-command-catalog).
 */
export type BashSideEffect = 'readonly' | 'workspace_write' | 'external_mutation' | 'dangerous_delete' | 'unknown' | 'protected_remote';

const BASH_SEVERITY: Record<BashSideEffect, number> = { readonly: 0, workspace_write: 1, external_mutation: 2, dangerous_delete: 3, unknown: 4, protected_remote: 5 };

/**
 * Classify a Bash/PowerShell command into its side-effect family — the
 * classifier's view of the SAME analysis `bashFloors` performs, so a command the
 * floor would ask about is never classified milder than `dangerous_delete`. It
 * REUSES the floor's exact dangerous-delete internals (heredoc strip → analyzer
 * → per-position `isDangerousDelete`, the `$`-head recursive-flag tell, and the
 * unparseable `unparseableDeleteRisk` scan) rather than re-deriving them — the
 * one place that judgment lives.
 *
 * Beyond deletes it adds a read/write split for the remaining positions via the
 * write taxonomy (`segmentMutatesHead`): a read-only head is `readonly`, anything
 * else is `workspace_write`. The MOST SEVERE family across positions wins, and an
 * unparseable command never resolves to `readonly` (fail toward asking).
 *
 * Uses the analyzer unconditionally (the production default `VESTRA_BASH_AST_GATE`
 * posture); it is only ever called under `ACCESS_LEVELS_V1`, a separate opt-in.
 * PURE / TOTAL / NEVER-THROWS.
 */
export function classifyBashCommand(
  command: string | null,
  workspaceRoot?: string,
  shellCwd?: string | null,
): BashSideEffect {
  if (command === null) return 'readonly'; // no command → no side effect
  const stripped = stripHeredocBodies(command); // documented rm in a heredoc body is data, not a delete
  const analysis = analyzeCommand(stripped);
  const words = joinContinuedLines(stripped);
  // A floor under every verdict below: the git family, and the code a stdin-fed shell runs (shell-stdin-code).
  const floor = [gitCommandFamily(analysis, words), ...shellStdinCode(command).map((code) => classifyBashCommand(code, workspaceRoot, shellCwd))]
    .reduce<BashSideEffect | null>((a, f) => (f !== null && (a === null || BASH_SEVERITY[f] > BASH_SEVERITY[a]) ? f : a), null);
  const atLeast = (f: BashSideEffect): BashSideEffect => (floor !== null && BASH_SEVERITY[floor] > BASH_SEVERITY[f] ? floor : f);
  if (!analysis.parsedSafely) {
    // Cannot enumerate the command — ask toward the dangerous side when a
    // delete/force/glob token is present, else treat as a workspace write
    // (NEVER readonly: an unparseable command might still mutate).
    return atLeast(unparseableFloors(analysis.commands, words) ? 'dangerous_delete' : 'workspace_write');
  }
  if ((analysis.nested || analysis.assigns) && nestedKeepsOldVerdict(analysis.commands, words)) return atLeast('dangerous_delete');
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const cwds = cwdStatesPerPosition(analysis.commands, shellCwd);
  let worst: BashSideEffect = 'readonly';
  analysis.commands.forEach((c, i) => {
    const fam = classifyBashPosition(c, root, cwds[i].moved, cwds[i].cwd);
    if (BASH_SEVERITY[fam] > BASH_SEVERITY[worst]) worst = fam;
  });
  // Reading subshells/substitutions and bare assignments sharpened the DELETE verdict only: never readonly, as before.
  return atLeast((analysis.nested || analysis.assigns) && worst === 'readonly' ? 'workspace_write' : worst);
}

/** One enumerated Bash command position → its side-effect family. */
function classifyBashPosition(
  c: CommandNode,
  root: string | null,
  cwdMoved: boolean,
  shellCwd: string | null | undefined,
): BashSideEffect {
  // Whatever the floor asks about is dangerous_delete, by construction — one
  // predicate, so the ladder can never rate a floored position milder.
  if (positionFloors(c, root, cwdMoved, shellCwd)) return 'dangerous_delete';
  // A safe, specific, in-workspace filesystem delete IS a workspace edit.
  if (bashPositionDeleteShape(c) === 'filesystem') return 'workspace_write';
  // Everything else: the write taxonomy's read/write verdict.
  return segmentMutatesHead(c.head, c.argv, c.raw) ? 'workspace_write' : 'readonly';
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE POSITION DOES — the operation taxonomy.
//
// The floor judges OPERATIONS, not the characters a script happens to contain.
// A delete is a delete whether it is spelled `rm`, `curl -X DELETE`, or
// `find … -delete`, and re-spelling it (fusing the flag, splitting the line,
// quoting the verb, hiding the URL behind $VAR) must never change the verdict.
// Staging drill 2026-08-09: a single-line `curl -sS -X DELETE "$URL/api/files/
// <id>"` removed a user's file with NO ask, while the SAME delete wrapped in a
// `$(…)` script asked — because the guard read tokens, not operations.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The delete SHAPE a command position carries, or null when it removes nothing.
 * `filesystem` is the only shape the rm narrowing applies to; the rest are
 * unconditional (see positionFloors). Exported so the card describer speaks
 * about the same operation the guard gated.
 */
export type BashDeleteShape = 'filesystem' | 'http' | 'find' | 'move-to-null';

export function bashPositionDeleteShape(node: CommandNode): BashDeleteShape | null {
  if (FILESYSTEM_DELETE_VERBS.has(node.head)) return 'filesystem';
  if (httpRequestDeletes(node)) return 'http';
  if (findRemoves(node)) return 'find';
  if (movesToDevNull(node)) return 'move-to-null';
  return null;
}

/** Heads that issue an HTTP request whose method their argv can name. */
const HTTP_CLIENT_HEADS: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh']);

/**
 * Clients that take the method as a bare POSITIONAL word (`http DELETE <url>`).
 * Never curl/wget, where a lone `DELETE` token is a URL path or a form value.
 */
const POSITIONAL_METHOD_HEADS: ReadonlySet<string> = new Set(['http', 'https', 'xh']);

/**
 * Does this position issue an HTTP DELETE? Read off the ARGV, so every spelling
 * lands on the same verdict: `-X DELETE`, `-XDELETE`, `-sSX DELETE` (curl
 * bundles short flags), `--request DELETE`, `--request=DELETE`,
 * `--method=DELETE`, any casing, quoted or bare, on one line or split across
 * many.
 *
 * A method we cannot resolve (`-X "$METHOD"`) also floors: the flag says a
 * method was chosen and we cannot see which. Doubt → ask. A client with NO
 * method flag is a GET and floors nothing.
 *
 * The target is deliberately not consulted. `$VESTRA_SERVER_URL` and friends
 * expand at run time, so the host is often unknowable — and a delete on someone
 * else's service is founder-gated exactly like one on ours.
 */
function httpRequestDeletes(node: CommandNode): boolean {
  if (!HTTP_CLIENT_HEADS.has(node.head)) return false;
  if (methodArgvDeletes(node.argv, true)) return true;
  // httpie/xh take the method as a bare positional word.
  return (
    POSITIONAL_METHOD_HEADS.has(node.head) &&
    node.argv.some((t) => removeQuotes(t) === 'DELETE')
  );
}

/**
 * Walk a token list for a method flag and judge its value. `unresolvableAsks`
 * says whether a value we cannot read (`-X "$METHOD"`) counts as a delete — true
 * where the head is known to be an HTTP client, false on the word scan, where
 * `-X` might belong to something else entirely (`tar -X "$EXCLUDES"`).
 */
function methodArgvDeletes(tokens: readonly string[], unresolvableAsks: boolean): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const inline = methodFlagValue(removeQuotes(tokens[i]));
    if (inline === null) continue;
    const value = inline !== '' ? inline : tokens[++i];
    if (value !== undefined && methodTokenDeletes(value, unresolvableAsks)) return true;
  }
  return false;
}

/**
 * If this token is a request-method flag, the value glued to it — or `''` when
 * the value is the NEXT token. Null when it is not a method flag at all.
 * Covers `--request`/`--method` (spaced or `=`) and curl's `-X`, including the
 * short-flag bundles curl accepts: `-XDELETE`, `-sSX DELETE`, `-sSXDELETE`.
 */
function methodFlagValue(token: string): string | null {
  if (token === '--request' || token === '--method') return '';
  const long = /^--(?:request|method)=(.*)$/.exec(token);
  if (long !== null) return long[1];
  const short = /^-[a-zA-Z]*X(.*)$/.exec(token);
  return short === null ? null : short[1];
}

/** Is this method token a DELETE (or, where the caller says so, unreadable)? */
function methodTokenDeletes(token: string, unresolvableAsks: boolean): boolean {
  const value = removeQuotes(token);
  if (value.includes('$') || value.includes('`')) return unresolvableAsks;
  return value.toUpperCase() === 'DELETE';
}

/** Find/fd heads whose own flags can delete what they match. */
const FIND_HEADS: ReadonlySet<string> = new Set(['find', 'fd']);

/**
 * A `find`/`fd` that removes what it matches: the built-in `-delete` action, or
 * an `-exec`/`-x` running one of the filesystem delete verbs. This deletes a SET
 * chosen by a pattern, which the rm narrowing already treats as dangerous
 * wherever it appears, so it floors unconditionally.
 */
function findRemoves(node: CommandNode): boolean {
  if (!FIND_HEADS.has(node.head)) return false;
  for (let i = 0; i < node.argv.length; i++) {
    const tok = removeQuotes(node.argv[i]);
    if (tok === '-delete' || tok === '--delete') return true;
    if (tok === '-exec' || tok === '-execdir' || tok === '-x' || tok === '--exec') {
      const next = node.argv[i + 1];
      if (next !== undefined && FILESYSTEM_DELETE_VERBS.has(normalizeHead(next))) {
        return true;
      }
    }
  }
  return false;
}

/** The null device, as a delete destination. Exported so the card names the same thing. */
export const DEV_NULL = '/dev/null';

/**
 * A `mv` whose destination is /dev/null — the source stops existing. Flags and
 * redirections (`2>&1`, `>log`) are not operands, so a trailing redirect cannot
 * hide the destination.
 */
function movesToDevNull(node: CommandNode): boolean {
  if (node.head !== 'mv') return false;
  const operands = node.argv.filter((t) => !removeQuotes(t).startsWith('-') && !/^\d*[<>]/.test(t));
  const destination = operands[operands.length - 1];
  return destination !== undefined && removeQuotes(destination) === DEV_NULL;
}

/**
 * SAFETY INVARIANT (rm narrowing): a delete floors unless the floor can
 * CONFIDENTLY determine it is non-recursive, non-glob, and every target stays
 * inside the workspace. Anything it cannot verify — wrapper-prefixed argv,
 * redirect-fed targets, unresolvable expansions, a moved cwd, a missing
 * workspace root for an absolute target — ASKS. Doubt → ask.
 *
 * DANGEROUS = any of:
 *   1. a RECURSIVE flag (-r/-R/--recursive, or any bundled short flag containing
 *      r or R: -rf, -fr, -rv, …) — recursion widens the delete to a whole
 *      subtree. A FORCE-only flag (-f/--force, or an f-only bundle like -vf) is
 *      NOT dangerous on its own (founder ruling 2026-09-03): force suppresses
 *      the prompt and ignores missing files but never widens the target SET, so
 *      a specific in-workspace file stays safe and falls through to rules 2–3.
 *   2. a glob/expansion metachar in a target (* ? [ — plus { and $ and
 *      backtick: brace expansion can smuggle absolute paths (`rm
 *      {/etc/hosts,}`) and a $VAR target cannot be resolved statically),
 *   3. a target escaping the workspace: leading ~, bare `.`/`..`/`/`, any `..`
 *      segment, or an absolute path not under workspaceRoot (or with no root
 *      to check against).
 */
/**
 * Heads that (can) change the shell cwd. Consulted per-chain: when any is
 * present, a RELATIVE delete target in the same command is unverifiable → ask.
 * eval/source/dot execute content we cannot statically resolve, so they count
 * even though they do not always cd. `{` is the brace-group opener; the analyzer
 * now strips it as a command-introducing keyword, so `{ cd /etc && rm x; }`
 * surfaces `cd` as a head of its own and this entry is belt-and-braces for a
 * bare `{` that reaches the floor as its own position.
 */
const CWD_MOVING_HEADS: ReadonlySet<string> = new Set([
  'cd', 'pushd', 'popd', 'builtin', 'eval', 'source', '.', '{',
]);

/**
 * The cwd-moving heads whose destination is NOT statically knowable. A clean
 * absolute `cd` is handled separately (cleanAbsoluteCdTarget resolves it), so it
 * is the ONE head excluded here — everything else moves the cwd to a place we
 * cannot vouch for. Derived from CWD_MOVING_HEADS so the two can never drift.
 */
const OPAQUE_CWD_MOVING_HEADS: ReadonlySet<string> = new Set(
  [...CWD_MOVING_HEADS].filter((h) => h !== 'cd'),
);

/**
 * If this position is a `cd` to a STATICALLY KNOWN absolute directory, the
 * normalized path it moves to; else null (the cwd becomes unknowable). Known =
 * exactly one operand, absolute, with no glob/brace metachar, no `$`/backtick
 * expansion, and no `..` segment. `cd` (no arg → $HOME), `cd -`, `cd relative`,
 * `cd "$VAR"`, and `cd a b` all return null → the caller marks the cwd moved.
 * Flags (`cd -P /x`) and redirections are not operands. Pure.
 */
function cleanAbsoluteCdTarget(node: CommandNode): string | null {
  if (node.head !== 'cd') return null;
  const operands = node.argv.filter(
    (t) =>
      !(t.startsWith('-') && t.length > 1) && // flags (but keep a bare `-` = `cd -`)
      !/^\d*>>?/.test(t) && t !== '<' && t !== '>' && t !== '>>', // redirections
  );
  if (operands.length !== 1) return null;
  const target = removeQuotes(operands[0]);
  if (!target.startsWith('/')) return null; // relative / $HOME / `-` → unknowable
  if (/[*?[{]/.test(target)) return null; // glob / brace expansion
  if (target.includes('$') || target.includes('`')) return null; // unresolvable expansion
  if (target.split('/').includes('..')) return null; // traversal → do not vouch
  return lexicalNormalize(target);
}

/**
 * The effective shell cwd IN FORCE at each command position, folding `cd` moves
 * in ORDER. The returned array is parallel to `commands`: entry i is the cwd a
 * delete AT position i resolves its relative targets against (positions before
 * it have already run; the position's own command has not — a delete never
 * changes the cwd, so its own position cannot excuse it).
 *
 *   - A clean absolute `cd` (cleanAbsoluteCdTarget) moves the cwd to a KNOWN
 *     path and clears the "moved" doubt — from there relative deletes resolve
 *     against that path and are contained normally (so `cd /app/workspace/x`
 *     then `rm scratch/y` is silent, while `cd /etc` then `rm hostname` still
 *     escapes → asks). An absolute cd fully determines the cwd, so it also
 *     re-pins the cwd after an earlier opaque move.
 *   - Any OTHER cwd move (relative/`$VAR`/no-arg cd, pushd/popd/builtin/eval/
 *     source/dot/brace-group) is opaque → moved = true → relative deletes from
 *     that point on cannot be vouched for and ask.
 *
 * Order matters: a delete BEFORE a later `cd` still resolves against the earlier
 * cwd, so `cd /etc; rm x; cd /app/workspace` never lets the second cd excuse the
 * escaped first delete.
 *
 * Scope matters too: a nested body (`( … )`, `$( … )`, `<( … )`, `sh -c`) is a
 * child shell whose `cd` dies with it, so each scope keeps its own cwd. Folded
 * flat, `sh -c 'cd /app/workspace/a'; rm x` resolved `x` there while bash deleted
 * it wherever the terminal stood (silent on origin/staging, 2026-09-25). Pure.
 */
function cwdStatesPerPosition(
  commands: readonly CommandNode[],
  shellCwd: string | null | undefined,
): Array<{ moved: boolean; cwd: string | null | undefined }> {
  const scopes = new Map<string, { moved: boolean; cwd: string | null | undefined }>();
  const stateOf = (scope: string): { moved: boolean; cwd: string | null | undefined } => {
    let state = scopes.get(scope);
    if (state === undefined) {
      const cut = scope.lastIndexOf('/');
      state = scope === '' ? { moved: false, cwd: shellCwd } : { ...stateOf(cut < 0 ? '' : scope.slice(0, cut)) };
      scopes.set(scope, state);
    }
    return state;
  };
  return commands.map((c) => {
    const state = stateOf(c.scope ?? '');
    const here = { moved: state.moved, cwd: state.cwd };
    if (c.head === 'cd') {
      // Behind a wrapper (`sudo cd`, `exec cd`, `env cd`) cd is a program of its
      // own and the shell does not move; `builtin cd` does. Either way: opaque.
      const abs = c.raw.trimStart().startsWith(c.rawHead) ? cleanAbsoluteCdTarget(c) : null;
      if (abs !== null) {
        state.cwd = abs;
        state.moved = false;
      } else {
        state.moved = true;
      }
    } else if (OPAQUE_CWD_MOVING_HEADS.has(c.head)) {
      state.moved = true;
    }
    return here;
  });
}

function isDangerousDelete(
  node: CommandNode,
  workspaceRoot: string | null,
  cwdMoved: boolean,
  shellCwd: string | null | undefined,
): boolean {
  // Wrapper/assignment-prefixed delete (`sudo rm x`, `xargs rm`, `env FOO=1
  // rm x`): the tokenized argv is not necessarily the real target set (xargs
  // feeds targets from stdin) → cannot vouch → ask.
  if (!node.raw.trimStart().startsWith(node.rawHead)) return true;

  let sawEndOfOptions = false;
  const targets: string[] = [];
  for (let i = 0; i < node.argv.length; i++) {
    const word = node.argv[i];
    // Redirections are not delete targets. `2>/dev/null` / `>out` / `>>log`
    // attach their operand; a bare `<` / `>` / `>>` consumes the next token.
    if (/^\d*>>?/.test(word)) continue;
    if (word === '<' || word === '>' || word === '>>') { i++; continue; }
    const tok = removeQuotes(word); // after those (a quoted `>` is a word): `"-rf"` is `-rf`
    if (!sawEndOfOptions) {
      if (tok === '--') { sawEndOfOptions = true; continue; }
      if (tok.startsWith('-') && tok.length > 1) {
        if (isRecursiveFlag(tok)) return true; // rule 1: recursion widens to a tree
        if (/[$`]/.test(tok)) return true; // `-$F` may expand to `-rf`: doubt → ask
        continue; // benign flag — force (-f/--force), verbose, interactive, …: a
                  //   FORCE-only flag never widens the target set, so a specific
                  //   in-workspace file stays safe and the target checks below
                  //   decide it (founder ruling 2026-09-03: an in-workspace asset
                  //   pipeline's `rm -f scratch/x` must run without asking).
      }
    }
    targets.push(word);
  }

  // A delete whose targets could not be extracted at all → ask (nothing to
  // vouch for; a literal bare `rm` deletes nothing, so the over-ask is moot).
  if (targets.length === 0) return true;

  return targets.some((t) => deleteTargetEscapesWorkspace(t, workspaceRoot, cwdMoved, shellCwd));
}

/** Rules 2 + 3 of isDangerousDelete, for one (unquoted) target token. */
function deleteTargetEscapesWorkspace(
  rawTarget: string,
  workspaceRoot: string | null,
  cwdMoved: boolean,
  shellCwd: string | null | undefined,
): boolean {
  const target = removeQuotes(rawTarget); // the path bash deletes: `\/etc`, `.\./` are `/etc`, `../`
  if (target.length === 0) return true;
  if (/[*?[{]/.test(target)) return true;                          // glob / brace expansion
  if (target.includes('$') || target.includes('`')) return true;   // unresolvable expansion
  if (target.startsWith('~')) return true;                          // $HOME escape
  if (target === '.' || target === '..' || target === '/') return true;
  if (target.split('/').includes('..')) return true;                // traversal, any position
  if (target.startsWith('/')) {
    if (workspaceRoot === null) return true; // no root to vouch against
    return !(lexicalNormalize(target).startsWith(workspaceRoot + '/'));
  }

  // RELATIVE target — it executes wherever the shell currently sits, and the
  // shell cwd PERSISTS across Bash calls (TerminalSession): a `cd /etc` last
  // call makes this call's `rm hostname` delete /etc/hostname. Resolve against
  // the LIVE cwd the gate threaded and require the result to land under the
  // workspace root (security-review CRITICAL, 2026-07-07).
  if (cwdMoved) return true;             // an in-command move → unverifiable
  if (shellCwd === undefined) return false; // caller tracks no live cwd (see options doc)
  if (shellCwd === null) return true;    // gate could not determine it → ask
  if (!shellCwd.startsWith('/')) return true;
  if (shellCwd.split('/').includes('..')) return true; // untrustworthy capture
  if (workspaceRoot === null) return true; // live cwd known but nothing to contain against
  const resolved = lexicalNormalize(shellCwd + '/' + target);
  return !(resolved.startsWith(workspaceRoot + '/'));
}

/**
 * Collapse `.` and empty segments of an absolute path. Safe ONLY because every
 * caller rejects `..` segments first — this never resolves traversal.
 */
function lexicalNormalize(absolute: string): string {
  return '/' + absolute.split('/').filter((s) => s.length > 0 && s !== '.').join('/');
}

/**
 * The unparseable path (the analyzer could not enumerate the command: an
 * unbalanced quote, an assignment-only position, a command word made by a
 * substitution, a body it cannot delimit soundly). We cannot verify a delete
 * is safe, so ask when the heredoc-stripped command carries:
 *   - a delete token (rm/rmdir/unlink/shred in any word position), or
 *   - a recursive/force flag token — the fragmented-rm tell:
 *     `$(printf r)$(printf m) -rf /` has NO rm token, and the security regexes
 *     do NOT backstop it (they anchor on a literal `rm`), but the `-rf` gives
 *     it away. A LONE `-r`/`-f` is NOT that tell (founder ruling 2026-08-10 —
 *     see RECURSIVE_FORCE_FLAG_TOKEN): it belongs to `jq -r` far more often
 *     than to a hidden delete, and a guard that cries wolf gets clicked
 *     through. KNOWN RESIDUE: a fully-token-fragmented delete
 *     (`$(printf rm) $(printf -- -rf) /`), and now a hidden-verb delete
 *     carrying only a single flag (`$CMD -r /path`), are NOT floored — neither
 *     this floor nor the security gate sees them. That matches the pre-existing
 *     parseable-path posture (`"r""m" x` never floored) and only arises from
 *     deliberate obfuscation (prompt injection), not cooperative agents.
 *   - an HTTP DELETE tell (`-X DELETE`, `--request=DELETE`, …) — the same
 *     operation the parseable path reads off the argv, scanned as words here
 *     because no command position could be enumerated.
 *   - a glob metachar appearing UNQUOTED and IN-WORD (`*.md`, `[abc]`, a bare
 *     `*` or `?`) — we cannot see what it expands to. Punctuation words the
 *     shell expands to themselves (`[`, `{`, `{}`) are not globs.
 * A benign read (`cat "$(ls "$BLOOM")"`) has none of these and stays silent.
 */
function unparseableDeleteRisk(stripped: string): boolean {
  if (namesADelete(stripped)) return true;
  for (const word of stripped.split(SHELL_WORD_DELIMITERS)) {
    if (RECURSIVE_FORCE_FLAG_TOKEN.test(removeQuotes(word))) return true;
  }
  return containsUnquotedGlob(stripped);
}

/**
 * The unparseable verdict: the word scan, or a delete in a position the analyzer
 * did read. The scan has no `find -delete` or `mv … /dev/null` tell, so on
 * staging @ bade6fe1c `X=1; find . -delete` (a bare assignment is refused)
 * deleted without an ask. Reading doubt as a moved cwd, every delete asks here.
 */
function unparseableFloors(commands: readonly CommandNode[], words: string): boolean {
  return unparseableDeleteRisk(words) || commands.some((c) => positionFloors(c, null, true, null));
}

/** The two VERB tells: a delete verb or an HTTP DELETE, spelled anywhere. */
function namesADelete(stripped: string): boolean {
  return commandContainsDeleteToken(stripped) || commandContainsHttpDeleteTell(stripped);
}

/**
 * A command read only since 2026-09-25 (`nested`: subshell, `$( … )`,
 * backticks) keeps its unparseable verdict where the reading cannot see WHAT
 * RUNS: a delete verb or HTTP DELETE spelled anywhere (a substitution's OUTPUT
 * can become a command word: `eval "$(echo rm -rf ~)"`), or a position running
 * unread code, where the old flag and glob tells stand (`($R *)`, `(echo "$X
 * -rf ~" | sh)`). Otherwise each position is judged on its own: that is what
 * takes `echo EXIT $?` and `{1..32}` off the floor. Bare assignments (`assigns`) too.
 */
function nestedKeepsOldVerdict(commands: readonly CommandNode[], stripped: string): boolean {
  if (namesADelete(stripped)) return true;
  return commands.some(runsUnreadCode) && unparseableDeleteRisk(stripped);
}

/**
 * The HTTP-DELETE tell as WHOLE SHELL WORDS, for the unparseable path (no
 * command positions to read an argv from). Tokenizing on the shell word
 * delimiters splits `--request=DELETE` and `-X "DELETE"` into flag + value, so
 * every spelling the argv reader accepts is caught here too — and a `DELETE`
 * word that is nobody's method value (`psql -c "DELETE FROM t"`) is not.
 *
 * A method we cannot READ only counts when an HTTP client is visible somewhere
 * in the command: without a known head, `-X "$EXCLUDES"` is as likely to be
 * tar's exclude-from as it is a request method, and asking on it would be the
 * over-ask this change exists to reduce.
 */
function commandContainsHttpDeleteTell(command: string): boolean {
  const words = command.split(SHELL_WORD_DELIMITERS).filter((w) => w.length > 0);
  const clientPresent = words.some((w) => HTTP_CLIENT_HEADS.has(normalizeHead(w)));
  return methodArgvDeletes(words, clientPresent);
}

/**
 * The recursive/force flag family as a TELL for a delete verb we cannot see:
 * the long forms, and two-letter bundles of r/R/f (`-rf`, `-fr`, `-Rf`, …).
 *
 * A LONE `-r`/`-R`/`-f` does NOT count (founder ruling 2026-08-10). It used to,
 * and a floor that fires on `jq -r`, `grep -r`, `curl -f`, `cp -r`, `sort -r`,
 * `tar -f` trains the user to approve without reading — click-through fatigue
 * defeats the guard far more reliably than the residual gap does. Live proof:
 * a pure CREATE script (mkdir + create-file POST + jq parse + printf) asked
 * "Delete files in your workspace" on staging, and `jq -r` was the entire
 * reason (interaction d4779933, 2026-08-10 05:23).
 *
 * The gap this leaves is narrow BY CONSTRUCTION. For a lone `-r` to have been
 * the only tell, the delete verb itself must be hidden behind an expansion
 * (`$CMD -r /path`): a visible rm/rmdir/unlink/shred is caught independently by
 * commandContainsDeleteToken, an HTTP DELETE by commandContainsHttpDeleteTell,
 * and no parseable command reaches this proxy at all.
 *
 * (The parseable path's isRecursiveFlag below is RECURSION-ONLY: there we can
 * read the delete's target, so a force-only flag on a specific in-workspace file
 * is safe. Here on the unparseable path the target is unknowable, so this token
 * stays the broader "recursive OR force bundle" tell — deliberately conservative
 * for a delete verb we cannot see.)
 */
const RECURSIVE_FORCE_FLAG_TOKEN = /^(?:--recursive|--force|-[rRf]{2})$/;

/**
 * Rule 1 of isDangerousDelete: is this argv token a RECURSIVE flag on an ACTUAL
 * delete command? Any single-dash short bundle containing `r` or `R` counts
 * (`-rf`, `-fr`, `-rv`, `-Rf`, …), plus `--recursive`.
 *
 * A FORCE-only flag (`-f`/`--force`, or an f-only bundle like `-vf`) is
 * DELIBERATELY excluded (founder ruling 2026-09-03). Unlike recursion, force
 * never widens the target set — it only skips the confirm prompt and ignores
 * missing files — so a forced delete of a specific in-workspace file is as safe
 * as an unforced one and must fall through to the target checks (rules 2–3),
 * not floor. `-rf`/`-fr` still floor here on the `r`; an outside-workspace or
 * glob target still floors at rules 2–3 regardless of `-f`. (The UNPARSEABLE
 * path's RECURSIVE_FORCE_FLAG_TOKEN keeps force as a hidden-verb tell — there
 * the target is unreadable, so force stays conservative.)
 */
export function isRecursiveFlag(tok: string): boolean {
  if (tok === '--recursive') return true;
  const m = /^-([A-Za-z]+)$/.exec(tok);
  return m !== null && /[rR]/.test(m[1]);
}

/**
 * The word scans' text: every backslash-newline out, quoted or not, so they also
 * read a body another shell reads later (`sh -c 'r\⏎m …'`, where bash removes it),
 * and `$IFS` read as the separator it expands to (`rm${IFS}-rf${IFS}/etc`).
 */
function joinContinuedLines(text: string): string {
  return text.replace(/\\([\s\S])/g, (pair: string, next: string) => (next === '\n' ? '' : pair))
    .replace(/\$(?:\{IFS\}|IFS(?![A-Za-z0-9_]))/g, ' ');
}

/** The workspace root usable for containment checks: absolute, no trailing slash. */
function normalizeWorkspaceRoot(root: string | undefined): string | null {
  if (typeof root !== 'string' || !root.startsWith('/')) return null;
  const trimmed = root.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Does a filesystem delete verb appear as a WHOLE shell word anywhere in the
 * command? Path prefixes resolve via basename so `/bin/rm` matches. Used on the
 * unparseable path (see bashFloors) — the analyzer could not enumerate command
 * positions, so we scan raw tokens instead: ask when a delete token is present
 * in any position, allow when none is. Exported so the card describer
 * (describe-tool) never UNDERSTATES an unparseable command the floor asked
 * about (same scan → same verdict about a hidden delete).
 */
export function commandContainsDeleteToken(command: string): boolean {
  for (const word of joinContinuedLines(command).split(SHELL_WORD_DELIMITERS)) {
    if (word.length === 0) continue;
    if (FILESYSTEM_DELETE_VERBS.has(normalizeHead(word))) return true;
  }
  return false;
}

/**
 * LEGACY head-only floor (used when `VESTRA_BASH_AST_GATE` is OFF). A Bash
 * command floors when ANY executed segment is a DELETE (rm/rmdir) at its
 * command HEAD. Redirections (`>`/`>>`) are WRITES — not floored.
 *
 * NOT conservative on unparseability (founder directive): an unparseable command
 * does NOT floor. We never scan the raw command string for "rm" — that would
 * false-floor a heredoc whose body documents shell commands. We only inspect
 * command HEADS (the first word of each operator-split segment).
 *
 * HEREDOC SAFETY: `splitShellSegments` splits on newlines, so a heredoc body
 * line that itself begins with `rm` (documentation) would otherwise look like a
 * delete segment. We strip heredoc bodies first — their content is data written
 * to a file, never executed — so only the real command line is inspected.
 */
function legacyBashFloors(command: string | null): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;

  const executable = stripHeredocBodies(command);
  const { segments } = splitShellSegments(executable);
  // Inspect command heads regardless of parsedSafely. When the splitter could
  // not vouch for the parse it returns the whole command as a single segment;
  // segmentIsDelete still correctly reads the head (`cat`, not `rm`) so a benign
  // unparseable command does not floor. A genuine `rm`/`rmdir` head still floors.
  for (const seg of segments) {
    if (segmentIsDelete(seg)) return true;
  }
  return false;
}

/**
 * A segment is a delete if its FIRST word (or a sudo-prefixed first word) is
 * `rm` / `rmdir`. Word-anchored so `perform`, `form.txt`, `transform` don't trip.
 */
function segmentIsDelete(segment: string): boolean {
  // Tokenize on whitespace; skip a leading `sudo`/`command`/`env` wrapper.
  const words = segment.split(/\s+/).filter((w) => w.length > 0);
  let i = 0;
  while (i < words.length && (words[i] === 'sudo' || words[i] === 'command' || words[i] === 'env')) {
    i++;
  }
  const head = words[i];
  return head === 'rm' || head === 'rmdir';
}

/**
 * A Composio tool (`mcp__composio__TOOLKIT_ACTION`) floors per its toolkit's
 * KNOWLEDGE level. SENDS never floor (founder directive):
 *
 *   - KNOWN payment toolkit → the action's money-movement verb word floors.
 *   - KNOWN delete toolkit → the action's destructive verb word floors.
 *   - UNKNOWN / non-listed toolkit → whole-word fallback over the PAYMENT +
 *     DELETE verb union, so an unlisted `AIRTABLE_DELETE_RECORD` / `SOMEPAY_
 *     CHARGE_*` still floors. A send action (`MASTODON_SEND_TOOT`) does NOT.
 *
 * Reads / lists / gets / sends never floor (no payment/delete verb word).
 */
function composioFloors(tool: string, hints?: ComposioToolHints): boolean {
  // ONE verdict table (composioVerdict) for the floor and the classifier: the
  // vendor's word first, money by name, then today's name rule as fallback.
  const verdict = composioVerdict(tool.slice(COMPOSIO_TOOL_PREFIX.length), hints);
  return verdict === 'payment' || verdict === 'dangerous_delete';
}

/**
 * The ACTION segment of a generic (non-composio) MCP tool name, UPPERCASED for
 * whole-word verb matching. `mcp__server__delete_row` → 'DELETE_ROW'.
 * Tools with no action segment (`mcp__server`) → '' (never floors).
 */
function mcpActionSegment(tool: string): string {
  // Drop the `mcp__` prefix, split on `__`; the action is everything after the
  // server name. `mcp__server__a__b` → action 'A__B' (its words are still
  // `_`-delimited for hasVerbWord). `mcp__server` (no action) → ''.
  const parts = tool.slice('mcp__'.length).split('__');
  if (parts.length < 2) return '';
  return parts.slice(1).join('__').toUpperCase();
}

/**
 * Is any of `verbs` present as a whole `_`-delimited word in `action`? Exported
 * so the side-effect classifier does whole-word verb matching over the SAME
 * matcher (no substring false-positives like `SENDER` matching `SEND`).
 */
export function hasVerbWord(action: string, verbs: readonly string[]): boolean {
  const parts = action.split('_');
  for (const v of verbs) {
    if (parts.includes(v)) return true;
  }
  return false;
}

// ── the VENDOR's word (founder ruling 2026-08-27: "Composio should already be helping") ──

/**
 * Composio's MCP hints for one tool, as the sandbox resolved them (state/
 * composio-tool-hints.ts → server /tool-hints → Composio `version=latest`).
 * `readOnly` = only observes; `destructive` = may destroy data (irreversible);
 * `update` = reversible change; `create` = makes a new thing (a send is a create).
 */
export interface ComposioToolHint {
  readOnly: boolean;
  destructive: boolean;
  update: boolean;
  create: boolean;
}
/** UPPERCASE Composio slug → the vendor's hint. Absent slug = vendor silent. */
export type ComposioToolHints = ReadonlyMap<string, ComposioToolHint>;

export type ComposioVerdict = 'readonly' | 'payment' | 'dangerous_delete' | 'remainder';

/** The vendor's hint for a bare slug, any case. */
export function vendorHintFor(slug: string, hints: ComposioToolHints | undefined): ComposioToolHint | undefined {
  return typeof slug === 'string' ? hints?.get(slug.toUpperCase()) : undefined;
}

/**
 * THE Composio verdict — one table the floor and the classifier both read, so
 * they cannot drift (the floor asks iff payment/dangerous_delete; the classifier
 * splits 'remainder' into send/read/mutation by name). Order:
 *   1. the vendor says read-only (and not destructive)   → readonly
 *   2. the NAME says payment                              → payment — the vendor
 *      has no payment hint (STRIPE_CREATE_REFUND is "destructive", a charge is
 *      "create"), so money keeps today's rule and beats every tag
 *   3. the vendor answered: destructive → dangerous_delete, else → remainder
 *      (GOOGLEDRIVE_EMPTY_TRASH asks; JIRA_REMOVE_WATCHER_FROM_ISSUE runs)
 *   4. the vendor is silent                               → today's name rule
 * A tool carrying readOnly AND destructive (LINEAR_RUN_QUERY_OR_MUTATION —
 * an opaque executor) is destructive: "can destroy" beats "can read".
 *
 * Belt: a read-only claim on a slug whose HEAD token is itself a floor verb
 * (GITHUB_DELETE_REPO, STRIPE_CHARGE_CUSTOMER) is a contradiction; the whole
 * hint is then distrusted and the name rule stands. Census 2026-08-27 at
 * `version=latest`: zero such slugs — the belt costs nothing.
 *
 * Toolkit awareness is today's, unchanged: a known payment toolkit pays only on
 * a payment verb and never deletes by name; a known delete toolkit deletes only
 * on a delete verb and never pays by name. `slug` is the bare Composio slug
 * (`TOOLKIT_ACTION…`), any case. Total.
 */
export function composioVerdict(slug: string, hints: ComposioToolHints | undefined): ComposioVerdict {
  if (typeof slug !== 'string') return 'remainder';
  const upper = slug.toUpperCase();
  const underscore = upper.indexOf('_');
  if (underscore <= 0) return 'remainder';
  const toolkit = upper.slice(0, underscore).toLowerCase();
  const action = upper.slice(underscore + 1);

  const hint = vendorHintFor(upper, hints);
  const trusted = hint !== undefined && !(hint.readOnly && FLOOR_VERBS.includes(action.split('_')[0]));
  if (trusted && hint.readOnly && !hint.destructive) return 'readonly';

  const paysByName = COMPOSIO_DELETE_TOOLKITS.has(toolkit) ? false : hasVerbWord(action, PAYMENT_VERBS);
  if (paysByName) return 'payment';

  if (trusted) return hint.destructive ? 'dangerous_delete' : 'remainder';

  const deletesByName = COMPOSIO_PAYMENT_TOOLKITS.has(toolkit) ? false : hasVerbWord(action, DELETE_VERBS);
  return deletesByName ? 'dangerous_delete' : 'remainder';
}

/** Does the vendor's (trusted) word make this slug a read? The classifier's step 1, exposed for tests. */
export function vendorReadOnlyVeto(slug: string, hints: ComposioToolHints | undefined): boolean {
  return composioVerdict(slug, hints) === 'readonly' && vendorHintFor(slug, hints)?.readOnly === true;
}
