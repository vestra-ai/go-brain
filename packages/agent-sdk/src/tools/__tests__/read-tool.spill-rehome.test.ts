import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, symlink, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeReadTool } from '../read-tool.js';
import { isInWorkspace, rehomeSpillPath } from '../fs-util.js';

/**
 * Continue anywhere (CONTINUITY_JOURNAL_V1): a spill stub names its file by an ABSOLUTE path, and a
 * task continued on another computer has its spills fetched into THIS workspace, whose root differs.
 * Read finds the local copy for exactly `<any root>/.kernel-offload/<taskId>/<id>.txt`, still
 * confined; every other path, and every path with the flag off, reads exactly as before.
 */

let workspace: string;
const OTHER = '/Users/someone/Library/Vestra/workspace'; // the other computer's root, absent here
const read = async (p: string) => {
  const r = await makeReadTool(() => workspace).execute({ file_path: p }, { toolCallId: 'c' });
  return typeof r === 'string' ? r : JSON.stringify(r);
};

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rehome-ws-'));
  await mkdir(join(workspace, '.kernel-offload', 'task_1'), { recursive: true });
  await writeFile(join(workspace, '.kernel-offload', 'task_1', 'toolu_01.txt'), 'the long log, fetched here\n', 'utf8');
  vi.stubEnv('CONTINUITY_JOURNAL_V1', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});

describe('Read: a spill stub from another computer (continue anywhere)', () => {
  it('flag on: the other root\'s spill path reads this workspace\'s copy', async () => {
    expect(await read(`${OTHER}/.kernel-offload/task_1/toolu_01.txt`)).toContain('the long log, fetched here');
  });

  it('a path already in this workspace reads as before', async () => {
    expect(await read(join(workspace, '.kernel-offload', 'task_1', 'toolu_01.txt'))).toContain('the long log, fetched here');
  });

  it('a spill path already under this workspace is never rehomed, even when the workspace is a parent of its root', async () => {
    // The spill's own root is a folder INSIDE this workspace (the working dir moved up within a session).
    const nested = join(workspace, 'projects', 'app', '.kernel-offload', 'task_1');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'toolu_01.txt'), 'the nested spill, read where it is\n', 'utf8');
    const out = await read(join(nested, 'toolu_01.txt'));
    expect(out).toContain('the nested spill, read where it is');
    expect(out).not.toContain('the long log, fetched here');
  });

  it.each([
    ['a parent hop after the segment', `${OTHER}/.kernel-offload/../etc/toolu_01.txt`],
    ['a parent hop as the task', `${OTHER}/.kernel-offload/task_1/../toolu_01.txt`],
    ['an extra segment', `${OTHER}/.kernel-offload/task_1/sub/toolu_01.txt`],
    ['a task id with a dot', `${OTHER}/.kernel-offload/task.1/toolu_01.txt`],
    ['a file that is not .txt', `${OTHER}/.kernel-offload/task_1/toolu_01.md`],
    ['a file id with a space', `${OTHER}/.kernel-offload/task_1/tool u.txt`],
    ['no file at all', `${OTHER}/.kernel-offload/task_1`],
  ])('%s is never rehomed, and stays confined (naming the path given)', async (_, p) => {
    const out = await read(p);
    expect(out).toContain(`Path escapes the workspace: ${p}`);
    expect(out).not.toContain('the long log');
  });

  it('a rehomed path is still realpath-confined: a planted link out of the workspace is refused, naming the path given', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'rehome-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'SECRET', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(workspace, '.kernel-offload', 'task_1', 'evil.txt'));
    const p = `${OTHER}/.kernel-offload/task_1/evil.txt`;
    const out = await read(p);
    expect(out).toContain(`Path escapes the workspace: ${p}`);
    expect(out).not.toContain('SECRET');
    await rm(outside, { recursive: true, force: true });
  });

  it.each([undefined, 'false', '1'])('flag %s: unchanged, the other root\'s path escapes the workspace as before', async (value) => {
    if (value === undefined) delete process.env.CONTINUITY_JOURNAL_V1;
    else vi.stubEnv('CONTINUITY_JOURNAL_V1', value);
    const p = `${OTHER}/.kernel-offload/task_1/toolu_01.txt`;
    expect(await read(p)).toContain(`Path escapes the workspace: ${p}`);
  });
});

describe('isInWorkspace', () => {
  it('answers by the lexical check: inside, the root itself, or outside', () => {
    expect(isInWorkspace('/ws/a/.kernel-offload/t/c.txt', '/ws')).toBe(true);
    expect(isInWorkspace('/ws', '/ws')).toBe(true);
    expect(isInWorkspace('/ws2/.kernel-offload/t/c.txt', '/ws')).toBe(false);
    expect(isInWorkspace('/ws/../other/c.txt', '/ws')).toBe(false);
  });
});

describe('rehomeSpillPath', () => {
  it('takes the LAST .kernel-offload segment and exactly <taskId>/<id>.txt after it', () => {
    expect(rehomeSpillPath('/a/.kernel-offload/x/.kernel-offload/t-1/c_2.txt', '/ws')).toBe('/ws/.kernel-offload/t-1/c_2.txt');
    expect(rehomeSpillPath('/a/.kernel-offload/t/c.txt', '/ws')).toBe('/ws/.kernel-offload/t/c.txt');
  });

  it('leaves a relative path, another shape, or a bad id unchanged', () => {
    for (const p of [
      '.kernel-offload/t/c.txt',
      '/a/kernel-offload/t/c.txt',
      '/a/.kernel-offload/t/c.txt/',
      '/a/.kernel-offload//c.txt',
      '/a/.kernel-offload/t/.txt',
      `/a/.kernel-offload/${'t'.repeat(65)}/c.txt`,
    ]) expect(rehomeSpillPath(p, '/ws')).toBe(p);
  });
});
