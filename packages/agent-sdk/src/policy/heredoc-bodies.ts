/**
 * Here-document bodies, stripped before a Bash command is judged. Moved out of
 * sensitivity-floor.ts unchanged (2026-09-25, file-size ratchet); the floor and
 * the card describer both read the bytes this leaves.
 *
 * KNOWN GAP (found 2026-09-25, not fixed here): the scan finds `<<` line by
 * line without reading quotes, comments, arithmetic or line continuations the
 * way bash does, so it can strip lines bash RUNS: `# <<EOF`, `echo "<<X"` and
 * `echo $((1<<2))` each hide the lines after them, and so does a continued
 * introducer (`cat <<EO\⏎F; rm …`) or a continued delimiter line (`E\⏎OF`).
 *
 * PURE / TOTAL / NEVER-THROWS.
 */

/**
 * Remove the BODY (and the trailing delimiter) of every here-document from a
 * command, leaving the command line(s) that introduce them intact. A here-doc
 * body is data piped into a file/stdin — never an executed command — so its
 * lines must not be inspected for a `rm` head (a SKILL.md body can legitimately
 * document `rm -rf` as prose).
 *
 * Exported so the card describer (describe-tool) reads the SAME bytes the floor
 * judged: a describer that parsed the body would put a documented `rm` (or a
 * python payload's parentheses) into the words shown to the user.
 *
 * Best-effort + total: recognizes `<<WORD`, `<< WORD`, `<<-WORD`, and quoted
 * delimiters (`<< 'EOF'` / `<< "EOF"`). When no heredoc is present the command
 * is returned unchanged. On any uncertainty we drop the rest of the input from
 * the first heredoc introducer onward, which can only REDUCE what we inspect —
 * the safe direction here is to inspect less (never false-floor a body).
 */
export function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;

  const lines = command.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    kept.push(line);
    const delim = heredocDelimiter(line);
    if (delim !== null) {
      // Skip body lines until the closing delimiter (a line whose trimmed
      // content equals the delimiter, allowing the `<<-` leading-tab form).
      i++;
      while (i < lines.length && lines[i].trim() !== delim) i++;
      // Drop the closing-delimiter line too (it is not an executed command).
      i++;
      continue;
    }
    i++;
  }
  return kept.join('\n');
}

/**
 * If `line` opens a here-document, return its delimiter word (unquoted); else
 * null. Reads the LAST `<<` on the line (the active heredoc introducer) and the
 * following bareword/quoted token. Conservative parse — anything unexpected
 * returns a usable delimiter or null without throwing.
 */
export function heredocDelimiter(line: string): string | null {
  const idx = line.lastIndexOf('<<');
  if (idx < 0) return null;
  // The char after `<<` may be `-` (strip-tabs form). Then the delimiter token.
  let rest = line.slice(idx + 2);
  if (rest.startsWith('-')) rest = rest.slice(1);
  rest = rest.replace(/^\s+/, '');
  if (rest.length === 0) return null;
  // Quoted delimiter: `'EOF'` or `"EOF"`.
  const q = rest[0];
  if (q === "'" || q === '"') {
    const end = rest.indexOf(q, 1);
    if (end > 0) return rest.slice(1, end);
    return null;
  }
  // Bareword delimiter: up to the next whitespace.
  const m = rest.match(/^[A-Za-z0-9_]+/);
  return m ? m[0] : null;
}
