import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  truncateAndStoreWeb,
  reapTaskWebContent,
  reapWebFetchContent,
  webStoreDir,
} from '../web-content-store.js';

const BUDGET = 1_000;
const bigText = (lines: number) => Array.from({ length: lines }, (_, i) => `line-${i} ${'x'.repeat(40)}`).join('\n');

// This dir is REAL and shared with other test files running in parallel —
// clean up only our own task ids, never rm the whole dir.
const MY_TASKS = ['task1', 't1', 't1x', 'tr1', 'tr2', 'ghost', '../evil/../../id', 'seedy'];
const myFiles = async (id: string) =>
  (await readdir(webStoreDir()).catch(() => [] as string[])).filter((f) => f.startsWith(`webfetch-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const id of MY_TASKS) await reapTaskWebContent(id);
});

describe('truncateAndStoreWeb', () => {
  it('returns text unchanged when at or under budget', async () => {
    const t = 'short text';
    expect(await truncateAndStoreWeb(t, 'task1', BUDGET)).toBe(t);
    expect(await myFiles('task1')).toEqual([]); // nothing written
  });

  it('over budget: writes full text, returns head+tail window with Read footer', async () => {
    const text = bigText(100);
    const out = await truncateAndStoreWeb(text, 'task1', BUDGET);
    expect(out).toContain('line-0'); // head kept
    expect(out).toContain('line-99'); // tail kept
    expect(out).toContain('lines omitted'); // middle marker
    const m = out.match(/Read\(file_path="([^"]+)", offset=(\d+), limit=(\d+)\)/);
    expect(m).not.toBeNull();
    const stored = await readFile(m![1], 'utf8');
    expect(stored).toBe(text); // nothing lost
    // the Read offset points into the omitted middle: that full line is absent inline
    const offsetLine = text.split('\n')[Number(m![2]) - 1]; // offset is 1-based
    expect(out).not.toContain(`${offsetLine}\n`);
  });

  it('keeps only 8 generations per task (>= max batch of 5 + history)', async () => {
    for (let g = 0; g < 10; g++) await truncateAndStoreWeb(bigText(100), 'task1', BUDGET);
    const files = await myFiles('task1');
    expect(files.length).toBe(8);
    expect(files.some((f) => f.endsWith('-g10.txt'))).toBe(true); // newest kept
    expect(files.some((f) => f.endsWith('-g1.txt'))).toBe(false); // oldest reaped
  });

  it('seeds the generation counter from disk after a process restart (never re-issues g1 under survivors)', async () => {
    // Simulate surviving files from before a restart: the in-process counter has
    // never seen 'seedy', but g7 already exists on disk.
    await mkdir(webStoreDir(), { recursive: true });
    await writeFile(join(webStoreDir(), 'webfetch-seedy-g7.txt'), 'old', 'utf8');
    const out = await truncateAndStoreWeb(bigText(100), 'seedy', BUDGET);
    expect(out).toContain('webfetch-seedy-g8.txt'); // continues after the survivor
    const files = await myFiles('seedy');
    expect(files).toContain('webfetch-seedy-g7.txt'); // survivor NOT reaped (8-keep window)
    expect(files).toContain('webfetch-seedy-g8.txt');
  });

  it('caps stored full text at 2MB and notes the cap in the footer', async () => {
    const huge = 'y'.repeat(2 * 1024 * 1024 + 500);
    const out = await truncateAndStoreWeb(huge, 'task1', BUDGET);
    const m = out.match(/Read\(file_path="([^"]+)"/);
    const stored = await readFile(m![1], 'utf8');
    expect(stored.length).toBe(2 * 1024 * 1024);
    expect(out).toContain('stored text capped at 2MB');
  });

  it('sanitizes hostile task ids into safe filenames inside the store dir', async () => {
    const out = await truncateAndStoreWeb(bigText(100), '../evil/../../id', BUDGET);
    const m = out.match(/Read\(file_path="([^"]+)"/);
    expect(m![1].startsWith(webStoreDir())).toBe(true);
    expect(m![1]).not.toContain('..');
  });
});

describe('reapTaskWebContent', () => {
  it("removes only the named task's files (prefix-collision safe)", async () => {
    await truncateAndStoreWeb(bigText(100), 't1', BUDGET);
    await truncateAndStoreWeb(bigText(100), 't1x', BUDGET);
    await reapTaskWebContent('t1');
    const files = await readdir(webStoreDir());
    expect(files.some((f) => f.startsWith('webfetch-t1-'))).toBe(false);
    expect(files.some((f) => f.startsWith('webfetch-t1x-'))).toBe(true);
  });

  it('never throws when the store dir does not exist', async () => {
    await expect(reapTaskWebContent('ghost')).resolves.toBeUndefined();
  });
});

// The runner sets TMPDIR on its own process at boot (apps/sandbox runner/tools-env.ts), which
// is AFTER this module is imported. A store dir captured at import would keep the image's small
// overlay /tmp for the life of the process — the exact byte path Phase 2 exists to move.
describe('the store dir follows TMPDIR', () => {
  it('is read at call time, not captured at import', async () => {
    const moved = await mkdtemp(join(tmpdir(), 'web-store-tmpdir-'));
    try {
      vi.stubEnv('TMPDIR', moved);
      expect(webStoreDir()).toBe(join(moved, 'vestra-web'));
      const out = await truncateAndStoreWeb(bigText(100), 'tmpd1', BUDGET);
      expect(out).toContain(join(moved, 'vestra-web'));
      expect(await readdir(join(moved, 'vestra-web'))).toContain('webfetch-tmpd1-g1.txt');
    } finally {
      vi.unstubAllEnvs();
      await rm(moved, { recursive: true, force: true });
    }
  });
});

describe('reapWebFetchContent (task-teardown wrapper)', () => {
  it('no-ops when flag is off', async () => {
    await truncateAndStoreWeb(bigText(100), 'tr1', BUDGET); // store fn is not flag-gated; the wrapper is
    vi.stubEnv('VESTRA_WEBFETCH_STORE', '0');
    await reapWebFetchContent('tr1');
    const files = await readdir(webStoreDir());
    expect(files.some((f) => f.startsWith('webfetch-tr1-'))).toBe(true); // untouched
  });

  it('reaps the task files when flag is on (default) and never throws', async () => {
    await truncateAndStoreWeb(bigText(100), 'tr2', BUDGET);
    await expect(reapWebFetchContent('tr2')).resolves.toBeUndefined();
    const files = await readdir(webStoreDir()).catch(() => [] as string[]);
    expect(files.some((f) => f.startsWith('webfetch-tr2-'))).toBe(false);
  });
});
