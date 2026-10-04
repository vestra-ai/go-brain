/**
 * The code a shell reads from its stdin, where the command itself spells it out.
 *
 * A shell with no `-c` body and no script file runs whatever arrives on stdin, and nothing the
 * analyzer enumerates shows it: `bash <<'EOF' … EOF`, `cat <<EOF | sh`, `echo 'git push -f' | bash`
 * were each read as a harmless `bash` (security review of #4064), so a force push or an `rm -rf`
 * there asked at no level. The sources in the text:
 *   - the body of a here-document on a line that feeds a shell (`bash <<X`, `cat <<X | bash`);
 *   - the body of a here-document inside a substitution (`sh -c "$(cat <<X …)"`), when the
 *     command runs code unread (an interpreter's `-c`, eval, a variable command word);
 *   - a here-string (`bash <<<"…"`, `cat <<<"…" | sh`) and the words `echo` / `printf` / `yes`
 *     print, when a shell in the same command reads stdin.
 * `source` and `.` read a script exactly as a shell does (`. /dev/stdin <<X`, `source <(…)`). A
 * literal whose escapes encode its text (`printf '\x67it push -f' | sh`) is unread:
 * `escapesLiteral` below.
 * The floor and the classifier judge each as a command of its own (sensitivity-floor.ts), with
 * every rule they apply to any command. Code from a file or a download (`bash x.sh`,
 * `curl … | sh`, `cat x.sh | bash`) shows no words, so there is nothing more to read there: that
 * keeps today's verdict on purpose (installers are common; the founder's Relaxed ruling asks only
 * for deletes and payments). A DECODED payload is different: `decodes` below.
 *
 * Out of reach, and named: a shell on another machine (`ssh box bash <<EOF`), and another
 * interpreter reading its stdin (`python3 - <<EOF`, `node - <<EOF`).
 *
 * PURE / TOTAL / NEVER-THROWS.
 */

import { analyzeCommand, isRedirectionWord, removeQuotes, runsUnreadCode, type CommandNode } from './command-analyzer.js';
import { heredocDelimiter, stripHeredocBodies } from './heredoc-bodies.js';

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'source', '.']);
/** Shell options whose value is the next word. */
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
/** A "script file" that is the shell's own stdin. */
const STDIN_PATHS: ReadonlySet<string> = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

/** A shell position that runs its stdin: no `-c` body, and `-s`, no script file, or a script file that IS stdin. */
export function readsCodeFromStdin(c: CommandNode): boolean {
  if (!SHELLS.has(c.head)) return false;
  let stdin = false;
  for (let i = 0; i < c.argv.length; i++) {
    const t = removeQuotes(c.argv[i]);
    if (isRedirectionWord(c.argv[i], i, c.argv)) continue;          // `<<<"…"`, `< in`, `2>&1`: the shell's, not an argument
    if (STDIN_PATHS.has(t)) return true;
    if (t === '--') return stdin || i === c.argv.length - 1 || STDIN_PATHS.has(removeQuotes(c.argv[i + 1] ?? ''));
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) return false; // an inline body: the analyzer reads it
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(t)) stdin = true;
    if (SHELL_VALUE_OPTIONS.has(t)) { i++; continue; }
    if (!t.startsWith('-') && !t.startsWith('+')) return stdin; // a script file runs, unless -s
  }
  return true;
}

/**
 * A position that DECODES or generates text, from an exact list: base64 / basenc / xxd / od, the
 * decompressors (gunzip, zcat, bunzip2, bzcat, xzcat, unxz; gzip / xz / zstd / bzip2 with -d),
 * `openssl enc|base64`, tr, rev, iconv, awk, and an interpreter's one-liner (perl / ruby -e,
 * python -c, node -e). Its output run as code (a shell reading stdin, code run unread) is
 * hidden on purpose: `echo Z2l0… | base64 -d | sh`. Obfuscation is the signal, so it asks.
 */
export function decodes(c: CommandNode): boolean {
  if (DECODERS.has(c.head)) return true;
  const flag = (re: RegExp): boolean => c.argv.some((t) => re.test(removeQuotes(t)));
  switch (c.head) {
    case 'gzip': case 'xz': case 'zstd': case 'bzip2': return flag(/^(?:-[a-zA-Z0-9]*d[a-zA-Z0-9]*|--decompress|--uncompress)$/);
    case 'openssl': return ['enc', 'base64'].includes(removeQuotes(c.argv[0] ?? ''));
    case 'perl': case 'ruby': return flag(/^-[a-zA-Z]*e[a-zA-Z]*$/);
    case 'python': case 'python2': case 'python3': return flag(/^-[a-zA-Z]*c$/);
    case 'node': case 'nodejs': return flag(/^(?:-e|--eval|-p|--print)$/);
    default: return false;
  }
}

/**
 * An `echo` / `printf` literal whose escapes encode its text: `\x67`, `\u0067`, `\U…`, an octal
 * `\0…` / `\147`. Run as code (a shell reading stdin, a command word made of it), what runs is not
 * the text: `printf '\x67\x69\x74 push -f' | sh`. `\n` and `\t` encode nothing.
 */
export function escapesLiteral(c: CommandNode): boolean {
  return (c.head === 'echo' || c.head === 'printf') && c.argv.some((t) => /\\(?:x[0-9a-fA-F]|u[0-9a-fA-F]|U[0-9a-fA-F]|[0-7])/.test(t));
}

const DECODERS: ReadonlySet<string> = new Set([
  'base64', 'basenc', 'xxd', 'od', 'gunzip', 'zcat', 'bunzip2', 'bzcat', 'xzcat', 'unxz', 'tr', 'rev', 'iconv',
  'awk', 'gawk', 'mawk', 'nawk',
]);

/** The code the command's stdin-fed shells run, as far as the text shows it. */
export function shellStdinCode(command: string): string[] {
  try {
    const out: string[] = [];
    const outer = analyzeCommand(stripHeredocBodies(command));
    // A substitution that is the command word (`$(…)`, a backtick) makes the parse unsafe: code run unread too.
    const runsUnread = !outer.parsedSafely || outer.commands.some(runsUnreadCode);
    const lines = command.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const delim = heredocDelimiter(lines[i]);
      if (delim === null) continue;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== delim) body.push(lines[j++]);
      const opener = lines[i].slice(0, lines[i].lastIndexOf('<<'));
      const inSubstitution = /\$\(|`|<\(/.test(opener);
      if (analyzeCommand(lines[i]).commands.some(readsCodeFromStdin) || (inSubstitution && runsUnread)) out.push(body.join('\n'));
      i = j;
    }
    if (outer.commands.some(readsCodeFromStdin)) {
      for (const c of outer.commands) {
        // A here-string on any position: `bash <<<"…"`, or `cat <<<"…" | sh`.
        c.argv.forEach((t, k) => {
          if (t.startsWith('<<<')) out.push(removeQuotes(t.length > 3 ? t.slice(3) : (c.argv[k + 1] ?? '')));
        });
        if (c.head !== 'echo' && c.head !== 'printf' && c.head !== 'yes') continue;
        // Every word it prints (printf's format, then its arguments), `\n` read as the newline it prints.
        const words = c.argv.filter((t, k) => !removeQuotes(t).startsWith('-') && !isRedirectionWord(t, k, c.argv) && !/^\d*[<>|&]/.test(t)).map(removeQuotes);
        if (words.length > 0) out.push(words.join(' ').replace(/\\n/g, '\n'));
      }
    }
    return out;
  } catch {
    return [];
  }
}
