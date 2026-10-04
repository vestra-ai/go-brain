/**
 * describeToolCall — the deterministic plain-language one-liner for a
 * tool_permission card ("Delete 2 files", "Read 3 files", "Run
 * validate-bloom.mjs", "Send email on Gmail").
 *
 * Founder ruling (2026-07-06): when a permission prompt DOES come, it must say
 * what the call will do in words a non-technical user understands — not a raw
 * `bash rm …` dump. The gateway computes this at request assembly (one site,
 * both arms) and rides it on `ToolPermissionRequest.summary`; the card leads
 * with it and demotes the raw input to a disclosure.
 *
 * DETERMINISTIC, no LLM lane: Bash goes through the shared command analyzer
 * (verb + targets per command position); file tools read `file_path`;
 * Composio/MCP names are humanized the same way the sandbox's tool-display
 * module does (this module is SDK-agnostic, so the small humanizers live here).
 *
 * COPY RULES: no em dashes; never the word "Claude"; ≤ 80 chars.
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

import type { ToolCall } from '../contract/harness.js';
import { analyzeCommand, normalizeHead, type CommandNode } from './command-analyzer.js';
import {
  commandContainsDeleteToken,
  stripHeredocBodies,
  bashPositionDeleteShape,
  FILESYSTEM_DELETE_VERBS,
  DEV_NULL,
} from './sensitivity-floor.js';
import { positionGitVerdict } from './git-command-catalog.js';
import { shellStdinCode } from './shell-stdin-code.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import {
  toolkitDisplayName,
  isComposioExecutorMetaTool,
  extractInnerComposioTools,
} from './composio-naming.js';
import { parseToolSpecifier } from './permission-rule-engine.js';
import { GITHUB_PULL_REQUEST_TOOL, classifyMetaExecutorTools, type SideEffectFamily } from './side-effect-classifier.js';
import { describePullRequest, pullRequestCard } from './describe-pull-request.js';
import { REMOTE_CODE_ASK_HEADLINE, REMOTE_CODE_ASK_REASON } from './remote-code-pins.js';
import type { ComposioToolHints } from './sensitivity-floor.js';
import { hardFloors, levelAsks, type AccessLevel } from './access-level.js';

/** Hard cap for the produced copy — a headline, not a paragraph. */
const MAX_SUMMARY_LENGTH = 80;
/** describeToolCall's total fallback for a command that cannot be put into words. */
const OPAQUE_COMMAND = 'Run a shell command';
/** The delete family's own words, shared by the unparseable path and the card. */
const DELETE_IN_WORKSPACE = 'Delete files in your workspace';
/** The unreadable family's headline: what is TRUE, never a guess at the action. */
const UNREADABLE_HEADLINE = "I can't tell exactly what this step does";
/** Cap for a single file/target name inside a phrase. */
const MAX_TARGET_LENGTH = 40;

/** The guard's own removal verbs, imported so the words and the gate enumerate one list. */
const DELETE_HEADS = FILESYSTEM_DELETE_VERBS;
const READ_HEADS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat']);
const LIST_HEADS = new Set(['ls', 'tree']);
const FIND_HEADS = new Set(['find', 'fd']);
const SEARCH_HEADS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const CREATE_HEADS = new Set(['mkdir', 'touch']);
const FETCH_HEADS = new Set(['curl', 'wget']);
const SCRIPT_RUNNERS = new Set([
  'node', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node', 'npx', 'ruby', 'perl',
]);
const SUBCOMMAND_CLIS = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'gh', 'cargo', 'make']);
/** Shell interpreters whose `-c` body the analyzer already enumerates as its own positions. */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh']);
/** Heads that add no information when other command positions exist. */
const NOISE_HEADS = new Set(['cd', 'echo', 'printf', 'true', 'false', 'pwd', 'export', 'set', 'exit', 'sleep', 'test']);

/**
 * The plain-language one-liner for a tool call. Total: any unexpected shape
 * degrades to a generic-but-truthful phrase, never a throw.
 */
export function describeToolCall(call: ToolCall): string {
  try {
    const toolName = typeof call?.toolName === 'string' ? call.toolName : '';
    if (toolName === '') return 'Use this tool';

    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return cap(describeBashCommand(getString(call.toolInput, 'command')) ?? OPAQUE_COMMAND);
    }

    if (toolName === 'Write') return cap(fileVerbPhrase('Save', call.toolInput, 'a file'));
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
      return cap(fileVerbPhrase('Edit', call.toolInput, 'a file'));
    }
    if (toolName === 'Read') return cap(fileVerbPhrase('Read', call.toolInput, 'a file'));

    if (toolName === 'Patch') {
      const envelope = getString(call.toolInput, 'input') ?? '';
      return /^\*\*\*\s*(Delete|Move)\s+File:/m.test(envelope)
        ? 'Delete or move files'
        : 'Update files';
    }

    if (toolName === 'WebFetch') {
      const host = hostnameOf(getString(call.toolInput, 'url'));
      return cap(host ? `Fetch ${host}` : 'Fetch a web page');
    }
    if (toolName === 'WebSearch') {
      const query = getString(call.toolInput, 'query');
      return cap(query ? `Search the web for "${truncate(query, 30)}"` : 'Search the web');
    }

    if (toolName === 'Skill') {
      const raw = getString(call.toolInput, 'skill') ?? getString(call.toolInput, 'name');
      if (raw) {
        const colon = raw.indexOf(':');
        const bare = colon >= 0 ? raw.slice(colon + 1) : raw;
        return cap(`Use the ${bare.replace(/[-_]/g, ' ')} skill`);
      }
      return 'Use a skill';
    }

    if (toolName === GITHUB_PULL_REQUEST_TOOL) return cap(describePullRequest(call.toolInput));

    if (toolName.startsWith(COMPOSIO_TOOL_PREFIX)) {
      // An executor meta-call is summarized by its PAYLOAD — the card must say
      // what will actually run ("Send email on Gmail"), not the wrapper's name.
      if (isComposioExecutorMetaTool(toolName)) {
        const unwrapped = describeMetaExecutor(call);
        if (unwrapped !== null) return cap(unwrapped);
      }
      return cap(describeComposio(toolName.slice(COMPOSIO_TOOL_PREFIX.length)));
    }
    if (toolName.startsWith('mcp__')) {
      return cap(describeGenericMcp(toolName));
    }

    return cap(`Use ${toolName}`);
  } catch {
    return 'Use this tool';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bash
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The command in the user's words, or NULL when nothing about it can be put
 * into words (an opaque script: unenumerable, and its head carries no meaning).
 * Null is the caller's cue to speak from the side-effect family instead — a raw
 * token from the script is never copy (staging incident c479: a script opening
 * `set -euo pipefail` was shown to the founder as "Run set").
 *
 * Heredoc bodies are stripped FIRST, exactly as the floor strips them: a body is
 * data written to a file, never an executed command, so the words must be drawn
 * from the same bytes the guard judged.
 */
function describeBashCommand(command: string | null): string | null {
  if (command === null || command.trim() === '') return null;

  const executable = stripHeredocBodies(command);
  const analysis = analyzeCommand(executable);
  // `nested` (a subshell or substitution was read) and `assigns` (a bare
  // assignment) keep the words these commands had while they were unparseable:
  // the card is not re-worded here.
  if (!analysis.parsedSafely || analysis.nested || analysis.assigns || analysis.commands.length === 0) {
    return describeUnparseable(executable);
  }

  const phrases: BashPhrase[] = [];
  for (const node of analysis.commands) {
    // A `sh -c` interpreter node is scaffolding: the analyzer already emitted
    // its body as separate positions, which carry the real meaning.
    if (SHELL_INTERPRETERS.has(node.head) && node.argv.some((t) => /^-[a-z]*c[a-z]*$/.test(t))) {
      continue;
    }
    // A shell builtin (`set`, `cd`, `export`, …) is preamble, not intent — it
    // never earns a phrase, not even as the only position.
    if (NOISE_HEADS.has(node.head)) continue;
    const phrase = phraseFor(node);
    if (phrase !== null) phrases.push(phrase);
  }
  // Everything was preamble or scaffolding: nothing to say in the call's words.
  if (phrases.length === 0) return null;
  // A DESTRUCTIVE phrase must never be dropped by the 3-slot cap — a delete
  // sitting past slot 3 would otherwise render as a pure read on the card.
  // Keep original order; drop only non-destructive overflow.
  const destructiveCount = phrases.filter((p) => p.destructive).length;
  const kept: BashPhrase[] = [];
  if (destructiveCount >= 3) {
    for (const p of phrases) {
      if (p.destructive && kept.length < 3) kept.push(p);
    }
  } else {
    let budget = 3 - destructiveCount;
    for (const p of phrases) {
      if (p.destructive) kept.push(p);
      else if (budget > 0) { kept.push(p); budget--; }
    }
  }
  return kept.map((p) => p.text).join(', then ');
}

/** One phrase for one command position; destructive phrases survive the slot cap. */
interface BashPhrase { text: string; destructive: boolean }

/**
 * NULL when the position's head is not one this describer recognizes. Copy is
 * minted from an ALLOWLIST of known heads, never from whatever token happens to
 * lead the position — see describeUnparseable for why the inverse (a denylist of
 * heads to suppress) cannot be finished.
 */
function phraseFor(node: CommandNode): BashPhrase | null {
  const head = node.head;
  // Redirect tokens (`2>/dev/null`, `>out`, `<in`, `<<EOF`) are plumbing, not
  // command targets: counting a heredoc introducer as a file told the user
  // "Read 2 files" about a one-file read.
  const targets = node.argv.filter(
    (t) => !t.startsWith('-') && !t.startsWith('<') && !/^\d*>>?/.test(t),
  );

  // What the GUARD decided this position does, so a gated delete can never be
  // announced as the read-shaped command it is spelled as ("Fetch a web
  // address" over a `curl -X DELETE` card).
  const deleteShape = bashPositionDeleteShape(node);
  if (deleteShape === 'http') {
    const host = hostnameOf(targets.find((t) => /^https?:\/\//.test(unquote(t))) ?? null);
    return {
      text: host ? `Delete data at ${host}` : 'Delete data at a web address',
      destructive: true,
    };
  }
  if (deleteShape !== null) {
    // A move onto /dev/null deletes its SOURCE; the destination is not a victim.
    const removed =
      deleteShape === 'move-to-null' ? targets.filter((t) => unquote(t) !== DEV_NULL) : targets;
    const globTarget = removed.find((t) => /[*?[]/.test(unquote(t)));
    if (globTarget) {
      return {
        text: `Delete files matching ${truncate(unquote(globTarget), 20)}`,
        destructive: true,
      };
    }
    const recursive = node.argv.some(
      (t) => t === '--recursive' || (/^-[A-Za-z]+$/.test(t) && /[rR]/.test(t.slice(1))),
    );
    const base = deletePhrase(removed);
    return { text: recursive ? `${base} and everything inside` : base, destructive: true };
  }
  // git and gh: the catalog the guard judged with names the act ("Push to main on origin").
  const git = positionGitVerdict(node);
  if (git !== null) {
    return git.kind === 'readonly' ? plain(git.headline) : { text: git.headline, destructive: git.kind !== 'external' };
  }
  if (READ_HEADS.has(head)) return plain(countPhrase('Read', targets));
  if (LIST_HEADS.has(head)) return plain('List files');
  if (FIND_HEADS.has(head)) return plain('Find files');
  if (SEARCH_HEADS.has(head)) {
    const pattern = targets[0];
    return plain(pattern ? `Search files for "${truncate(unquote(pattern), 20)}"` : 'Search files');
  }
  if (CREATE_HEADS.has(head)) return plain(countPhrase('Create', targets));
  if (head === 'cp') return plain('Copy files');
  if (head === 'mv') return plain('Move files');
  if (FETCH_HEADS.has(head)) {
    const host = hostnameOf(targets.find((t) => /^https?:\/\//.test(unquote(t))) ?? null);
    return plain(host ? `Fetch ${host}` : 'Fetch a web address');
  }
  if (SCRIPT_RUNNERS.has(head)) {
    const script = targets[0];
    return plain(script ? `Run ${displayName(script)}` : `Run ${head}`);
  }
  if (SUBCOMMAND_CLIS.has(head)) {
    const sub = targets[0];
    return plain(sub ? `Run ${head} ${unquote(sub)}` : `Run ${head}`);
  }
  return null;
}

function plain(text: string): BashPhrase {
  return { text, destructive: false };
}

/** "Read scratch.txt" / "Read 2 files" / "Read files". */
function countPhrase(verb: string, targets: string[]): string {
  if (targets.length === 1) return `${verb} ${displayName(targets[0])}`;
  if (targets.length > 1) return `${verb} ${targets.length} files`;
  return `${verb} files`;
}

/** How many deleted files the headline names before it starts counting. */
const MAX_NAMED_DELETE_TARGETS = 3;
/** Cap for one name inside a LIST of names (tighter than a lone target). */
const MAX_LISTED_TARGET_LENGTH = 20;

/**
 * "Delete scratch.txt" / "Delete 2 files: a.pdf, b.pdf" /
 * "Delete 5 files: a.pdf, b.pdf, c.pdf and 2 more" / "Delete files".
 *
 * A delete NAMES what it removes (founder ruling 2026-08-09): the one question a
 * non-technical user has in front of an irreversible ask is "which files?", and
 * a bare count does not answer it.
 */
function deletePhrase(targets: string[]): string {
  if (targets.length === 0) return 'Delete files';
  if (targets.length === 1) return `Delete ${displayName(targets[0])}`;
  const named = targets
    .slice(0, MAX_NAMED_DELETE_TARGETS)
    .map((t) => truncate(displayName(t), MAX_LISTED_TARGET_LENGTH))
    .join(', ');
  const rest = targets.length - MAX_NAMED_DELETE_TARGETS;
  const tail = rest > 0 ? ` and ${rest} more` : '';
  return `Delete ${targets.length} files: ${named}${tail}`;
}

/**
 * The analyzer could not enumerate the command (`$(…)`, unbalanced quote, an
 * assignment-only position, …). Stay truthful without pretending precision: name
 * the intent class from the head token, and NEVER understate a hidden delete —
 * if a delete token appears anywhere (the same whole-word scan the sensitivity
 * floor asks on), say so.
 *
 * NULL when the head is not one this describer recognizes, which is the caller's
 * cue to speak from the side-effect family instead.
 *
 * The rule is an ALLOWLIST on purpose. It used to be the inverse — mint
 * "Run <token>" from any plain-word head, and suppress the handful of heads
 * known to be meaningless (the shell BUILTINS: `set`, `cd`, `export`). That
 * denylist shipped after incident c479 showed the founder "Run set", and it
 * leaked the very next day: `for` is a shell KEYWORD, not a builtin, so two
 * read-only probe loops reached him captioned "Run for" (task 564a0462,
 * 2026-08-10). `while`, `until`, `case`, `select`, `time`, `coproc`, `{`, `[[`
 * and `!` were all still open, and so was every unrecognized program name, which
 * says no more to a non-technical reader than a keyword does. A denylist of
 * meaningless tokens cannot be completed; an allowlist of meaningful ones can.
 */
function describeUnparseable(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const head = normalizeHead(first);
  const hidesDelete = commandContainsDeleteToken(command);

  if (DELETE_HEADS.has(head)) return 'Delete files';
  if (hidesDelete) return DELETE_IN_WORKSPACE;
  if (READ_HEADS.has(head)) return 'Read files';
  if (LIST_HEADS.has(head)) return 'List files';
  if (FIND_HEADS.has(head)) return 'Find files';
  if (SEARCH_HEADS.has(head)) return 'Search files';
  if (FETCH_HEADS.has(head)) return 'Fetch a web address';
  if (SCRIPT_RUNNERS.has(head) || SUBCOMMAND_CLIS.has(head)) return `Run ${head}`;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Composio / generic MCP humanization (mirrors tool-display.ts style)
// ═══════════════════════════════════════════════════════════════════════════

/** Underscored multi-word Google toolkits whose slug is not the first `_` segment.
 *  The squashed shapes real tool names carry (`GOOGLEDRIVE_GET_FILE_METADATA`)
 *  resolve through `toolkitDisplayName` below — this table covers only the
 *  underscored variant (`GOOGLE_DRIVE_…`). */
const MULTI_WORD_TOOLKITS: ReadonlyArray<readonly [string, string]> = [
  ['GOOGLE_CALENDAR_', 'Google Calendar'],
  ['GOOGLE_DRIVE_', 'Google Drive'],
  ['GOOGLE_SHEETS_', 'Google Sheets'],
  ['GOOGLE_DOCS_', 'Google Docs'],
];

/** `GMAIL_SEND_EMAIL` → "Send email on Gmail". */
function describeComposio(suffix: string): string {
  const upper = suffix.toUpperCase();
  for (const [prefix, display] of MULTI_WORD_TOOLKITS) {
    if (upper.startsWith(prefix)) {
      return `${actionWords(upper.slice(prefix.length))} on ${display}`;
    }
  }
  const underscore = upper.indexOf('_');
  if (underscore <= 0) return `Use ${suffix}`;
  const display = toolkitDisplayName(upper.slice(0, underscore));
  return `${actionWords(upper.slice(underscore + 1))} on ${display}`;
}

/** `mcp__db__delete_row` → "Delete row (db)". */
function describeGenericMcp(toolName: string): string {
  const parts = toolName.slice('mcp__'.length).split('__');
  if (parts.length < 2 || parts[1] === '') return `Use ${toolName}`;
  const server = parts[0];
  const action = parts.slice(1).join('_');
  return `${actionWords(action.toUpperCase())} (${server})`;
}

/**
 * An executor meta-call summarized by its payload: a single inner action in its
 * own words ("Send email on Gmail"), or "Run N actions on <apps>" for several.
 * Null when the payload cannot be read — the caller falls back to the wrapper
 * name's copy.
 */
function describeMetaExecutor(call: ToolCall): string | null {
  const inner = extractInnerComposioTools(call);
  if (inner === null) return null;
  if (inner.length === 1) return describeComposio(inner[0].slug);
  const apps: string[] = [];
  for (const { toolkit } of inner) {
    const display = toolkitDisplayName(toolkit);
    if (!apps.includes(display)) apps.push(display);
  }
  return `Run ${inner.length} actions on ${joinApps(apps)}`;
}

/** "Gmail" / "Gmail and Notion" / "Gmail, Notion and Slack". */
function joinApps(apps: string[]): string {
  if (apps.length <= 1) return apps[0] ?? '';
  return `${apps.slice(0, -1).join(', ')} and ${apps[apps.length - 1]}`;
}

/** `SEND_EMAIL` → "Send email". */
function actionWords(action: string): string {
  const words = action.split('_').filter((w) => w.length > 0);
  if (words.length === 0) return 'Use';
  const lower = words.map((w) => w.toLowerCase());
  return lower[0].charAt(0).toUpperCase() + lower[0].slice(1) + (lower.length > 1 ? ' ' + lower.slice(1).join(' ') : '');
}

// ═══════════════════════════════════════════════════════════════════════════
// small helpers
// ═══════════════════════════════════════════════════════════════════════════

function fileVerbPhrase(verb: string, toolInput: unknown, fallback: string): string {
  const filePath = getString(toolInput, 'file_path');
  return filePath ? `${verb} ${displayName(filePath)}` : `${verb} ${fallback}`;
}

/** A short, human display for a path/target token: unquoted basename, capped. */
function displayName(token: string): string {
  const t = unquote(token);
  const slash = t.lastIndexOf('/');
  const base = slash >= 0 && slash < t.length - 1 ? t.slice(slash + 1) : t;
  return truncate(base, MAX_TARGET_LENGTH);
}

function unquote(token: string): string {
  const t = token.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(unquote(url)).hostname || null;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function cap(s: string): string {
  return truncate(s, MAX_SUMMARY_LENGTH);
}

function getString(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// describeRule — the plain-language one-liner for a STORED permission rule
// ═══════════════════════════════════════════════════════════════════════════

/**
 * describeRule — the human sentence for a stored permission-rule string, the
 * deterministic sibling of describeToolCall for the permissions page ("Things
 * Bash may always do") and the "Always allow" button label. It renders the rule
 * DSL — `Bash(git push:*)`, `Write(/app/report.md)`,
 * `WebFetch(domain:api.github.com)`, `mcp__composio__GMAIL_SEND_EMAIL`, a bare
 * `Tool` — as words a non-technical user reads.
 *
 * Reuses this module's private humanizers (`describeComposio`, `displayName`) and
 * the rule engine's `parseToolSpecifier` — one grammar, one set of tables,
 * nothing to drift.
 *
 * COPY RULES (same as describeToolCall): no em dashes; never the word "Claude";
 * ≤ 80 chars; destructive words never softened. PURE / TOTAL / NEVER-THROWS.
 */
export function describeRule(rule: string): string {
  try {
    if (typeof rule !== 'string' || rule.trim() === '') return 'Use this tool';
    const { toolName, ruleContent } = parseToolSpecifier(rule.trim());

    // Composio / generic MCP rules are bare tool names (no specifier).
    if (toolName.startsWith(COMPOSIO_TOOL_PREFIX)) {
      return cap(describeComposio(toolName.slice(COMPOSIO_TOOL_PREFIX.length)));
    }
    if (toolName.startsWith('mcp__')) {
      return cap(describeGenericMcp(toolName));
    }

    // A rule with a real specifier reads by what it scopes; `*` / '' are blanket.
    const content =
      ruleContent !== undefined && ruleContent !== '' && ruleContent !== '*'
        ? ruleContent
        : null;
    if (content !== null) {
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        return cap(describeRuleBash(content));
      }
      if (toolName === 'Read') return cap(`Read ${displayName(content)}`);
      if (
        toolName === 'Write' ||
        toolName === 'Edit' ||
        toolName === 'MultiEdit' ||
        toolName === 'NotebookEdit'
      ) {
        return cap(`Edit ${displayName(content)}`);
      }
      if (toolName === 'WebFetch') {
        const host = content.startsWith('domain:')
          ? content.slice('domain:'.length)
          : content;
        return cap(host ? `Fetch from ${truncate(host, MAX_TARGET_LENGTH)}` : 'Fetch web pages');
      }
    }

    // Bare tool (or `Tool(*)`): a blanket grant for that tool. The shell tools
    // get plain words — "Use Bash freely" reads as product jargon to the
    // non-technical user the grants list is written for.
    if (toolName === 'Bash' || toolName === 'PowerShell') return 'Run any command';
    return cap(toolName ? `Use ${toolName} freely` : 'Use this tool');
  } catch {
    return 'Use this tool';
  }
}

/** Command families that read better than the generic "Run <x> commands" form. */
const BASH_RULE_PHRASES: ReadonlyMap<string, string> = new Map([
  ['git push', 'Push code with git'],
]);

/** CLIs whose `run` subcommand is filler to a human ("npm run test" ≡ "npm test"). */
const RUN_SCRIPT_CLIS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo']);

/** `git push:*` → "Push code with git"; `npm run test:*` → "Run npm test commands". */
function describeRuleBash(content: string): string {
  const prefix = stripRuleWildcard(content).trim();
  if (prefix === '') return 'Run shell commands';
  const known = BASH_RULE_PHRASES.get(prefix);
  if (known) return known;
  const words = prefix.split(/\s+/).filter((w) => w.length > 0);
  if (words.length >= 3 && RUN_SCRIPT_CLIS.has(words[0]) && words[1] === 'run') {
    words.splice(1, 1); // drop the filler "run"
  }
  return `Run ${words.join(' ')} commands`;
}

/** Strip a trailing rule wildcard (`:*`, ` *`, or `*`) to recover the command prefix. */
function stripRuleWildcard(content: string): string {
  if (content.endsWith(':*')) return content.slice(0, -2);
  if (content.endsWith(' *')) return content.slice(0, -2);
  if (content.endsWith('*')) return content.slice(0, -1);
  return content;
}

// ═══════════════════════════════════════════════════════════════════════════
// describePermissionAsk — the RICH permission-card producer
//
// The deterministic sibling of describeToolCall: instead of ONE headline it
// returns everything a rich permission card renders — a verb headline, the
// label/value detail rows extracted from the REAL call args, a primary-button
// label that names the action, and a why-line naming which floor fired. The
// gateway assembles it at request time and threads the pieces onto the
// (optional) ToolPermissionRequest.details / .actionLabel / .reason fields; old
// bundles ignore them and fall back to exactly today's rendering.
//
// Same contract as describeToolCall: DETERMINISTIC / PURE / TOTAL / NEVER-THROWS,
// no I/O, no state. COPY RULES enforced by test: no em dashes; never "Claude";
// headline <= 80. And the hard product rule — NEVER invent a value: a missing
// arg omits its row (never a placeholder), a missing amount degrades the button
// to "Approve payment" (never a fabricated number).
// ═══════════════════════════════════════════════════════════════════════════

/** Which floor produced this ask — drives the why-line and (web-side) the tone. */
export type PermissionAskFloor = 'hard' | 'soft' | 'rule';

/** One label/value row on the card. `tone` styles the value (red note / quoted preview). */
export interface PermissionAskDetail {
  label: string;
  value: string;
  tone?: 'danger' | 'quote';
}

/** What the gateway knows about WHY this ask fired — the producer's only input beyond the call. */
export interface PermissionAskContext {
  family: SideEffectFamily;
  floor: PermissionAskFloor;
  /** The session access level, for the soft why-line wording. Absent when flag-off. */
  level?: AccessLevel;
  /**
   * The vendor's hints — the SAME map the gate classified with, so a
   * DELETE-named read batched beside a real delete is never counted as an item
   * to delete (side-effect-classifier `composioToolHints`).
   */
  composioToolHints?: ComposioToolHints;
  /**
   * L16 D5: the call is a company's registered client tool. The access level never asks about
   * one, so only a company ask rule brings it here: plain copy and the rule reason.
   */
  clientTool?: boolean;
  /**
   * The call runs code in Composio's remote sandbox and an app pin makes it ask (remote-code-pins.ts):
   * the card names the workbench, not the one app a literal slug in the script happens to name.
   */
  remoteCode?: boolean;
}

/** The rich card contents. `reasonLine` is the sentence; the gateway wraps it with family+floor. */
export interface PermissionAsk {
  headline: string;
  details: PermissionAskDetail[];
  actionLabel: string;
  reasonLine: string;
}

/** Today's neutral fallback button — a family with no special copy keeps it. */
const GENERIC_ALLOW_LABEL = 'Allow once';
/** Families whose ask stands on its own (payment, unreadable, shared history, deletes). */
const ALWAYS_ASK_FAMILIES: ReadonlySet<SideEffectFamily> = new Set(['payment', 'unknown', 'protected_remote', 'dangerous_delete']);

/**
 * What each family says when the CALL ITSELF cannot be put into words — an
 * opaque script (unenumerable, preamble-only head) has nothing to describe, but
 * the gate still knows WHAT KIND of action it is, and that is what the user
 * needs. Founder ruling 2026-08-09, after a delete ask reached him as "Run set":
 * users are non-technical, so a family sentence beats a token from the script.
 */
const FAMILY_HEADLINE: Record<SideEffectFamily, string> = {
  readonly: 'Read files in your workspace',
  workspace_write: 'Update files in your workspace',
  external_send: 'Send a message',
  external_mutation: 'Make a change in a connected app',
  dangerous_delete: DELETE_IN_WORKSPACE,
  unknown: UNREADABLE_HEADLINE,
  protected_remote: 'Rewrite or delete shared code history',
  payment: 'Approve a payment',
};

/**
 * The headline in the call's OWN words, falling back to its family's when the
 * call has none. The single site every card takes its headline from, so no
 * family can leak raw script text.
 */
function headlineFor(call: ToolCall, family: SideEffectFamily): string {
  const toolName = typeof call?.toolName === 'string' ? call.toolName : '';
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const phrase = describeBashCommand(getString(call.toolInput, 'command'));
    return cap(phrase ?? FAMILY_HEADLINE[family]);
  }
  return describeToolCall(call);
}

const REASON_UNREADABLE =
  "I could not read what this step does, so I am checking with you before it runs.";

const REASON_PAYMENT =
  'Payments always need your OK. On every level, including Autopilot. Money never moves without you.';
const REASON_DELETE = 'Deletions always check with you. Only Autopilot runs them alone.';
const REASON_PROTECTED =
  'Force pushes and remote deletes always check with you, on every level including Autopilot.';
const REASON_RULE = 'You asked me to check before this.';

/** Cap for a single preview value (subject / description / customer). */
const MAX_PREVIEW_LENGTH = 60;
/** Cap for a message-body preview inside the quoted row. */
const MAX_BODY_PREVIEW = 90;

/** Mail toolkits — a send is "an email", a delete counts "email(s)". */
const MAIL_TOOLKITS: ReadonlySet<string> = new Set(['gmail', 'outlook', 'googlemail']);
/** Social toolkits — a send is a "Post". */
const SOCIAL_TOOLKITS: ReadonlySet<string> = new Set([
  'twitter', 'linkedin', 'reddit', 'instagram', 'facebook', 'pinterest', 'mastodon',
]);
/** Payment toolkits whose integer `amount` is in MINOR units (cents). Others are left as-is. */
const KNOWN_CENTS_TOOLKITS: ReadonlySet<string> = new Set([
  'stripe', 'square', 'braintree', 'adyen', 'razorpay',
]);

/** Inner-tool slug field names (mirrors composio-naming INNER_SLUG_FIELDS + tool-display). */
const INNER_SLUG_FIELDS = [
  'tool_slug', 'tool_name', 'toolName', 'name', 'action', 'action_name', 'slug',
] as const;
/** Inner-tool arguments field names (mirrors tool-display extractRealTool). */
const INNER_ARGS_FIELDS = ['arguments', 'input', 'params', 'parameters'] as const;

/**
 * Which floor a family/level lands on — the gateway's helper for the `reason`
 * it threads onto the request (the gate itself doesn't hand the family/floor to
 * the assembly site, so this recomputes it from the SAME exported ladder pieces,
 * never an ad-hoc parallel table). `rule` is the residual: a prompt that is
 * neither a hard floor nor a level soft-ask came from an ask-rule (or, flag-off,
 * a non-payment/non-delete floor which does not exist — so still an ask-rule).
 */
export function permissionAskFloor(family: SideEffectFamily, level?: AccessLevel): PermissionAskFloor {
  const effective = level ?? 'relaxed';
  if (hardFloors(family, effective)) return 'hard';
  if (level !== undefined && levelAsks(family, level)) return 'soft';
  return 'rule';
}

/**
 * The rich card for a permission ask. Total: any unexpected shape degrades to the
 * neutral "Allow this action?" + "Allow once" card, never a throw.
 */
export function describePermissionAsk(call: ToolCall, ctx: PermissionAskContext): PermissionAsk {
  try {
    if (ctx.clientTool) {
      return { headline: `Use the tool ${call.toolName}`, details: [], actionLabel: GENERIC_ALLOW_LABEL, reasonLine: REASON_RULE };
    }
    // The always-ask families keep their own card: those words are truer than the pin's.
    if (ctx.remoteCode && !ALWAYS_ASK_FAMILIES.has(ctx.family)) {
      return { headline: REMOTE_CODE_ASK_HEADLINE, details: [], actionLabel: GENERIC_ALLOW_LABEL, reasonLine: REMOTE_CODE_ASK_REASON };
    }
    const reasonLine = reasonLineFor(ctx);
    const target = resolveTarget(call, ctx.family, ctx.composioToolHints);
    switch (ctx.family) {
      case 'external_send':
        return { ...sendCard(target), reasonLine };
      case 'dangerous_delete':
        return { ...deleteCard(call, target), reasonLine };
      case 'payment':
        return { ...paymentCard(target), reasonLine };
      case 'unknown':
        return { ...unreadableCard(target), reasonLine };
      case 'protected_remote':
        return { ...protectedCard(call), reasonLine };
      case 'external_mutation':
        return { ...mutationCard(call, target), reasonLine };
      default:
        // readonly / workspace_write / anything else: the plain one-liner as the
        // headline, no detail rows, today's neutral button.
        return { headline: headlineFor(call, ctx.family), details: [], actionLabel: GENERIC_ALLOW_LABEL, reasonLine };
    }
  } catch {
    return { headline: 'Allow this action?', details: [], actionLabel: GENERIC_ALLOW_LABEL, reasonLine: REASON_RULE };
  }
}

// ── why-line ────────────────────────────────────────────────────────────────

function reasonLineFor(ctx: PermissionAskContext): string {
  if (ctx.family === 'unknown') return REASON_UNREADABLE;
  if (ctx.family === 'payment') return REASON_PAYMENT;
  if (ctx.family === 'protected_remote') return REASON_PROTECTED;
  if (ctx.floor === 'hard' && ctx.family === 'dangerous_delete') return REASON_DELETE;
  if (ctx.floor === 'soft') {
    // Careful frames on "changes" (it asks before any change); Balanced (and a
    // Careful external ask) frames on "leaving your accounts".
    if (ctx.level === 'careful' && ctx.family === 'workspace_write') {
      return 'Careful checks with you before anything changes.';
    }
    const levelName = ctx.level === 'careful' ? 'Careful' : 'Balanced';
    return `${levelName} checks with you before anything leaves your accounts.`;
  }
  return REASON_RULE;
}

// ── the call's effective target (unwrapping executor meta-tools) ──────────────

interface AskTarget {
  /** Lowercase toolkit slug, or null for opaque/non-Composio calls. */
  toolkit: string | null;
  /** UPPERCASE action segment (e.g. 'SEND_EMAIL'), or null when unknown. */
  action: string | null;
  /** The real call args (the inner tool's args for a MULTI_EXECUTE payload). */
  args: Record<string, unknown>;
  /** How many items a delete removes (inner delete count, or an ids-array length; >= 1). */
  deleteCount: number;
}

const EMPTY_TARGET: AskTarget = { toolkit: null, action: null, args: {}, deleteCount: 1 };

function resolveTarget(
  call: ToolCall,
  family: SideEffectFamily,
  hints?: ComposioToolHints,
): AskTarget {
  try {
    const toolName = typeof call?.toolName === 'string' ? call.toolName : '';
    if (!toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return EMPTY_TARGET;

    // Executor meta-tool. MULTI_EXECUTE exposes a readable tools[] (classify +
    // extract inner args); a WORKBENCH code payload does not (classifyMetaExecutorTools
    // returns null) — it degrades to generic-by-family copy, no invented slug.
    if (isComposioExecutorMetaTool(toolName)) {
      const inner = classifyMetaExecutorTools(call, hints);
      if (inner === null || inner.length === 0) return EMPTY_TARGET;
      const chosen = inner.find((t) => t.family === family) ?? inner[0];
      const deleteCount = inner.filter((t) => t.family === 'dangerous_delete').length || 1;
      return {
        toolkit: chosen.toolkit,
        action: actionSegmentOf(chosen.slug),
        args: innerArgsForSlug(call, chosen.slug),
        deleteCount,
      };
    }

    const split = splitComposioName(toolName);
    if (split === null) return EMPTY_TARGET;
    const args = asRecord(call.toolInput);
    return { toolkit: split.toolkit, action: split.action, args, deleteCount: idsCountOf(args) };
  } catch {
    return EMPTY_TARGET;
  }
}

// ── send ──────────────────────────────────────────────────────────────────────

type Card = Omit<PermissionAsk, 'reasonLine'>;

function sendCard(t: AskTarget): Card {
  const app = t.toolkit ? toolkitDisplayName(t.toolkit) : null;
  const kind = t.toolkit && SOCIAL_TOOLKITS.has(t.toolkit)
    ? 'post'
    : t.toolkit && MAIL_TOOLKITS.has(t.toolkit)
      ? 'email'
      : 'message';

  const details: PermissionAskDetail[] = [];
  const to = recipientValue(t.args);
  if (to) details.push({ label: 'To', value: to });
  if (kind === 'email') {
    const subject = firstString(t.args, ['subject', 'title']);
    if (subject) details.push({ label: 'Subject', value: truncate(subject, MAX_PREVIEW_LENGTH) });
  }
  const body = firstString(t.args, ['body', 'message', 'text', 'content']);
  if (body) details.push({ label: 'Message', value: quote(truncate(body, MAX_BODY_PREVIEW)), tone: 'quote' });

  const headline =
    kind === 'email' ? `Send an email from your ${app}` :
    kind === 'post' ? `Post to ${app}` :
    app ? `Send a message on ${app}` : 'Send a message';
  const actionLabel = kind === 'email' ? 'Send email' : kind === 'post' ? 'Post' : 'Send message';
  return { headline: cap(headline), details, actionLabel };
}

// ── delete ─────────────────────────────────────────────────────────────────────

function deleteCard(call: ToolCall, t: AskTarget): Card {
  const app = t.toolkit ? toolkitDisplayName(t.toolkit) : null;
  const isMail = t.toolkit !== null && MAIL_TOOLKITS.has(t.toolkit);
  const noun = isMail ? 'email' : 'item';
  const n = t.deleteCount;

  const details: PermissionAskDetail[] = [];
  const subject = firstString(t.args, ['subject', 'title', 'name', 'email_subject']);
  if (subject) details.push({ label: isMail ? 'Email' : 'Item', value: quote(truncate(subject, MAX_PREVIEW_LENGTH)), tone: 'quote' });
  const from = firstString(t.args, ['sender', 'from', 'from_email', 'author']);
  if (from) details.push({ label: 'From', value: truncate(from, MAX_PREVIEW_LENGTH) });
  details.push({
    label: 'Note',
    value: isMail ? 'Skips the Trash. This cannot be undone.' : 'This cannot be undone.',
    tone: 'danger',
  });

  // A Composio delete gets the counted "N email(s)/item(s)" headline+button; a
  // non-Composio delete (Bash rm) names the files it removes, or says which
  // family it belongs to when the script is opaque.
  const headline = app
    ? `Permanently delete ${n} ${plural(noun, n)} from your ${app}`
    : headlineFor(call, 'dangerous_delete');
  const actionLabel = t.toolkit ? `Delete ${n} ${plural(noun, n)}` : 'Delete files';
  return { headline: cap(headline), details, actionLabel };
}

// ── payment ────────────────────────────────────────────────────────────────────

function paymentCard(t: AskTarget): Card {
  const app = t.toolkit ? toolkitDisplayName(t.toolkit) : null;
  const money = extractMoney(t.args, t.toolkit);

  const details: PermissionAskDetail[] = [];
  if (money) details.push({ label: 'Amount', value: money.row });
  const customer = customerValue(t.args);
  if (customer) details.push({ label: 'Customer', value: customer });
  const forVal = firstString(t.args, ['description', 'memo', 'statement_descriptor', 'note', 'reason']);
  if (forVal) details.push({ label: 'For', value: quote(truncate(forVal, MAX_PREVIEW_LENGTH)), tone: 'quote' });

  const headline = money
    ? `Charge a customer ${money.button} through ${app ?? 'a connected app'}`
    : app ? `Charge a customer through ${app}` : 'Approve a payment';
  const actionLabel = money ? `Pay ${money.button}` : 'Approve payment';
  return { headline: cap(headline), details, actionLabel };
}

// ── unreadable ─────────────────────────────────────────────────────────────────

/**
 * A call the gate could not read. The headline states that and nothing else; the
 * app is named when the target resolved one, because "in Notion" is true and
 * useful even when the action is not.
 */
function unreadableCard(t: AskTarget): Card {
  const app = t.toolkit ? toolkitDisplayName(t.toolkit) : null;
  return {
    headline: app ? `${UNREADABLE_HEADLINE} in ${app}` : UNREADABLE_HEADLINE,
    details: [],
    actionLabel: GENERIC_ALLOW_LABEL,
  };
}

// ── protected git action ───────────────────────────────────────────────────────

/**
 * A rewrite or delete of shared history: a force push, a remote branch delete, a mirror, a
 * repository delete. The headline is the catalog's own sentence for the protected position
 * ("Force-push (rewrites history) to feature/x on origin"), and the button names the act.
 */
function protectedCard(call: ToolCall): Card {
  const command = getString(call.toolInput, 'command');
  // The command's own positions, then the code a stdin-fed shell in it runs (`bash <<EOF`, `echo … | sh`).
  const git = command === null
    ? undefined
    : [stripHeredocBodies(command), ...shellStdinCode(command)]
      .flatMap((code) => analyzeCommand(code).commands)
      .map((c) => positionGitVerdict(c))
      .find((v) => v?.kind === 'protected');
  return {
    headline: git ? cap(git.headline) : headlineFor(call, 'protected_remote'),
    details: [{ label: 'Note', value: "This rewrites or deletes history other people's work depends on. It cannot be undone.", tone: 'danger' }],
    actionLabel: git?.actionLabel ?? GENERIC_ALLOW_LABEL,
  };
}

// ── external mutation ──────────────────────────────────────────────────────────

function mutationCard(call: ToolCall, t: AskTarget): Card {
  if (call.toolName === GITHUB_PULL_REQUEST_TOOL) return pullRequestCard(call, describeToolCall(call));
  // The headline reuses the shared humanizer ("Update page on Notion"); the
  // button names the action verb from the slug ("Update page", "Add label"), or
  // for a git push the catalog's own ("Push to main").
  const command = call.toolName === 'Bash' ? getString(call.toolInput, 'command') : null;
  const git = command === null
    ? undefined
    : analyzeCommand(stripHeredocBodies(command)).commands.map((c) => positionGitVerdict(c)).find((v) => v?.kind === 'external');
  return {
    headline: headlineFor(call, 'external_mutation'),
    details: [],
    actionLabel: t.action ? cap(actionWords(t.action)) : git?.actionLabel ?? GENERIC_ALLOW_LABEL,
  };
}

// ── extraction helpers ─────────────────────────────────────────────────────────

interface Money { /** "$500.00 USD" — the detail row. */ row: string; /** "$500.00" — the button. */ button: string }

/**
 * The charge amount as display strings, or null when no amount is readable (the
 * caller then degrades to "Approve payment" — NEVER a fabricated number). Integer
 * amounts on a known cents-convention toolkit are minor units (Stripe's 50000 →
 * $500.00); a decimal amount is always taken as major units as given.
 */
function extractMoney(args: Record<string, unknown>, toolkit: string | null): Money | null {
  const parsed = parseAmount(args['amount'] ?? args['amount_cents'] ?? args['total'] ?? args['value']);
  if (parsed === null) return null;
  const isCents = toolkit !== null && KNOWN_CENTS_TOOLKITS.has(toolkit) && parsed.integer;
  const major = isCents ? parsed.num / 100 : parsed.num;
  const currency = (firstString(args, ['currency', 'currency_code']) ?? '').toUpperCase();
  const grouped = groupThousands(major.toFixed(2));
  if (currency === '' || currency === 'USD') {
    return { row: `$${grouped} USD`, button: `$${grouped}` };
  }
  return { row: `${grouped} ${currency}`, button: `${grouped} ${currency}` };
}

function parseAmount(raw: unknown): { num: number; integer: boolean } | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { num: raw, integer: Number.isInteger(raw) };
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^0-9.]/g, '');
    if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
    return { num: parseFloat(cleaned), integer: !cleaned.includes('.') };
  }
  return null;
}

/** "$1,500.50" grouping on a `toFixed(2)` string. */
function groupThousands(fixed: string): string {
  const [int, frac] = fixed.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}

/** "Acme (cus_9x2…)" / "Acme" / "cus_9x2AbC" / null. */
function customerValue(args: Record<string, unknown>): string | null {
  const name = firstString(args, ['customer_name', 'customer_email']);
  const id = firstString(args, ['customer', 'customer_id']);
  if (name && id) return `${truncate(name, 40)} (${truncate(id, 12)})`;
  return name ?? id ?? null;
}

/** A recipient string, or the first few of a recipients array, or null. */
function recipientValue(args: Record<string, unknown>): string | null {
  for (const f of ['recipient_email', 'recipient', 'to', 'recipients', 'email', 'channel', 'chat_id']) {
    const v = args[f];
    if (typeof v === 'string' && v.trim() !== '') return truncate(v.trim(), 80);
    if (Array.isArray(v)) {
      const parts = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
      if (parts.length > 0) {
        const shown = parts.slice(0, 3).join(', ');
        return truncate(parts.length > 3 ? `${shown} +${parts.length - 3} more` : shown, 80);
      }
    }
  }
  return null;
}

/** The inner tool's args from a MULTI_EXECUTE payload, matched by slug (falls to the first entry). */
function innerArgsForSlug(call: ToolCall, slug: string): Record<string, unknown> {
  const input = call.toolInput;
  if (!input || typeof input !== 'object') return {};
  const tools = (input as Record<string, unknown>).tools;
  if (!Array.isArray(tools) || tools.length === 0) return {};
  const want = slug.toUpperCase();
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const entrySlug = firstString(rec, [...INNER_SLUG_FIELDS]);
    if (entrySlug && entrySlug.toUpperCase() === want) return argsObjectOf(rec);
  }
  const first = tools[0];
  return first && typeof first === 'object' ? argsObjectOf(first as Record<string, unknown>) : {};
}

function argsObjectOf(entry: Record<string, unknown>): Record<string, unknown> {
  for (const f of INNER_ARGS_FIELDS) {
    const v = entry[f];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return {};
}

/** Count of ids in a delete payload's array field, else 1. */
function idsCountOf(args: Record<string, unknown>): number {
  for (const f of ['message_ids', 'ids', 'messageIds', 'message_id_list']) {
    const v = args[f];
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 1;
}

function splitComposioName(tool: string): { toolkit: string; action: string } | null {
  const suffix = tool.slice(COMPOSIO_TOOL_PREFIX.length);
  const u = suffix.indexOf('_');
  if (u <= 0) return null;
  return { toolkit: suffix.slice(0, u).toLowerCase(), action: suffix.slice(u + 1).toUpperCase() };
}

/** 'GMAIL_SEND_EMAIL' → 'SEND_EMAIL'. */
function actionSegmentOf(slug: string): string {
  const u = slug.indexOf('_');
  return (u > 0 ? slug.slice(u + 1) : slug).toUpperCase();
}

function firstString(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function quote(s: string): string {
  return `"${s}"`;
}

function plural(noun: string, n: number): string {
  return n === 1 ? noun : `${noun}s`;
}
