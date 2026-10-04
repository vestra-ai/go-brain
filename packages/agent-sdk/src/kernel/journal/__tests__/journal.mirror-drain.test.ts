import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';
import type { SessionStore } from '../session-store.js';

const dir = join(tmpdir(), `mirror-drain-test-${process.pid}`);
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

const u = (): NewEntry => ({ taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '', payload: { type: 'system', event: 'x' } });

const make = (taskId: string, mirror: SessionStore) => new Journal({
  taskId,
  workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror,
  clock: sequentialClock('T'),
});

describe('flushMirror background drain — the mirror reaches EMPTY, not 400', () => {
  it('a 1000-entry backlog fully lands after one awaited flush plus the background chain', async () => {
    // Prod task 95076757 (2026-09-02): a 16-minute turn mirrored exactly 400 of its
    // journal entries — 2 windows x 200 — and the remainder waited for a next turn
    // that never came. The awaited drain stays bounded; the rest must still land.
    const calls: JournalEntry[][] = [];
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { calls.push(b); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-drain', mirror);
    for (let i = 0; i < 1000; i++) await j.append(u());

    vi.useFakeTimers();
    await j.flushMirror();
    expect(calls.flat().length).toBe(400); // the critical path is STILL bounded at 2 windows

    await vi.runAllTimersAsync(); // the background chain
    expect(calls.flat().length).toBe(1000);
    expect(calls.flat().map((e) => e.seq)).toEqual([...Array(1000).keys()]); // in order, exactly once
  });

  it('a failed window stops the chain — the retry stays on the next turn boundary', async () => {
    const attempts: number[] = [];
    const mirror: SessionStore = {
      appendBatch: async (_t, b) => { attempts.push(b.length); throw new Error('pg down'); },
      load: async () => null, listTasks: async () => [],
    };
    const j = make('t-drain-fail', mirror);
    for (let i = 0; i < 1000; i++) await j.append(u());

    vi.useFakeTimers();
    await j.flushMirror();
    expect(attempts).toEqual([200]); // one window tried, then the error path returned

    await vi.runAllTimersAsync();
    expect(attempts).toEqual([200]); // NO background retry storm against a down mirror
  });
});
