import { describe, it, expect, afterEach } from 'vitest';
import { isWriteTool } from '../../index.js';

const isWrite = (command: string) =>
  isWriteTool({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });

describe('write-taxonomy (plan-mode) — mutation reachable in ANY command position', () => {
  it('classifies a backgrounded mutation as a write', () => {
    expect(isWrite('sleep 1 & rm scratch.txt')).toBe(true);
  });
  it('classifies a mutation in an sh -c body as a write', () => {
    expect(isWrite(`sh -c "rm scratch.txt"`)).toBe(true);
  });
  it('stays conservative (write) on an unparseable command', () => {
    expect(isWrite('rm $(cat $(echo x))')).toBe(true);
  });
  it('leaves a pure read (pipe of read-only heads) as a non-write', () => {
    expect(isWrite('ls -la | grep foo')).toBe(false);
  });
  it('keeps a subshell or substitution a write, as it was while unparseable (2026-09-25)', () => {
    // The analyzer reads these now, but only the delete floor acts on that;
    // plan mode blocks them exactly as before.
    expect(isWrite('echo $(ls)')).toBe(true);
    expect(isWrite('(ls; cat a)')).toBe(true);
    expect(isWrite('echo `ls`')).toBe(true);
    expect(isWrite('cat <(ls)')).toBe(false); // process substitution: unchanged, read as before
  });
});

describe('write-taxonomy — flag OFF is byte-identical to the legacy head-only taxonomy', () => {
  afterEach(() => {
    delete process.env.VESTRA_BASH_AST_GATE;
  });

  it('legacy still classifies a plain rm at the command head as a write', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(isWrite('rm scratch.txt')).toBe(true);
  });

  it('legacy does NOT see a backgrounded mutation (proves the head-only path is unchanged)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(isWrite('sleep 1 & rm scratch.txt')).toBe(false);
  });
});
