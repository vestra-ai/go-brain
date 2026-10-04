import { describe, it, expect } from 'vitest';
import { containsUnquotedGlob } from '../unquoted-glob.js';

// The unparseable path's "we cannot see what this expands to" proxy, pinned on
// its own: since 2026-09-25 most commands that used to reach it (anything with
// a subshell or a substitution) are read position by position instead, so the
// floor-level tests no longer exercise every branch.

describe('containsUnquotedGlob', () => {
  it('reads unquoted in-word and bare patterns as globs', () => {
    for (const cmd of ['ls *.md', 'ls ?', 'ls *', 'ls [abc].txt', 'ls file[0-9]', 'cp {a,b}.txt out', 'printf x {1..32}']) {
      expect(containsUnquotedGlob(cmd), cmd).toBe(true);
    }
  });

  it('does not read quoted, escaped or punctuation-only words as globs', () => {
    for (const cmd of [`jq '{a:[.b[]]}'`, 'echo "{a,b}" "*"', 'echo \\[ \\*', 'if [ -z "$x" ]; then :; fi', 'find . -exec ls {} +', '{ echo hi; }']) {
      expect(containsUnquotedGlob(cmd), cmd).toBe(false);
    }
  });

  it('does not read a special parameter as a glob (prod 2026-09-25: `echo EXIT $?`)', () => {
    for (const cmd of ['echo EXIT $? >> r.log', 'status=$?', 'echo $*', 'echo $@ $# $! $$ $- $0 $9', 'x=$?y']) {
      expect(containsUnquotedGlob(cmd), cmd).toBe(false);
    }
  });

  it('does not read ${…} parameter expansion as a brace list or a pattern', () => {
    for (const cmd of ['echo ${HOME}', 'echo ${f%.*}', 'echo ${#arr[@]}', 'echo ${arr[*]}', 'echo ${a:-${b}}']) {
      expect(containsUnquotedGlob(cmd), cmd).toBe(false);
    }
  });

  it('still reads a real glob next to a parameter', () => {
    expect(containsUnquotedGlob('echo $? *.log')).toBe(true);
    expect(containsUnquotedGlob('ls ${DIR}/*.md')).toBe(true);
    expect(containsUnquotedGlob('echo $**')).toBe(true);
  });

  it('reads a ${…} it cannot delimit character by character, as before', () => {
    // A quote or a substitution inside: its end is not ours to guess.
    expect(containsUnquotedGlob('echo ${x:-"}"}')).toBe(true);
    expect(containsUnquotedGlob('echo ${x:-$(ls)}')).toBe(true);
    expect(containsUnquotedGlob('echo ${unclosed')).toBe(true);
  });
});
