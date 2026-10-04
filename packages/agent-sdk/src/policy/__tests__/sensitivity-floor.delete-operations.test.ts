/**
 * THE FLOOR JUDGES OPERATIONS, NOT SPELLINGS.
 *
 * Founder invariant: "Deletions always check with you. Only Autopilot runs them
 * alone." Until 2026-08-09 it was enforced by token patterns, and a staging
 * drill (native arm, relaxed, probe user) proved that inconsistent in BOTH
 * directions — the same delete asked or ran silently depending on how the
 * script was formatted.
 *
 * CONTROL RUN on the pre-fix code (origin/staging @ 24eeaae56, VESTRA_BASH_AST_GATE
 * default ON, workspaceRoot=/app/workspace, shellCwd=/app/workspace) — verbatim:
 *
 *   V1         floors=false  family=workspace_write   parsedSafely=true  heads=["curl"]
 *   V2         floors=true   family=dangerous_delete  parsedSafely=true  heads=["rm","test"]
 *   V3         floors=true   family=dangerous_delete  parsedSafely=false heads=["set"]
 *   V4         floors=false  family=workspace_write   parsedSafely=true  heads=["curl"]
 *   V4wrapped  floors=true   family=dangerous_delete  parsedSafely=false heads=[]
 *
 * V1 is the floor BYPASS: a clean single-line `curl -X DELETE` deleted a user's
 * file with no ask (staging 16:26 UTC). V4wrapped is the OVER-ASK: a read-only
 * verification asked as a delete because `'%{http_code}'` carries a brace and
 * the unparseable path read glob metachars out of quoted bytes. V3 asked for the
 * WRONG REASON (the same accidental brace), which is why re-spelling it as V1
 * silently opened the hole.
 */
import { describe, it, expect } from 'vitest';
import { sensitivityFloorAsks, classifyBashCommand } from '../../index.js';
import { describePermissionAsk } from '../describe-tool.js';
import { analyzeCommand } from '../command-analyzer.js';

const ROOT = '/app/workspace';

const asks = (command: string, shellCwd: string | null = ROOT): boolean =>
  sensitivityFloorAsks(
    { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
    { workspaceRoot: ROOT, shellCwd },
  );

const family = (command: string): string => classifyBashCommand(command, ROOT, ROOT);

// ── the four staging drill vectors, VERBATIM ─────────────────────────────────

/** The floor bypass: a single-line HTTP DELETE against the user's Files API. */
const V1_UNGATED_CURL_DELETE =
  'curl -sS -X DELETE "$VESTRA_SERVER_URL/api/files/2e34695c-d102-4663-b531-7dc1a034d1a9" -H "Authorization: Bearer $VESTRA_API_TOKEN"';

/** Post-2026-09-03: a FORCE-only delete of a specific IN-WORKSPACE file now runs
 *  SILENTLY (force never widens the target set — founder ruling). Kept as the
 *  vector whose verdict that ruling deliberately flipped; the curl-delete vectors
 *  V1/V3/V4 are unchanged. */
const V2_RM_FORCE =
  'rm -f /app/workspace/files/parity-tile.md && test ! -e /app/workspace/files/parity-tile.md';

/** Correctly gated, wrong reason: the same HTTP DELETE inside a `$(…)` script. */
const V3_SCRIPTED_CURL_DELETE = [
  'set -euo pipefail',
  'code=$(curl -sS -o /dev/null -w \'%{http_code}\' -X DELETE "$VESTRA_SERVER_URL/api/files/abc" -H "Authorization: Bearer $VESTRA_API_TOKEN")',
  'echo "$code"',
].join('\n');

/** The over-ask: a READ-ONLY verification with no DELETE anywhere. */
const V4_READONLY_VERIFY =
  'curl -sS -o /dev/null -w \'%{http_code}\' -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/files/2e34695c-d102-4663-b531-7dc1a034d1a9"';

/** V4 as it actually ran on staging: the status code captured through `$(…)`. */
const V4_READONLY_VERIFY_CAPTURED = [
  'code=$(curl -sS -o /dev/null -w \'%{http_code}\' -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/files/abc")',
  'echo "$code"',
].join('\n');

describe('the four staging drill vectors', () => {
  it('V1 (the bypass): a single-line curl -X DELETE now asks', () => {
    expect(asks(V1_UNGATED_CURL_DELETE)).toBe(true);
    expect(family(V1_UNGATED_CURL_DELETE)).toBe('dangerous_delete');
  });

  it('V2: a forced IN-WORKSPACE filesystem delete now runs silently (founder ruling 2026-09-03)', () => {
    // Force alone never widens the target set, so a specific in-workspace file
    // is safe. (A recursion/glob/escape target would still gate — see below.)
    expect(asks(V2_RM_FORCE)).toBe(false);
  });

  it('V3: the scripted curl -X DELETE still asks', () => {
    expect(asks(V3_SCRIPTED_CURL_DELETE)).toBe(true);
  });

  it('V3 asks because of the DELETE method, not because the script carries braces', () => {
    // The same script requesting a GET has identical punctuation ('%{http_code}',
    // $(…), quotes) and must NOT read as a delete. This is the pin that keeps the
    // verdict tied to the operation: re-spelling V3 as V1 is what opened the hole.
    expect(asks(V3_SCRIPTED_CURL_DELETE.replace('-X DELETE', '-X GET'))).toBe(false);
  });

  it('V4 (the over-ask): a read-only verification does not floor as a delete', () => {
    expect(asks(V4_READONLY_VERIFY)).toBe(false);
    expect(family(V4_READONLY_VERIFY)).not.toBe('dangerous_delete');
  });

  it('V4 as it ran on staging (status captured through $(…)) also stops flooring', () => {
    expect(asks(V4_READONLY_VERIFY_CAPTURED)).toBe(false);
    expect(family(V4_READONLY_VERIFY_CAPTURED)).not.toBe('dangerous_delete');
  });

  it('the same operation gets the same verdict however it is written', () => {
    // The bug in one line: V1 and V3 are the same HTTP DELETE, and before the fix
    // they disagreed.
    expect(asks(V1_UNGATED_CURL_DELETE)).toBe(asks(V3_SCRIPTED_CURL_DELETE));
  });
});

// ── formatting fuzz: one operation, many spellings ───────────────────────────

describe('an HTTP DELETE asks in every spelling', () => {
  const SPELLINGS: Record<string, string> = {
    'separate flag':            'curl -X DELETE https://api.example.com/files/1',
    'fused flag':               'curl -XDELETE https://api.example.com/files/1',
    'long flag, spaced':        'curl --request DELETE https://api.example.com/files/1',
    'long flag, equals':        'curl --request=DELETE https://api.example.com/files/1',
    'bundled short flags':      'curl -sSX DELETE https://api.example.com/files/1',
    'bundled and fused':        'curl -sSXDELETE https://api.example.com/files/1',
    'wget method flag':         'wget --method=DELETE https://api.example.com/files/1',
    'wget method, spaced':      'wget --method DELETE https://api.example.com/files/1',
    'httpie positional':        'http DELETE https://api.example.com/files/1',
    'lowercase method':         'curl -X delete https://api.example.com/files/1',
    'mixed case method':        'curl -X Delete https://api.example.com/files/1',
    'double-quoted method':     'curl -X "DELETE" https://api.example.com/files/1',
    'single-quoted method':     "curl -X 'DELETE' https://api.example.com/files/1",
    'method after the url':     'curl https://api.example.com/files/1 -X DELETE',
    'env-var url':              'curl -X DELETE "$VESTRA_SERVER_URL/api/files/1"',
    'env-var url, no quotes':   'curl -X DELETE $VESTRA_SERVER_URL/api/files/1',
    'line continuation':        'curl -sS \\\n  -X DELETE \\\n  "$URL/api/files/1"',
    'multi-line script':        'set -euo pipefail\ncurl -X DELETE "$URL/api/files/1"\necho done',
    'command substitution':     'out=$(curl -X DELETE "$URL/api/files/1")',
    'backtick substitution':    'out=`curl -X DELETE "$URL/api/files/1"`',
    'piped to jq':              'curl -s -X DELETE "$URL/api/files/1" | jq .',
    'after a read':             'curl -s "$URL/api/files" && curl -X DELETE "$URL/api/files/1"',
    'backgrounded':             'sleep 1 & curl -X DELETE "$URL/api/files/1"',
    'inside sh -c':             'sh -c "curl -X DELETE $URL/api/files/1"',
    'path-prefixed client':     '/usr/bin/curl -X DELETE "$URL/api/files/1"',
    'wrapper-prefixed':         'sudo curl -X DELETE "$URL/api/files/1"',
    'assignment-prefixed':      'FOO=1 curl -X DELETE "$URL/api/files/1"',
    'unresolvable method':      'curl -X "$METHOD" "$URL/api/files/1"',
  };

  for (const [name, command] of Object.entries(SPELLINGS)) {
    it(`asks: ${name}`, () => {
      expect(asks(command)).toBe(true);
      expect(family(command)).toBe('dangerous_delete');
    });
  }
});

describe('a request that deletes nothing stays silent', () => {
  const SILENT: Record<string, string> = {
    'implicit GET':            'curl -sS "$URL/api/files/1"',
    'explicit GET':            'curl -X GET "$URL/api/files/1"',
    'explicit HEAD':           'curl -I -X HEAD "$URL/api/files/1"',
    'POST (a write, not a delete)': 'curl -X POST "$URL/api/files/create-file" -d @body.json',
    'PUT':                     'curl -X PUT "$URL/api/files/1" -d \'{"a":1}\'',
    'format string braces':    'curl -sS -o /dev/null -w \'%{http_code}\' "$URL/api/files/1"',
    'jq filter brackets':      'curl -s "$URL/api/files" | jq \'{files:[.files[]|{id}]}\'',
    'DELETE as prose':         'echo "this will DELETE nothing"',
    'DELETE in a SQL string':  'psql -c "DELETE FROM staging_tmp" --dry-run',
    'wget download':           'wget "$URL/api/files/1" -O out.bin',
    // `-X` is tar's exclude-from here, not a request method. An unreadable
    // value only asks when an HTTP client is actually present in the command.
    // (No `-f`: that trips the older recursive/force tell, which is unchanged.)
    'tar exclude-from':        'tar -cz -X "$EXCLUDES" --file=/tmp/out.tgz "$(pwd)"',
  };

  for (const [name, command] of Object.entries(SILENT)) {
    it(`stays silent: ${name}`, () => {
      expect(asks(command)).toBe(false);
    });
  }
});

// ── the over-ask relaxation, and its exact boundary ──────────────────────────

describe('quoted metachars are not globs (the over-ask fix)', () => {
  // A glob only signals "we cannot see what this expands to" where the shell
  // would actually expand it. Inside quotes it expands to itself.
  it('does not floor an unparseable read whose braces are single-quoted', () => {
    expect(asks('cat "$(pwd)" | jq \'{a:[.b[]]}\'')).toBe(false);
  });

  it('does not floor an unparseable read whose braces are double-quoted', () => {
    expect(asks('echo "$(date)" "{a,b}"')).toBe(false);
  });

  it('STILL floors an unparseable command with an UNQUOTED glob', () => {
    // Unparseable through the arithmetic expansion; a bare `"$(pwd)"` (since
    // 2026-09-25) and a bare assignment (since 2026-09-28) no longer reach this proxy.
    expect(asks('ls *.md "$((n+1))"')).toBe(true);
    expect(asks('cp {a,b}.txt "$((n+1))"')).toBe(true);
  });

  it('a quoted rm is still a delete — only the glob signal is quote-aware', () => {
    expect(asks('cat "$(rm x)"')).toBe(true);
    expect(asks('"rm" -rf "$(pwd)"')).toBe(true);
  });
});

describe('bracket punctuation is not a glob either (drill 2026-08-10)', () => {
  // The shell expands none of these standing alone: `[`/`]` is the test
  // builtin, `{`/`}` open and close a brace group, `{}` is find's placeholder.
  // A word that IS one of them names only itself, so it cannot hide a set of
  // paths — which is why ignoring it cannot open an under-ask.
  it('does not floor an unparseable script guarded by the POSIX test builtin', () => {
    expect(asks('x=$(date); if [ -z "$x" ]; then echo none; fi')).toBe(false);
  });

  it('does not floor a brace group or a find placeholder in an unparseable script', () => {
    expect(asks('{ echo "$(date)"; }')).toBe(false);
    expect(asks('echo {} "$(pwd)"')).toBe(false);
  });

  it('STILL floors the IN-WORD forms, which really do expand', () => {
    expect(asks('ls [abc].txt "$((n+1))"')).toBe(true);
    expect(asks('ls file[0-9] "$((n+1))"')).toBe(true);
    expect(asks('cp {a,b}.txt "$((n+1))"')).toBe(true);
  });

  it('STILL floors a bare * or ? — those ARE globs on their own', () => {
    expect(asks('ls * "$((n+1))"')).toBe(true);
    expect(asks('ls ? "$((n+1))"')).toBe(true);
  });

  it('an escaped bracket is literal, and a real delete is caught regardless', () => {
    expect(asks('echo \\[ "$(date)"')).toBe(false);
    expect(asks('[ -z "$x" ] && rm -rf "$(pwd)"/build')).toBe(true);
  });
});

// ── the drill's pure-CREATE script ───────────────────────────────────────────

/**
 * VERBATIM from staging interaction d4779933-8d97-4f24-9e0c-9e3ea36f89de
 * (2026-08-10 05:23:00.189646+00), which asked "Delete files in your workspace"
 * for a script that deletes NOTHING: mkdir, a create-file POST, a jq parse, and
 * printf. Kept byte-for-byte so the vector tracks the real shape.
 */
const DRILL_CREATE_SCRIPT = [
  'set -euo pipefail',
  'mkdir -p /app/workspace/scratch',
  'response=$(curl -sS -H "Authorization: Bearer $VESTRA_API_TOKEN" -H "Content-Type: application/json" "$VESTRA_SERVER_URL/api/files/create-file" --data-binary \'{"filename":"guard-drill.md","content":"Quick guard drill note.\\n","mimeType":"text/markdown"}\')',
  'printf \'%s\' "$response" > /app/workspace/scratch/guard-drill-create.json',
  'file_id=$(printf \'%s\' "$response" | jq -r \'.id // .file.id // .data.id // empty\')',
  'if [ -z "$file_id" ] || [ "$file_id" = "null" ]; then',
  '  printf \'%s\\n\' "$response" >&2',
  '  exit 1',
  'fi',
  'printf \'%s\' "$file_id" > /app/workspace/scratch/guard-drill-id',
  'printf \'created %s\\n\' "$file_id"',
].join('\n');

describe('the drill create script carries no delete', () => {
  it('parses: its `response=$(curl …)` is a bare assignment, read since 2026-09-28', () => {
    // The analyzer reads substitutions as their own positions (2026-09-25), and a
    // bare assignment no longer fails the parse (2026-09-28), so the script is
    // judged position by position instead of through the raw-word proxies.
    expect(analyzeCommand(DRILL_CREATE_SCRIPT).parsedSafely).toBe(true);
  });

  it('produces NO delete ask (the regression pin for both triggers)', () => {
    // Two separate causes had to fall for this to go silent: the bare `[` of
    // its `if` guard (word-aware glob proxy, #2484) and its `jq -r` (the flag
    // tell now needs two letters, founder ruling 2026-08-10).
    expect(asks(DRILL_CREATE_SCRIPT)).toBe(false);
    expect(family(DRILL_CREATE_SCRIPT)).not.toBe('dangerous_delete');
  });

  it('and the create script never contained a delete of any kind', () => {
    expect(DRILL_CREATE_SCRIPT).not.toMatch(/\brm\b|\brmdir\b|\bunlink\b|\bshred\b/);
    expect(DRILL_CREATE_SCRIPT).not.toMatch(/-X\s*DELETE|--request[=\s]DELETE/i);
  });
});

// ── the recursive/force flag tell needs two letters ──────────────────────────

describe('a lone -r / -f is an ordinary tool flag, not a delete tell', () => {
  // Founder ruling 2026-08-10. A floor that fires on `jq -r` teaches the user
  // to approve without reading, and click-through fatigue defeats the guard
  // more reliably than the residual gap does.
  const EVERYDAY_FLAGS: Record<string, string> = {
    'jq -r':    'id=$(printf \'%s\' "$resp" | jq -r \'.id\')',
    'grep -r':  'hits=$(grep -r needle src)',
    'sort -r':  'top=$(sort -r counts.txt | head -1)',
    'cp -r':    'cp -r src "$(mktemp -d)"',
    'curl -f':  'body=$(curl -f -sS "$URL/api/files")',
    'tar -f':   'tar -cz -f /tmp/out.tgz "$(pwd)"',
    'ls -r':    'newest=$(ls -r /app/workspace/files | head -1)',
    'head -f':  'tail -f "$(ls /tmp/log)" &',
  };

  for (const [name, command] of Object.entries(EVERYDAY_FLAGS)) {
    it(`stays silent: ${name} in an unparseable script`, () => {
      expect(asks(command)).toBe(false);
      expect(family(command)).not.toBe('dangerous_delete');
    });
  }

  const REAL_TELLS: Record<string, string> = {
    '-rf':          '$(printf r)$(printf m) -rf /',
    '-fr':          '$(printf r)$(printf m) -fr /',
    '-Rf':          '$(printf r)$(printf m) -Rf /',
    '-rR':          '$(printf r)$(printf m) -rR /',
    // The verb is FRAGMENTED in each of these, so no `rm` word exists to be
    // found: the flag really is the only tell being exercised.
    '--force':       '$(printf r)$(printf m) --force /',
    '--recursive':   '$(printf r)$(printf m) --recursive /',
    'assembled -rf': 'R=r;M=m;$R$M -rf /',
    '$VAR head -rf': '$RM_CMD -rf /',
  };

  for (const [name, command] of Object.entries(REAL_TELLS)) {
    it(`STILL asks: ${name}`, () => {
      expect(asks(command)).toBe(true);
    });
  }

  it('a VISIBLE delete verb is caught on its own, flag or no flag', () => {
    // This is why the narrowing cannot reach an ordinary delete: only a
    // verb hidden behind an expansion ever depended on the flag alone.
    expect(asks('rm -r "$(pwd)"/build')).toBe(true);
    expect(asks('cat "$(rm -r x)"')).toBe(true);
    expect(asks('unlink "$(pwd)"/keep.txt')).toBe(true);
  });

  it('the parseable path: recursion still floors; force-only on an in-workspace file no longer does', () => {
    // On the PARSEABLE path we can read the target, so a FORCE-only flag on a
    // specific in-workspace file is safe (founder ruling 2026-09-03). Recursion
    // still floors. (This differs from the UNPARSEABLE path above, where the
    // target is unreadable so a `--force`/`-rf` token stays a hidden-verb tell.)
    expect(asks('rm -f /app/workspace/files/a.pdf')).toBe(false);
    expect(asks('rm -r /app/workspace/files/dir')).toBe(true);
  });
});

// ── the rest of the removal family, at argv level ────────────────────────────

describe('every filesystem removal verb floors when it is dangerous', () => {
  it('asks on unlink and shred outside the workspace', () => {
    expect(asks('unlink /etc/hosts')).toBe(true);
    expect(asks('shred -u /etc/hosts')).toBe(true);
  });

  it('a forced unlink/shred of a specific in-workspace file runs silently, but still asks when dangerous', () => {
    // Force applies uniformly across the removal family (rm/rmdir/unlink/shred):
    // it never widens the target set, so a specific in-workspace file is safe
    // (founder ruling 2026-09-03) …
    expect(asks('shred -f /app/workspace/files/a.pdf')).toBe(false);
    // … while escape / recursion / glob still gate for every verb.
    expect(asks('shred -f /etc/hosts')).toBe(true); // target escapes the workspace
    expect(asks('rmdir /app/workspace/../etc')).toBe(true); // traversal escape
  });

  it('keeps the rm narrowing: a plain in-workspace specific-file removal is silent', () => {
    expect(asks('rm /app/workspace/files/a.pdf')).toBe(false);
    expect(asks('unlink /app/workspace/files/a.pdf')).toBe(false);
  });

  it('asks on a find that deletes what it matches', () => {
    expect(asks('find /app/workspace/files -name "*.md" -delete')).toBe(true);
    expect(asks('find /app/workspace/files -name "*.md" -exec rm {} \\;')).toBe(true);
  });

  it('does NOT ask on a find that only lists', () => {
    expect(asks('find /app/workspace/files -name report.md')).toBe(false);
  });

  it('asks on a move onto /dev/null (the source stops existing)', () => {
    expect(asks('mv /app/workspace/files/a.pdf /dev/null')).toBe(true);
    expect(asks('mv /app/workspace/files/a.pdf /dev/null 2>&1')).toBe(true);
  });

  it('does NOT ask on an ordinary move or a /dev/null redirect', () => {
    expect(asks('mv /app/workspace/files/a.pdf /app/workspace/files/b.pdf')).toBe(false);
    expect(asks('ls /app/workspace 2>/dev/null')).toBe(false);
  });
});

// ── the ladder can never rate a floored call milder ──────────────────────────

describe('floor and family stay monotone', () => {
  const CORPUS = [
    V1_UNGATED_CURL_DELETE,
    V2_RM_FORCE,
    V3_SCRIPTED_CURL_DELETE,
    V4_READONLY_VERIFY,
    V4_READONLY_VERIFY_CAPTURED,
    'curl -XDELETE https://api.example.com/x',
    'find . -delete',
    'mv a.txt /dev/null',
    'ls -la',
    'rm /app/workspace/files/a.pdf',
  ];

  for (const command of CORPUS) {
    it(`agrees on: ${command.slice(0, 40)}`, () => {
      if (asks(command)) expect(family(command)).toBe('dangerous_delete');
      else expect(family(command)).not.toBe('dangerous_delete');
    });
  }
});

// ── the card speaks about the operation the guard gated ──────────────────────

describe('the permission card never announces a delete as a fetch', () => {
  const headline = (command: string): string =>
    describePermissionAsk(
      { toolName: 'Bash', toolInput: { command }, toolCallId: 't' },
      { family: 'dangerous_delete', floor: 'hard', level: 'relaxed' },
    ).headline;

  it('names the host a remote delete targets', () => {
    expect(headline('curl -X DELETE https://api.vestra.ai/api/files/1')).toBe(
      'Delete data at api.vestra.ai',
    );
  });

  it('says a delete happened even when the url hides behind an env var', () => {
    expect(headline(V1_UNGATED_CURL_DELETE)).toBe('Delete data at a web address');
  });

  it('speaks from the family when the script cannot be enumerated', () => {
    expect(headline(V3_SCRIPTED_CURL_DELETE)).toBe('Delete files in your workspace');
  });

  it('names the source a move-to-null removes, not the null device', () => {
    expect(headline('mv /app/workspace/files/a.pdf /dev/null')).toBe('Delete a.pdf');
  });

  it('names the pattern a find removes', () => {
    expect(headline('find /app/workspace/files -name "*.md" -delete')).toBe(
      'Delete files matching *.md',
    );
  });
});
