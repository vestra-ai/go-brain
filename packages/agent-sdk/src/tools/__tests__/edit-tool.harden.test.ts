/**
 * edit-tool.harden.test.ts — EDIT_HARDEN_V1, three axes.
 *
 *  OFF  every path is today's, error strings byte-identical.
 *  ON   the failure corpus below either succeeds or errors ACTIONABLY (one re-issue,
 *       never a blind retry) — each row is a billed round-trip we stop paying for.
 *  ON   the exact-match fast path is untouched: normalization runs only where today's
 *       code would already have returned "old_string not found".
 *
 * The corpus rows are real shapes, not invented ones. The text corruptions are how a
 * model mangles copied source; the argument shapes are the names other edit tools use
 * (Anthropic's text_editor: path/old_str/new_str; pi's: oldText/newText) plus the
 * whole-object-as-JSON-string that the dispatcher's coerceStringifiedToolArgs header
 * already documents from DeepSeek/GLM on our own wire — a coercion that never fires
 * for Edit, because it is schema-driven and Edit declares no structured field.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEditTool } from '../edit-tool.js';
import { isToolError } from '../tool-types.js';

let WS = '';
afterEach(async () => {
  if (WS) await fs.rm(WS, { recursive: true, force: true });
  WS = '';
  delete process.env.EDIT_HARDEN_V1;
});

const freshWs = () => {
  WS = realpathSync(mkdtempSync(join(tmpdir(), 'edit-harden-')));
  return WS;
};

async function run(
  on: boolean,
  file: string,
  args: unknown,
  name = 'e.txt',
): Promise<{ out: unknown; disk: string }> {
  const ws = freshWs();
  await fs.writeFile(join(ws, name), file, 'utf8');
  if (on) process.env.EDIT_HARDEN_V1 = '1';
  else delete process.env.EDIT_HARDEN_V1;
  const out = await makeEditTool(() => ws).execute(args, {});
  return { out, disk: await fs.readFile(join(ws, name), 'utf8') };
}

const failed = (out: unknown) => isToolError(out);
const message = (out: unknown) => (isToolError(out) ? out.__toolError.message : String(out));

// ── The failure corpus ───────────────────────────────────────────────────────
// Each row: OFF wastes a round-trip; ON writes the file. `disk` is the exact bytes
// expected after the ON run.

interface Row {
  name: string;
  file: string;
  args: Record<string, unknown>;
  disk: string;
}

const CORPUS: Row[] = [
  {
    name: 'smart double quotes retyped as ASCII',
    file: 'const a = “hi”;\ntail   \n',
    args: { file_path: 'e.txt', old_string: 'const a = "hi";', new_string: 'const a = "bye";' },
    disk: 'const a = "bye";\ntail   \n',
  },
  {
    name: 'smart apostrophe retyped as ASCII',
    file: "const m = ‘it’s’;\n",
    args: { file_path: 'e.txt', old_string: "const m = 'it's';", new_string: "const m = 'ok';" },
    disk: "const m = 'ok';\n",
  },
  {
    name: 'en dash substituted for hyphen',
    file: 'run --flag–value\n',
    args: { file_path: 'e.txt', old_string: 'run --flag-value', new_string: 'run --flag=value' },
    disk: 'run --flag=value\n',
  },
  {
    name: 'em dash substituted for hyphen',
    file: 'a—b\n',
    args: { file_path: 'e.txt', old_string: 'a-b', new_string: 'a_b' },
    disk: 'a_b\n',
  },
  {
    name: 'non-breaking spaces where the file has plain spaces',
    file: 'let x = 1;\n',
    args: {
      file_path: 'e.txt',
      old_string: 'let\u00A0x\u00A0=\u00A01;',
      new_string: 'let x = 2;',
    },
    disk: 'let x = 2;\n',
  },
  {
    name: 'ideographic space where the file has a plain space',
    file: 'let y = 1;\n',
    args: { file_path: 'e.txt', old_string: 'let\u3000y = 1;', new_string: 'let y = 2;' },
    disk: 'let y = 2;\n',
  },
  {
    name: 'file has trailing whitespace, model trimmed it',
    file: 'const a = 1;   \nnext\n',
    args: { file_path: 'e.txt', old_string: 'const a = 1;\nnext', new_string: 'const a = 9;\nnext' },
    disk: 'const a = 9;\nnext\n',
  },
  {
    name: 'model added trailing whitespace the file does not have',
    file: 'const a = 1;\nnext\n',
    args: { file_path: 'e.txt', old_string: 'const a = 1;   \nnext', new_string: 'const a = 9;\nnext' },
    disk: 'const a = 9;\nnext\n',
  },
  {
    name: 'CRLF file, LF old_string (endings restored on write)',
    file: 'alpha\r\nbeta\r\ngamma\r\n',
    args: { file_path: 'e.txt', old_string: 'alpha\nbeta', new_string: 'alpha\nBETA' },
    disk: 'alpha\r\nBETA\r\ngamma\r\n',
  },
  {
    name: 'BOM file, corrupted quotes on the first line (BOM survives the write)',
    file: '﻿const a = “hi”;\n',
    args: { file_path: 'e.txt', old_string: 'const a = "hi";', new_string: 'const a = "bye";' },
    disk: '﻿const a = "bye";\n',
  },
  {
    name: 'a single-entry edits array instead of the flat shape',
    file: 'hello world\n',
    args: { file_path: 'e.txt', edits: [{ oldText: 'world', newText: 'bash' }] },
    disk: 'hello bash\n',
  },
  {
    name: "pi's key names (oldText / newText)",
    file: 'hello world\n',
    args: { path: 'e.txt', oldText: 'world', newText: 'bash' },
    disk: 'hello bash\n',
  },
  {
    name: "Anthropic text_editor key names (path / old_str / new_str)",
    file: 'hello world\n',
    args: { path: 'e.txt', old_str: 'world', new_str: 'bash' },
    disk: 'hello bash\n',
  },
];

// The JSON-string row needs a raw string as `args`, which the Row type cannot hold.
const JSON_STRING_ROW = {
  file: 'hello world\n',
  args: '{"file_path":"e.txt","old_string":"world","new_string":"bash"}',
  disk: 'hello bash\n',
};

describe('EDIT_HARDEN_V1 — OFF axis: the corpus wastes a round-trip, the file is untouched', () => {
  for (const row of CORPUS.filter((r) => !r.name.includes('JSON string'))) {
    it(`OFF: ${row.name} → error, no write`, async () => {
      const { out, disk } = await run(false, row.file, row.args);
      expect(failed(out)).toBe(true);
      expect(disk).toBe(row.file);
    });
  }

  it('OFF: the whole argument object as a JSON string → error, no write', async () => {
    const { out, disk } = await run(false, JSON_STRING_ROW.file, JSON_STRING_ROW.args);
    expect(failed(out)).toBe(true);
    expect(disk).toBe(JSON_STRING_ROW.file);
  });
});

describe('EDIT_HARDEN_V1 — ON axis: the same corpus writes the file', () => {
  for (const row of CORPUS.filter((r) => !r.name.includes('JSON string'))) {
    it(`ON: ${row.name} → edited`, async () => {
      const { out, disk } = await run(true, row.file, row.args);
      expect(failed(out)).toBe(false);
      expect(String(out)).toMatch(/^Edited /);
      expect(disk).toBe(row.disk);
    });
  }

  it('ON: the whole argument object as a JSON string → edited', async () => {
    const { out, disk } = await run(true, JSON_STRING_ROW.file, JSON_STRING_ROW.args);
    expect(failed(out)).toBe(false);
    expect(disk).toBe(JSON_STRING_ROW.disk);
  });
});

describe('EDIT_HARDEN_V1 — ON axis: ambiguity errors are actionable, not blind', () => {
  it('a multi-entry edits array names the count and points at Patch (OFF just misses)', async () => {
    const args = {
      file_path: 'e.txt',
      edits: [
        { oldText: 'a', newText: 'A' },
        { oldText: 'b', newText: 'B' },
      ],
    };
    const off = await run(false, 'a b\n', args);
    expect(failed(off.out)).toBe(true);
    expect(off.disk).toBe('a b\n');

    const on = await run(true, 'a b\n', args);
    expect(failed(on.out)).toBe(true);
    expect(message(on.out)).toContain('2');
    expect(message(on.out)).toMatch(/Patch/);
    expect(on.disk).toBe('a b\n');
  });

  it('a match that is ambiguous ONLY in normalized space is counted, never guessed', async () => {
    const file = 'a—b\nfiller\na–b\n';
    const args = { file_path: 'e.txt', old_string: 'a-b', new_string: 'X' };
    expect(message((await run(false, file, args)).out)).toBe('old_string not found in e.txt');

    const on = await run(true, file, args);
    expect(failed(on.out)).toBe(true);
    expect(message(on.out)).toContain('found 2 times');
    expect(on.disk).toBe(file); // untouched — no silent first-match pick
  });

  it('the exact-match ambiguity message keeps its prefix and adds the context option', async () => {
    const args = { file_path: 'e.txt', old_string: 'x', new_string: 'y' };
    expect(message((await run(false, 'x x x\n', args)).out)).toBe(
      'old_string found 3 times in e.txt — use replace_all:true to replace all occurrences.',
    );
    expect(message((await run(true, 'x x x\n', args)).out)).toBe(
      'old_string found 3 times in e.txt — use replace_all:true to replace all occurrences, ' +
        'or add surrounding context to make old_string unique.',
    );
  });
});

describe('EDIT_HARDEN_V1 — a stringified replace_all is a WRONG edit today, not just a slow one', () => {
  // `replace_all: "false"` is a truthy string, so today's `!replace_all` guard never
  // fires and every occurrence is rewritten — the opposite of what the model asked.
  const args = { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: 'false' };

  it('OFF: silently replaces ALL occurrences', async () => {
    const { out, disk } = await run(false, 'x\nx\n', args);
    expect(failed(out)).toBe(false);
    expect(disk).toBe('y\ny\n');
  });

  it('ON: honours the intent — ambiguity is reported and nothing is written', async () => {
    const { out, disk } = await run(true, 'x\nx\n', args);
    expect(failed(out)).toBe(true);
    expect(message(out)).toContain('found 2 times');
    expect(disk).toBe('x\nx\n');
  });

  it('ON: a stringified "true" still replaces all', async () => {
    const { out, disk } = await run(true, 'x\nx\n', { ...args, replace_all: 'true' });
    expect(failed(out)).toBe(false);
    expect(disk).toBe('y\ny\n');
  });
});

describe('EDIT_HARDEN_V1 — ON axis: no false positives', () => {
  it('does not match a block that differs only in indentation width', async () => {
    const file = 'if (x) {\n  doThing();\n}\n';
    const { out, disk } = await run(true, file, {
      file_path: 'e.txt',
      old_string: 'if (x) {\n    doThing();\n}',
      new_string: 'REWRITTEN',
    });
    expect(message(out)).toBe('old_string not found in e.txt');
    expect(disk).toBe(file);
  });

  it('does not equate tab indentation with space indentation', async () => {
    const file = 'fn() {\n\treturn 1;\n}\n';
    const { out, disk } = await run(true, file, {
      file_path: 'e.txt',
      old_string: 'fn() {\n    return 1;\n}',
      new_string: 'REWRITTEN',
    });
    expect(message(out)).toBe('old_string not found in e.txt');
    expect(disk).toBe(file);
  });

  it('does not collapse whitespace inside a line', async () => {
    const file = 'a    b\n';
    const { out, disk } = await run(true, file, { file_path: 'e.txt', old_string: 'a b', new_string: 'X' });
    expect(message(out)).toBe('old_string not found in e.txt');
    expect(disk).toBe(file);
  });

  it('a fuzzy edit leaves every untouched line byte-identical, corruption included', async () => {
    const file = ['const keep = “quoted”;   ', 'const hit = “target”;', "const also = ‘kept’;\t", ''].join('\n');
    const { disk } = await run(true, file, {
      file_path: 'e.txt',
      old_string: 'const hit = "target";',
      new_string: 'const hit = "done";',
    });
    expect(disk).toBe(
      ['const keep = “quoted”;   ', 'const hit = "done";', "const also = ‘kept’;\t", ''].join('\n'),
    );
  });
});

describe('EDIT_HARDEN_V1 — ON axis: the exact-match fast path is unchanged', () => {
  it('an exact match takes precedence and is never ambiguated by the normalized space', async () => {
    // Both lines collapse to the same text once normalized; the exact match is unique,
    // so it wins outright and the smart-quoted twin is left alone.
    const file = 'v = "a";\nv = “a”;\n';
    const args = { file_path: 'e.txt', old_string: 'v = "a";', new_string: 'v = "b";' };
    const off = await run(false, file, args);
    const on = await run(true, file, args);
    expect(on.disk).toBe('v = "b";\nv = “a”;\n');
    expect(on.disk).toBe(off.disk);
    expect(String(on.out)).toBe(String(off.out));
  });

  it('exact single, exact replace_all, and both success strings match OFF byte for byte', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['hello world\n', { file_path: 'e.txt', old_string: 'world', new_string: 'bash' }],
      ['x x x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true }],
      ['x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true }],
    ];
    for (const [file, args] of cases) {
      const off = await run(false, file, args);
      const on = await run(true, file, args);
      expect(String(on.out)).toBe(String(off.out));
      expect(on.disk).toBe(off.disk);
    }
  });
});

describe('EDIT_HARDEN_V1 — OFF axis: today\'s contract is byte-identical', () => {
  it('the not-found, empty and ambiguity messages are verbatim', async () => {
    expect(message((await run(false, 'abc\n', { file_path: 'e.txt', old_string: 'zzz', new_string: 'q' })).out))
      .toBe('old_string not found in e.txt');
    expect(message((await run(false, 'abc\n', { file_path: 'e.txt', old_string: '', new_string: 'q' })).out))
      .toBe('old_string must not be empty');
    expect(message((await run(false, 'x x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y' })).out))
      .toBe('old_string found 2 times in e.txt — use replace_all:true to replace all occurrences.');
  });

  it('the success strings are verbatim (including the "1 replacements" quirk)', async () => {
    expect(String((await run(false, 'hello world\n', { file_path: 'e.txt', old_string: 'world', new_string: 'b' })).out))
      .toBe('Edited e.txt (1 replacement)');
    expect(String((await run(false, 'x x x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true })).out))
      .toBe('Edited e.txt (3 replacements)');
    expect(String((await run(false, 'x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true })).out))
      .toBe('Edited e.txt (1 replacements)');
  });

  it('ON keeps every one of those success strings identical', async () => {
    expect(String((await run(true, 'hello world\n', { file_path: 'e.txt', old_string: 'world', new_string: 'b' })).out))
      .toBe('Edited e.txt (1 replacement)');
    expect(String((await run(true, 'x x x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true })).out))
      .toBe('Edited e.txt (3 replacements)');
    expect(String((await run(true, 'x\n', { file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true })).out))
      .toBe('Edited e.txt (1 replacements)');
  });

  it('ON never throws on arguments repair cannot rescue — it reports the miss as today', async () => {
    // No old_string at all, and a new_string that is not a string: there is no needle
    // to normalize, so the matcher must never see it.
    for (const args of [
      { file_path: 'e.txt', new_string: 'q' },
      { file_path: 'e.txt', old_string: 42, new_string: 'q' },
      { file_path: 'e.txt', old_string: null, new_string: 'q' },
    ] as unknown[]) {
      const off = await run(false, 'abc\n', args);
      const on = await run(true, 'abc\n', args);
      expect(message(on.out)).toBe('old_string not found in e.txt');
      expect(message(on.out)).toBe(message(off.out));
      expect(on.disk).toBe('abc\n');
    }
  });

  it('ON does not disturb the sensitive-file block or the empty-old_string guard', async () => {
    const blocked = await run(true, 'SECRET=1\n', { file_path: '.env', old_string: 'SECRET', new_string: 'X' }, '.env');
    expect(String(blocked.out).toLowerCase()).toContain('block');
    expect(message((await run(true, 'abc\n', { file_path: 'e.txt', old_string: '', new_string: 'q' })).out))
      .toBe('old_string must not be empty');
  });
});
