import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePatchTool, applyHunk } from '../tools/patch-tool.js';
import type { ToolExecuteContext } from '../tools/tool-types.js';

const CTX = {} as ToolExecuteContext;
let wd: string;
const tool = makePatchTool(() => wd);
const run = (input: string) => tool.execute({ input }, CTX) as Promise<string>;
const read = (p: string) => readFile(join(wd, p), 'utf8');
const exists = async (p: string) => {
  try {
    await access(join(wd, p));
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  wd = await mkdtemp(join(tmpdir(), 'patch-tool-'));
});
afterEach(async () => {
  await rm(wd, { recursive: true, force: true });
});

describe('makePatchTool — apply', () => {
  it('updates a file via a context+remove+add hunk', async () => {
    await writeFile(join(wd, 'a.ts'), 'const x = 1;\nreturn x;\n');
    const out = await run(
      ['*** Begin Patch', '*** Update File: a.ts', '@@', ' const x = 1;', '-return x;', '+return x + 1;', '*** End Patch'].join('\n'),
    );
    expect(out).toContain('modified: a.ts');
    expect(await read('a.ts')).toBe('const x = 1;\nreturn x + 1;\n');
  });

  it('matches with trailing-whitespace tolerance', async () => {
    await writeFile(join(wd, 'a.ts'), 'foo   \nbar\n'); // trailing spaces on disk
    const out = await run(['*** Update File: a.ts', '@@', '-foo', '+FOO', ' bar'].join('\n'));
    expect(out).toContain('modified');
    expect(await read('a.ts')).toBe('FOO\nbar\n');
  });

  it('adds a new file (and creates parent dirs)', async () => {
    const out = await run(['*** Add File: nested/dir/new.txt', '+hello', '+world', '*** End Patch'].join('\n'));
    expect(out).toContain('created: nested/dir/new.txt');
    expect(await read('nested/dir/new.txt')).toBe('hello\nworld');
  });

  it('deletes a file', async () => {
    await writeFile(join(wd, 'gone.txt'), 'bye');
    expect(await run('*** Delete File: gone.txt')).toContain('deleted: gone.txt');
    expect(await exists('gone.txt')).toBe(false);
  });

  it('moves a file', async () => {
    await mkdir(join(wd, 'src'), { recursive: true });
    await writeFile(join(wd, 'src/old.ts'), 'body');
    const out = await run('*** Move File: src/old.ts -> dst/new.ts');
    expect(out).toContain('moved: src/old.ts -> dst/new.ts');
    expect(await exists('src/old.ts')).toBe(false);
    expect(await read('dst/new.ts')).toBe('body');
  });

  it('applies multiple files in one envelope', async () => {
    await writeFile(join(wd, 'a.ts'), 'x\n');
    const out = await run(
      ['*** Begin Patch', '*** Update File: a.ts', '@@', '-x', '+y', '*** Add File: b.ts', '+new', '*** End Patch'].join('\n'),
    );
    expect(out).toContain('modified: a.ts');
    expect(out).toContain('created: b.ts');
    expect(await read('a.ts')).toBe('y\n');
    expect(await read('b.ts')).toBe('new');
  });

  it('is ALL-OR-NOTHING: one bad hunk → no file is touched', async () => {
    await writeFile(join(wd, 'a.ts'), 'x\n');
    const out = await run(
      [
        '*** Begin Patch',
        '*** Add File: b.ts', // would succeed in isolation
        '+created',
        '*** Update File: a.ts',
        '@@',
        '-NOT_PRESENT', // fails to locate → whole patch aborts
        '+z',
        '*** End Patch',
      ].join('\n'),
    );
    expect(out).toMatch(/\[patch failed:/);
    expect(await read('a.ts')).toBe('x\n'); // untouched
    expect(await exists('b.ts')).toBe(false); // never written
  });

  it('errors (no write) when context is not found', async () => {
    await writeFile(join(wd, 'a.ts'), 'real\n');
    expect(await run(['*** Update File: a.ts', '@@', '-missing', '+x'].join('\n'))).toMatch(/could not find the context/);
    expect(await read('a.ts')).toBe('real\n');
  });

  it('errors on ambiguous context without a hint; a hint disambiguates', async () => {
    await writeFile(join(wd, 'a.ts'), 'dup\ndup\n');
    expect(await run(['*** Update File: a.ts', '@@', '-dup', '+ONE'].join('\n'))).toMatch(/matches 2 locations/);
    // unchanged
    expect(await read('a.ts')).toBe('dup\ndup\n');
  });

  it('blocks a workspace-escape path (no write)', async () => {
    const out = await run('*** Add File: ../escape.txt\n+pwn');
    expect(out).toMatch(/\[patch failed:/);
    expect(await exists('../escape.txt')).toBe(false);
  });

  it('blocks a sensitive file (.env)', async () => {
    const out = await run(['*** Add File: .env', '+SECRET=1'].join('\n'));
    expect(out).toMatch(/not permitted/);
  });

  it('refuses Add when the file already exists; Move when dst exists', async () => {
    await writeFile(join(wd, 'a.ts'), 'exists');
    expect(await run('*** Add File: a.ts\n+x')).toMatch(/already exists/);
    await writeFile(join(wd, 'b.ts'), 'dst');
    await writeFile(join(wd, 'c.ts'), 'src');
    expect(await run('*** Move File: c.ts -> b.ts')).toMatch(/already exists/);
  });

  it('returns a clear marker for a parse error and for a no-op patch', async () => {
    expect(await run('*** Update File: x.ts\n*** End Patch')).toMatch(/\[patch failed: Parse error/);
    expect(await run('')).toBe('[patch: no operations]');
  });

  it('non-string input never throws — returns a clean marker', async () => {
    expect(await (tool.execute({ input: 42 } as unknown, CTX) as Promise<string>)).toBe('[patch: no operations]');
  });

  // I3 — a ws-tolerant match must NOT rewrite unchanged CONTEXT lines.
  it('preserves trailing whitespace on unchanged context lines (ws-tolerant match)', async () => {
    await writeFile(join(wd, 'a.ts'), 'foo   \nbar\nbaz\n'); // 'foo' has trailing spaces
    // Patch writes the context line 'foo' WITHOUT the trailing spaces, changes 'bar'.
    const out = await run(['*** Update File: a.ts', '@@', ' foo', '-bar', '+BAR', ' baz'].join('\n'));
    expect(out).toContain('modified');
    // The context line keeps its original trailing spaces; only 'bar' changed.
    expect(await read('a.ts')).toBe('foo   \nBAR\nbaz\n');
  });

  // I4 — a hint that sits INSIDE the first matching block must select that block.
  it('hint inside the first matching block selects that block (not a later one)', async () => {
    await writeFile(join(wd, 'a.ts'), 'alpha\nTARGET\nbeta\ngamma\nalpha\nTARGET\nbeta\n');
    const out = await run(['*** Update File: a.ts', '@@ TARGET @@', ' alpha', ' TARGET', '-beta', '+BETA1'].join('\n'));
    expect(out).toContain('modified');
    // The FIRST block's beta becomes BETA1; the second block is untouched.
    expect(await read('a.ts')).toBe('alpha\nTARGET\nBETA1\ngamma\nalpha\nTARGET\nbeta\n');
  });

  // I4 — addition-only with a present-but-unmatched hint must ERROR, never silently EOF-append.
  it('addition-only hunk with a non-matching hint errors (no silent EOF append)', async () => {
    await writeFile(join(wd, 'a.ts'), 'one\ntwo\n');
    const out = await run(['*** Update File: a.ts', '@@ NOPE @@', '+inserted'].join('\n'));
    expect(out).toMatch(/addition hint "NOPE" not found/);
    expect(await read('a.ts')).toBe('one\ntwo\n'); // untouched
  });

  // I1 — Phase 2 is ALL-OR-NOTHING: a mid-write failure rolls back earlier writes.
  it('rolls back a committed write when a later write in the same patch fails', async () => {
    // Add 'roll/a' (a file), then 'roll/a/b' — Phase 1 passes (both absent), but Phase
    // 2 writes 'roll/a' then mkdir('roll/a') fails (it is a file) → rollback removes 'roll/a'.
    const out = await run(
      ['*** Begin Patch', '*** Add File: roll/a', '+x', '*** Add File: roll/a/b', '+y', '*** End Patch'].join('\n'),
    );
    expect(out).toMatch(/rolled back/);
    expect(await exists('roll/a')).toBe(false); // the committed write was undone
    expect(await exists('roll/a/b')).toBe(false);
  });

  // I2 — readContent must not treat EISDIR as "absent" (would pass validation then explode).
  it('Add onto an existing directory fails cleanly in validation (no partial apply)', async () => {
    await mkdir(join(wd, 'adir'), { recursive: true });
    const out = await run(['*** Begin Patch', '*** Add File: keep.txt', '+v', '*** Add File: adir', '+x', '*** End Patch'].join('\n'));
    expect(out).toMatch(/\[patch failed:/);
    expect(await exists('keep.txt')).toBe(false); // earlier op never committed (Phase 1 aborted)
  });

  it('updates a file with no trailing newline', async () => {
    await writeFile(join(wd, 'a.ts'), 'only'); // no trailing \n
    const out = await run(['*** Update File: a.ts', '@@', '-only', '+ONLY'].join('\n'));
    expect(out).toContain('modified');
    expect(await read('a.ts')).toBe('ONLY');
  });
});

describe('applyHunk — addition-only placement', () => {
  it('inserts after a unique hint line', () => {
    const out = applyHunk('a\nb\nc\n', { contextHint: 'b', lines: [{ prefix: '+', content: 'INSERTED' }] });
    expect(out).toBe('a\nb\nINSERTED\nc\n');
  });

  it('appends at EOF when there is no hint', () => {
    const out = applyHunk('a\nb', { contextHint: null, lines: [{ prefix: '+', content: 'END' }] });
    expect(out).toBe('a\nb\nEND');
  });

  it('EOF append preserves a trailing newline when the file had one', () => {
    const out = applyHunk('a\nb\n', { contextHint: null, lines: [{ prefix: '+', content: 'END' }] });
    expect(out).toBe('a\nb\nEND\n'); // not 'a\nb\nEND' (lost newline) nor 'a\nb\n\nEND' (stray blank)
  });
});
