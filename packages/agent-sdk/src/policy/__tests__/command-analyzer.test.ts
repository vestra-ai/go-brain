import { describe, it, expect } from 'vitest';
import { analyzeCommand, normalizeHead, removeQuotes } from '../command-analyzer.js';

const heads = (cmd: string) => analyzeCommand(cmd).commands.map((c) => c.head);

describe('analyzeCommand — enumerates every command position', () => {
  it('splits on the background operator (not just && | ;)', () => {
    // regression for the core bypass: a verb after "&" must be its own position
    expect(heads('sleep 1 & rm scratch.txt')).toEqual(['sleep', 'rm']);
  });
  it('enumerates commands inside process substitution', () => {
    expect(heads('cat <(rm scratch.txt)')).toContain('rm');
  });
  it('enumerates a piped command inside process substitution (no silent drop)', () => {
    // the inner `|` must NOT split the construct and drop `rm` as a command position
    const r = analyzeCommand('cat <(rm scratch.txt | sort)');
    expect(r.commands.map((c) => c.head)).toEqual(expect.arrayContaining(['cat', 'rm', 'sort']));
    expect(r.parsedSafely).toBe(true);
  });
  it('enumerates the commands inside a bare subshell group, in a scope of their own', () => {
    const r = analyzeCommand('(ls; rm scratch.txt)');
    expect(r.parsedSafely).toBe(true);
    expect(r.nested).toBe(true);
    expect(r.commands.map((c) => c.head)).toEqual(['ls', 'rm']);
    expect(new Set(r.commands.map((c) => c.scope)).size).toBe(1);
    expect(r.commands[0].scope).toBeDefined();
  });
  it('recurses into sh -c / bash -c string bodies', () => {
    expect(heads(`sh -c "rm scratch.txt"`)).toContain('rm');
  });
  it('normalizes path-prefixed and wrapped heads', () => {
    expect(heads('/bin/rm scratch.txt')).toEqual(['rm']);
    expect(heads('xargs rm < list.txt')).toContain('rm');
    expect(heads('sudo rm scratch.txt')).toEqual(['rm']);
  });
  it('still splits the classic operators', () => {
    expect(heads('ls && rm scratch.txt || echo done')).toEqual(['ls', 'rm', 'echo']);
  });
  it('parses ordinary commands safely', () => {
    const r = analyzeCommand('ls -la');
    expect(r.parsedSafely).toBe(true);
    expect(r.commands[0].head).toBe('ls');
  });
  it('enumerates nested command substitution; the outer word keeps its `$`', () => {
    const r = analyzeCommand('rm $(cat $(echo list))');
    expect(r.parsedSafely).toBe(true);
    expect(r.nested).toBe(true);
    expect(r.commands.map((c) => c.head)).toEqual(['echo', 'cat', 'rm']);
    expect(r.commands[2].argv).toEqual(['$(cat $(echo list))']);
  });
  it('is total — never throws', () => {
    const pathological = [
      '',
      '"unbalanced',
      '| | |',
      ')(',
      '   ',
      '&& rm scratch.txt',
      'rm $(',
      '`backtick',
      'sh -c',
      '<(',
    ];
    for (const c of pathological) {
      expect(() => analyzeCommand(c)).not.toThrow();
    }
  });
});

describe('analyzeCommand — no silent-allow of a destructive verb behind a construct', () => {
  // Fail-closed contract: for a command carrying a destructive verb behind a construct,
  // the analysis must EITHER enumerate that verb as a command head OR flag the parse
  // unsafe — it must never return a confident parse that silently drops the verb.
  const enumeratesOrUnsafe = (cmd: string) => {
    const r = analyzeCommand(cmd);
    return r.commands.some((c) => c.head === 'rm') || r.parsedSafely === false;
  };

  it('does not silently drop rm behind sh -ec combined shell flags', () => {
    expect(enumeratesOrUnsafe('sh -ec "rm scratch.txt"')).toBe(true);
  });
  it('does not silently drop rm behind bash -lc combined shell flags', () => {
    expect(enumeratesOrUnsafe('bash -lc "rm scratch.txt"')).toBe(true);
  });
  it('does not silently drop rm behind a NAME=value assignment prefix', () => {
    expect(enumeratesOrUnsafe('FOO=bar rm scratch.txt')).toBe(true);
  });
  it('does not silently drop rm behind an env NAME=value assignment prefix', () => {
    expect(enumeratesOrUnsafe('env FOO=bar rm scratch.txt')).toBe(true);
  });

  // Finding 1: the `-c` bundle where `c` is NOT the last letter. Real bash runs the
  // command word for `-cx`/`-ce`/`-cl` too, so the body must be recursed or the parse
  // flagged unsafe — never a confident head `bash` that drops the `rm`.
  it('does not silently drop rm behind bash -cx (c not last)', () => {
    expect(enumeratesOrUnsafe('bash -cx "rm scratch.txt"')).toBe(true);
  });
  it('does not silently drop rm behind sh -ce (c not last)', () => {
    expect(enumeratesOrUnsafe('sh -ce "rm scratch.txt"')).toBe(true);
  });
  it('does not silently drop rm behind bash -cl (c not last)', () => {
    expect(enumeratesOrUnsafe('bash -cl "rm scratch.txt"')).toBe(true);
  });

  // Finding 2: a wrapper consumes its own flags/args, leaving a `-`-prefixed token as
  // the resolved head. A flag is never a valid command name, so the parse must fail
  // closed rather than emit a confident node that leaves the real `rm` unexamined.
  it('does not silently drop rm behind xargs -0 (flag-resolved head)', () => {
    expect(enumeratesOrUnsafe('xargs -0 rm scratch.txt')).toBe(true);
  });
  it('does not silently drop rm behind env -i (flag-resolved head)', () => {
    expect(enumeratesOrUnsafe('env -i rm scratch.txt')).toBe(true);
  });

  // Regression guard: wrappers whose next token IS the real command must still resolve
  // and enumerate the `rm` head unchanged (the flag-head fix must not over-fire here).
  it('still enumerates rm behind a bare xargs wrapper', () => {
    expect(heads('xargs rm scratch.txt')).toContain('rm');
  });
  it('still enumerates rm behind a bare sudo wrapper', () => {
    expect(heads('sudo rm scratch.txt')).toEqual(['rm']);
  });
});

describe('analyzeCommand — subshells and substitutions are read (2026-09-25)', () => {
  it('reads $( ) inside double quotes and backticks as positions of their own', () => {
    expect(heads('echo "$(rm scratch.txt)"')).toEqual(['rm', 'echo']);
    expect(heads('echo `rm scratch.txt`')).toEqual(['rm', 'echo']);
    expect(analyzeCommand('echo "$(printf "a b")"').parsedSafely).toBe(true);
  });

  it('keeps a substitution one word, so the head is the real command', () => {
    // Split on its inner space, `X=$(date +%s) rm x` handed the head to `+%s)`.
    expect(heads('X=$(date +%s) rm scratch.txt')).toEqual(['date', 'rm']);
    const outer = analyzeCommand('npm test $(rm -rf ~)').commands.find((c) => c.head === 'npm');
    expect(outer?.argv).toEqual(['test', '$(rm -rf ~)']);
  });

  it('keeps redirections after a group as a position of their own', () => {
    const r = analyzeCommand('(ls; cat a) > out.txt 2>> err.log');
    expect(r.parsedSafely).toBe(true);
    expect(r.commands.map((c) => c.head)).toEqual(['ls', 'cat', '>']);
    expect(r.commands[2].raw).toBe('> out.txt 2>> err.log');
    expect(r.commands[2].scope).toBeUndefined();
  });

  it('reads a group after a command-introducing keyword', () => {
    expect(heads('if (test -f x); then (rm scratch.txt); fi')).toEqual(['test', 'rm', 'fi']);
    expect(analyzeCommand('! (ls)').parsedSafely).toBe(true);
  });

  it('gives every body its own scope, so a cd inside one cannot leak out', () => {
    const r = analyzeCommand('(cd /a; ls); cat <(cd /b); sh -c "cd /c"; rm x');
    const scopeOf = (i: number) => r.commands[i].scope;
    expect(r.commands.map((c) => c.head)).toEqual(['cd', 'ls', 'cd', 'cat', 'sh', 'cd', 'rm']);
    expect(scopeOf(0)).toBe(scopeOf(1));
    expect(new Set([scopeOf(0), scopeOf(2), scopeOf(5)]).size).toBe(3);
    expect(scopeOf(3)).toBeUndefined();
    expect(scopeOf(6)).toBeUndefined();
    const inner = analyzeCommand('echo $(echo $(rm x))').commands[0];
    expect(inner.head).toBe('rm');
    expect(inner.scope?.split('/')).toHaveLength(2);
  });

  it('marks nested only for subshells and substitutions', () => {
    expect(analyzeCommand('cat <(ls)').nested).toBe(false);
    expect(analyzeCommand('sh -c "ls"').nested).toBe(false);
    expect(analyzeCommand('ls | grep x').nested).toBe(false);
    expect(analyzeCommand("echo '$(ls)'").nested).toBe(false);
    expect(analyzeCommand('(ls)').nested).toBe(true);
    expect(analyzeCommand('echo $(ls)').nested).toBe(true);
    expect(analyzeCommand("sh -c 'echo $(ls)'").nested).toBe(true);
  });

  // Each of these can put bash's closing `)` somewhere other than ours, make a
  // command word out of data, or is a construct we do not read at all. Every
  // one must fail closed, never parse with a body in the wrong place.
  const REFUSED: Record<string, string> = {
    'arithmetic expansion':           'echo $(( 1 + $(rm -rf ~) ))',
    'arithmetic command':             '((x++)); rm scratch.txt',
    'case inside a substitution':     'echo $(case x in a) rm -rf / ;; esac)',
    'case inside a group':            '(case x in a) rm -rf / ;; esac)',
    'case inside process substitution': 'cat <(case x in a) rm -rf / ;; esac)',
    'comment inside a substitution':  'echo $(echo hi # )\nrm -rf ~\n)',
    "ANSI-C quote inside a body":     "echo $(printf $'\\')' ; rm -rf ~)",
    'backslash inside backticks':     'echo `echo \\` rm -rf ~`',
    'quote inside ${ } in a body':    'echo $(echo ${x:-")"} ; rm -rf ~)',
    'command word from $( )':         '$(echo rm) scratch.txt',
    'command word from backticks':    '`echo rm` scratch.txt',
    'command word after a wrapper':   'sudo $(echo rm) scratch.txt',
    'function definition':            'f() { rm scratch.txt; }',
    'array assignment':               'a=(1 2); rm scratch.txt',
    'time before a group':            'time (rm scratch.txt)',
    'a word after a group':           '(ls) rm scratch.txt',
    'unclosed substitution':          'echo $(rm scratch.txt',
    'unclosed group':                 '(rm scratch.txt',
    'bodies nested too deep':         `${'echo $('.repeat(17)}rm x${')'.repeat(17)}`,
  };
  for (const [name, command] of Object.entries(REFUSED)) {
    it(`fails closed: ${name}`, () => {
      expect(analyzeCommand(command).parsedSafely).toBe(false);
    });
  }

  it('reads what those refusals sit beside when it can be delimited', () => {
    expect(analyzeCommand('echo $(basename "${f%.*}")').parsedSafely).toBe(true);
    expect(analyzeCommand('echo $(echo ${x/)/y})').parsedSafely).toBe(true);
    expect(analyzeCommand('echo $(echo "# not a comment" a#b)').parsedSafely).toBe(true);
    expect(analyzeCommand('git commit -m "$(cat <<\'EOF\'\n)"').parsedSafely).toBe(true);
  });
});

describe('analyzeCommand — escapes, timeout and eval (review of #3863)', () => {
  it('removes backslash escapes from a head, as bash does before running it', () => {
    expect(heads('\\rm -rf x')).toEqual(['rm']);
    expect(heads('r\\m x')).toEqual(['rm']);
    expect(heads('\\sudo \\rm x')).toEqual(['rm']);
  });

  it('reads timeout as a wrapper: options, their values and one DURATION', () => {
    expect(heads('timeout 5 rm -rf x')).toEqual(['rm']);
    expect(heads('timeout -s KILL 10s rm x')).toEqual(['rm']);
    expect(heads('timeout -k 5 --signal=KILL 1.5m rm x')).toEqual(['rm']);
    expect(heads('timeout --kill-after 5 --preserve-status -v 30 npm test')).toEqual(['npm']);
    expect(heads('timeout -vsKILL -- .5 rm x')).toEqual(['rm']);
  });

  it('walks what eval runs, as its own body', () => {
    expect(heads('eval "rm -rf x"')).toEqual(['eval', 'rm']);
    expect(heads("eval 'rm -rf x' && ls")).toEqual(['eval', 'rm', 'ls']);
    expect(heads('eval rm -rf x')).toEqual(['eval', 'rm']);
    expect(analyzeCommand('eval "echo hi"').parsedSafely).toBe(true);
    // Quoting inside a word is removed before eval joins its words, as bash does.
    expect(analyzeCommand(`eval "echo "'hi'`).commands.map((c) => c.raw)).toEqual([`eval "echo "'hi'`, 'echo hi']);
  });

  const REFUSED: Record<string, string> = {
    'timeout with an unknown option':  'timeout --frobnicate 5 rm x',
    'timeout with a $VAR duration':    'timeout "$T" rm x',
    'timeout with no command':         'timeout 5',
    'timeout with a missing value':    'timeout -s',
    'eval of a substitution':          'eval "$(ssh-agent -s)"',
    'eval of a variable':              'eval "echo $X"',
    'eval of an escaped quote':        'eval "a\\"b"',
  };
  for (const [name, command] of Object.entries(REFUSED)) {
    it(`fails closed: ${name}`, () => {
      expect(analyzeCommand(command).parsedSafely).toBe(false);
    });
  }
});

describe('quote removal and line continuations (security re-review of #3863, 2026-09-25)', () => {
  it('removes quotes the way bash does, one word at a time', () => {
    const CASES: Array<[string, string]> = [
      ['\\rm', 'rm'], ['r\\m', 'rm'], ['"r"m', 'rm'], ["'r'm", 'rm'], ['r\\\nm', 'rm'], ['\\/etc/hosts', '/etc/hosts'],
      ['.\\./.\\./etc', '../../etc'], ['"a\\b"', 'a\\b'], ['"a\\"b"', 'a"b'], ['"a\\$b"', 'a$b'], ["'a\\b'", 'a\\b'],
      ['"a\\\nb"', 'ab'], ["'a\\\nb'", 'a\\\nb'], ['$"rm"', '$rm'], ["$'rm'", 'rm'], ["$'\\x72m'", 'rm'],
      ["$'\\162m'", 'rm'], ["$'a\\'b'", "a'b"], ["$'\\u0072m'", "$'\\u0072m'"], ['"$(echo "a b")"', '$(echo "a b")'],
      ['x`echo "y"`', 'x`echo "y"`'], ['"unclosed', 'unclosed'], ['trailing\\', 'trailing\\'], ['"$HOME"/x', '$HOME/x'],
    ];
    for (const [word, removed] of CASES) expect(removeQuotes(word), word).toBe(removed);
  });

  it('resolves a head after quote removal, before any trim', () => {
    expect(normalizeHead('rm\\\n')).toBe('rm');
    expect(normalizeHead('\\\nrm')).toBe('rm');
    expect(normalizeHead('"/bin/r"m')).toBe('rm');
    expect(normalizeHead('\\ rm')).toBe(' rm'); // an escaped space is part of the name
  });

  it('removes line continuations in every body before splitting it', () => {
    expect(heads('r\\\nm -rf x')).toEqual(['rm']);
    expect(analyzeCommand('rm -r\\\nf x').commands[0].argv).toEqual(['-rf', 'x']);
    expect(heads("sh -c 'r\\\nm x'")).toEqual(['sh', 'rm']);
    expect(heads('for d in a; d\\\no rm x; done')).toEqual(['for', 'rm', 'done']);
    expect(heads('cd /x && \\\n  npm run build')).toEqual(['cd', 'npm']);
  });

  it('keeps a continuation where bash keeps it: single quotes and $\'…\'', () => {
    expect(analyzeCommand("echo 'a\\\nb'").commands[0].argv).toEqual(["'a\\\nb'"]);
    expect(analyzeCommand("echo $'a\\\nb'").commands[0].argv).toEqual(["$'a\\\nb'"]);
    expect(analyzeCommand('echo "a\\\nb"').commands[0].argv).toEqual(['"ab"']);
  });

  it('fails closed on a comment ending in a backslash: bash runs the next line', () => {
    const r = analyzeCommand('# note \\\nrm -rf /etc');
    expect(r.parsedSafely).toBe(false);
    expect(analyzeCommand('echo a#b \\\n c').parsedSafely).toBe(true); // `a#b` is no comment
    expect(analyzeCommand('echo ${#x} \\\n c').parsedSafely).toBe(true);
  });

  it('reads builtin, exec and command -p as wrappers', () => {
    expect(heads('builtin eval "rm -rf x"')).toEqual(['eval', 'rm']);
    expect(heads('builtin command rm -rf x')).toEqual(['rm']);
    expect(heads('exec rm -rf x')).toEqual(['rm']);
    expect(heads('command -p rm -rf x')).toEqual(['rm']);
    expect(analyzeCommand('command -v rm').parsedSafely).toBe(false); // a lookup: still a flag head, fail closed
    expect(analyzeCommand('exec -a name rm x').parsedSafely).toBe(false);
  });

  it('reads eval and sh -c bodies after quote removal', () => {
    expect(analyzeCommand('eval rm\\ -rf\\ /etc').commands.map((c) => c.raw)).toEqual(['eval rm\\ -rf\\ /etc', 'rm -rf /etc']);
    expect(heads('eval echo\\;rm -rf x')).toEqual(['eval', 'echo', 'rm']);
    expect(analyzeCommand('sh -c "rm \\"/etc/x\\""').commands[1].argv).toEqual(['"/etc/x"']);
    expect(heads('sh "-c" "rm x"')).toEqual(['sh', 'rm']);
    expect(heads('e"va"l "rm x"')).toEqual(['eval', 'rm']);
    expect(analyzeCommand('eval "echo $X"').parsedSafely).toBe(false); // an expansion before eval reads it
    expect(analyzeCommand('eval "echo \\$X"').commands[1].raw).toBe('echo $X'); // escaped: eval expands it
  });

  it('never decodes a NUL in $\'…\': bash ends the word there, so the run stays verbatim', () => {
    expect(removeQuotes("$'rm\\0zz'")).toBe("$'rm\\0zz'");
    expect(removeQuotes("$'rm\\x00'")).toBe("$'rm\\x00'");
    expect(removeQuotes("$'rm\\000'")).toBe("$'rm\\000'");
    expect(heads("$'rm\\0' -rf x")).toEqual(["$'rm\\0'"]);
  });

  it('keeps one byte of an octal escape, as bash does', () => {
    expect(removeQuotes("$'\\562\\555'")).toBe('rm');         // 0o562 & 0xff = 'r'
    expect(removeQuotes("$'rm\\400'")).toBe("$'rm\\400'");   // 0o400 & 0xff = NUL: verbatim
    expect(removeQuotes("$'\\u0000'")).toBe("$'\\u0000'");   // \u is never decoded
  });

  it('never basenames inside ${…}', () => {
    expect(normalizeHead('"${R:-/bin/rm}"')).toBe('${R:-/bin/rm}');
    expect(normalizeHead('"${P%/*}"')).toBe('${P%/*}');
    expect(normalizeHead('"${VENV}/bin/python"')).toBe('python');
    expect(normalizeHead('${A:-{x}/y}')).toBe('${A:-{x}/y}');
  });

  it('delimits a body across an ANSI-C run', () => {
    expect(heads("(eval $'rm\\x20-rf\\x20x')")).toEqual(['eval', 'rm']);
    expect(heads("echo $(printf $'a)b\\n')")).toEqual(['printf', 'echo']);
    expect(analyzeCommand("echo $(printf $'never closes)").parsedSafely).toBe(false);
  });

  it('decodes an ANSI-C eval word, and refuses one it cannot decode', () => {
    expect(heads("eval $'rm\\x20-rf\\x20x'")).toEqual(['eval', 'rm']);
    expect(heads("eval $'echo\\x20hi'")).toEqual(['eval', 'echo']);
    expect(analyzeCommand("eval $'rm\\0 -rf x'").parsedSafely).toBe(false);
  });

  it('fails closed on a command word bash splits apart', () => {
    for (const cmd of ['rm${IFS}-rf${IFS}x', 'rm$IFS-rf x', '{rm,-rf,x}', '{rm,-rf} x', 'r{m,} x']) {
      expect(analyzeCommand(cmd).parsedSafely, cmd).toBe(false);
    }
    for (const cmd of ['cp notes.md{,.bak}', 'mkdir -p src/{a,b}', 'echo "${IFS}"x', '"${VENV}/bin/python" run.py', 'echo $IFSX']) {
      expect(analyzeCommand(cmd).parsedSafely, cmd).toBe(true);
    }
  });
});
