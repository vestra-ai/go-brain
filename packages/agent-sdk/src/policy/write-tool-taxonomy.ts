/**
 * K6 P3 C6 — THE PLAN-MODE WRITE/READ TAXONOMY.
 *
 * Plan mode (Claude-Code parity) is READ-ONLY: the agent investigates and
 * PRESENTS a plan; it cannot mutate the world. It leaves plan mode ONLY by
 * calling ExitPlanMode (the user approves "proceed?"). To enforce that, the
 * gate's MODE step (decideToolGate, step 6 — BEFORE the ALLOW step) blocks any
 * WRITE while `ctx.mode === 'plan'`. This module is the single, documented
 * decision of what counts as a WRITE.
 *
 * ── A WRITE (plan blocks it) ────────────────────────────────────────────────
 *   - builtin file edits: Write / Edit / NotebookEdit / MultiEdit
 *   - Bash with a MUTATING command — `>`/`>>` redirection, or a mutating head
 *     command (rm/mv/cp/mkdir/touch/tee/sed -i/dd/install/git commit|push/…),
 *     evaluated PER ENUMERATED COMMAND POSITION. Under the default-ON gate
 *     (VESTRA_BASH_AST_GATE) the shared command analyzer enumerates every
 *     position — including backgrounded (`… & rm x`), process-substituted
 *     (`<(rm x)`), and `sh -c "rm x"` bodies — so a mutation ANYWHERE (not just
 *     in a top-level `ls && rm x` segment) makes the whole call a write; an
 *     unparseable command FAILS CLOSED (write, so plan mode blocks it). With the
 *     kill-switch OFF (`VESTRA_BASH_AST_GATE=0`) the legacy compound-segment
 *     scan applies (byte-identical to the prior behavior).
 *   - MCP (non-composio) create_/update_/delete_/push_/put_/post_ verbs
 *   - Composio CREATE/UPDATE/DELETE/SEND/POST/PUT actions
 *
 * ── A READ (plan allows it) ─────────────────────────────────────────────────
 *   - Read / Grep / Glob / WebSearch / WebFetch / TodoWrite(plan-safe) /
 *     AskUserQuestion / ExitPlanMode (ExitPlanMode is the EXIT — never a write)
 *   - ToolSearch (loads deferred tools' definitions into the session, nothing else)
 *   - session_search (reads the user's past sessions, nothing else)
 *   - Bash with a read-only head command (ls/cat/grep/find/rg/head/tail/
 *     git status|log|diff/echo without redirect)
 *   - MCP / Composio get_/list_/search_/read_ (GET/LIST/SEARCH) verbs
 *
 * ── CONSERVATIVE DIRECTION (the load-bearing call) ──────────────────────────
 * When UNCERTAIN — an unrecognized Bash head command, an unknown MCP/Composio
 * verb, an unparseable shell command — treat the call as a WRITE (return true).
 * In plan mode over-blocking is SAFE: the user can ExitPlanMode to proceed.
 * Under-blocking is the BUG: it lets a real mutation slip into a read-only plan.
 * So every "I don't recognize this" branch resolves to `true`.
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

import type { ToolCall } from '../contract/harness.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { splitShellSegments } from './shell-split.js';
import { analyzeCommand } from './command-analyzer.js';
import { bashAstGateEnabled } from './feature-flags.js';
import { gitCatalogVerdict } from './git-command-catalog.js';
import { TOOL_SEARCH_TOOL_NAME } from '../engine/tool-search.js';

// ═══════════════════════════════════════════════════════════════════════════
// Builtin tools
// ═══════════════════════════════════════════════════════════════════════════

/** Builtin tools that ALWAYS write (file mutations). */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'Patch',
  'NotebookEdit',
  'MultiEdit',
]);

/**
 * Builtin tools that are ALWAYS reads (plan-safe) regardless of input. TodoWrite
 * "writes" only the in-session todo list (no world mutation) — plan-safe.
 * ExitPlanMode is the EXIT from plan mode, never a write. AskUserQuestion just
 * prompts the user. Web* + Read/Grep/Glob are pure reads.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  // Agents first (1c): a pure read of the agent's OWN notebook. Its two siblings,
  // NotebookAppend and NotebookCompact, change the file and stay writes.
  'NotebookRead',
  // Tool search: returns deferred tools' schemas and marks them loaded for this
  // session. It reaches nothing outside the process, and a tool it loads is still
  // judged by name when called. As an unnamed tool it was a write, so plan mode
  // could not load any deferred tool, not even a read.
  TOOL_SEARCH_TOOL_NAME,
  // Past-session search (apps/sandbox harness/tools/session-tools.ts, a literal there too:
  // the SDK cannot import the product). It only reads: a POST that runs SELECTs and a STABLE
  // RPC on the server, or a local transcript grep when the server is down. As an unnamed
  // tool it was a write, so plan mode refused it (staging drill, 30 Sep).
  'session_search',
  // X5b: lists or reads a connected MCP server's resources (apps/sandbox mcp-resources-tool.ts).
  'mcp_resources',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Bash command taxonomy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Head commands (the first word of a shell segment) that MUTATE the filesystem /
 * repo / system. A segment whose head is one of these is a write. `install` is
 * matched as a SUBCOMMAND of package managers (npm/pip/apt/…) below, not here.
 */
const MUTATING_HEADS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'tee', 'dd',
  'ln', 'chmod', 'chown', 'truncate', 'install', 'unlink', 'shred',
  'rsync', 'patch', 'make',
]);

/**
 * Read-only head commands — the explicit allowlist of investigative commands a
 * plan may run. Anything NOT here (and not a recognized mutator) is conservative
 * → write. Kept tight: only commands that observe without mutating.
 */
const READONLY_HEADS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'head', 'tail',
  'echo', 'pwd', 'wc', 'sort', 'uniq', 'cut', 'awk', 'tr', 'diff', 'cmp',
  'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'date', 'env',
  'printenv', 'whoami', 'id', 'hostname', 'uname', 'basename', 'dirname',
  'realpath', 'readlink', 'tree', 'jq', 'xxd', 'od', 'nl', 'column', 'less',
  'more', 'tac', 'seq', 'test', 'true', 'false', 'sleep', 'man', 'help',
]);

/** Leading wrappers we skip to find the real head command. */
const WRAPPER_HEADS: ReadonlySet<string> = new Set(['sudo', 'command', 'env', 'nice', 'time', 'nohup', 'xargs']);

/** Package-manager binaries whose `install`/`add`/`remove`/etc. subcommands mutate. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'apt', 'apt-get', 'brew', 'gem',
  'cargo', 'go', 'bundle', 'poetry', 'conda', 'dnf', 'yum', 'pacman', 'apk',
]);

/** Mutating package-manager subcommands. */
const PM_MUTATING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade',
  'publish', 'link', 'unlink', 'get', 'build', 'run',
]);

/**
 * Read-only git subcommands. A git head with any OTHER subcommand is
 * conservative-write. NOTE: `tag`/`stash`/`branch`/`config` are deliberately NOT
 * here — they mutate local repo/worktree state (`git tag v1`, `git stash`,
 * `git branch x`, `git config k v`), so in read-only plan mode they must classify
 * as WRITES. We don't arg-parse a bare `git branch` (which only lists): over-
 * blocking it in plan mode is the safe direction — a planning agent shouldn't be
 * tagging/branching/stashing anyway.
 */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'remote',
  'rev-parse', 'describe', 'blame', 'shortlog', 'ls-files', 'ls-tree',
  'cat-file', 'reflog', 'whatchanged', 'grep', 'for-each-ref',
]);

// ═══════════════════════════════════════════════════════════════════════════
// MCP / Composio verb taxonomy
// ═══════════════════════════════════════════════════════════════════════════

/** Mutating verbs (whole `_`-delimited words) for MCP + Composio actions. */
const MCP_WRITE_VERBS: readonly string[] = [
  'CREATE', 'UPDATE', 'DELETE', 'PUSH', 'PUT', 'POST', 'SEND', 'PATCH',
  'REMOVE', 'INSERT', 'WRITE', 'ADD', 'SET', 'MODIFY', 'UPLOAD', 'PUBLISH',
  'MERGE', 'CLOSE', 'ARCHIVE', 'MOVE', 'COPY', 'RENAME', 'EDIT', 'REPLY',
  'CANCEL', 'APPROVE', 'REJECT', 'COMPLETE', 'EXECUTE', 'RUN', 'TRIGGER',
];

/** Read verbs — a Composio/MCP action whose verb word is one of these is a read. */
const MCP_READ_VERBS: readonly string[] = [
  'GET', 'LIST', 'SEARCH', 'READ', 'FETCH', 'FIND', 'QUERY', 'RETRIEVE',
  'DOWNLOAD', 'VIEW', 'SHOW', 'DESCRIBE', 'CHECK', 'COUNT', 'LOOKUP',
];

// ═══════════════════════════════════════════════════════════════════════════
// public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Does this call MUTATE the world (so plan mode must block it)? Total — any
 * unexpected shape degrades to the CONSERVATIVE answer: a recognized read is
 * `false`; everything else uncertain is `true` (block in plan mode).
 */
export function isWriteTool(call: ToolCall): boolean {
  try {
    if (!call || typeof call.toolName !== 'string') return true; // unknown shape → conservative write
    const tool = call.toolName;

    // 1. Builtin tools — explicit read / write sets.
    if (READ_TOOLS.has(tool)) return false;
    if (WRITE_TOOLS.has(tool)) return true;

    // 2. Bash / PowerShell — segment-aware mutating-command detection.
    if (tool === 'Bash' || tool === 'PowerShell') {
      return bashWrites(getCommand(call.toolInput));
    }

    // 3. Composio tools — verb word from the ACTION suffix.
    if (tool.startsWith(COMPOSIO_TOOL_PREFIX)) {
      return composioWrites(tool);
    }

    // 4. Generic (non-composio) MCP tools (`mcp__server__action`) — verb word.
    if (tool.startsWith('mcp__')) {
      return mcpActionWrites(mcpActionSegment(tool));
    }

    // 5. Any other tool name we don't recognize → conservative write.
    //    (All KNOWN read-only builtins are in READ_TOOLS above; an unrecognized
    //     bare tool name could mutate, so block it in plan mode.)
    return true;
  } catch {
    // Total: never throw out of the taxonomy. The safe plan-mode direction on an
    // error is to BLOCK (treat as write) — under-blocking is the bug.
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// internals — Bash
// ═══════════════════════════════════════════════════════════════════════════

function getCommand(input: unknown): string | null {
  if (input && typeof input === 'object' && 'command' in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>).command;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/**
 * A Bash command WRITES when ANY enumerated command position mutates — including
 * ones the legacy compound-segment scan missed: backgrounded (`… & rm x`),
 * process-substituted (`<(rm x)`), path-prefixed (`/bin/rm`), wrapper-invoked
 * (`xargs rm`), and `sh -c "rm x"` bodies.
 *
 * Flag-gated (`VESTRA_BASH_AST_GATE`, default ON). OFF → delegate to
 * `legacyBashWrites` (byte-identical to the prior compound-segment behavior). ON →
 * consume the shared command analyzer and classify each enumerated command by its
 * (already-normalized) head. Conservative in BOTH directions plan mode needs: a
 * missing command (`null`), or a command the analyzer cannot confidently enumerate
 * (`parsedSafely: false` — unbalanced quote / command substitution), is a WRITE so
 * plan mode blocks it. Under-blocking is the bug. A command whose subshell or
 * substitution the analyzer reads (`nested`) stays a WRITE, as it was while it
 * was unparseable: only the delete floor reads those bodies. A bare assignment
 * (`assigns`) is conservative the same way.
 */
function bashWrites(command: string | null): boolean {
  if (command === null) return true;                          // no command → conservative write
  if (!bashAstGateEnabled()) return legacyBashWrites(command); // byte-identical when OFF
  const analysis = analyzeCommand(command);
  if (!analysis.parsedSafely || analysis.nested || analysis.assigns) return true; // unparseable / nested / assigns → conservative → treat as write
  return analysis.commands.some((c) => segmentMutatesHead(c.head, c.argv, c.raw));
}

/**
 * LEGACY compound-segment write scan (used when `VESTRA_BASH_AST_GATE` is OFF). A
 * Bash command WRITES when ANY of its compound segments mutates. Conservative:
 * a missing command, or an unparseable command (unbalanced quote / command
 * substitution), is a write — we can't prove it is read-only.
 */
function legacyBashWrites(command: string | null): boolean {
  if (typeof command !== 'string' || command.length === 0) return true; // no command → conservative write

  const { segments, parsedSafely } = splitShellSegments(command);
  if (!parsedSafely) return true; // unparseable → conservative write

  for (const seg of segments) {
    if (segmentMutates(seg)) return true;
  }
  return false;
}

/**
 * Does one ENUMERATED command (from the analyzer) mutate? Same taxonomy as the
 * legacy `segmentMutates`, but the `head` arrives ALREADY normalized (the analyzer
 * skipped wrappers/assignment prefixes, basenamed the path, and unquoted it) so we
 * match it against `MUTATING_HEADS`/`READONLY_HEADS` directly — no re-split, no
 * re-basename. It mutates when it:
 *   - contains a `>` / `>>` output redirection (checked on the command's `raw`), or
 *   - has a recognized mutating head, or
 *   - is a package-manager mutating subcommand (`npm install`, `pip install`), or
 *   - is `git` with a non-read-only subcommand, or
 *   - has an UNRECOGNIZED head (conservative — could be a mutator we don't know).
 * A head in READONLY_HEADS carrying no redirection is a read.
 *
 * Exported for the side-effect classifier (access-level ladder): it reuses this
 * EXACT read/write verdict to tell a `readonly` bash position from a
 * `workspace_write` one, so the two taxonomies never drift.
 */
export function segmentMutatesHead(head: string, argv: string[], raw: string): boolean {
  // Output redirection writes a file. Checked (quote-aware) on the raw command text.
  if (hasOutputRedirect(raw)) return true;

  if (!head) return false; // no command head (defensive) → not a write head

  if (MUTATING_HEADS.has(head)) return true;

  // `sed -i` mutates in place; a plain `sed` (stream) is a read.
  if (head === 'sed') return argv.some((w) => w === '-i' || w.startsWith('-i'));

  // Package managers: a mutating subcommand writes; a read subcommand (`npm ls`)
  // does not, but an UNKNOWN subcommand is conservative-write.
  if (PACKAGE_MANAGERS.has(head)) {
    const sub = argv[0];
    if (!sub) return true; // bare `npm` with no subcommand → conservative write
    return PM_MUTATING_SUBCOMMANDS.has(sub) || !isKnownPmReadSubcommand(sub);
  }

  // git: read-only subcommands pass; everything else (commit/push/merge/…) writes.
  if (head === 'git') {
    const sub = argv[0];
    if (!sub) return false; // bare `git` prints help → read
    return !GIT_READONLY_SUBCOMMANDS.has(sub);
  }

  // gh: the catalog's exact read list reads (`gh pr view`, `gh pr list`); everything else writes.
  if (head === 'gh') return gitCatalogVerdict('gh', argv)?.kind !== 'readonly';

  if (READONLY_HEADS.has(head)) return false;

  // Unrecognized head command → conservative write (could mutate).
  return true;
}

/**
 * Does one shell segment mutate? A segment mutates when it:
 *   - contains a `>` / `>>` output redirection (to a file), or
 *   - has a recognized mutating head command, or
 *   - is a package-manager mutating subcommand (`npm install`, `pip install`), or
 *   - is `git` with a non-read-only subcommand, or
 *   - has an UNRECOGNIZED head (conservative — could be a mutator we don't know).
 * A segment whose head is in READONLY_HEADS and carries no redirection is a read.
 */
function segmentMutates(segment: string): boolean {
  // Output redirection writes a file. `>`/`>>` (but NOT `2>&1`-style fd dups to a
  // descriptor, and not the `<` input redirect). We look for a `>` that targets a
  // path — any unquoted `>` is conservatively a write.
  if (hasOutputRedirect(segment)) return true;

  const words = segment.split(/\s+/).filter((w) => w.length > 0);
  let i = 0;
  while (i < words.length && WRAPPER_HEADS.has(words[i])) i++;
  const head = words[i];
  if (!head) return false; // empty segment (e.g. a bare redirect already handled) → not a write head

  // Strip a leading path (./script, /usr/bin/rm) down to the basename for matching.
  const base = head.includes('/') ? head.slice(head.lastIndexOf('/') + 1) : head;

  if (MUTATING_HEADS.has(base)) return true;

  // `sed -i` mutates in place; a plain `sed` (stream) is a read.
  if (base === 'sed') return words.slice(i + 1).some((w) => w === '-i' || w.startsWith('-i'));

  // Package managers: a mutating subcommand writes; a read subcommand (`npm ls`)
  // does not, but an UNKNOWN subcommand is conservative-write.
  if (PACKAGE_MANAGERS.has(base)) {
    const sub = words[i + 1];
    if (!sub) return true; // bare `npm` with no subcommand → conservative write
    return PM_MUTATING_SUBCOMMANDS.has(sub) || !isKnownPmReadSubcommand(sub);
  }

  // git: read-only subcommands pass; everything else (commit/push/merge/…) writes.
  if (base === 'git') {
    const sub = words[i + 1];
    if (!sub) return false; // bare `git` prints help → read
    return !GIT_READONLY_SUBCOMMANDS.has(sub);
  }

  if (READONLY_HEADS.has(base)) return false;

  // Unrecognized head command → conservative write (could mutate).
  return true;
}

/** Known read-only package-manager subcommands (so they don't trip conservative-write). */
function isKnownPmReadSubcommand(sub: string): boolean {
  return sub === 'ls' || sub === 'list' || sub === 'view' || sub === 'show'
    || sub === 'info' || sub === 'outdated' || sub === 'audit' || sub === 'config'
    || sub === 'why' || sub === 'search' || sub === 'help' || sub === 'version'
    || sub === '--version' || sub === '-v';
}

/**
 * Does the segment contain a `>` / `>>` OUTPUT redirection (outside quotes)?
 * Respects single/double quotes so `echo '> not a redirect'` is NOT a write.
 * A `2>` / `&>` fd-redirect to a FILE also writes; a `2>&1` fd-dup does not, but
 * we conservatively treat any unquoted `>` as a write (over-block is safe).
 */
function hasOutputRedirect(segment: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '\\' && !inSingle) { i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === '>' && !inSingle && !inDouble) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// internals — MCP / Composio
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A Composio tool (`mcp__composio__TOOLKIT_ACTION`) writes per its ACTION verb.
 * CONSERVATIVE: an action with NO recognized read OR write verb word → write.
 */
function composioWrites(tool: string): boolean {
  const suffix = tool.slice(COMPOSIO_TOOL_PREFIX.length); // 'GITHUB_CREATE_ISSUE'
  const underscore = suffix.indexOf('_');
  if (underscore <= 0) return true; // malformed → conservative write
  const action = suffix.slice(underscore + 1).toUpperCase(); // 'CREATE_ISSUE'
  return mcpActionWrites(action);
}

/**
 * Classify an UPPERCASE `_`-delimited MCP/Composio action into write vs read.
 *   - a WRITE verb word present  → write
 *   - else a READ verb word present → read
 *   - else (no recognized verb)   → CONSERVATIVE write.
 * Write is checked first so a mixed action (e.g. CREATE_OR_GET) errs to write.
 */
function mcpActionWrites(action: string): boolean {
  if (!action) return true; // no action segment → conservative write
  const parts = action.toUpperCase().split('_');
  if (parts.some((p) => MCP_WRITE_VERBS.includes(p))) return true;
  if (parts.some((p) => MCP_READ_VERBS.includes(p))) return false;
  return true; // unknown verb → conservative write
}

/**
 * The ACTION segment of a generic (non-composio) MCP tool name, UPPERCASED.
 * `mcp__server__send_message` → 'SEND_MESSAGE'. No action segment → ''.
 */
function mcpActionSegment(tool: string): string {
  const parts = tool.slice('mcp__'.length).split('__');
  if (parts.length < 2) return '';
  return parts.slice(1).join('__').toUpperCase();
}
