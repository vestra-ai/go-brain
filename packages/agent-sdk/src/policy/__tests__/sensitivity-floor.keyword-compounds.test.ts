/**
 * A delete does not stop being a delete because a loop wraps it.
 *
 * Found while pinning the founder's 2026-08-10 over-ask: the analyzer skipped
 * wrapper heads (sudo/env/xargs) and assignment prefixes when resolving a
 * command position, but not SHELL KEYWORD prefixes. So the segment `do rm -rf x`
 * resolved to head `do`, with the real command sitting unexamined in its argv —
 * and a position the floor cannot see is a position the floor cannot gate.
 *
 * Measured end-to-end through decideToolGate on the code before this change,
 * mode bypassPermissions, cwd /app/workspace:
 *
 *     rm -rf /etc/hosts                                 -> deny (security)
 *     for d in a b; do rm -rf "/etc/$d"; done           -> ALLOW, silently
 *     for id in 1 2; do curl -X DELETE "$URL/$id"; done -> ALLOW, silently
 *     curl -X DELETE "$URL/1"                           -> needs_human
 *
 * The bare forms were gated and the looped forms were not, which made the loop a
 * general-purpose bypass for the founder-locked "deletions always ask" rule.
 *
 * This is the SAME defect that captioned his read-only probe loops "Run for":
 * the describer and the guard both read a keyword as if it were the program.
 */
import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { sensitivityFloorAsks, classifyBashCommand } from '../sensitivity-floor.js';
import { analyzeCommand } from '../command-analyzer.js';
import { describeToolCall } from '../describe-tool.js';

const WORKSPACE = '/app/workspace';

const floors = (command: string): boolean =>
  sensitivityFloorAsks({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' } as ToolCall, {
    workspaceRoot: WORKSPACE,
    shellCwd: WORKSPACE,
  });

describe('a keyword-wrapped delete still asks', () => {
  const WRAPPED: Array<[string, string]> = [
    ['for … do rm -rf', 'for d in a b; do rm -rf "/etc/$d"; done'],
    ['for … do rm -rf, in workspace', 'for d in a b; do rm -rf "/app/workspace/$d"; done'],
    ['while … do rm -rf', 'while read -r f; do rm -rf "$f"; done'],
    ['until … do rm -rf', 'until ok; do rm -rf /etc/hosts; done'],
    ['if … then rm -rf', 'if [ -f x ]; then rm -rf /etc/hosts; fi'],
    ['if … else rm -rf', 'if [ -f x ]; then ok; else rm -rf /etc/hosts; fi'],
    ['for … do curl -X DELETE', 'for id in 1 2; do curl -X DELETE "$URL/$id"; done'],
    ['while … do curl -X DELETE', 'while read -r id; do curl -X DELETE "$URL/$id"; done'],
    ['negated delete', '! rm -rf /etc/hosts'],
    ['brace group', '{ cd /etc; rm -rf hosts; }'],
  ];

  for (const [name, command] of WRAPPED) {
    it(`asks: ${name}`, () => {
      expect(floors(command)).toBe(true);
    });

    it(`classifies as a dangerous delete: ${name}`, () => {
      expect(classifyBashCommand(command, WORKSPACE, WORKSPACE)).toBe('dangerous_delete');
    });
  }
});

describe('a branch or a function body is not a hiding place either', () => {
  // `case` and `function` put their command on the SAME line as the opener,
  // after a `)` or a `{` rather than a `;`, so the segment splitter used to hand
  // the whole branch to the keyword node as argv. Same silent delete, different
  // punctuation.
  const HIDDEN: Array<[string, string]> = [
    ['case arm, rm -rf', 'case "$m" in start) rm -rf /etc/hosts;; esac'],
    ['case arm, curl -X DELETE', 'case "$m" in start) curl -X DELETE "$URL/1";; esac'],
    ['case arm nested in a loop', 'for f in a; do case "$f" in x) rm -rf /etc;; esac; done'],
    ['select body', 'select o in a b; do rm -rf /etc/hosts; done'],
    ['function body', 'function nuke { rm -rf /etc/hosts; }'],
    ['posix function body', 'nuke() { rm -rf /etc/hosts; }'],
  ];

  for (const [name, command] of HIDDEN) {
    it(`asks: ${name}`, () => {
      expect(floors(command)).toBe(true);
    });
  }

  it('reveals the branch command as a position instead of failing the whole parse', () => {
    // Fail-closed on the entire script would route every glob in it through the
    // token scanner and cry wolf on reads. The commands are ENUMERATED instead.
    expect(analyzeCommand('case "$m" in start) rm -rf /etc/hosts;; esac')).toEqual({
      parsedSafely: true,
      nested: false,
      assigns: false,
      commands: expect.arrayContaining([expect.objectContaining({ head: 'rm' })]),
    });
  });

  it('does not tear a brace expansion or a variable into pieces', () => {
    // Only a STANDALONE `{` opens a body; these are ordinary words.
    expect(floors('cp /app/workspace/{a,b}.txt /app/workspace/out/')).toBe(false);
    expect(floors('printf "%s" "${HOME}"')).toBe(false);
  });
});

describe('the bare and the wrapped form get the SAME verdict', () => {
  // The operation is what is judged, never the punctuation around it.
  const PAIRS: Array<[string, string]> = [
    ['rm -rf /etc/hosts', 'for d in hosts; do rm -rf "/etc/$d"; done'],
    ['curl -X DELETE "$URL/1"', 'for id in 1; do curl -X DELETE "$URL/$id"; done'],
  ];

  for (const [bare, wrapped] of PAIRS) {
    it(`agrees on ${bare.slice(0, 28)}`, () => {
      expect(floors(wrapped)).toBe(floors(bare));
    });
  }
});

describe('the rm narrowing survives the keyword prefix', () => {
  // A plain, specific, in-workspace delete runs silently wherever it sits
  // (founder ruling 2026-07-06). The keyword prefix must not turn it into an
  // ask — that would be trading the under-ask for a nuisance.
  it('stays silent on a plain in-workspace delete inside a loop', () => {
    expect(floors('for f in one; do rm /app/workspace/notes.txt; done')).toBe(false);
  });

  it('stays silent on a plain in-workspace delete after then', () => {
    expect(floors('if [ -f x ]; then rm /app/workspace/notes.txt; fi')).toBe(false);
  });

  it('still asks once that same delete turns recursive', () => {
    expect(floors('for f in one; do rm -rf /app/workspace/build; done')).toBe(true);
  });

  it('still asks once that same delete leaves the workspace', () => {
    expect(floors('for f in one; do rm /etc/hosts; done')).toBe(true);
  });
});

describe('a keyword-wrapped read stays silent', () => {
  const QUIET: Array<[string, string]> = [
    ['read loop', 'for f in a b; do cat "/app/workspace/$f"; done'],
    ['list loop', 'for d in a b; do ls "/app/workspace/$d"; done'],
    ['GET loop', 'for p in a b; do curl -sS "$URL/$p"; done'],
    ['guarded print', 'if [ -f notes.md ]; then printf "found"; fi'],
  ];

  for (const [name, command] of QUIET) {
    it(`stays silent: ${name}`, () => {
      expect(floors(command)).toBe(false);
    });
  }
});

describe('the card names the delete the loop performs', () => {
  it('names a looped filesystem delete instead of the loop keyword', () => {
    expect(describeToolCall({
      toolName: 'Bash',
      toolInput: { command: 'for f in one; do rm -rf /app/workspace/build; done' },
      toolCallId: 't',
    } as ToolCall)).toBe('Delete build and everything inside');
  });

  it('names a looped remote delete instead of the loop keyword', () => {
    expect(describeToolCall({
      toolName: 'Bash',
      toolInput: { command: 'for id in 1 2; do curl -X DELETE "https://api.vestra.ai/f/$id"; done' },
      toolCallId: 't',
    } as ToolCall)).toBe('Delete data at api.vestra.ai');
  });
});
