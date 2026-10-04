import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `validity-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' } as const, timestamp: '' };
const make = () => new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 't.jsonl')), mirror: new InMemorySessionStore(), clock: sequentialClock('T') });

describe('healOrphanedToolUse', () => {
  it('appends an error tool_result for any tool_use without a matching tool_result', async () => {
    const j = make();
    await j.append({ ...base, payload: { type: 'tool_use', toolUseId: 'x', name: 'bash', input: {} } } as NewEntry);
    await j.healOrphanedToolUse();
    const state = await j.project();
    const results = state.messages.filter((m) => m.payload.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as { isError?: boolean }).isError).toBe(true);
  });

  it('uses the real workspaceId (not empty string) for synthetic entries', async () => {
    const j = make();
    await j.append({ ...base, payload: { type: 'tool_use', toolUseId: 'y', name: 'bash', input: {} } } as NewEntry);
    await j.healOrphanedToolUse();
    const state = await j.project();
    const synth = state.messages.find((m) => m.payload.type === 'tool_result');
    expect(synth?.workspaceId).toBe('w');
  });

  it('does nothing when all tool_use entries have matching tool_result', async () => {
    const j = make();
    await j.append({ ...base, payload: { type: 'tool_use', toolUseId: 'z', name: 'bash', input: {} } } as NewEntry);
    await j.append({ ...base, payload: { type: 'tool_result', toolUseId: 'z', blocks: [] } } as NewEntry);
    await j.healOrphanedToolUse();
    const state = await j.project();
    const results = state.messages.filter((m) => m.payload.type === 'tool_result');
    expect(results).toHaveLength(1); // only the real one, no synthetic added
    expect((results[0].payload as { isError?: boolean }).isError).toBeUndefined();
  });
});
