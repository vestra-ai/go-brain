/**
 * THE CONTRACT: a permission card's words are a sentence, never a token lifted
 * out of the script.
 *
 * Incident c479 (2026-08-09) showed the founder "Run set" on a delete ask. The
 * fix at the time made the describer return null when a command was unenumerable
 * AND its head was a shell BUILTIN. That is a denylist, and it leaked the very
 * next day: `for` is a shell KEYWORD, not a builtin, so two read-only probe
 * loops reached him captioned "Run for" (task 564a0462, 2026-08-10).
 *
 * A denylist cannot be finished — `while`, `until`, `case`, `select`, `time`,
 * `coproc`, `{`, `[[` and `!` are all heads a script can open with, and none of
 * them name an action. So the rule is inverted here: copy is minted ONLY from a
 * head the describer actually recognizes (a reader, a lister, a fetcher, a
 * script runner, a subcommand CLI, a delete shape). Anything else contributes no
 * phrase, and a call with no phrases speaks from its side-effect family instead.
 *
 * This is a COPY change only. Nothing here moves the guard: what floors, which
 * family a call carries, and which level asks are all unchanged — see the
 * destructive-phrase tests at the bottom, which prove a delete can never be
 * dropped by the stricter rule.
 */
import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../../contract/harness.js';
import { describeToolCall, describePermissionAsk } from '../describe-tool.js';

const bash = (command: string): ToolCall => ({
  toolName: 'Bash',
  toolInput: { command },
  toolCallId: 't1',
});

/** The generic sentence a call with nothing describable falls back to. */
const OPAQUE = 'Run a shell command';

describe('card copy — a shell keyword is never the words', () => {
  // Each of these opens a compound command. None of them is a program, and none
  // of them tells a non-technical reader anything about what will happen.
  const KEYWORD_COMMANDS: Array<[string, string]> = [
    ['for', 'for f in a b; do printf "%s" "$f"; done'],
    ['while', 'while read -r line; do printf "%s" "$line"; done < input.txt'],
    ['until', 'until ping -c1 host; do sleep 1; done'],
    ['if', 'if [ -z "$token" ]; then printf "missing"; fi'],
    ['case', 'case "$mode" in start) printf "go";; esac'],
    ['select', 'select opt in one two; do printf "%s" "$opt"; done'],
    ['function', 'function deploy { printf "shipping"; }'],
    ['time', 'time tally "$(pwd)"'],
    ['{', '{ printf "one"; printf "two"; }'],
    ['[[', '[[ -f notes.md ]] && printf "found"'],
    ['coproc', 'coproc reader { cat notes.md; }'],
  ];

  for (const [keyword, command] of KEYWORD_COMMANDS) {
    it(`does not caption a ${keyword}-headed command "Run ${keyword}"`, () => {
      expect(describeToolCall(bash(command))).not.toBe(`Run ${keyword}`);
    });
  }
});

describe('card copy — no raw token survives, on either path', () => {
  it('says nothing inventive about an unenumerable unknown head', () => {
    // Was "Run somecli". A command name we do not recognize is not a word the
    // reader knows either, and the family sentence carries more meaning.
    expect(describeToolCall(bash('somecli "$(pwd)"'))).toBe(OPAQUE);
  });

  it('says nothing inventive about an enumerable unknown head', () => {
    expect(describeToolCall(bash('somecli --flag input.txt'))).toBe(OPAQUE);
  });

  it('still names a script by its file', () => {
    expect(describeToolCall(bash('node scripts/validate.mjs'))).toBe('Run validate.mjs');
  });

  it('still names a CLI subcommand', () => {
    expect(describeToolCall(bash('git commit -m "wip"'))).toBe('Run git commit');
  });

  it('still reads a known head on the unenumerable path', () => {
    expect(describeToolCall(bash('cat "$(ls lib)"'))).toBe('Read files');
  });

  it('keeps the known phrase when an unknown head sits beside it', () => {
    expect(describeToolCall(bash('somecli --prep && ls'))).toBe('List files');
  });
});

describe('card copy — the family speaks when the call cannot', () => {
  const opaque = bash('for f in a b; do printf "%s" "$f"; done');

  const TEMPLATES: Array<[string, string]> = [
    ['readonly', 'Read files in your workspace'],
    ['workspace_write', 'Update files in your workspace'],
    ['dangerous_delete', 'Delete files in your workspace'],
  ];

  for (const [family, expected] of TEMPLATES) {
    it(`${family} reads "${expected}"`, () => {
      const ask = describePermissionAsk(opaque, {
        family: family as never,
        floor: 'rule',
      });
      expect(ask.headline).toBe(expected);
    });
  }

  it('never lets any family caption a keyword-headed loop with a bare token', () => {
    for (const [family] of TEMPLATES) {
      const ask = describePermissionAsk(opaque, { family: family as never, floor: 'rule' });
      expect(ask.headline).not.toMatch(/^Run \S+$/);
    }
  });
});

describe('card copy — the stricter rule never drops a deletion', () => {
  // The whole risk of "only recognized heads earn a phrase" is that a delete
  // hiding behind an unrecognized neighbour goes unmentioned. It cannot: a
  // delete is detected by its SHAPE, before any head lookup.
  it('names a delete standing next to an unknown head', () => {
    expect(describeToolCall(bash('somecli --prep && rm scratch.txt'))).toBe('Delete scratch.txt');
  });

  it('names an HTTP delete inside a keyword-headed loop', () => {
    expect(describeToolCall(bash('for id in 1 2; do curl -X DELETE "$URL/$id"; done'))).toContain(
      'Delete data at',
    );
  });

  it('still refuses to understate a hidden delete it cannot enumerate', () => {
    expect(describeToolCall(bash('cat "$(rm x)"'))).toBe('Delete files in your workspace');
  });

  it('still names a recursive delete', () => {
    expect(describeToolCall(bash('rm -rf build/'))).toBe('Delete build/ and everything inside');
  });
});
