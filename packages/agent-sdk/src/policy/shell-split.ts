/**
 * K6 P3 C2 — shell-aware compound-command splitting.
 *
 * The security crux of the permission gate: a Bash `command` can chain
 * subcommands with `&&`, `||`, `|`, `;` (and newlines). If the gate matched the
 * WHOLE command string, an `allow Bash(ls:*)` rule would over-allow
 * `ls && rm -rf /` — the dangerous `rm` rides in on the benign `ls` prefix. This
 * module splits a command into its subcommands so the gate can:
 *
 *   - require EVERY segment to satisfy an allow rule (a chain is allowed only if
 *     all of its parts are), and
 *   - deny / floor-ask if ANY segment trips a deny rule or the delete/write floor.
 *
 * The splitter is shell-AWARE: it respects single quotes, double quotes, and
 * backslash escapes so an operator inside a quoted string (`echo 'a && b'`) is
 * NOT treated as a chain boundary.
 *
 * CONSERVATIVE on anything it can't safely parse. Two failure surfaces return
 * `parsedSafely: false` with the WHOLE command as a single segment, so the caller
 * can (a) still run deny/floor checks against the whole string AND (b)
 * additionally force an ask (floor over-asking is safe; under-asking is the bug):
 *   - unbalanced quotes (we can't know where the string ends), and
 *   - command substitution (`$(...)` / backticks) — a substituted command is a
 *     hidden subcommand the operator-splitter alone would miss, so we refuse to
 *     vouch for the parse.
 *
 * PURE / TOTAL / NEVER-THROWS. No I/O, no state.
 */

export interface ShellSplitResult {
  /**
   * The subcommands, trimmed, with empty fragments dropped. When the command
   * could not be parsed safely this is the whole command as a single segment.
   */
  segments: string[];
  /**
   * False when the command contains an unbalanced quote or command substitution
   * — the caller MUST treat the call conservatively (additionally ask) because
   * the segment list may not capture every real subcommand.
   */
  parsedSafely: boolean;
}

/**
 * Split a shell command into its operator-separated subcommands.
 *
 * Operators that separate subcommands (outside quotes): `&&`, `||`, `|`, `;`,
 * and newline. A single `&` (background) is intentionally NOT split on — it does
 * not introduce a new gated subcommand boundary the way the others do, and
 * splitting on it would mangle `find ... &` style trailing backgrounds; the
 * security floor still inspects the whole-command fallback for those. (`&&` is
 * matched before a lone `&`.)
 */
export function splitShellSegments(command: string): ShellSplitResult {
  if (typeof command !== 'string' || command.length === 0) {
    return { segments: command ? [command] : [], parsedSafely: true };
  }

  // Bail out (conservatively) on command substitution: a substituted command is
  // a hidden subcommand our operator scan would not surface. Detected OUTSIDE of
  // single quotes (inside single quotes it is inert in POSIX shells). We keep
  // this simple: if an unquoted `$(` or backtick appears, refuse to vouch.
  if (hasCommandSubstitution(command)) {
    return { segments: [command], parsedSafely: false };
  }

  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Backslash escape (only meaningful outside single quotes, where backslash
    // is literal). Consume the next char verbatim so an escaped operator
    // (`\;`, `\|`) never splits.
    if (ch === '\\' && !inSingle) {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Outside quotes: look for an operator at this position.
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++; // consume the second operator char
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }
  segments.push(current);

  // Unbalanced quote → we walked off the end still inside a string. The split is
  // untrustworthy; hand back the whole command and flag it.
  if (inSingle || inDouble) {
    return { segments: [command], parsedSafely: false };
  }

  const trimmed = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  return { segments: trimmed, parsedSafely: true };
}

/**
 * Does the command contain command substitution OUTSIDE single quotes?
 * `$(...)` or a backtick. Inside single quotes both are literal in POSIX shells,
 * so we only flag occurrences in unquoted / double-quoted context (double quotes
 * DO expand `$(...)` and backticks, so those count).
 */
function hasCommandSubstitution(command: string): boolean {
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && !inSingle) {
      i++; // skip escaped char
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;
    if (ch === '`') return true;
    if (ch === '$' && command[i + 1] === '(') return true;
  }
  return false;
}
