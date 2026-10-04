import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStore } from '../jsonl-store.js';
import type { JournalEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `jsonl-test-${process.pid}`);
const path = join(dir, 't.jsonl');
const e = (uuid: string): JournalEntry => ({
  uuid, parentUuid: null, seq: 0, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'system', event: 'x' },
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('JsonlStore', () => {
  it('appends lines and reads them back in order via streaming', async () => {
    const s = new JsonlStore(path);
    await s.append(e('a'));
    await s.append(e('b'));
    const read: string[] = [];
    for await (const entry of s.read()) read.push(entry.uuid);
    expect(read).toEqual(['a', 'b']);
  });

  it("round-trips payload.injected — the volume JSONL is what a WARM RESUME reads", async () => {
    // W4-2. The injection screen's boundary set reads `payload.injected`, and the
    // volume JSONL is the source of truth a resumed task reloads from (the mirror
    // is best-effort). If the write projected fields or the read validated against
    // a whitelist, the marker would vanish across a resume and hook-authored text
    // would silently become a turn boundary and the ask again.
    const s = new JsonlStore(path);
    await s.append({
      ...e('inj'),
      principal: { kind: 'user', userId: 'w' },
      payload: { type: 'user', blocks: [{ type: 'text', text: 'hook context' }], injected: 'hook' },
    });
    const read: JournalEntry[] = [];
    for await (const entry of s.read()) read.push(entry);
    expect(read).toHaveLength(1);
    expect(read[0].payload).toEqual({
      type: 'user',
      blocks: [{ type: 'text', text: 'hook context' }],
      injected: 'hook',
    });
  });

  it('returns empty for a task with no file', async () => {
    const s = new JsonlStore(join(dir, 'none.jsonl'));
    const read: JournalEntry[] = [];
    for await (const entry of s.read()) read.push(entry);
    expect(read).toEqual([]);
  });

  it('skips a torn final line (crash mid-append) instead of throwing', async () => {
    // A valid line followed by a partial/torn JSON line — what a crash mid-append leaves.
    await fs.mkdir(dir, { recursive: true });
    const tornPath = join(dir, 'torn.jsonl');
    await fs.writeFile(tornPath, JSON.stringify(e('valid')) + '\n' + '{"uuid":"torn","par', 'utf8');
    const s = new JsonlStore(tornPath);
    const read: string[] = [];
    // Must not throw — crash recovery depends on replay surviving a torn tail.
    for await (const entry of s.read()) read.push(entry.uuid);
    expect(read).toEqual(['valid']);
  });

  it('fsync resolves after an append (D4) and is a safe no-op for a missing file', async () => {
    const fsyncPath = join(tmpdir(), `fsync-${process.pid}-${Math.random().toString(36).slice(2)}`, 'x.jsonl');
    const store = new JsonlStore(fsyncPath);
    await expect(store.fsync()).resolves.toBeUndefined(); // file not created yet → no-op
    await store.append(e('hi'));
    await expect(store.fsync()).resolves.toBeUndefined(); // durable flush, no throw
  });
});
