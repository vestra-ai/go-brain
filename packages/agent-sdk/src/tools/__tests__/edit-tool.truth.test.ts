/**
 * edit-tool.truth.test.ts — Hardening-I Edit truth contract.
 *
 * Two axes:
 *  1. Taxonomy: every Edit failure returns a typed toolError SENTINEL (not a plain
 *     string) so isError:true reaches the wire — matching what Read already does.
 *     Messages stay byte-compatible with today (the flag-OFF dispatcher unwraps to
 *     the same string).
 *  2. Read-before-edit + freshness: when a per-session store is injected, editing a
 *     file never Read this session, or one that changed on disk since the last Read,
 *     is refused. With NO store injected the tool behaves exactly as today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEditTool } from '../edit-tool.js';
import { makeReadTool } from '../read-tool.js';
import { isToolError } from '../tool-types.js';
import { createFileViewState, MSG_UNREAD, MSG_STALE } from '../file-view-state.js';

let WS = '';
afterEach(async () => { if (WS) await fs.rm(WS, { recursive: true, force: true }); WS = ''; });
const freshWs = () => { WS = realpathSync(mkdtempSync(join(tmpdir(), 'edit-truth-'))); return WS; };

describe('Edit taxonomy — every failure is a typed sentinel (no store)', () => {
  it('old_string not found → invalid_input sentinel naming the miss', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'e.txt'), 'abc');
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: 'e.txt', old_string: 'zzz', new_string: 'q' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message.toLowerCase()).toContain('not found');
    expect(await fs.readFile(join(ws, 'e.txt'), 'utf8')).toBe('abc'); // no write
  });

  it('multi-match without replace_all → invalid_input sentinel naming the count', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'e.txt'), 'x x x');
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: 'e.txt', old_string: 'x', new_string: 'y' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message).toContain('3');
  });

  it('missing file → not_found sentinel', async () => {
    const ws = freshWs();
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: 'nope.txt', old_string: 'a', new_string: 'b' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('not_found');
    expect(out.__toolError.message).toMatch(/could not read/i);
  });

  it('workspace escape → invalid_input sentinel', async () => {
    const ws = freshWs();
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: '../../etc/hosts', old_string: 'x', new_string: 'y' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
  });

  it('a successful edit still returns the byte-compatible plain string', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'e.txt'), 'hello world');
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: 'e.txt', old_string: 'world', new_string: 'bash' }, {});
    expect(typeof out).toBe('string');
    expect(out).toMatch(/Edited/);
    expect(await fs.readFile(join(ws, 'e.txt'), 'utf8')).toBe('hello bash');
  });

  it('a blocked sensitive file stays a plain string (byte-compat, like Read)', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, '.env'), 'SECRET=1');
    const edit = makeEditTool(() => ws);
    const out = await edit.execute({ file_path: '.env', old_string: 'SECRET', new_string: 'X' }, {});
    expect(typeof out).toBe('string');
    expect(String(out).toLowerCase()).toContain('block');
  });
});

describe('Edit read-before-edit + freshness (store injected)', () => {
  const wire = (ws: string) => {
    const store = createFileViewState();
    return { store, read: makeReadTool(() => ws, store), edit: makeEditTool(() => ws, store) };
  };

  it('editing a file never Read this session is refused', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'a.txt'), 'hello world');
    const { edit } = wire(ws);
    const out = await edit.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'bash' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message).toBe(MSG_UNREAD);
    expect(await fs.readFile(join(ws, 'a.txt'), 'utf8')).toBe('hello world'); // untouched
  });

  it('editing after a Read succeeds', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'a.txt'), 'hello world');
    const { read, edit } = wire(ws);
    await read.execute({ file_path: 'a.txt' }, {});
    const out = await edit.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'bash' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(join(ws, 'a.txt'), 'utf8')).toBe('hello bash');
  });

  it('editing a file changed on disk since the last Read is refused', async () => {
    const ws = freshWs();
    const abs = join(ws, 'a.txt');
    await fs.writeFile(abs, 'hello world');
    const { read, edit } = wire(ws);
    await read.execute({ file_path: 'a.txt' }, {});
    // External change: force a differing mtime explicitly (no timer flake).
    await fs.utimes(abs, new Date('2020-06-01T00:00:00Z'), new Date('2020-06-01T00:00:00Z'));
    const out = await edit.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'bash' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message).toBe(MSG_STALE);
    expect(await fs.readFile(abs, 'utf8')).toBe('hello world'); // untouched
  });

  it('a successful edit refreshes the store so a follow-up edit needs no re-Read', async () => {
    const ws = freshWs();
    const abs = join(ws, 'a.txt');
    await fs.writeFile(abs, 'aaa bbb ccc');
    const { read, edit } = wire(ws);
    await read.execute({ file_path: 'a.txt' }, {});
    await edit.execute({ file_path: 'a.txt', old_string: 'aaa', new_string: 'AAA' }, {});
    // No re-Read between edits — the first edit updated the store to its own write.
    const out = await edit.execute({ file_path: 'a.txt', old_string: 'bbb', new_string: 'BBB' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(abs, 'utf8')).toBe('AAA BBB ccc');
  });

  it('with NO store injected, an edit without a prior Read still succeeds (byte-compat)', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'a.txt'), 'hello world');
    const edit = makeEditTool(() => ws); // no store
    const out = await edit.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'bash' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(join(ws, 'a.txt'), 'utf8')).toBe('hello bash');
  });
});
