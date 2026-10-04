/**
 * THE DELETE FLOOR ASKS ONLY FOR REAL DELETES.
 *
 * #bugs 2026-09-25 (Adarsh): an "Allow Bash?" card, "Delete files in your
 * workspace", over a Remotion render in the agent's own scratch folder. Prod,
 * last 30 days: 37 Bash asks, nearly all `dangerous_delete` on the hard floor,
 * nearly all answered Allow, and by hand about half of them were not deletes.
 *
 * Cause (measured on origin/staging @ 74b8faa66): the analyzer refused every
 * `( … )` subshell, `$( … )` and backtick, so those commands fell to the
 * unparseable fallback, whose glob proxy read the `?` of `$?`, the `*` of `$*`
 * and the `{` of `${…}` / `{1..32}` as pathname globs. One more shape was never
 * on the fallback: `"$WMR" … --force` parses fine and was floored by the
 * `$`-head tell, which counted a lone `--force` as a hidden `rm -rf`.
 *
 * `before` is the family origin/staging returned, measured, not assumed. The
 * shapes marked "as written" were already off the floor there; each has a
 * sibling that carries what the real command carried and was on the floor.
 */
import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { classifySideEffect, type SideEffectFamily } from '../side-effect-classifier.js';
import { sensitivityFloorAsks } from '../sensitivity-floor.js';

const WS = '/app/workspace';

interface Row {
  name: string;
  command: string;
  /** The live terminal cwd the gate threads; defaults to the workspace root. */
  shellCwd?: string;
  before: SideEffectFamily;
  after: SideEffectFamily;
}

const ADARSH =
  'cd /app/workspace/scratch/vestra-video && sed -i "s/\\[1100, P, 0.4\\], //" src/Main.tsx && nproc && ' +
  '(npx remotion render src/index.ts Vestra out/vestra.mp4 --browser-executable=$CHROME_PATH --codec=h264 ' +
  '--crf=16 --concurrency=$(nproc) --log=error > render.log 2>&1; echo EXIT $? >> render.log)';

const RENDER_BODY = 'npx remotion render src/index.ts V out.mp4 > r.log 2>&1; echo EXIT $? >> r.log';

/** A line continuation: backslash-newline, which bash removes before it reads a word. */
const CONT = '\\\n';

/** Not deletes. Every one of these asked "Delete files" on origin/staging (or is marked). */
const FALSE_POSITIVES: Row[] = [
  { name: 'F1 exit status in a subshell', command: `(${RENDER_BODY})`, before: 'dangerous_delete', after: 'workspace_write' },
  {
    name: 'F1 status=$? after a redirect',
    command: `python x.py > out.json 2> err.log; status=$?; printf 'status=%s\\n' "$status"`,
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
  { name: 'F1 status=$? on its own line', command: 'pip install foo >/tmp/log 2>&1\nstatus=$?', before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'F2 ${HOME} in a subshell', command: '(echo ${HOME})', before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'F2 $* in a subshell', command: '(echo $*)', before: 'dangerous_delete', after: 'workspace_write' },
  {
    name: 'F3 brace range inside a substitution',
    command: "APP_KEY=$(printf '11%.0s' {1..32}) node server.js",
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
  {
    name: 'F3 nested substitution (as written)',
    command: 'ffmpeg -y $(for f in $(cat list.txt); do echo -i $f; done) -filter_complex "…" out.mp4',
    before: 'workspace_write',
    after: 'workspace_write',
  },
  {
    name: 'F3 nested substitution over a glob',
    command: 'ffmpeg -y $(for f in frames/*.png; do echo -i $f; done) -filter_complex "…" out.mp4',
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
  {
    name: 'F3 CHROME=$(command -v …) (as written)',
    command: 'CHROME=$(command -v google-chrome-stable)\n"$CHROME" --headless=new --print-to-pdf=out.pdf file.html',
    before: 'workspace_write',
    after: 'workspace_write',
  },
  {
    name: 'F3 CHROME=$(command -v …) then echo exit=$?',
    command:
      'CHROME=$(command -v google-chrome-stable)\n"$CHROME" --headless=new --print-to-pdf=out.pdf file.html\necho exit=$?',
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
  {
    name: 'F4 pkill -f then a subshell (as written)',
    command: 'pkill -f chrome-headless 2>/dev/null; cd /app/workspace/scratch/v && (npx remotion render …)',
    before: 'workspace_write',
    after: 'workspace_write',
  },
  {
    name: 'F4 pkill -f then a render subshell',
    command: `pkill -f chrome-headless 2>/dev/null; cd /app/workspace/scratch/v && (${RENDER_BODY})`,
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
  { name: 'F4 --force on a $VAR tool', command: '"$WMR" video "$SRC" --force -o out.mp4', before: 'dangerous_delete', after: 'workspace_write' },
  { name: "F5 Adarsh's render", command: ADARSH, before: 'dangerous_delete', after: 'workspace_write' },
  // The vehicle the older glob tests used: a read made unparseable by `"$(pwd)"`.
  { name: 'a glob read beside a substitution', command: 'ls *.md "$(pwd)"', before: 'dangerous_delete', after: 'workspace_write' },
  // A read in a group is still never `readonly`, as while it was unparseable.
  { name: 'a pure read in a group', command: '(ls; cat notes.md)', before: 'workspace_write', after: 'workspace_write' },
  // Reading through `timeout` and `eval` must not start asking on ordinary work.
  { name: 'timeout around a render', command: 'timeout 5 npx remotion render a b', before: 'workspace_write', after: 'workspace_write' },
  { name: 'timeout around a test run', command: 'timeout 30 npm test', before: 'workspace_write', after: 'workspace_write' },
  { name: 'eval of ssh-agent output', command: 'eval "$(ssh-agent -s)"', before: 'workspace_write', after: 'workspace_write' },
  { name: 'eval of an echo', command: 'eval "echo hi"', before: 'workspace_write', after: 'workspace_write' },

  // Agents split long commands with `\` continuations all the time. Reading them
  // the way bash does must not start asking on any of these.
  {
    name: 'continued curl GET on our API',
    command: `curl -sS ${CONT}  -H "Authorization: Bearer $VESTRA_API_TOKEN" ${CONT}  "$VESTRA_SERVER_URL/api/tasks"`,
    before: 'workspace_write',
    after: 'workspace_write',
  },
  {
    name: 'continued curl POST with a JSON body',
    command: `curl -sS -X POST ${CONT}  -H "Content-Type: application/json" ${CONT}  -d '{"title":"x"}' ${CONT}  "$VESTRA_SERVER_URL/api/tasks"`,
    before: 'workspace_write',
    after: 'workspace_write',
  },
  { name: 'continued ffmpeg encode', command: `ffmpeg -y -i in.mp4 ${CONT}  -c:v libx264 -crf 18 ${CONT}  out.mp4`, before: 'workspace_write', after: 'workspace_write' },
  { name: 'continued docker run', command: `docker run ${CONT}  --rm -v "$PWD":/w ${CONT}  node:20 npm test`, before: 'workspace_write', after: 'workspace_write' },
  {
    name: 'continued remotion render',
    command: `npx remotion render src/index.ts Vestra out/vestra.mp4 ${CONT}  --codec=h264 ${CONT}  --concurrency=$(nproc) > render.log 2>&1`,
    before: 'workspace_write',
    after: 'workspace_write',
  },
  { name: 'continued python script', command: `python3 scripts/make.py ${CONT}  --input data.csv ${CONT}  --out report.pdf`, before: 'workspace_write', after: 'workspace_write' },
  { name: 'cd, then a continued build', command: `cd /app/workspace/scratch && ${CONT}  npm run build`, before: 'workspace_write', after: 'workspace_write' },
  { name: 'continued pipe into jq', command: `curl -sS "$VESTRA_SERVER_URL/api/tasks" | ${CONT}  jq -r ".[].id"`, before: 'workspace_write', after: 'workspace_write' },
  { name: 'continued find', command: `find . -name "*.log" ${CONT}  -mtime +7 -print`, before: 'readonly', after: 'readonly' },
  { name: 'continued sh -c body', command: `sh -c 'npm ci && ${CONT}  npm test'`, before: 'workspace_write', after: 'workspace_write' },
  // A plain in-workspace delete stays silent when it is continued or quoted.
  { name: 'continued plain workspace delete', command: `rm -f scratch/a.png ${CONT}  scratch/b.png`, before: 'workspace_write', after: 'workspace_write' },
  { name: 'double-quoted workspace target', command: 'rm "scratch/my file.txt"', before: 'workspace_write', after: 'workspace_write' },
  { name: 'single-quoted workspace target', command: "rm -f 'scratch/a b.png'", before: 'workspace_write', after: 'workspace_write' },
  { name: 'quoted cd into the workspace, then a delete', command: 'cd "/app/workspace/my dir" && rm notes.txt', before: 'workspace_write', after: 'workspace_write' },
  { name: 'eval of a single-quoted echo', command: "eval 'echo hi'", before: 'workspace_write', after: 'workspace_write' },
  // The fallback now also reads the positions it has: none of these delete.
  { name: 'a move beside a bare assignment', command: 'X=1; mv a.txt b.txt 2>/dev/null', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a find beside a bare assignment', command: 'X=1; find . -name "*.log" -print', before: 'workspace_write', after: 'workspace_write' },
  // `[[` is a keyword, not a glob verb; a glob-named script without a recursive flag stays silent.
  { name: 'a [[ test beside a glob, in a group', command: '( [[ -f x ]] && ls *.md )', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a glob-named script', command: './build-*.sh --force', before: 'workspace_write', after: 'workspace_write' },
  // Parameters and brace lists in ARGUMENTS are ordinary work: only a command word
  // that splits apart fails closed.
  { name: 'a brace list in a copy', command: 'cp notes.md{,.bak}', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a brace list in a mkdir', command: 'mkdir -p src/{a,b}', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a ${VAR} argument', command: 'cat "${OUT_DIR}/report.txt"', before: 'readonly', after: 'readonly' },
  { name: 'a ${VAR} interpreter path', command: '"${VENV}/bin/python" run.py --out "${OUT_DIR}"', before: 'workspace_write', after: 'workspace_write' },
  { name: 'eval of an ANSI-C echo', command: "eval $'echo\\x20hi'", before: 'workspace_write', after: 'workspace_write' },
  { name: 'a quoted ${VAR} interpreter beside a glob, in a group', command: '( "${VENV}/bin/python" run.py; ls "${OUT_DIR}"/*.png )', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a $HOME tool', command: '$HOME/bin/tool --verbose report.md', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a $HOME tool beside a glob, in a group', command: '( $HOME/bin/tool --verbose report.md; ls dist/*.whl )', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a defaulted interpreter', command: '${PYTHON:-python3} scripts/make.py --out r.pdf', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a quoted venv pip', command: '"$VIRTUAL_ENV/bin/pip" install -r requirements.txt', before: 'workspace_write', after: 'workspace_write' },
  { name: 'a quoted venv pip beside a glob, in a group', command: '( "$VIRTUAL_ENV/bin/pip" install -r requirements.txt && ls dist/*.whl )', before: 'workspace_write', after: 'workspace_write' },
  { name: 'an ANSI-C argument inside a substitution', command: "echo \"$(printf $'%s\\n' a b)\"", before: 'workspace_write', after: 'workspace_write' },
];

/** Real deletes and obfuscations. Every one must stay dangerous_delete. */
const TRUE_POSITIVES: Row[] = [
  { name: 'T1 recursive workspace delete', command: 'rm -rf node_modules scratch build.log', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T1 rm -rf source', command: 'rm -rf source', before: 'dangerous_delete', after: 'dangerous_delete' },
  {
    name: 'T2 cd, rm -rf, cp -r',
    command: 'cd /app/workspace/files && rm -rf proj-v2 && cp -r proj/source proj-v2',
    before: 'dangerous_delete',
    after: 'dangerous_delete',
  },
  {
    name: 'T3 curl -X DELETE on our API',
    command: 'curl -sS -X DELETE -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/tasks"',
    before: 'dangerous_delete',
    after: 'dangerous_delete',
  },
  {
    name: 'T3 method from a loop variable',
    command: 'for m in DELETE; do curl -X $m -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/tasks"; done',
    before: 'dangerous_delete',
    after: 'dangerous_delete',
  },
  { name: 'T4 rm -rf inside a subshell', command: '(cd /tmp && rm -rf x)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 rm -rf inside $( )', command: 'echo $(rm -rf ~)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 rm -rf inside backticks', command: 'echo `rm -rf ~`', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 target from an assignment', command: 'X=$(ls); rm $X', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 target from a substitution', command: 'rm -f $(cat list.txt)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 rm in a for loop', command: 'for f in *.log; do rm "$f"; done', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T4 rm -rf * in a subshell', command: '(rm -rf *)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'T5 verb from a variable', command: 'R=rm; $R -rf ~', before: 'dangerous_delete', after: 'dangerous_delete' },

  // Added: the shapes the new reading could have opened, each proved closed.
  { name: 'verb produced by a substitution', command: '$(echo rm) -f ~/notes.txt', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'fragmented verb, -rf', command: '$(printf r)$(printf m) -rf /', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'fragmented verb, glob target', command: '$(printf r)$(printf m) *', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'eval of a substitution', command: 'eval "$(echo rm -rf ~)"', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'find -exec of a substitution', command: 'find . -exec $(echo rm) {} +', before: 'dangerous_delete', after: 'dangerous_delete' },
  {
    name: 'assignment with a spaced substitution, then a $VAR verb',
    command: 'X=$(date +%s) $R -rf ~',
    before: 'dangerous_delete',
    after: 'dangerous_delete',
  },
  { name: 'case inside a substitution', command: 'echo $(case x in a) rm -rf / ;; esac)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'arithmetic around a substitution', command: 'echo $(( 1 + $(rm -rf ~) ))', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'comment inside a substitution', command: 'echo $(echo hi # )\nrm -rf ~\n)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'method from a substitution', command: 'curl -X $(echo DELETE) "$VESTRA_SERVER_URL/api/tasks"', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'client from a substitution', command: '$(echo curl) -X DELETE https://x.test/api/a', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'plain rm inside $( )', command: 'echo $(rm scratch.txt)', before: 'dangerous_delete', after: 'dangerous_delete' },
  {
    name: 'a subshell cd does not excuse a later relative delete',
    command: '(cd /app/workspace/a); rm notes.txt',
    shellCwd: '/etc',
    before: 'dangerous_delete',
    after: 'dangerous_delete',
  },
  { name: 'cd out inside a subshell', command: '(cd /etc && rm hosts)', before: 'dangerous_delete', after: 'dangerous_delete' },
  // A group around code the analyzer cannot read keeps the old flag and glob tells.
  { name: '$VAR verb with a glob, in a group', command: '($R *)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'eval of a $VAR verb, in a group', command: '(eval "$X -rf ~")', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a $VAR verb piped into sh, in a group', command: '(echo "$X -rf ~" | sh)', before: 'dangerous_delete', after: 'dangerous_delete' },

  // Tighter than before: holes on origin/staging the same reading closes.
  { name: 'find -delete in a group', command: '(cd /app/workspace && find . -name "*.tmp" -delete)', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'move onto /dev/null in a group', command: '(mv notes.md /dev/null)', before: 'workspace_write', after: 'dangerous_delete' },
  {
    name: 'a case arm inside process substitution',
    command: 'cat <(case x in a) rm -rf ~/notes ;; esac)',
    before: 'workspace_write',
    after: 'dangerous_delete',
  },
  {
    name: 'an sh -c cd does not excuse a later relative delete',
    command: "sh -c 'cd /app/workspace/a'; rm notes.txt",
    shellCwd: '/etc',
    before: 'workspace_write',
    after: 'dangerous_delete',
  },
  {
    name: 'a process-substitution cd does not excuse a later relative delete',
    command: 'cat <(cd /app/workspace/a); rm notes.txt',
    shellCwd: '/etc',
    before: 'workspace_write',
    after: 'dangerous_delete',
  },

  // Review of #3863 (2026-09-25): bash runs `\rm` and `r\m` as plain `rm`. The
  // nested forms asked on staging only because the whole command was unparseable;
  // reading the group dropped them. The top-level forms never asked at all.
  { name: 'escaped verb in a group', command: '( \\rm -rf ~ )', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'escaped verb over a glob, in a group', command: '( \\rm -rf scratch/* )', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'escaped verb, -fr, in a group', command: '( \\rm -fr ~ )', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'escaped rmdir over a glob, in a group', command: '( \\rmdir foo/* )', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'mid-word escape in a group', command: '( r\\m -rf ~ )', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'escaped verb inside $( )', command: 'echo $(\\rm -rf ~)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'escaped verb at the top level', command: '\\rm -rf ~', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped verb, -fr, at the top level', command: '\\rm -fr /app/workspace/files', before: 'workspace_write', after: 'dangerous_delete' },

  // `timeout [OPTION] DURATION COMMAND` always runs COMMAND.
  { name: 'timeout around rm -rf', command: 'timeout 5 rm -rf /app/workspace/files', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'timeout with a signal option', command: 'timeout -s KILL 10s rm -rf x', before: 'workspace_write', after: 'dangerous_delete' },

  // eval joins its words and runs them, like an `sh -c` body.
  { name: 'eval of a quoted delete', command: 'eval "rm -rf /app/workspace/files"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'eval of bare delete words', command: 'eval rm -rf x', before: 'workspace_write', after: 'dangerous_delete' },

  // Security re-review of #3863 (2026-09-25): bash removes quotes and line
  // continuations before it reads a word, and the floor read the raw text. Each of
  // these deleted without an ask on origin/staging @ bade6fe1c.
  // 1. Line continuations (backslash-newline, gone outside single quotes).
  { name: 'continuation inside the verb', command: `r${CONT}m -rf /etc`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation after the verb', command: `rm${CONT} -rf /etc`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation before the verb', command: `${CONT}rm -rf /etc`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in a double-quoted sh -c body', command: `sh -c "r${CONT}m -rf /etc"`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in a single-quoted sh -c body', command: `sh -c 'r${CONT}m -rf /etc'`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in a group', command: `(r${CONT}m -rf /etc)`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in $( )', command: `echo $(r${CONT}m -rf /etc)`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation after timeout', command: `timeout 5 r${CONT}m -rf /etc`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in an eval body', command: `eval 'r${CONT}m -rf /etc'`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation in backticks (already asked)', command: `echo \`r${CONT}m -rf /etc\``, before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'continuation inside a flag', command: `rm -r${CONT}f scratch`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'continuation inside a loop keyword', command: `for d in a b; d${CONT}o rm -rf "/etc/$d"; done`, before: 'workspace_write', after: 'dangerous_delete' },
  // A comment ends at the newline even after a backslash: the next line runs.
  { name: 'comment ending in a backslash', command: `# note ${CONT}rm -rf /etc`, before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'trailing comment ending in a backslash', command: `echo hi # note ${CONT}rm /etc/hosts`, before: 'readonly', after: 'dangerous_delete' },
  // 2. Backslashes in unquoted eval words (removed before eval reads them).
  { name: 'eval of escaped spaces', command: 'eval rm\\ -rf\\ /etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'eval of an escaped separator', command: 'eval echo\\;rm -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },
  // 3. Wrappers that run their argument as a command.
  { name: 'builtin eval', command: 'builtin eval "rm -rf /etc"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'builtin command', command: 'builtin command rm -rf x', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'exec', command: 'exec rm -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'nohup (already read)', command: 'nohup rm -rf /etc', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'command -p', command: 'command -p rm -rf /etc', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'command -p, plain outside target', command: 'command -p rm /etc/hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  // 4. Escapes and quotes in delete targets: the containment check saw another path.
  { name: 'escaped leading slash', command: 'rm \\/etc/hosts', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped dots', command: 'rm .\\./.\\./etc/hosts', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped dots in a cd', command: 'cd /app/workspace/.\\./.\\./etc; rm hosts', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quoted leading slash', command: 'rm -f "/"etc/hosts', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'single-quoted leading slash', command: "rm -f '/'etc/hosts", before: 'workspace_write', after: 'dangerous_delete' },
  // The same removal, applied to the other words the floor interprets.
  { name: 'quoted recursive flag', command: 'rm "-rf" scratch', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped recursive flag', command: 'rm -\\r\\f scratch', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quoted -c', command: 'sh "-c" "rm -rf /etc"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped -c', command: 'bash -\\c "rm -rf /etc"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quotes inside the eval head', command: 'e"va"l "rm -rf /etc"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped quotes in an sh -c body', command: 'sh -c "rm \\"/etc/hosts\\""', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped spaces in an sh -c body', command: 'sh -c rm\\ /etc/hosts', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quoted method flag', command: 'curl "-X" DELETE https://a.test/x', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped method', command: 'curl -X DELE\\TE https://a.test/x', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'escaped find -delete', command: 'find . -dele\\te', before: 'readonly', after: 'dangerous_delete' },
  { name: 'escaped /dev/null', command: 'mv notes.md /dev/nul\\l', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quoted flag on a $VAR verb', command: '"$R" "-rf" ~', before: 'workspace_write', after: 'dangerous_delete' },
  // ANSI-C quoting is quote removal too: `$'rm'` and `$'\x72m'` both run `rm`.
  { name: "ANSI-C quoted verb", command: "$'rm' /etc/hosts", before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'ANSI-C hex-escaped verb', command: "$'\\x72m' /etc/hosts", before: 'workspace_write', after: 'dangerous_delete' },
  // Found by the differential: the unparseable fallback's word scan has no
  // find/mv tell, and a bare assignment makes any command unparseable.
  { name: 'find -delete beside a bare assignment', command: 'X=1; find . -delete', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'move onto /dev/null beside a bare assignment', command: 'X=1; mv notes.md /dev/null', before: 'workspace_write', after: 'dangerous_delete' },
  // Also found by the differential: more words the floor read before quote removal.
  { name: 'quoted wrapper flag', command: 'find . -print0 | xargs "-0" rm -f', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'quoted flag after the /dev/null destination', command: 'mv notes.md /dev/null "-f"', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a flag made by an expansion', command: 'rm -$F scratch', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a quoted flag made by an expansion', command: 'rm "-$F" scratch', before: 'dangerous_delete', after: 'dangerous_delete' },
  // Bash runs `"\cd"` as a command named `\cd`: the cwd does not move, so `x` is /etc/x.
  { name: 'a cd bash does not run', command: '"\\cd" /app/workspace/a; rm x', shellCwd: '/etc', before: 'workspace_write', after: 'dangerous_delete' },
  // Behind a wrapper, cd is an external program and the shell's cwd stays put.
  { name: 'exec cd does not move the shell', command: 'exec cd /app/workspace/a; rm x', shellCwd: '/etc', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'sudo cd does not move the shell', command: 'sudo cd /app/workspace/a; rm x', shellCwd: '/etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'env cd does not move the shell', command: 'env cd /app/workspace/a; rm x', shellCwd: '/etc', before: 'workspace_write', after: 'dangerous_delete' },
  // A glob as the command word runs its first match, as unknowable as `$R`.
  { name: 'a glob verb', command: '/bin/r? -rf /', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a bare glob verb', command: '* -rf /', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a glob verb over a glob, in a group', command: '(? x *)', before: 'workspace_write', after: 'dangerous_delete' },
  // `$"…"` is translated through the locale's catalog: its value stays unknown.
  { name: 'a locale-quoted target', command: 'rm -f a.txt $"rm"', before: 'dangerous_delete', after: 'dangerous_delete' },

  // Security review of #3875: bash keeps an ANSI-C word as a C string, so a NUL
  // ends it (`$'rm\0zz'` runs `rm`). Decoded with the NUL kept, the verb read as
  // `rm\0` and lost its `$`; left undecoded it stays a `$`-head, as on staging.
  { name: 'NUL after an ANSI-C verb', command: "$'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'hex NUL after an ANSI-C verb', command: "$'rm\\x00' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL inside a hex-escaped verb', command: "$'\\x72m\\0zz' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb, --recursive', command: "$'rm\\0' --recursive /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb, -fr', command: "$'rm\\0' -fr /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb behind sudo', command: "sudo $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb behind nohup', command: "nohup $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb behind xargs', command: "xargs $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb behind timeout', command: "timeout 5 $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb behind command -p', command: "command -p $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb after a cd', command: "cd /app/workspace/a && $'rm\\0' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb into a pipe', command: "$'rm\\0' -rf /etc | cat", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL verb in a bash -c body', command: `bash -c "$'rm\\0' -rf /etc"`, before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'NUL after an ANSI-C method', command: "curl -X $'DELETE\\0' http://x", before: 'dangerous_delete', after: 'dangerous_delete' },

  // A flag fused into a command word bash splits apart: `${IFS}` expands to a
  // separator and `{a,b}` to one word per item, so each runs `rm -rf /etc`.
  { name: 'verb and flag joined by ${IFS}', command: 'rm${IFS}-rf${IFS}/etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'verb and flag joined by $IFS', command: 'rm$IFS-rf$IFS/etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'verb, flag and target in one brace list', command: '{rm,-rf,/etc}', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'verb and flag in a brace list', command: '{rm,-rf} /etc', before: 'workspace_write', after: 'dangerous_delete' },
  // An unquoted expansion in a command word is word-split, so it can add words.
  { name: 'an unquoted directory expansion as the verb', command: '$D/x -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },

  // An ANSI-C eval word has no expansion: it is read, not refused.
  { name: 'eval of an ANSI-C delete', command: "eval $'rm\\x20-rf\\x20/etc'", before: 'workspace_write', after: 'dangerous_delete' },

  // Scoped re-review of daf947d0e: bash keeps only the low byte of an octal
  // escape, so `\400` is a NUL (the NUL rule applies) and `\562\555` is `rm`.
  { name: 'octal NUL (\\400) after an ANSI-C verb', command: "$'rm\\400' -rf x", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'octal NUL inside a split verb', command: "$'r\\400'm -rf x", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'octal NUL verb behind sudo', command: "sudo $'rm\\400' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'octal NUL verb in eval', command: "eval $'rm\\400' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'wide octal escapes spelling rm', command: "$'\\562\\555' -rf /etc", before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'wide octal escapes spelling rm, in eval', command: "eval $'\\562\\555 -rf /etc'", before: 'dangerous_delete', after: 'dangerous_delete' },

  // A command word whose name comes from inside `${…}`: the part after its last
  // `/` is not a program name (`"${R:-/bin/rm}"` runs /bin/rm).
  { name: 'a default-value expansion as the verb', command: '"${R:-/bin/rm}" -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a substitution expansion as the verb', command: '"${P/x/}" -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a suffix-trim expansion as the verb', command: '"${P%/*}" -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'a prefix-trim expansion as the verb', command: '"${P#*/}" -rf /etc', before: 'workspace_write', after: 'dangerous_delete' },

  // An ANSI-C word inside a group or a substitution no longer makes the body unreadable.
  { name: 'eval of an ANSI-C delete, in a group', command: "(eval $'rm\\x20-rf\\x20x')", before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'eval of an ANSI-C delete, in a substitution', command: "x=$(eval $'rm\\x20-rf\\x20x')", before: 'workspace_write', after: 'dangerous_delete' },
  { name: 'cd, then eval of an ANSI-C delete, in a group', command: "(cd /tmp && eval $'rm\\x20-rf\\x20/etc')", before: 'workspace_write', after: 'dangerous_delete' },
];

/**
 * Narrowed ON PURPOSE, pinned so a change here is deliberate. Each was asking
 * for a reason the brief removes, and each top-level twin already ran silently.
 *   - `$R --force ~`: a lone `--force` stopped being the `$`-head tell (see
 *     HIDDEN_VERB_RECURSION_FLAG); `$R -f ~` and `$R ~` never asked.
 *   - `($*)`: the `*` of `$*` is a parameter name, not a glob; `$@` and `$1`
 *     never read as one.
 */
const NARROWED: Row[] = [
  { name: 'a lone --force on a $VAR head', command: '$R --force ~', before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'the positional parameters as a command', command: '($*)', before: 'dangerous_delete', after: 'workspace_write' },
];

const family = (row: Row): SideEffectFamily =>
  classifySideEffect({ toolName: 'Bash', toolInput: { command: row.command }, toolCallId: 't' } as ToolCall, {
    workspaceRoot: WS,
    shellCwd: row.shellCwd ?? WS,
  });

const floors = (row: Row): boolean =>
  sensitivityFloorAsks({ toolName: 'Bash', toolInput: { command: row.command }, toolCallId: 't' } as ToolCall, {
    workspaceRoot: WS,
    shellCwd: row.shellCwd ?? WS,
  });

describe('the delete floor stays off commands that delete nothing', () => {
  for (const row of FALSE_POSITIVES) {
    it(`${row.name}: ${row.before} -> ${row.after}`, () => {
      expect(family(row)).toBe(row.after);
      expect(floors(row)).toBe(false);
    });
  }
});

describe('the delete floor still asks for every real delete', () => {
  for (const row of TRUE_POSITIVES) {
    it(`${row.name}: stays ${row.after}`, () => {
      expect(family(row)).toBe(row.after);
      expect(floors(row)).toBe(true);
    });
  }
});

describe('narrowed on purpose', () => {
  for (const row of NARROWED) {
    it(`${row.name}: ${row.before} -> ${row.after}`, () => {
      expect(family(row)).toBe(row.after);
      expect(floors(row)).toBe(false);
    });
  }
});
