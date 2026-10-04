/**
 * read-tool.truncation.test.ts — Hardening-I Read truth: truncation honesty,
 * size guard, and read-state recording.
 *
 * A slice that is not the whole file MUST announce itself (exact range + next
 * offset) so a silent 2000-line cutoff can never masquerade as the full file. A
 * whole-file read stays byte-identical (no marker). A too-large whole-file read is
 * refused with `too_large` and pointed at offset/limit or Grep. Every successful
 * read records the file's mtime+size into the injected per-session store.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReadTool } from '../read-tool.js';
import { isToolError } from '../tool-types.js';
import { createFileViewState } from '../file-view-state.js';

const DASH = '–'; // en-dash, matching the marker spec "lines X–Y"

let WS = '';
afterEach(async () => { if (WS) await fs.rm(WS, { recursive: true, force: true }); WS = ''; });
const freshWs = () => { WS = realpathSync(mkdtempSync(join(tmpdir(), 'read-trunc-'))); return WS; };

describe('Read truncation marker', () => {
  it('a whole-file read appends NO marker (byte-identical)', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'small.txt'), 'a\nb\nc'); // 3 lines, no trailing newline
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'small.txt' }, {})) as string;
    expect(out).not.toContain('showing lines');
    expect(out).toMatch(/1\ta/);
    expect(out).toMatch(/3\tc/);
  });

  it('an implicit MAX_LINES truncation appends the exact marker', async () => {
    const ws = freshWs();
    const body = Array.from({ length: 5000 }, (_, i) => `row${i + 1}`).join('\n');
    await fs.writeFile(join(ws, 'big.txt'), body);
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'big.txt' }, {})) as string;
    expect(out.endsWith(`[showing lines 1${DASH}2000 of 5000 total; continue with offset=2001]`)).toBe(true);
    // last shown content line is 2000, and 2001 is NOT shown
    expect(out).toMatch(/2000\trow2000/);
    expect(out).not.toMatch(/2001\trow2001/);
  });

  it('an offset+limit slice reports its exact range and next offset', async () => {
    const ws = freshWs();
    const body = Array.from({ length: 10 }, (_, i) => `n${i + 1}`).join('\n');
    await fs.writeFile(join(ws, 'ten.txt'), body);
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'ten.txt', offset: 3, limit: 2 }, {})) as string;
    expect(out.endsWith(`[showing lines 3${DASH}4 of 10 total; continue with offset=5]`)).toBe(true);
    expect(out).toMatch(/3\tn3/);
    expect(out).toMatch(/4\tn4/);
  });

  it('a slice that happens to reach EOF gets no marker', async () => {
    const ws = freshWs();
    const body = Array.from({ length: 5 }, (_, i) => `x${i + 1}`).join('\n');
    await fs.writeFile(join(ws, 'five.txt'), body);
    const read = makeReadTool(() => ws);
    // offset 3, limit 5 → lines 3..5 which is the tail → whole remainder, ends at EOF
    const out = (await read.execute({ file_path: 'five.txt', offset: 3, limit: 5 }, {})) as string;
    expect(out).not.toContain('showing lines');
  });
});

describe('Read size guard', () => {
  it('refuses a >5MB whole-file read with too_large and points at offset/limit or Grep', async () => {
    const ws = freshWs();
    const p = join(ws, 'huge.bin');
    await fs.writeFile(p, '');
    await fs.truncate(p, 6 * 1024 * 1024); // 6MB sparse, no expensive write
    const read = makeReadTool(() => ws);
    const out = await read.execute({ file_path: 'huge.bin' }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('too_large');
    expect(out.__toolError.message).toMatch(/offset/i);
    expect(out.__toolError.message).toMatch(/grep/i);
  });

  it('allows a >5MB read when narrowed with offset/limit (the escape hatch)', async () => {
    const ws = freshWs();
    const p = join(ws, 'huge.bin');
    await fs.writeFile(p, '');
    await fs.truncate(p, 6 * 1024 * 1024);
    const read = makeReadTool(() => ws);
    const out = await read.execute({ file_path: 'huge.bin', offset: 1, limit: 1 }, {});
    expect(isToolError(out)).toBe(false);
    expect(typeof out).toBe('string');
  });

  it('refuses even a narrowed read above the hard ceiling', async () => {
    const ws = freshWs();
    const p = join(ws, 'colossal.bin');
    await fs.writeFile(p, '');
    await fs.truncate(p, 101 * 1024 * 1024); // 101MB sparse, refused before any read
    const read = makeReadTool(() => ws);
    const out = await read.execute({ file_path: 'colossal.bin', offset: 1, limit: 1 }, {});
    expect(isToolError(out)).toBe(true);
    if (!isToolError(out)) throw new Error('unreachable');
    expect(out.__toolError.code).toBe('too_large');
  });
});

describe('Read records into the per-session store', () => {
  it('records mtime+size on a successful read when a store is injected', async () => {
    const ws = freshWs();
    const body = 'hello\nworld\n';
    const abs = join(ws, 'rec.txt');
    await fs.writeFile(abs, body);
    const store = createFileViewState();
    const read = makeReadTool(() => ws, store);
    await read.execute({ file_path: 'rec.txt' }, {});
    const rec = store.get(abs);
    expect(rec).toBeDefined();
    expect(rec?.size).toBe(Buffer.byteLength(body, 'utf8'));
    expect(rec?.mtimeMs).toBeGreaterThan(0);
  });

  it('does not throw when no store is injected (store is optional)', async () => {
    const ws = freshWs();
    await fs.writeFile(join(ws, 'nostore.txt'), 'x\ny\nz');
    const read = makeReadTool(() => ws);
    const out = (await read.execute({ file_path: 'nostore.txt' }, {})) as string;
    expect(out).toMatch(/1\tx/);
  });
});
