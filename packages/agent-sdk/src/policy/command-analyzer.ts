// One pure analyzer for shell commands. Enumerates every command POSITION so the
// safety floor / plan-block / rule-match no longer parse shell themselves.
// Correctness posture: fail CLOSED — if we cannot fully represent the command,
// parsedSafely=false and callers ask/block.
//
// This extends the STYLE of shell-split.ts (quote/escape-aware scan) and adds:
// splitting on the lone background operator `&`, enumeration of the commands inside
// every nested body (process substitution `<(...)`/`>(...)`, a `( ... )` subshell,
// `$( ... )` and backticks), recursion into `sh -c`/`bash -c` string bodies, and
// head normalization.
//
// Subshells and substitutions were refused outright until 2026-09-25. Refusing them
// sent every render script with `echo EXIT $?` in a subshell to the floor's
// unparseable fallback, whose glob proxy read the `?` of `$?` as a pattern and
// asked "Delete files" over a video render (#bugs, Adarsh). Reading them is
// sound only where we delimit a body exactly where bash does, so the body scan
// refuses what can move a `)` (a `case` arm, a comment, `$'…'`, arithmetic).
//
// Words are read after bash's quote removal (removeQuotes), and every body has
// its line continuations removed before it is split (removeLineContinuations).
// Until 2026-09-25 the raw text was read instead, so `r\⏎m -rf /etc`,
// `rm \/etc/hosts` and `eval rm\ -rf\ /etc` deleted without an ask (security
// re-review of #3863).
//
// PURE / TOTAL / NEVER-THROWS. No I/O, no state.

import { containsUnquotedGlob } from './unquoted-glob.js';

// `builtin` and `exec` run their argument as a command too: `builtin eval "rm -rf
// /etc"` and `exec rm -rf /etc` resolved to heads we never looked past.
const WRAPPER_HEADS = new Set([
  'sudo', 'command', 'builtin', 'exec', 'env', 'nice', 'time', 'nohup', 'xargs', 'stdbuf', 'setsid',
]);
// dash -c handled by name below (sh/bash/dash/ash/zsh + -c)
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh']);
// Shell KEYWORDS that stand immediately in front of a command: whatever word
// follows them is the thing that actually runs. Stripping them is what lets a
// command position be enumerated at all — `do rm -rf x` otherwise resolves to
// head `do` with the real `rm` sitting unexamined in its argv, and a position
// the floor cannot see is a position the floor cannot gate. Measured before this
// existed: `for d in a b; do rm -rf "/etc/$d"; done` was ALLOWED under
// bypassPermissions while the bare `rm -rf /etc/hosts` was denied, making a loop
// a general-purpose bypass of "deletions always ask".
//
// Only the keywords a COMMAND follows belong here. `for`/`case`/`select`/
// `function` are followed by a variable or a word list, and `done`/`fi`/`esac`/
// `}` close a construct — none of them introduces a command, so none is stripped.
// (`time` already resolves through WRAPPER_HEADS below.)
const COMMAND_INTRODUCING_KEYWORDS = new Set([
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'coproc', '!', '{',
]);
// A single-dash short-flag bundle containing `c` ANYWHERE — the `-c` that takes a
// command string, possibly combined with other single-char flags in any order
// (`-c`, `-ec`, `-lc`, `-xc`, and also `-cx`, `-ce`, `-cl`, `-cex`). Real bash runs
// the command word regardless of `c`'s position in the bundle, so anchoring `c` as the
// last letter silently dropped the body for `-cx`/`-ce`/… — a fail-closed violation.
const DASH_C_FLAG = /^-[a-z]*c[a-z]*$/;
// POSIX assignment prefix: `NAME=` leading a command position (`FOO=bar rm x`).
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The variables whose value changes how bash reads LATER words: which program a head
// runs (PATH, BASH_ENV, ENV), where `cd` and `~` land (CDPATH, HOME, OLDPWD, PWD), how
// an expansion splits or globs (IFS, GLOBIGNORE), and shell options (SHELLOPTS,
// BASHOPTS). A bare assignment to one of them still fails closed. Any other bare
// assignment (`id=$(…)`, `status=$?`) runs nothing itself, since its substitutions are
// walked as their own positions, and moves no later head. Failing closed on those sent
// whole commands to the fallback, where one harmless glob asked "Delete files" (#bugs
// 2026-09-28, prod task 28edef30: `id=$(grep … | tr -d …)` then `file assets/*`).
const RESOLUTION_VARS = new Set([
  'PATH', 'CDPATH', 'HOME', 'OLDPWD', 'PWD', 'IFS', 'BASH_ENV', 'ENV', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS',
]);

// Bash runs a word after quote removal: `"rm"`, `\rm` (the usual way past an
// alias), `r\m` and `r\⏎m` all run `rm`. Removal comes BEFORE any trim: trimmed
// first, `rm\⏎` kept its backslash and read as `rm\`.
export function normalizeHead(token: string): string {
  const t = removeQuotes(token.trimStart());
  return t.slice(lastPathSlash(t) + 1);       // basename /bin/rm -> rm
}

/**
 * The last `/` outside any `${…}`, or -1. A `/` inside one cuts no path:
 * `"${R:-/bin/rm}"` runs /bin/rm, and basenamed there it read as `rm}`, a head
 * with no `$` left to ask on. `"${VENV}/bin/python"` still runs python.
 */
function lastPathSlash(word: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '$' && word[i + 1] === '{') { depth += 1; i++; }
    else if (word[i] === '{' && depth > 0) depth += 1;
    else if (word[i] === '}' && depth > 0) depth -= 1;
    else if (word[i] === '/' && depth === 0) last = i;
  }
  return last;
}

/**
 * Bash's quote removal for ONE word: the text a command receives. Outside
 * quotes `\X` is `X` and a backslash-newline is nothing; inside double quotes a
 * backslash escapes only `$`, backtick, `"`, `\` and newline; inside single
 * quotes nothing is special. `$'…'` decodes its escapes (ANSI-C quoting);
 * `$"…"` keeps its `$`: bash translates it through the locale's message catalog,
 * so its value is not the text we see.
 *
 * A `$( … )` or backtick run is kept verbatim: its quotes belong to its own
 * body, and its `$` keeps the word unresolvable for every rule that refuses one.
 * An `$'…'` escape we do not decode keeps the whole run verbatim for the same
 * reason. Total: an unclosed quote runs to the end of the word.
 */
export function removeQuotes(word: string): string {
  let out = '';
  let inDouble = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === '\\' && i + 1 < word.length) {
      const next = word[++i];
      if (next === '\n') continue;                                  // a line continuation
      if (inDouble && !'$`"\\'.includes(next)) out += ch;           // `\X` stays `\X` in "…"
      out += next;
      continue;
    }
    if (ch === '`' || (ch === '$' && word[i + 1] === '(')) {
      const end = substitutionEnd(word, i);
      if (end >= 0) { out += word.slice(i, end + 1); i = end; continue; }
    }
    if (ch === '"') { inDouble = !inDouble; continue; }
    if (inDouble) { out += ch; continue; }
    if (ch === '$' && word[i + 1] === "'") {
      const ansi = ansiCQuoted(word, i);
      out += ansi.value ?? word.slice(i, ansi.end + 1);
      i = ansi.end;
      continue;
    }
    if (ch === "'") {
      const close = word.indexOf("'", i + 1);
      const end = close < 0 ? word.length : close;
      out += word.slice(i + 1, end);
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'],
  ['v', '\v'], ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'],
]);

/**
 * The `$'…'` run starting at `start` (the `$`): its decoded value, or null when
 * it holds an escape we do not decode (`\u`, `\c`, …) or never closes, and the
 * index of its closing quote. Decodes `\xHH`, octal `\NNN` and the escapes above.
 *
 * A NUL is never decoded: bash keeps the word as a C string, so `$'rm\0zz'` runs
 * `rm`. Decoded, the verb read as `rm\0` and lost its `$`; left verbatim it stays
 * a `$`-head the floor already asks about (security review of #3875, 2026-09-25).
 * An octal escape keeps only its low byte (`\562\555` is `rm`, `\400` a NUL);
 * `\u`/`\U` are never decoded, so no code point can carry a NUL past this.
 * A run that never closes ends one past the word.
 */
function ansiCQuoted(word: string, start: number): { value: string | null; end: number } {
  let value = '';
  let decoded = true;
  for (let j = start + 2; j < word.length; j++) {
    const ch = word[j];
    if (ch === "'") return { value: decoded ? value : null, end: j };
    if (ch !== '\\') { value += ch; continue; }
    const next = word[++j] ?? '';
    const code = /^x([0-9A-Fa-f]{1,2})/.exec(word.slice(j, j + 3)) ?? /^([0-7]{1,3})/.exec(word.slice(j, j + 3));
    const char = code === null ? 0 : parseInt(code[1], next === 'x' ? 16 : 8) & 0xff;   // bash keeps one byte
    if (code !== null && char !== 0) {
      value += String.fromCharCode(char);
      j += code[0].length - 1;
    } else if (ANSI_C_ESCAPES.has(next)) {
      value += ANSI_C_ESCAPES.get(next);
    } else {
      decoded = false;
    }
  }
  return { value: null, end: word.length };
}

/**
 * The text with its line continuations (backslash-newline) removed where bash
 * removes them: everywhere except inside single quotes, `$'…'` and comments.
 * Bash does this before it reads words, so a continuation can sit anywhere: in a
 * verb (`r\⏎m`), a flag, a keyword (`d\⏎o`), between a verb and its flags.
 *
 * A comment ends at the newline even after a backslash (the backslash is
 * comment text), so that pair is KEPT, and splitTopLevel refuses it: our
 * splitter would read it as an escaped newline and fold the next line, which
 * bash runs, into the comment.
 */
function removeLineContinuations(src: string): string {
  if (!src.includes('\\\n')) return src;
  let out = '';
  let quote: '' | "'" | '"' | "$'" | '#' = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote === "'" || quote === '#') {
      if (ch === (quote === '#' ? '\n' : "'")) quote = '';
      out += ch;
      continue;
    }
    if (ch === '\\') {
      if (src[i + 1] === '\n' && quote !== "$'") { i++; continue; }
      out += src.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote !== '') {
      if (ch === quote[quote.length - 1]) quote = '';
      out += ch;
      continue;
    }
    if (ch === '$' && src[i + 1] === "'") { quote = "$'"; out += "$'"; i++; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#' && (out === '' || /[\s;&|()<>`]/.test(out[out.length - 1]))) quote = '#';
    out += ch;
  }
  return out;
}

// The union of shell verbs that are destructive/mutating enough to floor or block.
/** Heads that run a string, a file or stdin as code (their text is not a position here). */
const UNREAD_CODE_HEADS = new Set(['eval', 'source', '.', 'exec', 'builtin', 'sh', 'bash', 'dash', 'ash', 'zsh', 'ksh']);

/** Does this position run code the analyzer cannot name: an unresolvable head, or an interpreter? */
export function runsUnreadCode(c: CommandNode): boolean {
  return headUnresolvable(c) || UNREAD_CODE_HEADS.has(c.head);
}

/**
 * A command word we cannot name: an expansion in its name (`$R`, `"${R:-/bin/rm}"`),
 * or an unquoted glob whose first match runs (`/bin/r? -rf /`). `[[` is a keyword.
 */
export function headUnresolvable(c: CommandNode): boolean {
  return c.head.includes('$') || (c.rawHead !== '[[' && containsUnquotedGlob(c.rawHead));
}

/**
 * Characters that end a shell word. Tokenizing on these (instead of regex word
 * boundaries) keeps `rm.txt` / `perform` / `confirm` from matching while still
 * seeing `rm` through quotes, `$(…)`, backticks, pipes, and separators.
 */
export const SHELL_WORD_DELIMITERS = /[\s;|&<>()`"'=]+/;

// SINGLE SOURCE consumed by the floor AND write-taxonomy AND the regex gate's
// narrowing checks — see Task 3.
export const DESTRUCTIVE_SHELL_VERBS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'dd', 'mkfs', 'chmod', 'chown', 'truncate',
]);

export interface CommandNode {
  head: string;
  rawHead: string;
  argv: string[];
  raw: string;
  /**
   * The nested body this position runs in; absent at the top level. Bodies nest
   * as paths (`2`, `2/5` = body 5 inside body 2). Every body runs in a CHILD
   * shell (a `( … )` subshell, `$( … )`, backticks, `<( … )`, an `sh -c`
   * string), so a `cd` inside one moves only that body's cwd (see
   * cwdStatesPerPosition in sensitivity-floor).
   */
  scope?: string;
}

export interface CommandAnalysis {
  commands: CommandNode[];
  parsedSafely: boolean;
  /**
   * Some positions were read from inside a `( … )` subshell, a `$( … )` or
   * backticks: the constructs this analyzer refused (parsedSafely=false) until
   * 2026-09-25. Only the delete floor (and its classifier twin) judges them
   * position by position. Every other consumer treats `nested` as it treats
   * `!parsedSafely`, so none of them loosens; deny/ask rules also match the new
   * inner positions, which only tightens. Each consumer's comment says which.
   */
  nested: boolean;
  /**
   * A bare assignment statement (`id=$(…)`, `status=$?`) sits between the positions.
   * It runs nothing itself (its substitutions are positions, and `nested` says so),
   * but it can rewrite a variable the shell already exports (`NODE_OPTIONS=…; npm
   * test`), which the next position's program then reads, and its value is text a
   * later position can run (`R=rm; $R x`). Every consumer treats `assigns` as it
   * treats `nested`: the delete floor keeps the old verdict when a delete is named
   * anywhere (nestedKeepsOldVerdict), and Always-allow rules and plan mode never
   * vouch, so none of them loosens.
   */
  assigns: boolean;
}

/** Bodies nest at most this deep; deeper is refused (and bounds the rescans). */
const MAX_BODY_DEPTH = 16;

/** The walk's shared state: the positions found so far, and the two verdicts. */
interface Walk {
  out: CommandNode[];
  unsafe: () => void;
  nested: () => void;
  assigns: () => void;
  /** Record a bare assignment `name=raw` read in `scope`. */
  assign: (name: string, raw: string, scope: string | undefined) => void;
  /** The plain literal a command word `$name` runs as here, or null when it cannot be known. */
  literal: (name: string, scope: string | undefined) => string | null;
  /** A fresh scope path for a body opened inside `parent`. */
  child: (parent: string | undefined) => string;
  /** Read sudo's and nice's own options (AnalyzeOptions.wrapperOptions). */
  wrapperOptions: boolean;
}

export interface AnalyzeOptions {
  /**
   * Read sudo's and nice's own options and resolve the command after them (`sudo -E bash`,
   * `sudo -u app rm -rf /`, `nice -n 10 rm …`). Only the dangerous-command catalogs ask for
   * it (SECURITY_PATTERNS_V2). Off, a wrapper option stays a flag head and fails closed,
   * byte-identical: every other consumer keeps today's reading.
   */
  wrapperOptions?: boolean;
}

export function analyzeCommand(command: string, opts: AnalyzeOptions = {}): CommandAnalysis {
  if (typeof command !== 'string' || command.trim() === '') {
    return { commands: [], parsedSafely: true, nested: false, assigns: false };
  }
  const commands: CommandNode[] = [];
  let parsedSafely = true;
  let nested = false;
  let assigns = false;
  let bodies = 0;
  const vars = new Map<string, { value: string | null; scope: string | undefined; count: number }>();
  const w: Walk = {
    out: commands,
    unsafe: () => { parsedSafely = false; },
    nested: () => { nested = true; },
    assigns: () => { assigns = true; },
    assign: (name, raw, scope) => {
      vars.set(name, { value: literalValue(raw), scope, count: (vars.get(name)?.count ?? 0) + 1 });
    },
    literal: (name, scope) => {
      const v = vars.get(name);
      return v && v.count === 1 && v.scope === scope ? v.value : null;
    },
    child: (parent) => {
      bodies += 1;
      return parent === undefined ? String(bodies) : `${parent}/${bodies}`;
    },
    wrapperOptions: opts.wrapperOptions === true,
  };
  try {
    walk(command, w, undefined);
  } catch {
    return { commands, parsedSafely: false, nested, assigns };   // total: any surprise fails closed
  }
  // A bare assignment can feed a later command word: what runs there is the assigned
  // text, which no position shows. Read on the RAW word, since a variable can hide in a
  // path prefix (`D="rm -rf /etc #"; $D/x`) or stand in for `cd` (`R=cd; $R /etc;
  // r""m hosts`). Fail closed, as every bare assignment did before 2026-09-28.
  if (assigns && commands.some((c) => c.rawHead.includes('$') || c.rawHead.includes('`'))) parsedSafely = false;
  return { commands, parsedSafely, nested, assigns };
}

// Split into raw command positions across list operators (&&, ||, |, ;, newline,
// AND the background operator &), respecting quotes/escapes, then read each one.
// Every body (the top level, `sh -c`, a group, a substitution, eval) is read by a
// shell of its own, which removes its line continuations first.
function walk(src: string, w: Walk, scope: string | undefined): void {
  for (const segment of splitTopLevel(removeLineContinuations(src), w)) walkSegment(segment, w, scope);
}

/** Walk a nested body as a list of its own, one scope below `parent`. */
function walkBody(body: string, w: Walk, parent: string | undefined): void {
  const scope = w.child(parent);
  if (scope.split('/').length > MAX_BODY_DEPTH) { w.unsafe(); return; }
  walk(body, w, scope);
}

// One command position. Every nested body it carries is walked FIRST, in its own
// scope (bash runs a substitution before the command it feeds), then the position
// itself becomes a node.
function walkSegment(segment: string, w: Walk, scope: string | undefined): void {
  // Strip keyword prefixes on the STRING, before the node is built, so the
  // node's `raw` begins at the real command head. Skipping them inside toNode
  // (the way wrapper heads are skipped) would leave `raw` starting at the
  // keyword, and isDangerousDelete reads exactly that to decide it cannot
  // vouch for the argv — which would turn every plain in-workspace delete
  // sitting after a `do`/`then` into a needless ask.
  const seg = stripCommandIntroducingKeywords(segment.trim());
  if (!seg) return;
  if (seg.startsWith('(')) { walkGroup(seg, w, scope); return; }
  const scan = scanBodies(seg);
  if (scan === null) { w.unsafe(); pushNode(seg, w, scope); return; }
  for (const body of scan.bodies) walkBody(body, w, scope);
  if (scan.substituted) w.nested();
  pushNode(scan.outer, w, scope);
}

// A `( … )` subshell group standing where a command goes. Its body is a list of
// its own, run in a child shell. Only redirections may follow the `)`: they apply
// to the whole group and stay a position, so `(…) > log` still reads as a write.
// Anything else there is a syntax error bash refuses, so we refuse it too.
function walkGroup(seg: string, w: Walk, scope: string | undefined): void {
  const close = seg[1] === '(' ? -1 : closingParen(seg, 1);   // `((` is arithmetic
  if (close < 0) { w.unsafe(); pushNode(seg, w, scope); return; }
  w.nested();
  walkBody(seg.slice(1, close), w, scope);
  const tail = seg.slice(close + 1).trim();
  if (tail === '') return;
  if (!tokenize(tail).every(isRedirectionWord)) w.unsafe();
  walkSegment(tail, w, scope);
}

/** A word a redirection is made of: an operator (`>`, `2>>`, `<`, `>|`) or its target. */
export function isRedirectionWord(token: string, i: number, tokens: readonly string[]): boolean {
  return REDIRECT_OPERATOR.test(token) || (i > 0 && BARE_REDIRECT_OPERATOR.test(tokens[i - 1]));
}
const REDIRECT_OPERATOR = /^\d*(?:>>?|<<?<?|>\||<>)/;
const BARE_REDIRECT_OPERATOR = /^\d*(?:>>?|<<?<?|>\||<>)$/;

// Build the node for one position and, for `sh -c "BODY"`, walk the body too.
function pushNode(text: string, w: Walk, scope: string | undefined): void {
  const node = toNode(text, w, scope);
  if (!node) return;
  if (scope !== undefined) node.scope = scope;
  w.out.push(node);
  // sh -c "BODY": recurse into the quoted body. Accept combined short-flag bundles
  // ending in `c` (`sh -ec`, `bash -lc`, …), not just the exact `-c` token. When a
  // `-c`-bearing flag is present but the body cannot be cleanly extracted, fail
  // closed rather than fall through to a confident parse missing the body.
  if (SHELL_INTERPRETERS.has(node.head)) {
    const flagIdx = node.argv.findIndex((t) => DASH_C_FLAG.test(removeQuotes(t)));
    if (flagIdx !== -1) {
      const body = shellDashCBody(node.argv, flagIdx);
      if (body !== null) walkBody(body, w, scope);
      else w.unsafe();
    }
  }
  // eval joins its words with spaces and runs the result, like an `sh -c` body:
  // `eval "rm -rf x"` hid its delete in a head we never looked past (review of
  // #3863, 2026-09-25). Its body runs in THIS shell, but eval stays an opaque cwd
  // move, so the body is walked as a child scope: a `cd` in it re-pins nothing.
  if (node.head === 'eval' && node.argv.length > 0) {
    const body = evalBody(node.argv);
    if (body !== null) walkBody(body, w, scope);
    else w.unsafe();
  }
}

/**
 * The text eval runs: its words after quote removal, joined with spaces, or
 * null when it cannot be read with confidence. An expansion is expanded BEFORE
 * eval parses its words, so its value is code we cannot see (`eval "$(ssh-agent
 * -s)"`, `eval "echo $X"`): refused. Backslashes and quotes are removed first,
 * as bash removes them (`eval rm\ -rf\ /etc` runs `rm -rf /etc`; kept, the head
 * read as `etc`), and a `$'…'` word is decoded (`eval $'rm\x20-rf\x20/etc'`).
 */
function evalBody(argv: string[]): string | null {
  const words: string[] = [];
  for (const token of argv) {
    if (expandsInWord(token)) return null;
    words.push(removeQuotes(token));
  }
  return words.join(' ');
}

/**
 * Does bash expand something in this word: a `$` or backtick outside single
 * quotes, other than an `$'…'` run we decode (one we do not decode counts)?
 */
function expandsInWord(word: string): boolean {
  let inDouble = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"') { inDouble = !inDouble; continue; }
    if (!inDouble && ch === "'") {
      const close = word.indexOf("'", i + 1);
      if (close < 0) return false;
      i = close;
      continue;
    }
    if (!inDouble && ch === '$' && word[i + 1] === "'") {
      const ansi = ansiCQuoted(word, i);
      if (ansi.value === null) return true;
      i = ansi.end;
      continue;
    }
    if (ch === '$' || ch === '`') return true;
  }
  return false;
}

// Is the `{` at `index` a word of its own (group / function-body opener) rather
// than part of a larger word (`{a,b}.txt`, `${VAR}`)? Both neighbours must be a
// word boundary.
function isStandaloneBrace(src: string, index: number): boolean {
  const before = index > 0 ? src[index - 1] : ' ';
  const after = index + 1 < src.length ? src[index + 1] : ' ';
  return /\s/.test(before) && /\s/.test(after);
}

// Drop leading command-introducing keywords so the command they introduce
// becomes the head (`do rm -rf x` -> `rm -rf x`, `if ! test x` -> `test x`).
// Repeats, because they stack. A keyword standing ALONE is left as-is: there is
// no command behind it to promote, and returning an empty string would drop the
// position entirely.
function stripCommandIntroducingKeywords(segment: string): string {
  let rest = segment.trimStart();
  for (;;) {
    const match = /^(\S+)(?:\s+|$)/.exec(rest);
    if (match === null || !COMMAND_INTRODUCING_KEYWORDS.has(match[1])) return rest;
    const after = rest.slice(match[0].length).trimStart();
    if (after.length === 0) return rest;
    rest = after;
  }
}

// Quote/escape-aware scan that splits on && || | ; \n and a lone &. On an unbalanced
// quote, or a construct whose end we cannot find soundly, markUnsafe() and yield the
// whole string as one segment.
//
// Construct-aware: a `$( … )`, a backtick, a `<( … )`/`>( … )` and a `( … )` group
// are each skipped as ONE run, so their inner operators (`<(rm x | sort)`) never
// split the outer list; walkSegment reads their bodies. A bare `(` anywhere a
// command cannot start (a function definition, an array, an extglob, `((`) is a
// construct we do not enumerate → markUnsafe (fail closed, never a silent allow).
function splitTopLevel(src: string, w: Walk): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    // Backslash escape (inert inside single quotes, where backslash is literal).
    // A backslash-newline still here is one walk() did not remove: a comment's,
    // or one inside quoting we read differently. Bash may end the line there.
    if (ch === '\\' && !inSingle) {
      if (src[i + 1] === '\n') w.unsafe();
      current += ch;
      if (i + 1 < src.length) { current += src[i + 1]; i++; }
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (inSingle) { current += ch; continue; }
    // A substitution expands inside double quotes too, and its body has quotes of
    // its own: skip it whole so an inner `"` cannot flip the outer quote state.
    if (ch === '`' || (ch === '$' && src[i + 1] === '(')) {
      const end = substitutionEnd(src, i);
      if (end < 0) { w.unsafe(); return [src]; }
      current += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '"') { inDouble = !inDouble; current += ch; continue; }
    if (inDouble) { current += ch; continue; }

    if (ch === '(') {
      const prev = i > 0 ? src[i - 1] : '';
      const processSubstitution = prev === '<' || prev === '>';
      const group = !processSubstitution && src[i + 1] !== '(' && atCommandPosition(current);
      if (!processSubstitution && !group) w.unsafe();
      const end = closingParen(src, i + 1);
      if (end < 0) { w.unsafe(); return [src]; }
      current += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === ')') {
      // An UNMATCHED `)` at the top level closes a `case` pattern — the command
      // it guards follows it on the same line (`start) rm -rf /etc`). Splitting
      // here is what makes that command its own position; without it the whole
      // branch stayed inside the `case` node's argv, unexamined, and a delete in
      // a case arm was allowed silently.
      segments.push(current);
      current = '';
      continue;
    }

    // Operators. `&&` before a lone `&`.
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') { segments.push(current); current = ''; i++; continue; }
    if (ch === '|' || ch === ';' || ch === '\n' || ch === '&') { segments.push(current); current = ''; continue; }
    // A STANDALONE `{` opens a group or a function body, and the command
    // inside starts right after it (`function nuke { rm -rf /etc`). Only a
    // lone `{` word counts: brace expansion and `${VAR}` glue it to other
    // characters, and splitting those would tear a single word in half.
    if (ch === '{' && isStandaloneBrace(src, i)) { segments.push(current); current = ''; continue; }

    current += ch;
  }
  segments.push(current);

  // Unbalanced quote → we walked off the end still inside a string; the split is
  // untrustworthy. Hand back the whole command and flag it.
  if (inSingle || inDouble) {
    w.unsafe();
    return [src];
  }

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Could a command start right after `prefix` (the segment so far)? Yes when
 * nothing is there yet, or only command-introducing keywords followed by a
 * space (`if (…)`, `! (…)`, `do (…)`): the same words walkSegment strips, so
 * the two agree on which `(` opens a group.
 */
function atCommandPosition(prefix: string): boolean {
  const words = prefix.trim();
  if (words === '') return true;
  return /\s$/.test(prefix) && words.split(/\s+/).every((t) => COMMAND_INTRODUCING_KEYWORDS.has(t));
}

// ── where a nested body ends ────────────────────────────────────────────────
// Reading a body is only sound if we end it exactly where bash does. A `)` we
// take for the close when bash does not would hand the rest of the body to the
// outer list, where a `cd` could leak or an `rm` land in some command's argv.
// So each scan refuses (returns -1) whatever can make a `)` mean something else.

/**
 * The index of the character closing the substitution opened at `i` (the `$` of
 * `$(`, or a backtick), or -1 when it cannot be delimited soundly.
 */
function substitutionEnd(src: string, i: number): number {
  if (src[i] === '`') {
    const end = src.indexOf('`', i + 1);
    // Inside backticks bash reads `\$`, `\\` and `` \` `` a second time; we do
    // not model that second reading, so a backslash there is refused.
    return end < 0 || src.slice(i + 1, end).includes('\\') ? -1 : end;
  }
  if (src[i + 2] === '(') return -1; // `$((` is arithmetic: its parens are not commands
  return closingParen(src, i + 2);
}

/**
 * The index of the `)` closing a paren opened just before `start`, or -1. Tracks
 * quotes, escapes and nested constructs. Refuses a `case` word (its arms close
 * with a `)` that closes nothing), a comment (whose `)` is not code) and `$((`:
 * each can put bash's close somewhere other than ours. A `$'…'` run, where a
 * backslash escapes a quote, is skipped whole (refused until 2026-09-25, which
 * left `(eval $'rm\x20-rf\x20x')` unread and silent).
 */
function closingParen(src: string, start: number): number {
  let depth = 1;
  let quote = '';
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (quote === "'") { if (ch === "'") quote = ''; continue; }
    if (ch === '\\') { j++; continue; }
    if (ch === '`' || (ch === '$' && (src[j + 1] === '(' || src[j + 1] === '{'))) {
      const end = src[j + 1] === '{' ? parameterEnd(src, j) : substitutionEnd(src, j);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (quote === '"') { if (ch === '"') quote = ''; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === "'") {
      if (src[j - 1] === '$') {
        j = ansiCQuoted(src, j - 1).end;
        if (j >= src.length) return -1;   // never closes
        continue;
      }
      quote = "'";
      continue;
    }
    if (startsWord(src, j) && (ch === '#' || isWordAt(src, j, 'case'))) return -1;
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return j;
  }
  return -1;
}

/**
 * The index of the `}` closing the `${` at `i`, or -1. A `)` inside
 * `${x/)/y}` closes nothing, so the scan above must step over the whole
 * expansion. Quotes inside one follow rules of their own (they differ in and
 * out of double quotes), so a quote there is refused rather than guessed at.
 */
function parameterEnd(src: string, i: number): number {
  let depth = 1;
  for (let j = i + 2; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (ch === "'" || ch === '"') return -1;
    if (ch === '`' || (ch === '$' && src[j + 1] === '(')) {
      const end = substitutionEnd(src, j);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Does a new shell word start at `j` (so a `#` there opens a comment)? */
function startsWord(src: string, j: number): boolean {
  return j === 0 || /[\s;&|()<>]/.test(src[j - 1]);
}

/** Is `word` the whole shell word starting at `j`? */
function isWordAt(src: string, j: number, word: string): boolean {
  const after = src[j + word.length];
  return src.startsWith(word, j) && (after === undefined || /[\s;&|()<>]/.test(after));
}

// Scan one position for its nested bodies: each `<( … )`/`>( … )` (outside
// quotes) and each `$( … )`/backtick (outside single quotes). Returns the bodies
// in text order and the position's own text: a process substitution is cut out
// (it is a file name, not a word the command reads), while a command
// substitution stays in place, so the word still carries its `$` and every
// target rule that refuses an unresolvable `$` still fires on it. Null when a
// body cannot be delimited soundly.
interface BodyScan { bodies: string[]; substituted: boolean; outer: string; }

function scanBodies(seg: string): BodyScan | null {
  const bodies: string[] = [];
  let outer = '';
  let substituted = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '\\' && !inSingle) {
      outer += seg.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; outer += ch; continue; }
    if (inSingle) { outer += ch; continue; }
    if (ch === '`' || (ch === '$' && seg[i + 1] === '(')) {
      const end = substitutionEnd(seg, i);
      if (end < 0) return null;
      bodies.push(seg.slice(ch === '`' ? i + 1 : i + 2, end));
      substituted = true;
      outer += seg.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '"') { inDouble = !inDouble; outer += ch; continue; }
    if (!inDouble && (ch === '<' || ch === '>') && seg[i + 1] === '(') {
      const end = closingParen(seg, i + 2);
      if (end < 0) return null;
      bodies.push(seg.slice(i + 2, end));
      outer += ' ';   // leave whitespace so surrounding tokens don't merge
      i = end;
      continue;
    }
    outer += ch;
  }
  return { bodies, substituted, outer };
}

// Split a raw command position into tokens on unquoted whitespace, preserving quote
// characters and backslash escapes verbatim so a quoted body stays one token. A
// substitution is one run inside its word (`X=$(date +%s)` is one token), or its
// inner spaces would split the word and hand the head to the wrong token.
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let has = false;
  let inSingle = false;
  let inDouble = false;
  let delimits = true;   // once one substitution fails to close, the rest cannot either

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && !inSingle) {
      current += ch; has = true;
      if (i + 1 < raw.length) { current += raw[i + 1]; i++; }
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; has = true; continue; }
    if (delimits && !inSingle && (ch === '`' || (ch === '$' && raw[i + 1] === '('))) {
      const end = substitutionEnd(raw, i);
      if (end >= 0) { current += raw.slice(i, end + 1); has = true; i = end; continue; }
      delimits = false;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; has = true; continue; }
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (has) { tokens.push(current); current = ''; has = false; }
      continue;
    }
    current += ch; has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

// Turn a raw command position into a node: tokenize, skip leading wrapper heads
// (sudo/env/xargs/…) AND POSIX assignment prefixes (`FOO=bar`), then the first
// remaining token is the command head. Skipping assignments the same way wrappers
// are skipped keeps `FOO=bar rm x` / `env FOO=bar rm x` from resolving `head:'FOO=bar'`
// and silently dropping the real `rm` head. An assignment that leaves no head behind is
// a bare assignment: no node, reported through `w.assigns` and recorded for
// `literalHead`, and it fails closed only when it sets a RESOLUTION_VARS name.
function toNode(raw: string, w: Walk, scope: string | undefined): CommandNode | null {
  const markUnsafe = w.unsafe;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;

  let idx = 0;
  let sawAssignment = false;
  let setsResolutionVar = false;
  let sawWrapper = false;
  let resolved = false;
  while (idx < tokens.length) {
    if (ASSIGNMENT_PREFIX.test(tokens[idx])) {
      sawAssignment = true;
      if (RESOLUTION_VARS.has(tokens[idx].slice(0, tokens[idx].indexOf('=')))) setsResolutionVar = true;
      idx++;
      continue;
    }
    if (!resolved) {
      const words = literalHead(tokens[idx], w, scope);
      if (words !== null) {
        tokens = [...tokens.slice(0, idx), ...words, ...tokens.slice(idx + 1)];
        resolved = true;
        continue;
      }
    }
    if (normalizeHead(tokens[idx]) === 'env') {
      sawWrapper = true;
      idx = afterEnvOptions(tokens, idx + 1);
      continue;
    }
    if (WRAPPER_HEADS.has(normalizeHead(tokens[idx]))) {
      sawWrapper = true;
      const wrapper = normalizeHead(tokens[idx]);
      // `command -p rm x` runs rm with the default PATH. (`-v`/`-V` only look it up,
      // and stay a flag head below: fail closed.)
      if (wrapper === 'command' && removeQuotes(tokens[idx + 1] ?? '') === '-p') idx++;
      idx++;
      const grammar = w.wrapperOptions ? WRAPPER_OPTION_GRAMMAR.get(wrapper) : undefined;
      if (grammar !== undefined) {
        const next = afterWrapperOptions(tokens, idx, grammar);
        if (next === null) { markUnsafe(); return null; }   // an option we do not know → fail closed
        idx = next;
      }
      continue;
    }
    if (normalizeHead(tokens[idx]) === 'timeout') {
      const next = afterTimeoutPrefix(tokens, idx + 1);
      if (next === null) { markUnsafe(); return null; }   // a shape we cannot resolve → fail closed
      idx = next;
      continue;
    }
    break;
  }
  if (idx >= tokens.length) {
    if (setsResolutionVar) markUnsafe();   // a bare PATH=/HOME=/IFS=… → fail closed
    else if (sawAssignment) w.assigns();
    // Only the shell's own assignments are variables later words read: `env R=ls`
    // sets nothing in this shell.
    if (sawAssignment && !sawWrapper) {
      for (const t of tokens) {
        if (ASSIGNMENT_PREFIX.test(t)) w.assign(t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1), scope);
      }
    }
    return null;                       // wrapper-only — no command to gate
  }

  const rawHead = tokens[idx];
  // A resolved head that is a flag (`xargs -0 rm x`, `env -i rm x`, `time -p rm x`):
  // the wrapper took its own flags/args, which we cannot enumerate generically, leaving
  // a `-`-prefixed token here. A real command name never starts with `-`, so this only
  // ever fails closed (over-asks) — it never gates `sudo rm x` / `xargs rm x`, whose
  // heads resolve to `rm`. Emitting a confident node for `-0` would leave the real `rm`
  // in argv unexamined — a silent allow.
  if (removeQuotes(rawHead).startsWith('-')) {   // `xargs "-0" rm x` too
    markUnsafe();
    return null;
  }
  // A command word MADE by a substitution (`$(echo rm) x`, `` `which rm` x ``):
  // what runs is the inner command's OUTPUT, which no reading of the text can
  // show. Fail closed, exactly as before substitutions were read at all.
  if (rawHead.includes('$(') || rawHead.includes('`')) markUnsafe();
  // A command word bash splits into several: `${IFS}` expands to a separator and
  // `{a,b}` to one word per item, so `rm${IFS}-rf${IFS}/etc` and `{rm,-rf,/etc}`
  // run `rm -rf /etc` from one word. What runs is not this word: fail closed.
  if (SPLIT_BY_IFS.test(rawHead) || expandsBraceList(rawHead)) markUnsafe();
  const argv = tokens.slice(idx + 1);
  return { head: normalizeHead(rawHead), rawHead, argv, raw: trimmed };
}

const SPLIT_BY_IFS = /\$(?:\{IFS\}|IFS(?![A-Za-z0-9_]))/;

// #bugs 2026-09-28 (prod task 28edef30): `NP="env -u HTTPS_PROXY …"; $NP curl -o Inter.ttf
// …; ls *.ttf` asked "Delete files": the variable command word failed the parse and the
// fallback read `*.ttf` as a hidden delete. A command word that is exactly `$NAME`,
// `${NAME}` or `"$NAME"` runs the value of NAME. When this command assigned NAME once, in
// this scope, to a plain literal, that value is known: read the words it runs instead
// (`R=rm; $R x` reads as `rm x` and is judged as the delete it is). Anything else about
// it (assigned twice, in another body, built from other expansions, a path such as
// `$D/x`) returns null and stays the unresolvable head it was.
const VARIABLE_WORD = /^("?)\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})\1$/;

function literalHead(token: string, w: Walk, scope: string | undefined): string[] | null {
  const m = VARIABLE_WORD.exec(token);
  if (!m) return null;
  const value = w.literal(m[2] ?? m[3], scope);
  if (value === null) return null;
  const words = value.split(' ').filter((x) => x !== '');
  if (m[1] === '"') return words.length === 1 && words[0] === value ? words : null;   // quoted: one word or nothing we can name
  return words;
}

/**
 * An assigned value as plain words, or null when any expansion, escape, glob, quote or
 * operator is in it. `literalHead` splits it on spaces, bash's default IFS: an IFS set in
 * this command is a RESOLUTION_VARS assignment and fails closed before this is read.
 */
function literalValue(raw: string): string | null {
  if (/[$`\\\n]/.test(raw)) return null;
  const value = removeQuotes(raw);
  return /^[A-Za-z0-9_\-.\/:=,@%+ ]*$/.test(value) ? value : null;
}

// sudo's and nice's own options (read only under AnalyzeOptions.wrapperOptions): the short
// letters whose value is the rest of the word or the next word, and the long options with
// no value and with one. Any other long option returns null: fail closed.
interface WrapperOptionGrammar { valueLetters: string; flags: readonly string[]; valued: readonly string[] }
const WRAPPER_OPTION_GRAMMAR: ReadonlyMap<string, WrapperOptionGrammar> = new Map([
  ['sudo', {
    valueLetters: 'CDghpRrTtUu',
    flags: ['--askpass', '--background', '--edit', '--login', '--non-interactive', '--preserve-env',
      '--reset-timestamp', '--set-home', '--shell', '--stdin'],
    valued: ['--chdir', '--chroot', '--close-from', '--command-timeout', '--group', '--host', '--other-user',
      '--prompt', '--role', '--type', '--user'],
  }],
  ['nice', { valueLetters: 'n', flags: [], valued: ['--adjustment'] }],
]);

/** The index of the word after a wrapper's own options, or null for one we cannot read. */
function afterWrapperOptions(tokens: string[], start: number, g: WrapperOptionGrammar): number | null {
  let i = start;
  while (i < tokens.length) {
    const t = removeQuotes(tokens[i]);
    if (t === '--') return i + 1;
    if (!t.startsWith('-') || t === '-') return i;
    if (t.startsWith('--')) {
      const name = t.split('=')[0];
      if (g.flags.includes(name)) { i++; continue; }   // `--preserve-env`, `--preserve-env=PATH`
      if (!g.valued.includes(name)) return null;
      i += t.includes('=') ? 1 : 2;                    // `--user=app`, `--user app`
      continue;
    }
    if (/^-\d+$/.test(t)) { i++; continue; }   // `nice -10`
    // A short bundle: the first value letter takes the rest of the word, or the next word.
    const at = [...t.slice(1)].findIndex((ch) => g.valueLetters.includes(ch));
    i += at === t.length - 2 ? 2 : 1;
  }
  return i;
}

// `env`'s own options, which take nothing to run: `-i`/`-`, `-0`, `-u NAME`, `--unset
// NAME` and `--`. `env -u HTTPS_PROXY curl …` then resolves to curl. Any other option
// stays a flag head, which fails closed: `-S` splits a string into the command to run
// and `-C` moves the cwd a later delete would resolve against.
const ENV_BARE_OPTIONS = new Set(['-i', '-', '--ignore-environment', '-0', '--null']);

function afterEnvOptions(tokens: string[], start: number): number {
  let i = start;
  while (i < tokens.length) {
    const t = removeQuotes(tokens[i]);
    if (t === '--') return i + 1;
    if (ENV_BARE_OPTIONS.has(t)) { i++; continue; }
    if (t === '-u' || t === '--unset') {
      if (i + 1 >= tokens.length) return i;   // no NAME after it: a malformed command stays a flag head (fails closed)
      i += 2;
      continue;
    }
    if (/^-u[A-Za-z_]/.test(t) || t.startsWith('--unset=')) { i++; continue; }
    return i;
  }
  return i;
}

/**
 * Does an unquoted expansion sit in this word? Bash word-splits its value, so it
 * can add words: `$D/x` with D="rm -rf /etc #" runs rm. A quoted one cannot, so
 * `"${VENV}/bin/python"` still runs a program named python.
 */
export function expandsUnquoted(word: string): boolean {
  let quote = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '$' && word[i + 1] === "'") { i = ansiCQuoted(word, i).end; continue; }
    if (ch === '$' || ch === '`') return true;
  }
  return false;
}

/** Does this word hold an unquoted brace list (`{a,b}`, `{1..3}`) that bash expands? */
function expandsBraceList(word: string): boolean {
  let quote = '';
  let open = -1;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (quote !== '') { if (ch === quote) quote = ''; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '{' && word[i - 1] !== '$') open = i;
    else if (ch === '}' && open >= 0 && /,|\.\./.test(word.slice(open, i))) return true;
  }
  return false;
}

// `timeout [OPTION]... DURATION COMMAND [ARG]...` always runs COMMAND, so it is a
// wrapper whose own words must be skipped first: `timeout 5 rm -rf x` resolved to
// head `timeout` and its delete went unexamined (review of #3863, 2026-09-25).
// Returns the index of COMMAND, or null for any shape we cannot read with
// confidence (an unknown option, a missing value, a DURATION that is not a
// literal number, no COMMAND): the caller fails closed.
const TIMEOUT_DURATION = /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/;

function afterTimeoutPrefix(tokens: string[], start: number): number | null {
  let i = start;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { i++; break; }
    if (!t.startsWith('-') || t === '-') break;
    if (t === '--preserve-status' || t === '--foreground' || t === '--verbose') continue;
    if (/^--(?:signal|kill-after)=./.test(t)) continue;
    if (t === '--signal' || t === '--kill-after') { i++; if (i >= tokens.length) return null; continue; }
    if (t.startsWith('--')) return null;
    // A short bundle: `v` is a switch; `s` and `k` take the rest of the word, or the next one.
    let takesNext = false;
    for (let j = 1; j < t.length; j++) {
      const flag = t[j];
      if (flag === 'v') continue;
      if (flag !== 's' && flag !== 'k') return null;
      takesNext = j === t.length - 1;
      break;
    }
    if (takesNext) { i++; if (i >= tokens.length) return null; }
  }
  if (i >= tokens.length || !TIMEOUT_DURATION.test(tokens[i])) return null;
  return i + 1 < tokens.length ? i + 1 : null;
}

// The body of a `sh -c <BODY>` invocation: the token immediately after the
// `-c`-bearing flag (at flagIdx), after quote removal (`sh -c "rm \"/etc/x\""`
// runs `rm "/etc/x"`). null when there is no such token (caller fails closed).
function shellDashCBody(argv: string[], flagIdx: number): string | null {
  if (flagIdx < 0 || flagIdx + 1 >= argv.length) return null;
  return removeQuotes(argv[flagIdx + 1]);
}
