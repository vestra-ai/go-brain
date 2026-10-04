import { describe, it, expect } from 'vitest';
import { parseV4APatch } from '../tools/patch-parser.js';

describe('parseV4APatch', () => {
  it('parses an Update File with a hinted hunk', () => {
    const { ops, error } = parseV4APatch(
      [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '@@ function foo @@',
        ' const x = 1;',
        '-  return x;',
        '+  return x + 1;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(error).toBeUndefined();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('update');
    expect(ops[0].path).toBe('src/a.ts');
    expect(ops[0].hunks).toHaveLength(1);
    expect(ops[0].hunks![0].contextHint).toBe('function foo');
    expect(ops[0].hunks![0].lines).toEqual([
      { prefix: ' ', content: 'const x = 1;' },
      { prefix: '-', content: '  return x;' },
      { prefix: '+', content: '  return x + 1;' },
    ]);
  });

  it('parses an Add File (strips the + prefix into content)', () => {
    const { ops } = parseV4APatch(
      ['*** Add File: new.txt', '+line one', '+line two', '*** End Patch'].join('\n'),
    );
    expect(ops[0]).toMatchObject({ kind: 'add', path: 'new.txt', content: 'line one\nline two' });
  });

  it('parses a Delete File (no hunks)', () => {
    const { ops } = parseV4APatch('*** Delete File: gone.txt');
    expect(ops[0]).toEqual({ kind: 'delete', path: 'gone.txt' });
  });

  it('parses a Move File: src -> dst', () => {
    const { ops } = parseV4APatch('*** Move File: a/old.ts -> b/new.ts');
    expect(ops[0]).toEqual({ kind: 'move', path: 'a/old.ts', newPath: 'b/new.ts' });
  });

  it('parses multiple files + multiple hunks in one envelope', () => {
    const { ops } = parseV4APatch(
      [
        '*** Begin Patch',
        '*** Update File: one.ts',
        '@@ a @@',
        '-x',
        '+y',
        '@@ b @@',
        '-p',
        '+q',
        '*** Add File: two.ts',
        '+hello',
        '*** End Patch',
      ].join('\n'),
    );
    expect(ops).toHaveLength(2);
    expect(ops[0].hunks).toHaveLength(2);
    expect(ops[1]).toMatchObject({ kind: 'add', path: 'two.ts', content: 'hello' });
  });

  it('works without Begin/End markers (parses to EOF)', () => {
    const { ops, error } = parseV4APatch(['*** Update File: x.ts', '-a', '+b'].join('\n'));
    expect(error).toBeUndefined();
    expect(ops[0].kind).toBe('update');
  });

  it('treats an empty patch as a no-op (no error)', () => {
    expect(parseV4APatch('')).toEqual({ ops: [] });
    expect(parseV4APatch('*** Begin Patch\n*** End Patch')).toEqual({ ops: [] });
  });

  it('skips the "\\ No newline at end of file" marker', () => {
    const { ops } = parseV4APatch(['*** Update File: x', '-a', '+b', '\\ No newline at end of file'].join('\n'));
    expect(ops[0].hunks![0].lines).toEqual([
      { prefix: '-', content: 'a' },
      { prefix: '+', content: 'b' },
    ]);
  });

  it('errors on an empty file path', () => {
    expect(parseV4APatch('*** Update File: ').error).toMatch(/empty path/);
  });

  it('errors on an Update with no hunks', () => {
    expect(parseV4APatch('*** Update File: x.ts\n*** End Patch').error).toMatch(/no hunks/);
  });

  it('errors on a Move without a destination', () => {
    expect(parseV4APatch('*** Move File: only-src.ts').error).toMatch(/Move File/);
  });

  it('normalizes CRLF — no stray \\r leaks into hunk content', () => {
    const { ops } = parseV4APatch(['*** Update File: x.ts', '@@', '-a', '+b'].join('\r\n'));
    expect(ops[0].hunks![0].lines).toEqual([
      { prefix: '-', content: 'a' },
      { prefix: '+', content: 'b' },
    ]);
  });

  it('drops empty hunks (consecutive @@) without tripping the no-hunks guard', () => {
    const { ops, error } = parseV4APatch(['*** Update File: x.ts', '@@', '@@', '-a', '+b'].join('\n'));
    expect(error).toBeUndefined();
    expect(ops[0].hunks).toHaveLength(1); // the empty first hunk is dropped
    expect(ops[0].hunks![0].lines).toHaveLength(2);
  });

  it('a trailing @@ with no body is dropped, not treated as a hunk', () => {
    const { ops, error } = parseV4APatch(['*** Update File: x.ts', '@@', '-a', '+b', '@@'].join('\n'));
    expect(error).toBeUndefined();
    expect(ops[0].hunks).toHaveLength(1);
  });
});
