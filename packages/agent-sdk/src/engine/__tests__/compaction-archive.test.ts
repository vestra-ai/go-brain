import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDroppedEntries } from '../compaction-archive.js';
import type { JournalEntry } from '../../contract/journal.js';

const workingDir = join(tmpdir(), `compaction-archive-test-${process.pid}`);
afterEach(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });

const entry = (payload: JournalEntry['payload'], seq = 0): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't',
  spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload,
});

describe('archiveDroppedEntries', () => {
  it('writes the rendered span to a namespaced path and returns it', async () => {
    const droppedEntries = [entry({ type: 'user', blocks: [{ type: 'text', text: 'dropped context' }] })];
    const result = await archiveDroppedEntries({ droppedEntries, workingDir, taskId: 'task-1', thread: 'thread-a' });
    expect(result.path).toBe('.kernel-archive/task-1/thread-a.md');
    const onDisk = await fs.readFile(join(workingDir, result.path!), 'utf8');
    expect(onDisk).toContain('dropped context');
  });

  it('returns no path (no-op) for an empty dropped span — nothing to archive', async () => {
    const result = await archiveDroppedEntries({ droppedEntries: [], workingDir, taskId: 'task-1', thread: 'thread-a' });
    expect(result.path).toBeUndefined();
    await expect(fs.access(join(workingDir, '.kernel-archive'))).rejects.toThrow();
  });

  it('degrades gracefully (never throws) when the write fails', async () => {
    await fs.mkdir(workingDir, { recursive: true });
    const blockerFile = join(workingDir, 'not-a-dir');
    await fs.writeFile(blockerFile, 'x');
    const droppedEntries = [entry({ type: 'user', blocks: [{ type: 'text', text: 'x' }] })];
    const result = await archiveDroppedEntries({ droppedEntries, workingDir: blockerFile, taskId: 't', thread: 'th' });
    expect(result.path).toBeUndefined();
  });
});
