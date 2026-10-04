/**
 * A COMMAND WORD FROM A LITERAL, AND ENV'S OWN OPTIONS, ARE READ.
 *
 * #bugs 2026-09-28 (Adarsh, prod task 28edef30), the second false card of the day, on a
 * font download:
 *   NP="env -u HTTPS_PROXY …"; $NP curl -sSL -o Inter.ttf …; ls -la *.ttf
 * Two separate refusals sent it to the fallback, where `*.ttf` read as a hidden delete:
 *   - `env -u NAME`: the analyzer took any flag after a wrapper as unreadable, so even
 *     the spelled-out `env -u HTTPS_PROXY curl …; ls *.ttf` asked.
 *   - `$NP` as the command word: a variable head fails closed after a bare assignment
 *     (#3933), although NP was assigned a plain literal in the same command.
 * Now `env`'s option set is read (`-i`, `-`, `-0`, `-u NAME`, `--unset[=]NAME`, `--`),
 * with `-S` (splits a string into the command) and `-C` (moves the cwd) still refused,
 * and a command word that is exactly `$NAME` / `${NAME}` / `"$NAME"` runs the value of a
 * single literal assignment made in the same scope. Anything else stays unresolvable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { classifySideEffect } from '../side-effect-classifier.js';
import { sensitivityFloorAsks } from '../sensitivity-floor.js';
import { analyzeCommand } from '../command-analyzer.js';
import { decideToolGate } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

const WS = '/app/workspace';
const call = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' }) as ToolCall;
const floors = (command: string) => sensitivityFloorAsks(call(command), { workspaceRoot: WS, shellCwd: WS });
const family = (command: string) => classifySideEffect(call(command), { workspaceRoot: WS, shellCwd: WS });

// The command behind the prod card, verbatim.
const PROD_CARD =
  'cd /app/workspace/scratch/reel/assets && NP="env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy"; ' +
  '$NP curl -sSL -o Inter.ttf -w "%{http_code} " "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf"; ' +
  '$NP curl -sSL -o NewsreaderItalic.ttf -w "%{http_code} " "https://github.com/google/fonts/raw/main/ofl/newsreader/Newsreader-Italic%5Bopsz,wght%5D.ttf"; ' +
  '$NP curl -sSL -o Mono.ttf -w "%{http_code}\\n" "https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf"; ls -la *.ttf';

/** Not deletes. Every one asked "Delete files" on origin/staging @ d87c21363. */
const OFF_THE_FLOOR = [
  { name: 'prod card (28edef30, 10:25 UTC)', command: PROD_CARD },
  { name: 'env -u spelled out', command: 'env -u HTTPS_PROXY curl -sSL -o a.ttf https://x; ls *.ttf' },
  { name: 'every env option it reads', command: 'env -i -u X --unset=Y -uZ -0 -- curl -o a https://x; ls *.png' },
  { name: 'an interpreter in a variable', command: 'PY=python3; $PY make.py; ls out/*' },
  { name: 'a command with flags in a variable', command: 'NODE="node --max-old-space-size=4096"; $NODE build.js; ls dist/*' },
];

/** Real, hidden and resolution-changing deletes. Every one still asks. */
const STILL_ASKS = [
  { name: 'the verb from a literal', command: 'R=rm; $R /etc/hosts' },
  { name: 'the verb, quoted', command: 'R=rm; "$R" a.txt out/*' },
  { name: 'the verb, braced', command: 'R=rm; ${R} -rf out/*' },
  { name: 'the verb and its flags from a literal', command: 'R="rm -rf"; $R out' },
  { name: 'a path to the verb', command: 'R=/bin/rm; $R /etc/hosts' },
  { name: 'the verb behind sudo', command: 'R=rm; sudo $R /etc/hosts' },
  { name: 'the verb behind timeout', command: 'R=rm; timeout 5 $R -rf out' },
  { name: 'cd from a literal, then a delete', command: 'R=cd; $R /etc; r""m hosts' },
  { name: 'pushd from a literal, then a delete', command: 'R=pushd; $R /etc; r""m hosts' },
  { name: 'built from another expansion, in a path prefix', command: 'a=r; D="${a}m -rf /etc #"; $D/x' },
  { name: 'assigned twice', command: 'R=rm; R=ls; $R /etc/hosts' },
  { name: 'assigned in another body', command: 'R=ls; ( R=rm; $R /etc/hosts )' },
  { name: 'set for env, not for this shell', command: 'env R=rm; $R /etc/hosts' },
  { name: 'env -S runs a string', command: 'env -S "rm -rf /etc"' },
  { name: 'env -C moves the cwd', command: 'env -C /etc rm hosts' },
  { name: 'env -u then a real delete', command: 'env -u X rm -rf /etc' },
  { name: 'a method word-split from a value', command: 'M="-X DELETE"; curl $M "$U/f/1"' },
  { name: 'the verb fed to find -exec', command: 'v=rm; find s -exec $v {} \\;' },
  { name: 'the delete piped into a shell', command: 'c="rm -rf out"; echo "$c" | sh' },
  { name: 'the assignment itself runs rm', command: 'x=$(rm -rf ~)' },
];

describe('literal command words and env options: the floor asks only for real deletes', () => {
  for (const r of OFF_THE_FLOOR) {
    it(`off the floor: ${r.name}`, () => {
      expect(floors(r.command)).toBe(false);
      expect(family(r.command)).not.toBe('dangerous_delete');
    });
  }
  for (const r of STILL_ASKS) {
    it(`still asks: ${r.name}`, () => {
      expect(floors(r.command)).toBe(true);
      expect(family(r.command)).toBe('dangerous_delete');
    });
  }
});

describe('the analyzer reads what runs', () => {
  const heads = (c: string) => analyzeCommand(c).commands.map((n) => n.head);
  it('env options resolve to the command they run', () => {
    expect(heads('env -u HTTPS_PROXY curl -o a https://x')).toEqual(['curl']);
    expect(heads('env -i -u X --unset=Y -uZ -0 -- curl -o a https://x')).toEqual(['curl']);
    expect(heads('env --unset Y rm x')).toEqual(['rm']);
  });
  it('env options that change what or where runs still fail closed', () => {
    for (const c of ['env -S "rm -rf /etc"', 'env -C /etc rm hosts', 'env --split-string="rm x"', 'env -v rm x', 'env -u', 'env --unset']) {
      expect(analyzeCommand(c).parsedSafely).toBe(false);
    }
  });
  it('a literal command word is replaced by its words', () => {
    expect(heads('NP="env -u HTTPS_PROXY"; $NP curl -o a https://x')).toEqual(['curl']);
    expect(heads('R=rm; "$R" a.txt')).toEqual(['rm']);
    expect(analyzeCommand('R=rm; $R /etc/hosts').parsedSafely).toBe(true);
  });
  it('anything that is not one literal in this scope stays unresolvable', () => {
    for (const c of [
      'R=rm; R=ls; $R x',                // assigned twice
      'R=ls; ( R=rm; $R x )',            // another body
      'env R=ls; $R x',                  // env's variable, not the shell's
      'a=r; R="${a}m"; $R x',            // built from an expansion
      'R="rm -rf /etc #"; $R/x',         // a path prefix, not the whole word
      'R="r m"; "$R" x',                 // quoted words with a space name no program
      'R="*"; $R x',                     // a glob in the value
    ]) {
      expect(analyzeCommand(c).parsedSafely).toBe(false);
    }
  });
});

// Every vouching consumer keeps today's answer: a command carrying a bare assignment is
// still unvouched (#3933), so an Always-allow rule does not start covering it.
describe('Always-allow does not widen', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });
  const ctx: ToolGateContext = {
    mode: 'default',
    cwd: WS,
    accessLevel: 'careful',
    permissionRules: { allow: [{ toolName: 'Bash', ruleContent: 'curl:*' }], ask: [], deny: [] },
  };
  it('a curl rule covers `env -u X curl …` but not the variable form', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(decideToolGate(call('curl -o a https://x'), ctx).decision).toBe('allow'); // control
    expect(decideToolGate(call('NP="env -u X"; $NP curl -o a https://x'), ctx).decision).not.toBe('allow');
  });
});

// KNOWN RESIDUE, pinned so a change to it is a decision: a value that only reaches a
// child's environment and is executed there by an interpreter body. Silent on staging
// for the plain form; the env-prefixed form asked there only because `env -u` was
// unreadable. Deliberate obfuscation only; see the floor's residue comment.
describe('known residue (same as the plain form on staging)', () => {
  it('a prefix-assigned command run by sh -c stays silent, with or without env options', () => {
    expect(floors(`CMD="rm -rf /etc" sh -c '$CMD'`)).toBe(false);
    expect(floors(`CMD="rm -rf /etc" env -u X sh -c '$CMD'`)).toBe(false);
  });
});
