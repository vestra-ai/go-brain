import { describe, it, expect, afterEach } from 'vitest';
import { spawnBackground, submitStdin, getOutputBlocking, listProcesses, stopProcess } from '../process-registry.js';

const spawned: string[] = [];
afterEach(() => {
  for (const id of spawned) stopProcess(id);
  spawned.length = 0;
});

describe('process-registry stdin + list', () => {
  it('feeds stdin to a running background process', async () => {
    // `cat` echoes whatever it receives on stdin.
    const id = spawnBackground('cat', 'task_a', process.cwd());
    spawned.push(id);
    submitStdin(id, 'ping');
    // cat stays alive; getOutputBlocking resolves on the 500ms timeout with the buffered echo
    const res = await getOutputBlocking(id, 500);
    expect(res.output).toContain('ping');
  });

  it('lists only the owner task\'s processes', () => {
    const a = spawnBackground('sleep 5', 'task_owner_x', process.cwd());
    spawned.push(a);
    const b = spawnBackground('sleep 5', 'task_owner_y', process.cwd());
    spawned.push(b);
    const mine = listProcesses('task_owner_x').map((p) => p.id);
    expect(mine).toContain(a);
    expect(mine).not.toContain(b);
  });

  it('returns a not-found string for stdin to an unknown id', () => {
    expect(submitStdin('bg_nope', 'x')).toMatch(/Unknown background task/);
  });
});
