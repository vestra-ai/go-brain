/**
 * read-tool.tool-error.test.ts — Hardening-G proof (tool 2/2).
 *
 * The Read tool's failure paths return typed error SENTINELs (never-throw): a
 * missing file → `not_found`, a workspace-escaping/bad path → `invalid_input`.
 * The sentinel `.message` is byte-identical to the string returned before, so the
 * flag-OFF dispatcher path reproduces today's behavior exactly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReadTool } from '../read-tool.js';
import { isToolError } from '../tool-types.js';

const workingDir = join(tmpdir(), `read-tool-error-test-${process.pid}`);
afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

const read = (file_path: string) => {
  const tool = makeReadTool(() => workingDir);
  return tool.execute({ file_path }, {});
};

describe('Read tool — error taxonomy sentinels', () => {
  it('a missing file returns a not_found sentinel whose message is the classic "Could not read" string', async () => {
    await fs.mkdir(workingDir, { recursive: true });
    const result = await read('does-not-exist.txt');
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error('unreachable');
    expect(result.__toolError.code).toBe('not_found');
    expect(result.__toolError.message).toMatch(/^Could not read/);
  });

  it('a workspace-escaping path returns an invalid_input sentinel', async () => {
    await fs.mkdir(workingDir, { recursive: true });
    const result = await read('../../etc/passwd');
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error('unreachable');
    expect(result.__toolError.code).toBe('invalid_input');
  });

  it('a readable file still returns numbered content (no sentinel)', async () => {
    await fs.mkdir(workingDir, { recursive: true });
    await fs.writeFile(join(workingDir, 'ok.txt'), 'hello\nworld');
    const result = await read('ok.txt');
    expect(isToolError(result)).toBe(false);
    expect(result).toContain('hello');
  });
});
