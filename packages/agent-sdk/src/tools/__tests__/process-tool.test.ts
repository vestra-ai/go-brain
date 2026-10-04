import { describe, it, expect, afterEach } from 'vitest';
import { processToolOptions } from '../process-tool.js';
import { spawnBackground, stopProcess } from '../process-registry.js';

const call = (args: Record<string, unknown>) => processToolOptions.execute(args, {}) as Promise<string>;

const spawned: string[] = [];
afterEach(() => {
  for (const id of spawned) stopProcess(id);
  spawned.length = 0;
});

describe('process tool', () => {
  it("reads a background task's output", async () => {
    const id = spawnBackground(`echo hello-proc`, 'task_p', process.cwd(), {});
    spawned.push(id);
    const out = await call({ action: 'read', id, block: true, timeout: 1000 });
    expect(out).toContain('hello-proc');
  });

  it('lists running tasks for the owner is not required (global list ok)', async () => {
    const id = spawnBackground('sleep 5', 'task_p2', process.cwd(), {});
    spawned.push(id);
    const out = await call({ action: 'list' });
    expect(out).toContain(id);
  });

  it('kills a task', async () => {
    const id = spawnBackground('sleep 5', 'task_p3', process.cwd(), {});
    // No push to spawned — kill action handles cleanup
    const out = await call({ action: 'kill', id });
    expect(out).toMatch(/Stopped/);
  });

  it('rejects an unknown action with a model-visible error', async () => {
    const out = await call({ action: 'frobnicate', id: 'bg_x' });
    expect(out).toMatch(/unknown action/i);
  });

  it('blocks a dangerous submit payload (defense-in-depth)', async () => {
    const id = spawnBackground('cat', 'task_blk', process.cwd(), {});
    spawned.push(id);
    const out = await call({ action: 'submit', id, data: 'rm -rf /' });
    expect(out).toMatch(/Blocked dangerous input/i);
  });
});
