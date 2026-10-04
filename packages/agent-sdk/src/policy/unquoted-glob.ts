/**
 * THE UNKNOWN-EXPANSION PROXY of the delete floor's unparseable path
 * (sensitivity-floor `unparseableDeleteRisk`). Moved out of sensitivity-floor
 * 2026-09-25, unchanged except for the parameter rule below.
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

/**
 * Does a GLOB metachar appear where the shell would actually EXPAND it — that
 * is, outside quotes? Inside single OR double quotes `* ? [ {` are literal:
 * bash performs neither pathname nor brace expansion there. Reading them as
 * delete risk is what made a read-only verification ask: a jq filter
 * (`'{files:[.files[]|{id}]}'`) and a curl format string (`'%{http_code}'`)
 * both carry braces, and neither can expand to anything (staging over-ask,
 * 2026-08-09). The destructive tells in sensitivity-floor deliberately still
 * see THROUGH quotes — only this "unknown expansion" proxy is quote-aware,
 * because quoting is precisely what makes the expansion knowable: it does not
 * happen.
 *
 * A parameter is not a pattern either. `$?` `$*` `$@` `$#` `$!` `$$` `$-`
 * `$0`…`$9` are NAMES whose last character happens to be a metachar, and the
 * braces of `${VAR}` / `${f%.*}` delimit an expansion, not a brace list. Their
 * VALUES are as unknowable as `$HOME`'s, which this proxy has never flagged.
 * Prod 2026-09-25 (#bugs, Adarsh): `echo EXIT $? >> render.log` after a
 * Remotion render asked "Delete files in your workspace", because `?` was read
 * as a one-character glob. A `${…}` holding a quote or a substitution is still
 * read character by character, as before: its end is not ours to guess.
 */
export function containsUnquotedGlob(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let word = '';
  let sawMetachar = false;
  const wordGlobs = (): boolean => sawMetachar && !PUNCTUATION_WORDS.has(word);

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && !inSingle) {
      word += ch;
      if (i + 1 < command.length) { word += command[i + 1]; i++; } // escaped: literal, never a glob
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; word += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; word += ch; continue; }
    if (inSingle || inDouble) { word += ch; continue; }
    if (ch === '$') {
      const end = parameterEnd(command, i);
      if (end > i) { word += command.slice(i, end + 1); i = end; continue; }
    }
    if (WORD_BREAK.test(ch)) {
      if (wordGlobs()) return true;
      word = '';
      sawMetachar = false;
      continue;
    }
    if (GLOB_METACHARS.includes(ch)) sawMetachar = true;
    word += ch;
  }
  return wordGlobs();
}

/** The one-character special parameters (`$?`, `$*`, `$1`, …). */
const SPECIAL_PARAMETER = /^[?*@#!$\-0-9]$/;

/**
 * The index of the last character of the parameter expansion starting at the
 * `$` at `i`: a special parameter, or a `${…}` with no quote, backtick or
 * `$(` inside. -1 otherwise (the caller reads on character by character).
 */
function parameterEnd(command: string, i: number): number {
  const next = command[i + 1] ?? '';
  if (SPECIAL_PARAMETER.test(next)) return i + 1;
  if (next !== '{') return -1;
  let depth = 0;
  for (let j = i + 1; j < command.length; j++) {
    const ch = command[j];
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '$' && command[j + 1] === '(')) return -1;
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Unquoted whitespace and shell operators end a word. */
const WORD_BREAK = /[\s;|&<>()]/;

/** Characters that make the word they sit in a glob PATTERN. */
const GLOB_METACHARS = '*?[]{}';

/**
 * Words that are ENTIRELY bracket/brace punctuation. Bash expands none of them:
 * a lone `[`/`]` is the POSIX test builtin (`if [ -z "$x" ]`), `{`/`}` open and
 * close a brace group, and `{}` is find's placeholder. Brace expansion needs a
 * comma or `..` INSIDE the braces and a bracket match needs a class inside the
 * brackets, so each of these stands only for itself and cannot name a set of
 * paths. In-word forms (`[abc]`, `{a,b}.txt`, `file[0-9]`) still count.
 *
 * `*` and `?` are deliberately absent: those ARE globs standing alone.
 *
 * Staging drill 2026-08-10 (interaction d4779933): a pure CREATE script asked
 * "Delete files in your workspace" because its `if [ -z "$file_id" ]` guard put
 * two bare `[` in front of a proxy that read characters, not words.
 */
const PUNCTUATION_WORDS: ReadonlySet<string> = new Set(['[', ']', '{', '}', '{}']);
