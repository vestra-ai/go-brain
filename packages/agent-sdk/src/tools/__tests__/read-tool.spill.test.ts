import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, unlink, symlink, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeReadTool } from '../read-tool.js';
import { webStoreDir } from '../web-content-store.js';

/**
 * Read must be able to page tool-spill files (WebFetch/browser truncate-and-store
 * footers point there) while staying workspace-confined for everything else.
 */

let workspace: string;
// Rejections come back as toolError objects — serialize so assertions see the message.
const read = async (p: string) => {
  const r = await makeReadTool(() => workspace).execute({ file_path: p }, { toolCallId: 'c' });
  return typeof r === 'string' ? r : JSON.stringify(r);
};
const F = join(webStoreDir(), 'webfetch-spillt-g1.txt');

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'spill-ws-'));
  await mkdir(webStoreDir(), { recursive: true });
  await writeFile(F, 'stored middle line\n', 'utf8');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await unlink(F).catch(() => {});
  await unlink(join(webStoreDir(), 'evil-link')).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
});

describe('Read spill-dir allowance', () => {
  it('reads a stored WebFetch file outside the workspace when the flag is on (default)', async () => {
    const out = String(await read(F));
    expect(out).toContain('stored middle line');
  });

  it('rejects the same path when VESTRA_WEBFETCH_STORE is off (byte-identical OFF surface)', async () => {
    vi.stubEnv('VESTRA_WEBFETCH_STORE', '0');
    vi.stubEnv('BROWSER_SNAPSHOT_V1', 'false'); // both spill dirs disabled
    const out = String(await read(F));
    expect(out).toContain('Path escapes the workspace');
  });

  it('rejects a symlink planted inside the spill dir pointing outside it', async () => {
    const secret = join(workspace, 'secret.txt');
    await writeFile(secret, 'SECRET', 'utf8');
    await symlink(secret, join(webStoreDir(), 'evil-link'));
    const out = String(await read(join(webStoreDir(), 'evil-link')));
    // realpath resolves outside the spill dir → not admitted → workspace confinement
    // takes over; the symlink itself is outside the workspace → rejected.
    expect(out).toContain('Path escapes the workspace');
  });

  it('rejects arbitrary /tmp paths outside the spill dirs', async () => {
    const stray = join(tmpdir(), `stray-${process.pid}.txt`);
    await writeFile(stray, 'stray', 'utf8');
    const out = String(await read(stray));
    expect(out).toContain('Path escapes the workspace');
    await unlink(stray).catch(() => {});
  });
});
