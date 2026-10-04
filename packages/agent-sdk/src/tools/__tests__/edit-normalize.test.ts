/**
 * edit-normalize.test.ts — the pure half of EDIT_HARDEN_V1.
 *
 * Two things carry all the risk and get the most tests:
 *  1. THE MAPPING. A fuzzy match is found in normalized space but applied to the
 *     ORIGINAL bytes. Every test here asserts that lines the match did not touch come
 *     back byte-for-byte — including their own smart quotes and trailing whitespace,
 *     which normalization would happily have eaten.
 *  2. NO FALSE POSITIVES. The transform set must never make semantically different
 *     code equal. Leading indentation and tabs are the cases that matter.
 */
import { describe, it, expect } from 'vitest';
import {
  buildNormalizedView,
  normalizeNeedle,
  fuzzyReplace,
  stripBom,
  repairEditArgs,
} from '../edit-normalize.js';

const ok = (r: ReturnType<typeof fuzzyReplace>) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r;
};

describe('buildNormalizedView — the line-count invariant the mapping rests on', () => {
  const CASES: Array<[string, string]> = [
    ['empty', ''],
    ['no trailing newline', 'a\nb'],
    ['trailing newline', 'a\nb\n'],
    ['blank lines', 'a\n\n\nb\n'],
    ['CRLF', 'a\r\nb\r\n'],
    ['mixed endings', 'a\r\nb\nc\r\n'],
    ['lone CR inside a line', 'a\rb\nc\n'],
    ['only newlines', '\n\n\n'],
    ['smart quotes + trailing spaces', 'x = “q”   \ny\n'],
  ];

  for (const [name, text] of CASES) {
    it(`${name}: one span per original line, spans tile the normalized text`, () => {
      const view = buildNormalizedView(text);
      expect(view.spans.length).toBe(view.originalLines.length);
      expect(view.originalLines.join('')).toBe(text); // the split is lossless
      let offset = 0;
      for (const span of view.spans) {
        expect(span.start).toBe(offset);
        offset = span.end;
      }
      expect(offset).toBe(view.text.length);
    });
  }
});

describe('normalizeNeedle — the fixed transform set', () => {
  it('folds smart quotes, unicode dashes and unicode spaces to ASCII', () => {
    expect(normalizeNeedle('“hi”')).toBe('"hi"');
    expect(normalizeNeedle('it’s')).toBe("it's");
    expect(normalizeNeedle('a—b')).toBe('a-b');
    expect(normalizeNeedle('a–b')).toBe('a-b');
    expect(normalizeNeedle('a−b')).toBe('a-b');
    expect(normalizeNeedle('a b')).toBe('a b');
    expect(normalizeNeedle('a　b')).toBe('a b');
  });

  it('strips trailing whitespace per line and drops CR', () => {
    expect(normalizeNeedle('a   \nb\t\n')).toBe('a\nb\n');
    expect(normalizeNeedle('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeNeedle('a  ')).toBe('a');
  });

  it('NEVER touches leading indentation', () => {
    expect(normalizeNeedle('    a\n')).toBe('    a\n');
    expect(normalizeNeedle('\t\ta\n')).toBe('\t\ta\n');
  });
});

describe('fuzzyReplace — the mapping back to original bytes', () => {
  it('rewrites only the matched line; neighbours keep their own smart quotes verbatim', () => {
    const original = [
      'const a = “keep me”;   ', // smart quotes AND trailing spaces, untouched
      'const b = “target”;',
      'const c = ‘keep me too’;',
      '',
    ].join('\n');
    // The model retyped line 2 with ASCII quotes — exact matching misses.
    const r = ok(fuzzyReplace(original, 'const b = "target";', 'const b = "done";', false));
    expect(r.text).toBe(
      [
        'const a = “keep me”;   ',
        'const b = "done";',
        'const c = ‘keep me too’;',
        '',
      ].join('\n'),
    );
    expect(r.count).toBe(1);
  });

  it('matches across multiple lines and rewrites exactly that block', () => {
    const original = [
      'header   ',
      'function f() {',
      '  return “x”;',
      '}',
      'footer   ',
      '',
    ].join('\n');
    const r = ok(
      fuzzyReplace(original, 'function f() {\n  return "x";\n}', 'function f() {\n  return "y";\n}', false),
    );
    expect(r.text).toBe(
      ['header   ', 'function f() {', '  return "y";', '}', 'footer   ', ''].join('\n'),
    );
  });

  it('handles a match on the last line with no trailing newline', () => {
    const original = 'a   \nb—c';
    const r = ok(fuzzyReplace(original, 'b-c', 'B-C', false));
    expect(r.text).toBe('a   \nB-C');
  });

  it('handles a match on the very first line', () => {
    const original = 'x—y\nz   \n';
    const r = ok(fuzzyReplace(original, 'x-y', 'X-Y', false));
    expect(r.text).toBe('X-Y\nz   \n');
  });

  it('replace_all rewrites every matched line and nothing else', () => {
    const original = ['p—q', 'untouched   ', 'p–q', 'also untouched’s', ''].join('\n');
    const r = ok(fuzzyReplace(original, 'p-q', 'PQ', true));
    expect(r.text).toBe(['PQ', 'untouched   ', 'PQ', 'also untouched’s', ''].join('\n'));
    expect(r.count).toBe(2);
  });

  it('two matches on ONE line are both applied without corrupting offsets', () => {
    const original = 'lo — hi — lo\nnext   \n';
    const r = ok(fuzzyReplace(original, '-', '+', true));
    expect(r.text).toBe('lo + hi + lo\nnext   \n');
    expect(r.count).toBe(2);
  });

  it('CRLF: the rewritten line keeps CRLF and untouched lines are byte-identical', () => {
    const original = 'a   \r\nb—c\r\nd\r\n';
    const r = ok(fuzzyReplace(original, 'b-c', 'b-C', false));
    expect(r.text).toBe('a   \r\nb-C\r\nd\r\n');
  });

  it('CRLF: a multi-line new_string gets CRLF terminators, not bare LF', () => {
    const original = 'a\r\nb—c\r\nd\r\n';
    const r = ok(fuzzyReplace(original, 'b-c', 'one\ntwo', false));
    expect(r.text).toBe('a\r\none\r\ntwo\r\nd\r\n');
  });

  it('CRLF: a new_string that already carries CRLF does not become \\r\\r\\n', () => {
    const original = 'a\r\nb—c\r\n';
    const r = ok(fuzzyReplace(original, 'b-c', 'one\r\ntwo', false));
    expect(r.text).toBe('a\r\none\r\ntwo\r\n');
    expect(r.text).not.toContain('\r\r');
  });

  it('an LF file stays LF even when the new_string carries CRLF', () => {
    const original = 'a\nb—c\n';
    const r = ok(fuzzyReplace(original, 'b-c', 'one\r\ntwo', false));
    expect(r.text).toBe('a\none\ntwo\n');
  });

  it('reports ambiguity by count instead of guessing', () => {
    const original = 'a—b\nfiller\na–b\n';
    expect(fuzzyReplace(original, 'a-b', 'X', false)).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('an empty needle is never a match', () => {
    expect(fuzzyReplace('abc', '', 'X', false)).toEqual({ kind: 'not_found' });
    expect(fuzzyReplace('abc', '   ', 'X', false)).toEqual({ kind: 'not_found' });
  });
});

describe('fuzzyReplace — no false positives', () => {
  it('does NOT match a block that differs only in indentation width', () => {
    const original = 'if (x) {\n  doThing();\n}\n';
    expect(fuzzyReplace(original, 'if (x) {\n    doThing();\n}', 'X', false)).toEqual({ kind: 'not_found' });
  });

  it('does NOT equate tab indentation with space indentation', () => {
    const original = 'fn() {\n\treturn 1;\n}\n';
    expect(fuzzyReplace(original, 'fn() {\n    return 1;\n}', 'X', false)).toEqual({ kind: 'not_found' });
    expect(fuzzyReplace('\tx\n', '    x', 'X', false)).toEqual({ kind: 'not_found' });
  });

  it('does NOT match different identifiers or different code', () => {
    expect(fuzzyReplace('const alpha = 1;\n', 'const beta = 1;', 'X', false)).toEqual({ kind: 'not_found' });
    expect(fuzzyReplace('a + b\n', 'a - b', 'X', false)).toEqual({ kind: 'not_found' });
  });

  it('does NOT collapse whitespace INSIDE a line (only trailing is stripped)', () => {
    expect(fuzzyReplace('a    b\n', 'a b', 'X', false)).toEqual({ kind: 'not_found' });
  });

  it('leaves the file untouched on every miss', () => {
    const original = 'if (x) {\n  doThing();\n}\n';
    const r = fuzzyReplace(original, 'if (x) {\n    doThing();\n}', 'X', false);
    expect(r.kind).toBe('not_found');
    expect(original).toBe('if (x) {\n  doThing();\n}\n');
  });
});

describe('stripBom', () => {
  it('separates a BOM and leaves BOM-less content by value', () => {
    expect(stripBom('﻿abc')).toEqual({ bom: '﻿', text: 'abc' });
    expect(stripBom('abc')).toEqual({ bom: '', text: 'abc' });
  });
});

describe('repairEditArgs — every repair is a billed round-trip not spent', () => {
  it('parses an argument OBJECT that arrived as a JSON string', () => {
    const r = repairEditArgs('{"file_path":"a.ts","old_string":"x","new_string":"y"}');
    expect(r).toMatchObject({ ok: true, repaired: true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.args).toMatchObject({ file_path: 'a.ts', old_string: 'x', new_string: 'y' });
  });

  it('upgrades the Anthropic text_editor key names (path / old_str / new_str)', () => {
    const r = repairEditArgs({ path: 'a.ts', old_str: 'x', new_str: 'y' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.args).toMatchObject({ file_path: 'a.ts', old_string: 'x', new_string: 'y' });
    expect(r.repaired).toBe(true);
  });

  it('upgrades the oldText / newText and camelCase variants', () => {
    for (const shape of [
      { path: 'a.ts', oldText: 'x', newText: 'y' },
      { filePath: 'a.ts', oldString: 'x', newString: 'y' },
    ]) {
      const r = repairEditArgs(shape);
      if (!r.ok) throw new Error('unreachable');
      expect(r.args).toMatchObject({ file_path: 'a.ts', old_string: 'x', new_string: 'y' });
    }
  });

  it('lifts a single-entry edits array — as an array and as a JSON string', () => {
    for (const edits of [
      [{ oldText: 'x', newText: 'y' }],
      '[{"old_string":"x","new_string":"y"}]',
    ] as unknown[]) {
      const r = repairEditArgs({ file_path: 'a.ts', edits });
      if (!r.ok) throw new Error('unreachable');
      expect(r.args).toMatchObject({ file_path: 'a.ts', old_string: 'x', new_string: 'y' });
      expect((r.args as unknown as Record<string, unknown>).edits).toBeUndefined();
    }
  });

  it('REFUSES a multi-entry edits array with an actionable count instead of dropping edits', () => {
    const r = repairEditArgs({
      file_path: 'a.ts',
      edits: [
        { oldText: 'x', newText: 'y' },
        { oldText: 'p', newText: 'q' },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('2');
    expect(r.error).toMatch(/Patch/);
  });

  it('coerces a stringified replace_all — including "false", which is TRUTHY untouched', () => {
    const on = repairEditArgs({ file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: 'true' });
    const off = repairEditArgs({ file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: 'false' });
    if (!on.ok || !off.ok) throw new Error('unreachable');
    expect(on.args.replace_all).toBe(true);
    expect(off.args.replace_all).toBe(false);
  });

  it('never overrides a canonical key that is already present', () => {
    const r = repairEditArgs({ file_path: 'real.ts', path: 'decoy.ts', old_string: 'x', new_string: 'y' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.file_path).toBe('real.ts');
  });

  it('leaves a well-formed object alone and reports no repair', () => {
    const input = { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true };
    const r = repairEditArgs(input);
    if (!r.ok) throw new Error('unreachable');
    expect(r.repaired).toBe(false);
    expect(r.args).toEqual(input);
  });

  it('leaves un-repairable input alone rather than inventing fields', () => {
    for (const junk of ['not json at all', null, undefined, 42, ['a']] as unknown[]) {
      const r = repairEditArgs(junk);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.repaired).toBe(false);
    }
  });
});
