import { describe, it, expect } from 'vitest';
import { InMemorySessionStore } from '../session-store.js';
import type { JournalEntry } from '../../../contract/journal.js';

const SECRET_PATTERNS = [/sk-[a-z0-9]/i, /bearer\s+/i, /password/i, /api[_-]?key/i, /BLAXEL/i, /SUPABASE_SERVICE/i];
const scan = (e: JournalEntry) => {
  const s = JSON.stringify(e);
  return SECRET_PATTERNS.some((p) => p.test(s));
};
const entry = (taskId: string, workspaceId: string): JournalEntry => ({
  uuid: 'a', parentUuid: null, seq: 0, taskId, rootTaskId: taskId, spawnDepth: 0,
  workspaceId, agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'assistant', blocks: [{ type: 'text', text: 'hello world' } as never] },
});

describe('journal security invariants', () => {
  it('mirrored entries contain no secrets', async () => {
    const s = new InMemorySessionStore();
    await s.appendBatch('t', [entry('t', 'w')]);
    const loaded = (await s.load('t'))!;
    expect(loaded.every((e) => !scan(e))).toBe(true);
  });
  it('listTasks is workspace-scoped (no cross-tenant leakage)', async () => {
    const s = new InMemorySessionStore();
    await s.appendBatch('t1', [entry('t1', 'w1')]);
    await s.appendBatch('t2', [entry('t2', 'w2')]);
    expect(await s.listTasks('w1')).toEqual(['t1']);
    expect(await s.listTasks('w2')).toEqual(['t2']);
  });
});
