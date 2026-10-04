import { describe, it, expect } from 'vitest';
import { InMemorySessionStore } from '../session-store.js';
import type { JournalEntry } from '../../../contract/journal.js';

const entry = (uuid: string, taskId = 't', workspaceId = 'w'): JournalEntry => ({
  uuid, parentUuid: null, seq: 0, taskId, rootTaskId: taskId, spawnDepth: 0,
  workspaceId, agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'system', event: 'x' },
});

describe('InMemorySessionStore', () => {
  it('round-trips batches and lists tasks by workspace', async () => {
    const s = new InMemorySessionStore();
    await s.appendBatch('t', [entry('a'), entry('b')]);
    expect(await s.load('t')).toHaveLength(2);
    expect(await s.load('missing')).toBeNull();
    expect(await s.listTasks('w')).toEqual(['t']);
    expect(await s.listTasks('other')).toEqual([]);
  });
});
