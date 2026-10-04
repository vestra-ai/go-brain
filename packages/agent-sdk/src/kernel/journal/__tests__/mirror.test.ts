import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { sequentialClock } from '../clock.js';
import type { NewEntry } from '../../../contract/journal.js';
import type { SessionStore } from '../session-store.js';

const dir = join(tmpdir(), `mirror-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const slowMirror: SessionStore = {
  appendBatch: () => new Promise((r) => setTimeout(r, 5000)),
  load: async () => null, listTasks: async () => [],
};
const failMirror: SessionStore = {
  appendBatch: async () => { throw new Error('pg down'); },
  load: async () => null, listTasks: async () => [],
};
const u = (): NewEntry => ({ taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '', payload: { type: 'system', event: 'x' } });

describe('mirror is off the critical path', () => {
  it('append returns immediately even when the mirror is slow', async () => {
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 't.jsonl')), mirror: slowMirror, clock: sequentialClock('T') });
    const start = Date.now();
    await j.append(u());
    expect(Date.now() - start).toBeLessThan(1000); // did NOT wait 5s
  });
  it('flushMirror swallows mirror failure via onMirrorError, never throws', async () => {
    const onMirrorError = vi.fn();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 't2.jsonl')), mirror: failMirror, clock: sequentialClock('T'), onMirrorError });
    await j.append(u());
    await expect(j.flushMirror()).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledOnce();
  });
});
