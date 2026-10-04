/**
 * bash-tool.tool-error.test.ts — Hardening-G proof (tool 1/2).
 *
 * The Bash tool's failure paths now return a typed error SENTINEL (never-throw)
 * instead of a plain `Command failed:` string, so the dispatcher can map it to the
 * wire is_error channel + a stable code. The sentinel's `.message` is byte-identical
 * to the string it returned before (the flag-OFF dispatcher path reproduces today).
 */
import { describe, it, expect } from 'vitest';
import { makeBashTool } from '../bash-tool.js';
import { isToolError } from '../tool-types.js';

const run = (cmd: string, timeout?: number) => {
  const tool = makeBashTool(() => process.cwd(), 'task_test');
  return tool.execute({ command: cmd, ...(timeout !== undefined ? { timeout } : {}) }, {});
};

describe('Bash tool — error taxonomy sentinels', () => {
  it('a non-zero exit returns an exec_failed sentinel whose message is the classic "Command failed:" string', async () => {
    const result = await run(`node -e "process.stderr.write('nope'); process.exit(3)"`);
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error('unreachable');
    expect(result.__toolError.code).toBe('exec_failed');
    expect(result.__toolError.message).toMatch(/^Command failed:/);
    expect(result.__toolError.message).toContain('nope');
  });

  it('a timed-out command returns a timeout sentinel', async () => {
    // `sleep 2` with a 50ms timeout: node SIGTERMs the child (killed:true). macOS has
    // no shell `timeout`, but `sleep` is a real binary and node enforces the timeout.
    const result = await run('sleep 2', 50);
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error('unreachable');
    expect(result.__toolError.code).toBe('timeout');
  });

  it('a successful command still returns a plain string (no sentinel)', async () => {
    const result = await run('echo hfrom-bash');
    expect(isToolError(result)).toBe(false);
    expect(result).toContain('hfrom-bash');
  });
});
