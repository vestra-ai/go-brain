/**
 * K6 P3 C1 — the permission RULE ENGINE.
 *
 * A pure parser + matcher + evaluator for the Claude-Code tool-specifier rule
 * DSL (`Bash(npm run test:*)`, `Read(~/.zshrc)`, `WebFetch(domain:example.com)`,
 * `mcp__server__get_*`, bare `Bash`). The matching is the load-bearing security
 * surface: a too-broad ALLOW match under-denies (a real security bug), so the
 * matcher is CONSERVATIVE — when uncertain whether a rule matches, it returns
 * false. (Over-matching a deny is the safe direction; over-matching an allow is
 * not, and we never do it on purpose.)
 *
 * PURE / TOTAL / NEVER-THROWS — no I/O, no fs, no socket, no shared state. Every
 * exported function is total: malformed inputs degrade to a conservative result
 * (parse → bare tool name; match → false), never an exception.
 *
 * Semantics are grounded in the Claude Code permissions docs
 * (code.claude.com/docs/en/permissions, "Tool-specific permission rules").
 *
 * ## What C2 must add (this module is engine-only by design)
 *
 * Wiring this into decideToolGate is C2. Two responsibilities CANNOT live here
 * (the engine is pure — no I/O — and matches one rule against one call), and
 * C2 MUST supply them or the gate is unsafe:
 *
 *   (a) Real path-root resolution. matchPath() tail-matches relative/home/
 *       project-root patterns at a `/` boundary because it cannot read the real
 *       cwd, $HOME, or project root. C2 has those values: it should RESOLVE the
 *       rule's anchor (`~/`→$HOME, leading `/`→project root, bare/`./`→cwd) to an
 *       absolute pattern and the call's file_path to an absolute path before
 *       matching, so an allow rule can't be satisfied by a same-named file in an
 *       unrelated tree. (The tail-match here is the conservative fallback, not
 *       the final word.)
 *
 *   (b) Compound-command splitting for Bash. matchBashContent() matches the
 *       WHOLE `command` string. A shell command can chain subcommands with
 *       `&&`, `||`, `|`, `;` (and newlines). C2 MUST split the command into its
 *       subcommands and require EVERY subcommand to satisfy an allow rule (and
 *       treat the call as denied if ANY subcommand matches a deny). Otherwise an
 *       `allow Bash(ls:*)` rule would over-allow `ls && rm -rf /` — the `rm`
 *       subcommand rides in on the `ls` prefix. This splitting is shell-aware
 *       parsing (quote/escape handling) and belongs in C2, not the pure engine.
 */

import type { ToolCall } from '../contract/harness.js';
import type { PermissionRuleValue, PermissionBehavior } from '../contract/permission.js';

/**
 * C4 path-anchoring roots. INJECTED (the engine never reads the filesystem / env
 * — it stays pure). When supplied, a path rule's anchor resolves to a CONCRETE
 * absolute pattern before matching:
 *   - `~/x`         → `<home>/x`
 *   - leading `/x`  → `<cwd>/x`   (project root == cwd in this sandbox)
 *   - relative `x`  → `<cwd>/x`
 * so a same-named file in an unrelated tree can no longer satisfy an allow rule.
 * BOTH absent → the conservative tail-match fallback is used (today's behavior).
 */
export interface PathAnchors {
  /** Absolute cwd / project root (resolves leading-`/` + relative path rules). */
  cwd?: string;
  /** Absolute $HOME (resolves `~/` path rules). */
  home?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// parseToolSpecifier
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a tool-specifier string into its `{ toolName, ruleContent? }` parts.
 *
 *   'Bash(npm run test:*)'  → { toolName: 'Bash', ruleContent: 'npm run test:*' }
 *   'Bash'                  → { toolName: 'Bash' }
 *   'Bash()'                → { toolName: 'Bash', ruleContent: '' }
 *   'mcp__github__get_*'    → { toolName: 'mcp__github__get_*' }
 *
 * The specifier is the text between the FIRST '(' and the LAST ')', so inner
 * parens in a Bash command (`Bash(echo (hi))`) are preserved as content.
 *
 * Malformed forms degrade SAFELY (never throw):
 *   - no '(' at all                → whole string is the toolName, no content.
 *   - '(' present but no closing ')'→ whole string is the toolName, no content
 *                                     (we do NOT guess a specifier from an
 *                                     unterminated paren — a guess could widen
 *                                     an allow rule).
 */
export function parseToolSpecifier(spec: string): PermissionRuleValue {
  if (typeof spec !== 'string') {
    // Defensive: the type says string, but stay total for untyped callers.
    return { toolName: String(spec ?? '') };
  }

  const open = spec.indexOf('(');
  // No '(' → bare tool name (covers 'Bash', 'mcp__github__get_*', stray ')').
  if (open === -1) {
    return { toolName: spec };
  }

  const close = spec.lastIndexOf(')');
  // '(' with no closing ')' after it → malformed. Treat the whole string as the
  // tool name (conservative: no specifier extracted from an unterminated paren).
  if (close <= open) {
    return { toolName: spec };
  }

  const toolName = spec.slice(0, open);
  const ruleContent = spec.slice(open + 1, close);
  return { toolName, ruleContent };
}

/**
 * Serialize a {@link PermissionRuleValue} back to its Claude-Code tool-specifier
 * string — the inverse of {@link parseToolSpecifier}:
 *   - WITH content → `Tool(content)`  (e.g. `Bash(npm run test:*)`).
 *   - bare (no/empty content) → `Tool` (e.g. `mcp__github__get_issue`).
 */
export function serializeToolSpecifier(rule: PermissionRuleValue): string {
  const name = typeof rule?.toolName === 'string' ? rule.toolName : String(rule?.toolName ?? '');
  return rule?.ruleContent ? `${name}(${rule.ruleContent})` : name;
}

// ───────────────────────────────────────────────────────────────────────────
// matchRule
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does `rule` match `call`?
 *
 * toolName is matched FIRST (literal or a tool-name glob like `*` / `mcp__*`).
 * Then, if the rule has `ruleContent`, the per-tool content semantics decide:
 *
 *   - bare rule (no ruleContent)  → matches ANY input for that tool.
 *   - `*` as ruleContent          → equivalent to bare (matches all).
 *   - Bash / PowerShell           → command glob/prefix (see matchBashContent).
 *   - Read / Edit / Write         → gitignore-style path glob (see matchPath).
 *   - WebFetch                    → `domain:` host glob (see matchWebFetch).
 *   - mcp__server / mcp__server__*→ handled at the toolName layer (no content).
 *   - any other tool with content → conservative literal/glob fallthrough.
 *
 * Conservative on ambiguity: anything we can't confidently match returns false.
 * Total — never throws.
 *
 * `anchors` (optional, INJECTED) resolves path-rule anchors against a real cwd /
 * $HOME — see PathAnchors. Absent → the conservative tail-match fallback. The
 * engine stays PURE: anchors are strings the caller (the gate) supplies.
 */
export function matchRule(
  call: ToolCall,
  rule: PermissionRuleValue,
  anchors?: PathAnchors,
): boolean {
  try {
    if (!rule || typeof rule.toolName !== 'string') return false;
    if (!call || typeof call.toolName !== 'string') return false;

    // 1. toolName gate — literal or tool-name glob.
    if (!matchToolName(call.toolName, rule.toolName)) return false;

    // 2. bare rule, or `Tool(*)` → matches any input for that tool.
    if (rule.ruleContent === undefined || rule.ruleContent === '*') return true;

    // 3. per-tool content semantics, keyed off the CALL's tool name.
    const content = rule.ruleContent;
    const tool = call.toolName;

    if (tool === 'Bash' || tool === 'PowerShell') {
      return matchBashContent(getStringField(call.toolInput, 'command'), content);
    }
    if (
      tool === 'Read' ||
      tool === 'Edit' ||
      tool === 'Write' ||
      tool === 'NotebookEdit' ||
      tool === 'MultiEdit'
    ) {
      // All of these carry the target path in `file_path` (MultiEdit included —
      // its per-edit list lives under `edits`, but the file it targets is still
      // `file_path`). Keep this set in sync with EDIT_FAMILY so an `Edit` rule's
      // path glob is applied to MultiEdit calls too.
      return matchPath(getStringField(call.toolInput, 'file_path'), content, anchors);
    }
    if (tool === 'WebFetch') {
      return matchWebFetch(getStringField(call.toolInput, 'url'), content);
    }

    // Unknown tool with a content specifier: we don't know its argument shape,
    // so we cannot confidently apply a content match. Conservative → no match.
    // (A bare/`*` rule already returned true above; only specific content lands
    // here, and over-matching it would risk a false allow.)
    return false;
  } catch {
    // Total: any unexpected throw degrades to a conservative non-match.
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// evaluateRules
// ───────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the allow/ask/deny rule lists for a call.
 *
 * Precedence (Claude Code docs): "Rules are evaluated in order: deny, then ask,
 * then allow. The first match in that order determines the outcome, and rule
 * specificity does not change the order."
 *
 *   any deny matches  → 'deny'
 *   else any ask      → 'ask'
 *   else any allow    → 'allow'
 *   else              → undefined  (no rule decided; caller falls to mode/default)
 *
 * Total — never throws (matchRule swallows its own errors).
 */
export function evaluateRules(
  call: ToolCall,
  rules: {
    allow: PermissionRuleValue[];
    ask: PermissionRuleValue[];
    deny: PermissionRuleValue[];
  },
  anchors?: PathAnchors,
): PermissionBehavior | undefined {
  if (anyMatch(call, rules?.deny, anchors)) return 'deny';
  if (anyMatch(call, rules?.ask, anchors)) return 'ask';
  if (anyMatch(call, rules?.allow, anchors)) return 'allow';
  return undefined;
}

function anyMatch(
  call: ToolCall,
  list: PermissionRuleValue[] | undefined,
  anchors?: PathAnchors,
): boolean {
  if (!Array.isArray(list)) return false;
  for (const rule of list) {
    if (matchRule(call, rule, anchors)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// internal helpers — all pure, all total
// ═══════════════════════════════════════════════════════════════════════════

/** Safely read a string field off an unknown toolInput; the string or null. */
function getStringField(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in (input as Record<string, unknown>)) {
    const v = (input as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/**
 * Escape a literal char/string for use inside a RegExp. Used ONLY by the
 * WebFetch domain matcher, whose regex is bounded (`(?:[^.]+\.)+` / `[^.]*`) —
 * no adjacent unbounded greedy quantifiers, so no ReDoS. The Bash and path
 * matchers do NOT use regex (linear glob matchers above).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── linear glob matchers (NO regex → NO catastrophic backtracking / ReDoS) ──
//
// The rule strings are operator/agent-authored and the matched commands/paths
// are agent-generated and can be long. C2 calls this on EVERY gate decision, so
// the matchers MUST be linear-time. We use the classic greedy-with-backtrack-
// pointer glob algorithm: it scans each input char at most O(n·m) with a SINGLE
// backtrack pointer (no nested quantifiers), so a pathological pattern of many
// `*` against a long non-matching input stays fast — no exponential blowup.

/**
 * Flat glob match: `*` matches ANY run of characters (including spaces and `/`),
 * anchored to the whole `text`. No other metacharacter is special — used for
 * tool-name globs (`mcp__github__get_*`) and Bash command bodies (`git * main`),
 * where `*` is documented to span multiple arguments including spaces.
 *
 * Linear: `star`/`mark` remember the last `*` position so a failed match
 * backtracks the `*` one char forward instead of re-exploring exponentially.
 */
function globMatchFlat(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1; // index in pattern of the most recent '*'
  let mark = 0; // index in text to resume from after that '*'
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p++;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      // mismatch: let the last '*' absorb one more char of text.
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  // consume any trailing '*' in the pattern
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Single-SEGMENT glob match (the gitignore within-segment semantics): `*`
 * matches any run of chars, `?` a single char, everything else literal. The
 * segment text contains NO `/` (segments are pre-split), so this is just a flat
 * glob with `?` support. Linear (single-backtrack-pointer), no ReDoS.
 */
function segmentMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p++;
    } else if (
      p < pattern.length &&
      (pattern[p] === text[t] || pattern[p] === '?')
    ) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Gitignore-style PATH glob match, anchored to the whole `text` — done on the
 * SEGMENT lists (split on `/`), which is the natural gitignore model and is
 * genuinely linear:
 *   - a `**` pattern segment matches ZERO OR MORE path segments (crosses `/`).
 *   - any other pattern segment matches EXACTLY ONE path segment via the
 *     within-segment glob (`*` = any run of non-`/`, `?` = one non-`/`).
 *
 * Linearity: ONE backtrack pointer for the most recent `**` segment. Each path
 * segment is consumed once forward; on a downstream mismatch we let the last
 * `**` swallow one more path segment and retry. Total work is bounded by
 * O(patternSegments · pathSegments · segLen) — a polynomial with TINY factors,
 * NO char-level cross-product and NO exponential blowup (the old regex hit
 * ~5ms/op here; this is sub-microsecond).
 *
 * A trailing `**` (or a pattern that is exactly `**`) matches zero+ remaining
 * segments, so `a/**` matches `a`, `a/x`, and `a/x/y`.
 */
function globMatchPath(pattern: string, text: string): boolean {
  const pp = pattern.split('/');
  const tt = text.split('/');
  let pi = 0;
  let ti = 0;
  let starPi = -1; // pattern index of the most recent '**' segment
  let starTi = 0; // path index that '**' is currently expanded to

  while (ti < tt.length) {
    if (pi < pp.length && pp[pi] === '**') {
      starPi = pi;
      starTi = ti;
      pi++; // tentatively let '**' match zero segments
    } else if (pi < pp.length && segmentMatch(pp[pi], tt[ti])) {
      pi++;
      ti++;
    } else if (starPi !== -1) {
      // backtrack: let the most recent '**' swallow one more path segment.
      starTi++;
      ti = starTi;
      pi = starPi + 1;
    } else {
      return false;
    }
  }
  // path consumed: skip any trailing '**' segments; pattern must be exhausted.
  while (pi < pp.length && pp[pi] === '**') pi++;
  return pi === pp.length;
}

/** File-editing builtins an `Edit` rule also applies to (doc parity). */
const EDIT_FAMILY = new Set(['Write', 'NotebookEdit', 'MultiEdit']);

// ── toolName matching ──────────────────────────────────────────────────────

/**
 * Match the call's tool name against the rule's tool-name pattern.
 *
 * Doc semantics:
 *   - exact literal              → equality.
 *   - `*`                        → matches every tool.
 *   - `mcp__*`                   → matches every MCP tool (any server).
 *   - `mcp__server`              → matches any tool from `server`
 *                                  (i.e. `mcp__server__<anything>`).
 *   - `mcp__server__*`           → matches all tools from `server`.
 *   - `mcp__server__get_*`       → glob in the tool segment.
 *   - any other pattern with `*` → general tool-name glob (`*` = any chars,
 *                                  no `.`-special handling — tool names are flat).
 */
function matchToolName(callTool: string, pattern: string): boolean {
  if (pattern === callTool) return true;
  if (pattern === '*') return true;

  // Edit-family aliasing (doc: "Edit rules apply to all built-in tools that
  // edit files"). An `Edit` rule matches Write / NotebookEdit / MultiEdit calls.
  // This is a one-way alias: a `Write` rule does NOT broaden to `Edit` calls.
  if (pattern === 'Edit' && EDIT_FAMILY.has(callTool)) return true;

  // Bare `mcp__server` (no wildcard) → any tool from that server.
  // 'mcp__github'.split('__')  === ['mcp', 'github']      (length 2)
  // 'mcp__github__'.split('__') === ['mcp', 'github', ''] (length 3, last '')
  if (pattern.startsWith('mcp__') && !pattern.includes('*')) {
    const segs = pattern.split('__');
    if (segs.length === 3 && segs[2] === '') {
      // 'mcp__github__' — trailing '__' form; treat as a server prefix.
      return callTool.startsWith(pattern) && callTool.length > pattern.length;
    }
    if (segs.length === 2) {
      // 'mcp__github' — server form; match any tool 'mcp__github__<tool>'.
      return callTool.startsWith(pattern + '__') && callTool.length > pattern.length + 2;
    }
    // 'mcp__server__tool' (length 4 with content) is an exact name — already
    // handled by the equality check at the top of this function.
    return false;
  }

  // Glob pattern (contains `*`). Tool names are flat identifiers, so `*` is a
  // plain "any chars" wildcard anchored to the full name (linear matcher).
  if (pattern.includes('*')) {
    return globMatchFlat(pattern, callTool);
  }

  return false;
}

// ── Bash command matching ──────────────────────────────────────────────────

/**
 * Match a Bash/PowerShell command against a rule content glob.
 *
 * Doc semantics (code.claude.com/docs/en/permissions §Bash):
 *   - No wildcard           → EXACT match of the whole command.
 *   - `*`                   → any sequence of chars INCLUDING spaces, at any
 *                             position (`git *`, `* install`, `git * main`).
 *   - trailing ` *` (space) → word boundary: the prefix must be followed by a
 *                             space OR end-of-string. `ls *` matches `ls -la`
 *                             and `ls`, but NOT `lsof`.
 *   - trailing `*` (no space)→ no word boundary: `ls*` matches `ls -la` AND `lsof`.
 *   - `:*` suffix           → trailing wildcard with a word boundary, but the
 *                             COLON is part of the prefix's separator class:
 *                             after the prefix the next char must be a space, a
 *                             `:`, or end-of-string. So `npm run test:*` matches
 *                             `npm run test`, `npm run test:unit` (colon), and
 *                             `npm run test --watch` (space) — the documented
 *                             parity examples — while `git push:*` matches
 *                             `git push` / `git push origin main` but NOT
 *                             `git pushy` (a word char follows the prefix).
 *                             A `:*` that is NOT at the end is a literal colon.
 *
 * The command itself is matched LITERALLY (regex metachars escaped) — only the
 * rule's `*` placeholders become wildcards.
 */
function matchBashContent(command: string | null, content: string): boolean {
  if (typeof command !== 'string') return false;

  // A trailing `:*` and a trailing ` *` are both "prefix + boundary + rest",
  // differing only in the separator class allowed right after the prefix:
  //   `:*`  → ' ' or ':' or end-of-string  (colon counts as a boundary)
  //   ` *`  → ' '         or end-of-string
  // A mid-string `:*` keeps the colon literal (only the suffix is special).
  if (content.endsWith(':*')) {
    return matchBashPrefixBoundary(command, content.slice(0, -2), [' ', ':']);
  }
  if (content.endsWith(' *')) {
    return matchBashPrefixBoundary(command, content.slice(0, -2), [' ']);
  }

  // No special suffix. No wildcard at all → exact match.
  if (!content.includes('*')) {
    return command === content;
  }

  // General glob: `*` spans any chars incl. spaces, at any position (linear).
  return globMatchFlat(content, command);
}

/**
 * Match a Bash prefix glob followed by a word boundary: `command` matches when
 * it equals the prefix exactly (EOS boundary) OR the prefix followed by one of
 * `boundaryChars` and then any remainder. `prefix` may contain inner `*`
 * (flat — spans any chars). Linear: at most two flat-glob scans.
 *
 * We find the shortest match of `prefix` against a leading slice of `command`,
 * then check the next char. Because a trailing `*` in the prefix is greedy and
 * could swallow the boundary, we test BOTH the EOS case (prefix consumes the
 * whole command) and the boundary case (prefix consumes a head, next char is a
 * boundary). For a prefix WITHOUT a trailing `*` we can split deterministically
 * at the first boundary char; with a trailing `*` we scan boundary positions.
 */
function matchBashPrefixBoundary(
  command: string,
  prefix: string,
  boundaryChars: string[],
): boolean {
  // EOS boundary: the prefix matches the entire command.
  if (globMatchFlat(prefix, command)) return true;

  // Boundary-char case: for each position i where command[i] is a boundary
  // char, test whether the prefix matches command[0..i). The first such match
  // suffices. This is O(n · scan) — bounded, no nested quantifier.
  for (let i = 0; i < command.length; i++) {
    if (boundaryChars.includes(command[i])) {
      if (globMatchFlat(prefix, command.slice(0, i))) return true;
    }
  }
  return false;
}

// ── path (Read/Edit/Write) matching ────────────────────────────────────────

/**
 * Match a file path against a gitignore-style path glob.
 *
 * Doc semantics (code.claude.com/docs/en/permissions §Read and Edit):
 *   Anchors:
 *     `//path`     → absolute from filesystem root.
 *     `~/path`     → home-relative.
 *     `/path`      → relative to PROJECT ROOT.
 *     `path`/`./p` → relative to CWD.
 *   Globs (gitignore):
 *     `*`  → within a single path segment (does NOT cross `/`).
 *     `**` → across directories.
 *     a bare filename (no slash) matches at ANY depth — `.env` is equivalent
 *     to a recursive any-depth match.
 *
 * We do not know the concrete project-root / cwd here (pure, no I/O), so we
 * match the path's TAIL conservatively: a rule that resolves to "...X" matches
 * any incoming path that ends at the same anchored position. Specifically:
 *
 *   - `//...`  absolute → the path (normalized) must match the pattern from the
 *               filesystem root (`/` anchored).
 *   - `~/...`  home     → matches a `~/`-literal path OR an absolute path whose
 *               tail under a home dir matches (we accept any `/.../` home, since
 *               we can't read $HOME; we match the `~/`-stripped suffix at the
 *               END of the path — e.g. `~/.zshrc` matches `/home/x/.zshrc`).
 *   - bare name / relative → matched at any depth (suffix match honoring `/`).
 *   - `/...` project-relative → treated like a relative suffix anchored to a
 *               segment boundary (we can't resolve the real project root, so we
 *               match the `/`-stripped tail at a `/`-boundary; conservative).
 *
 * Conservative: when in doubt, the regex anchors at a `/` boundary so a sibling
 * dir (`srcother/`) never satisfies a `src/**` rule, and a different filename
 * (`.envrc`) never satisfies a `.env` rule.
 *
 * C4: when `anchors.cwd` / `anchors.home` are supplied, a rule WITH PATH
 * STRUCTURE is RESOLVED to a concrete absolute pattern and matched against the
 * absolute call path — closing the tail-match hole so an allow rule can no longer
 * be satisfied by a same-named file in an unrelated tree. "Path structure" means:
 *   - `~/x`        → anchored to `<home>/x`
 *   - leading `/x` → anchored to `<cwd>/x` (project root == cwd)
 *   - `a/x` (a `/` anywhere) → anchored to `<cwd>/a/x`
 * A BARE FILENAME (no `/`, e.g. `.env`, `secrets.txt`) is NOT anchored even with
 * cwd supplied — per gitignore it matches at ANY depth (`.env` ≡ a recursive
 * any-depth match). Anchoring it would silently NARROW a deny rule to root-only (the UNSAFE
 * direction) and contradict the any-depth promise above. The engine stays PURE —
 * anchors are injected strings, no I/O. With the relevant anchor absent, the
 * conservative tail-match is the fallback.
 */
function matchPath(filePath: string | null, content: string, anchors?: PathAnchors): boolean {
  if (typeof filePath !== 'string' || content.length === 0) return false;

  const normPath = filePath.replace(/\\/g, '/');

  // Classify the anchor, then match with the LINEAR path-glob matcher.
  if (content.startsWith('//')) {
    // Absolute from filesystem root. `//tmp/x` → `/tmp/x`. Whole-path anchored.
    // Already absolute — anchors don't change it.
    return globMatchPath('/' + content.slice(2), normPath);
  }

  if (content.startsWith('~/') || content === '~') {
    const tail = content.replace(/^~\/?/, ''); // '.zshrc'
    // ANCHORED: resolve `~/tail` against the supplied $HOME and match the call
    // path (resolved to absolute against home/cwd) as a WHOLE-path glob.
    if (anchors?.home) {
      const pattern = joinPattern(anchors.home, tail);
      return globMatchPath(pattern, resolveCallPath(normPath, anchors.cwd, anchors.home));
    }
    // FALLBACK (no home): literal `~/...` form OR a tail suffix-match at a
    // `/` boundary (we can't resolve the real home).
    if (globMatchPath('~/' + tail, normPath)) return true;
    return matchPathSuffix(tail, normPath);
  }

  // leading `/` → project root (== cwd); `./` or bare → cwd-relative.
  const isProjectRooted = content.startsWith('/');
  let rel = content;
  if (rel.startsWith('/')) rel = rel.slice(1);
  else if (rel.startsWith('./')) rel = rel.slice(2);

  // gitignore parity: a pattern with PATH STRUCTURE anchors; a BARE filename
  // (no `/`) does NOT — it matches at ANY depth (gitignore: `.env` ≡ `**/.env`).
  // A leading-`/` rule was explicitly project-rooted (always anchored); a `/`
  // anywhere in `rel` means the rule is path-structured (anchor to cwd). A bare
  // name keeps the conservative any-depth tail-match EVEN WITH cwd supplied —
  // anchoring it would silently NARROW a deny rule to root-only (the unsafe
  // direction) and break the docstring's any-depth promise.
  const hasPathStructure = isProjectRooted || rel.includes('/');

  // ANCHORED: a path-structured rule resolves against cwd (the sandbox project
  // root IS the cwd) → an absolute pattern matched against the absolute call path.
  if (anchors?.cwd && hasPathStructure) {
    const pattern = joinPattern(anchors.cwd, rel);
    return globMatchPath(pattern, resolveCallPath(normPath, anchors.cwd, anchors.home));
  }

  // A bare filename (no slash) → any depth (gitignore), even when cwd is supplied.
  // A multi-segment relative path with NO cwd → also a suffix at a `/` boundary
  // (conservative; the project root isn't resolvable without cwd).
  return matchPathSuffix(rel, normPath);
}

/**
 * Join an absolute anchor root with a (possibly glob) relative pattern into a
 * single `/`-normalized absolute glob pattern. Pure string join: trims a
 * trailing `/` off the root and a leading `/` off the rel so the result has
 * exactly one separator. Only PATH-STRUCTURED rels reach here (matchPath keeps
 * bare filenames any-depth); e.g. `src/**` → `<root>/src/**`.
 */
function joinPattern(root: string, rel: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const tail = rel.replace(/^\/+/, '');
  return tail.length === 0 ? r : `${r}/${tail}`;
}

/**
 * Resolve a call's file path to an absolute, `/`-normalized path. A `~/`-literal
 * path expands against `home`; an already-absolute path passes through; a
 * relative path joins under `cwd`. Total — no I/O, no `..` normalization (the
 * agent's paths are already normalized; we only anchor `~`/relative forms).
 */
function resolveCallPath(normPath: string, cwd?: string, home?: string): string {
  if ((normPath === '~' || normPath.startsWith('~/')) && home) {
    return joinPattern(home, normPath.replace(/^~\/?/, ''));
  }
  if (normPath.startsWith('/')) return normPath;
  if (cwd) return joinPattern(cwd, normPath);
  return normPath;
}

/**
 * Match `pattern` (a gitignore path glob, no anchor) against `path` anchored at
 * the END and at a `/` segment boundary, at ANY depth — the gitignore
 * "bare/relative name matches at any depth" semantics (`.env` ≡ any-depth
 * `.env`; `src/**` matches `<root>/src/...` and `src/...`).
 *
 * Implemented by prepending an implicit `**` segment so the pattern can match a
 * tail of the path's segment list. If the pattern ALREADY begins with `**`, the
 * prefix is redundant — pass it through unchanged. Single linear segment scan
 * (no per-`/` re-scan), so this is sub-microsecond even on deep paths.
 */
function matchPathSuffix(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith('**/') || pattern === '**' ? pattern : '**/' + pattern;
  return globMatchPath(anchored, path);
}

// ── WebFetch domain matching ───────────────────────────────────────────────

/**
 * Match a WebFetch URL's host against a `domain:` rule.
 *
 * Doc semantics (code.claude.com/docs/en/permissions §WebFetch):
 *   - `domain:example.com`   → matches host `example.com` (case-insensitive).
 *   - `domain:*.example.com` → any subdomain at any depth, NOT the apex.
 *   - `domain:*`             → every domain.
 *   - a leading `*.` (or whole-pattern `*`) is the ONLY way `*` crosses a `.`;
 *     elsewhere `*` stays within ONE label, so `github.*` matches `github.io`
 *     but NOT `github.evil.com`.
 *   - a trailing `.` is stripped from BOTH rule and host.
 *
 * If the rule content lacks the `domain:` prefix, or the URL has no parseable
 * host, we conservatively do not match.
 */
function matchWebFetch(url: string | null, content: string): boolean {
  if (typeof url !== 'string') return false;
  if (!content.startsWith('domain:')) return false;

  let pattern = content.slice('domain:'.length).toLowerCase();
  if (pattern.length === 0) return false;

  const host = extractHost(url);
  if (host === null) return false;

  let h = host.toLowerCase();
  // Strip a single trailing dot from both.
  if (pattern.endsWith('.')) pattern = pattern.slice(0, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);

  if (pattern === '*') return true;

  // Build a regex where `*` crosses a `.` ONLY as a leading `*.`; elsewhere it
  // stays within one label ([^.]*).
  let body = '';
  let leading = true;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (leading && pattern[i + 1] === '.') {
        // leading `*.` → one-or-more sub-labels: `(?:[^.]+\.)+`
        body += '(?:[^.]+\\.)+';
        i += 2; // consume '*' and '.'
        leading = false;
        continue;
      }
      // a `*` within a label — does NOT cross '.'.
      body += '[^.]*';
      i += 1;
      leading = false;
      continue;
    }
    body += escapeRegExp(ch);
    leading = false;
    i += 1;
  }
  return new RegExp('^' + body + '$').test(h);
}

/** Extract the host from a URL; null if it can't be parsed. Never throws. */
function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
