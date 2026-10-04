/**
 * write-tool.truth.test.ts — Hardening-I Write truth contract.
 *
 * Creating a NEW file needs no prior Read; OVERWRITING an existing file follows the
 * same read-before-write + freshness rule as Edit (a lost-update guard). Enforced
 * only when a per-session store is injected — with none, Write behaves as today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWriteTool } from '../write-tool.js';
import { makeReadTool } from '../read-tool.js';
import { isToolError } from '../tool-types.js';
import { createFileViewState, MSG_UNREAD, MSG_STALE } from '../file-view-state.js';

let WS = '';
afterEach(async () => { if (WS) await fs.rm(WS, { recursive: true, force: true }); WS = ''; });
const freshWs = () => { WS = realpathSync(mkdtempSync(join(tmpdir(), 'write-truth-'))); return WS; };

describe('Write truth contract (store injected)', () => {
  const wire = (ws: string) => {
    const store = createFileViewState();
    return { store, read: makeReadTool(() => ws, store), write: makeWriteTool(() => ws, store) };
  };

  it('creating a NEW file needs no prior Read', async () => {
    const ws = freshWs();
    const { write } = wire(ws);
    const out = await write.execute({ file_path: 'brand-new.txt', content: 'hello' }, {});
    expect(typeof out).toBe('string');
    expect(String(out)).toMatch(/Wrote/);
    expect(await fs.readFile(join(ws, 'brand-new.txt'), 'utf8')).toBe('hello');
  });

  it('records the new file into the store so an immediate overwrite is allowed', async () => {
    const ws = freshWs();
    const { write } = wire(ws);
    await write.execute({ file_path: 'f.txt', content: 'one' }, {});
    // No Read between writes — the first write recorded its own output.
    const out = await write.execute({ file_path: 'f.txt', content: 'two' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(join(ws, 'f.txt'), 'utf8')).toBe('two');
  });

  it('overwriting an EXISTING file never Read this session is refused', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'exists.txt'), 'original');
    const { write } = wire(ws);
    const out = await write.execute({ file_path: 'exists.txt', content: 'clobber' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message).toBe(MSG_UNREAD);
    expect(await fs.readFile(join(ws, 'exists.txt'), 'utf8')).toBe('original'); // untouched
  });

  it('overwriting after a Read succeeds', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'exists.txt'), 'original');
    const { read, write } = wire(ws);
    await read.execute({ file_path: 'exists.txt' }, {});
    const out = await write.execute({ file_path: 'exists.txt', content: 'updated' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(join(ws, 'exists.txt'), 'utf8')).toBe('updated');
  });

  it('overwriting a file changed on disk since the last Read is refused', async () => {
    const ws = freshWs();
    const abs = join(ws, 'exists.txt');
    await fs.writeFile(abs, 'original');
    const { read, write } = wire(ws);
    await read.execute({ file_path: 'exists.txt' }, {});
    await fs.utimes(abs, new Date('2020-06-01T00:00:00Z'), new Date('2020-06-01T00:00:00Z'));
    const out = await write.execute({ file_path: 'exists.txt', content: 'clobber' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('invalid_input');
    expect(out.__toolError.message).toBe(MSG_STALE);
    expect(await fs.readFile(abs, 'utf8')).toBe('original'); // untouched
  });
});

describe('Write byte-compat (no store injected)', () => {
  it('overwriting an existing file without a prior Read still succeeds', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'exists.txt'), 'original');
    const write = makeWriteTool(() => ws); // no store
    const out = await write.execute({ file_path: 'exists.txt', content: 'updated' }, {});
    expect(typeof out).toBe('string');
    expect(await fs.readFile(join(ws, 'exists.txt'), 'utf8')).toBe('updated');
  });
});
