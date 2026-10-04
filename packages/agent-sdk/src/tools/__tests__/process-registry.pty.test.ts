import { describe, it, expect, afterEach } from 'vitest';
import { spawnBackground, getOutputBlocking, stopProcess } from '../process-registry.js';

const spawned: string[] = [];
afterEach(() => {
  for (const id of spawned) stopProcess(id);
  spawned.length = 0;
});

describe('PTY-backed spawn', () => {
  // BSD script (macOS) requires its own stdin to be a real TTY — vitest runs in a
  // non-TTY process so script emits "tcgetattr/ioctl: Operation not supported on
  // socket" and exits without allocating a pty. The util-linux variant (Linux/CI)
  // does not have this restriction. Guard the TTY-positive assertion to Linux only.
  it.skipIf(process.platform === 'darwin')('reports a TTY when pty:true', async () => {
    // `test -t 1` succeeds only with a tty on stdout; echo proves the branch.
    const id = spawnBackground(`test -t 1 && echo HASTTY || echo NOTTY`, 'task_pty', process.cwd(), { pty: true });
    spawned.push(id);
    const res = await getOutputBlocking(id, 2000);
    expect(res.output).toContain('HASTTY');
  });

  it('has no TTY without pty (default path unchanged)', async () => {
    const id = spawnBackground(`test -t 1 && echo HASTTY || echo NOTTY`, 'task_notty', process.cwd());
    spawned.push(id);
    const res = await getOutputBlocking(id, 2000);
    expect(res.output).toContain('NOTTY');
  });
});
