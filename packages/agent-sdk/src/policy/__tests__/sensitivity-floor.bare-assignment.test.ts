/**
 * A BARE ASSIGNMENT IS NOT A HIDDEN DELETE.
 *
 * #bugs 2026-09-28 (Adarsh, prod task 28edef30): two "Delete files. This cannot be
 * undone." cards over a loop that downloaded four images and listed them. Neither
 * command deletes anything. He re-sent his ask instead of answering the first card,
 * and the late approval of that stale card is what bricked the task (the projection
 * half is fixed separately).
 *
 * Cause (measured on origin/staging @ d6bf84480): the analyzer failed closed on ANY
 * bare assignment (`x=1`, `id=$(…)`, `status=$?`), a rule from before it could read
 * substitutions. The whole command then fell to the unparseable fallback, where one
 * harmless glob anywhere (`file scratch/reel/assets/*`) floored it as a delete.
 *
 * Now a bare assignment parses and is reported as `assigns`, which every consumer
 * treats exactly like `nested` (#3863): the delete floor keeps the old verdict when a
 * delete is named anywhere or unread code runs (an assigned value is text a later
 * position can run), the classifier never says readonly, and Always-allow rules and
 * plan mode never vouch. An assignment to a variable that changes how later words
 * resolve (PATH, IFS, CDPATH, HOME, OLDPWD, …) still fails closed.
 *
 * `before` is what origin/staging returned, measured, not assumed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { classifySideEffect, type SideEffectFamily } from '../side-effect-classifier.js';
import { sensitivityFloorAsks } from '../sensitivity-floor.js';
import { analyzeCommand } from '../command-analyzer.js';
import { isWriteTool } from '../write-tool-taxonomy.js';
import { decideToolGate } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

const WS = '/app/workspace';

interface Row {
  name: string;
  command: string;
  before: SideEffectFamily;
  after: SideEffectFamily;
}

// The two commands behind the prod cards, verbatim.
const CARD_1 =
  'cd /app/workspace && mkdir -p scratch/reel/assets && for i in 1 2 3 4; do cat files/image-$i.png.ref.yaml; ' +
  "id=$(grep -m1 file_id files/image-$i.png.ref.yaml | awk '{print $2}' | tr -d '\\\"'); " +
  'curl -fsSL -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/box/files/$id" -o scratch/reel/assets/shot$i.png; ' +
  'done; file scratch/reel/assets/*; which ffmpeg; ffmpeg -version | head -1; fc-list | grep -iE "inter|serif|playfair|fraunces" | head';
const CARD_2 =
  'cd /app/workspace && mkdir -p scratch/reel/assets && for i in 1 2 3 4; do ' +
  "id=$(grep -m1 file_id files/image-$i.png.ref.yaml | awk '{print $2}' | tr -d '\\\"'); " +
  'curl -fsSL -H "Authorization: Bearer $VESTRA_API_TOKEN" "$VESTRA_SERVER_URL/api/box/files/$id" -o scratch/reel/assets/shot$i.png; ' +
  'done; file scratch/reel/assets/*; ffmpeg -version | head -1; fc-list : family | sort -u | head -40; ' +
  'node -e "require(\'playwright\')" 2>&1 | head -2; npm ls -g 2>/dev/null | head';

/** Not deletes. Every one asked "Delete files" on origin/staging. */
const FALSE_POSITIVES: Row[] = [
  { name: 'prod card 1 (28edef30)', command: CARD_1, before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'prod card 2 (28edef30)', command: CARD_2, before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'id from a substitution, then a glob', command: 'id=$(cat f.yaml); file out/*', before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'a plain assignment, then a glob', command: 'x=1; ls *.log', before: 'dangerous_delete', after: 'workspace_write' },
  { name: 'status=$?, then a glob', command: 'make build; status=$?; ls out/*.o', before: 'dangerous_delete', after: 'workspace_write' },
  {
    name: 'an output dir variable, then a copy glob',
    command: 'OUT=/app/workspace/out; mkdir -p "$OUT" && cp shots/*.png "$OUT"/',
    before: 'dangerous_delete',
    after: 'workspace_write',
  },
];

/** Real deletes, hidden deletes and resolution tricks. Every one still asks. */
const HELD: Row[] = [
  { name: 'the assignment itself runs rm', command: 'x=$(rm -rf ~)', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'backtick twin', command: 'x=`rm -rf ~`', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the verb in a variable head', command: 'R=rm; $R -rf out/*', before: 'dangerous_delete', after: 'dangerous_delete' },
  // Found by the differential: a variable head with no -rf bundle is silent on the parsed
  // path (#3863, the Remotion `"$WMR" … --force` ruling), so an assignment that feeds a
  // head keeps the command unparseable and the fallback reads the `rm` in it.
  { name: 'the verb in a variable head, no flags', command: 'R=rm; $R /etc/hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the verb in a quoted variable head', command: 'R=rm; "$R" a.txt out/*', before: 'dangerous_delete', after: 'dangerous_delete' },
  // Found by review: the value reaches an ARGUMENT, not the head. Staging's word scan read
  // the delete in the value; nestedKeepsOldVerdict keeps doing so.
  { name: 'a method word-split out of a value', command: 'M="-X DELETE"; curl $M "$U/f/1"', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the verb fed to find -exec', command: 'v=rm; find scratch -type f -exec $v {} \\;', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the delete piped into a shell', command: 'c="rm -rf out"; echo "$c" | sh', before: 'dangerous_delete', after: 'dangerous_delete' },
  // Found by the re-review: a variable head the floor reads only on the RAW word.
  { name: 'the verb hidden in a path prefix', command: 'a=r; D="${a}m -rf /etc #"; $D/x', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a variable standing in for cd', command: 'R=cd; $R /etc; r""m hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the cooperative method variable (T3)', command: 'm=DELETE; curl -X $m "$VESTRA_SERVER_URL/api/tasks/1"', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'the target in a variable', command: 'D=/etc; rm -rf $D', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a real recursive delete after it', command: 'x=1; rm -rf out/*', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a real glob delete after it (the third prod card)', command: 'x=1; rm files/_music*_check.mp3', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a delete outside the workspace after it', command: 'x=1; rm /etc/hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'a relative cd out, then a delete', command: 'x=1; cd ../../etc && rm hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'PATH changes what later heads run', command: 'PATH=/tmp/x:$PATH; ls out/*', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'IFS changes how later words split', command: 'IFS=/; ls out/*', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'HOME moves ~', command: 'HOME=/etc; rm ~/hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'HOME moves a bare cd', command: 'HOME=/etc; cd; rm hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'CDPATH moves a relative cd', command: 'CDPATH=/; cd etc && rm hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
  { name: 'OLDPWD moves cd -', command: 'OLDPWD=/etc; cd - && rm hosts', before: 'dangerous_delete', after: 'dangerous_delete' },
];

const call = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' }) as ToolCall;
const floors = (command: string) => sensitivityFloorAsks(call(command), { workspaceRoot: WS, shellCwd: WS });

describe('bare assignments: the delete floor asks only for real deletes', () => {
  for (const r of FALSE_POSITIVES) {
    it(`off the floor: ${r.name}`, () => {
      expect(r.before).toBe('dangerous_delete');
      expect(classifySideEffect(call(r.command), { workspaceRoot: WS, shellCwd: WS })).toBe(r.after);
      expect(floors(r.command)).toBe(false);
    });
  }
  for (const r of HELD) {
    it(`still asks: ${r.name}`, () => {
      expect(classifySideEffect(call(r.command), { workspaceRoot: WS, shellCwd: WS })).toBe(r.after);
      expect(floors(r.command)).toBe(true);
    });
  }
});

describe('the analyzer reports a bare assignment instead of refusing the command', () => {
  it('parses, and flags `assigns`', () => {
    expect(analyzeCommand('id=$(cat f); file out/*')).toMatchObject({ parsedSafely: true, assigns: true });
  });
  it('a prefix assignment is not a bare one', () => {
    expect(analyzeCommand('X=1 node a.js')).toMatchObject({ parsedSafely: true, assigns: false });
  });
  it('an assignment feeding a variable head still fails closed, in a group too', () => {
    for (const c of ['R=rm; (cd x && "$R" y)', 'a=r; D="${a}m -rf /etc #"; $D/x']) {
      expect(analyzeCommand(c).parsedSafely).toBe(false);
      expect(floors(c)).toBe(true);
    }
    // A single literal in the same scope is read since 2026-09-28 (literal-var-head test):
    // `$R` runs `rm`, judged as the delete it is.
    expect(analyzeCommand('R=rm; $R /etc/hosts').commands.map((n) => n.head)).toEqual(['rm']);
    expect(floors('R=rm; $R /etc/hosts')).toBe(true);
  });
  it('a resolution variable still fails closed', () => {
    for (const v of ['PATH', 'IFS', 'CDPATH', 'HOME', 'OLDPWD', 'PWD', 'BASH_ENV', 'ENV', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS']) {
      expect(analyzeCommand(`${v}=x; ls`).parsedSafely).toBe(false);
    }
  });
});

// Every consumer that VOUCHES for a command keeps today's answer: the assignment can
// rewrite a variable the shell already exports, which the next program reads.
describe('bare assignments never widen Always-allow or plan mode', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  const allowNpmTest: ToolGateContext = {
    mode: 'default',
    cwd: WS,
    accessLevel: 'careful',
    permissionRules: { allow: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], ask: [], deny: [] },
  };
  const decide = (command: string) => decideToolGate(call(command), allowNpmTest).decision;

  it('an npm test rule does not cover a command that reassigns a variable first', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(decide('npm test')).toBe('allow'); // control
    expect(decide('NODE_OPTIONS=--require=/tmp/e.js; npm test')).not.toBe('allow');
    expect(decide('x=1; npm test')).not.toBe('allow');
    expect(decide('PATH=/tmp/x:$PATH; npm test')).not.toBe('allow');
  });

  it('plan mode still counts a command with a bare assignment as a write', () => {
    expect(isWriteTool(call('x=1; ls'))).toBe(true);
  });
});
