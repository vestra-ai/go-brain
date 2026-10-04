import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { NewEntry } from '../../../contract/journal.js';

const entry = (text: string): NewEntry => ({
  taskId: 't1', rootTaskId: 't1', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: '',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});

describe('Journal autoFlushMs (continue anywhere §6.3, Mac lane)', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes once, autoFlushMs after the LAST append', async () => {
    vi.useFakeTimers();
    const mirror = new InMemorySessionStore();
    const spy = vi.spyOn(mirror, 'appendBatch');
    const j = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl')), mirror, autoFlushMs: 2000 });
    await j.append(entry('a'));
    await vi.advanceTimersByTimeAsync(1500);
    await j.append(entry('b'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await mirror.load('t1'))!.length).toBe(2);
  });

  it('a busy stretch still mirrors: appends every 1 s flush at 2 x autoFlushMs after the first, not never', async () => {
    vi.useFakeTimers();
    const mirror = new InMemorySessionStore();
    const spy = vi.spyOn(mirror, 'appendBatch');
    const j = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl')), mirror, autoFlushMs: 2000 });
    await j.append(entry('a'));                                  // t=0: the quiet stretch ends, the max wait arms
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await j.append(entry(`b${i}`));                            // t=1,2,3: each re-arms the debounce only
    }
    await vi.advanceTimersByTimeAsync(900);                      // t=3.9
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);                      // t=4.1: the max wait fired
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await mirror.load('t1'))!.length).toBe(4);
    expect(vi.getTimerCount()).toBe(0);                          // both timers gone with the flush
    await j.append(entry('c'));                                  // the next stretch arms afresh
    await vi.advanceTimersByTimeAsync(2100);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('topSeq and oldestPendingSeq: the journal top, and the oldest entry the mirror has yet to get', async () => {
    const mirror = new InMemorySessionStore();
    const j = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl')), mirror });
    expect(j.topSeq).toBeUndefined();
    expect(j.oldestPendingSeq).toBeUndefined();
    await j.append(entry('a')); await j.append(entry('b'));
    expect([j.topSeq, j.oldestPendingSeq]).toEqual([1, 0]);
    await j.flushMirror();
    expect([j.topSeq, j.oldestPendingSeq]).toEqual([1, undefined]);
    await j.append(entry('c'));
    expect([j.topSeq, j.oldestPendingSeq]).toEqual([2, 2]);
  });

  it('absent autoFlushMs: never flushes on its own (today)', async () => {
    vi.useFakeTimers();
    const mirror = new InMemorySessionStore();
    const spy = vi.spyOn(mirror, 'appendBatch');
    const j = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl')), mirror });
    await j.append(entry('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('an auto-flush that fires while a catch-up checks the queue against a changed file returns at once', async () => {
    vi.useFakeTimers();
    const mirror = new InMemorySessionStore();
    const spy = vi.spyOn(mirror, 'appendBatch');
    let reached!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let hold = false;
    /** The catch-up's re-read of the changed file waits here, with the flush gate held. */
    class HeldStore extends JsonlStore {
      override repairTail(): Promise<void> {
        if (!hold) return super.repairTail();
        hold = false;
        reached();
        return gate.then(() => super.repairTail());
      }
    }
    const p = join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl');
    const j = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new HeldStore(p), mirror, hydrateFromMirror: true, autoFlushMs: 2000 });
    const one = await j.append(entry('a'));
    await vi.advanceTimersByTimeAsync(2000);                     // 'a' mirrors itself
    expect(spy).toHaveBeenCalledTimes(1);
    await j.append(entry('b'));                                  // queued: its auto-flush is due in 2 s
    await j.snapshot();                                          // read since: the next change is not ours
    await fs.writeFile(p, await fs.readFile(p));                 // rewritten from outside, same entries
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);
    hold = true;
    const caught = j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid });
    await atGate;
    expect(j.needsCatchUp).toBe(false);                          // the gate is held while the queue is checked, its own (no refusal)
    await vi.advanceTimersByTimeAsync(2000);                     // 'b's auto-flush fires inside it ...
    expect(spy).toHaveBeenCalledTimes(1);                        // ... and sends nothing
    release();
    expect(await caught).toBe('ahead');
    expect(j.needsCatchUp).toBe(false);
    expect(j.pendingMirrorCount).toBe(1);                        // the file holds it: the queue stays
    await j.flushMirror();
    expect((await mirror.load('t1'))!.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('a rebuild drops the queue and forgets its pending auto-flush', async () => {
    vi.useFakeTimers();
    const mirror = new InMemorySessionStore();
    const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'af-')), 't1.jsonl');
    const mac = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(tmp()), mirror });
    await mac.append(entry('a')); await mac.append(entry('b'));
    const top = await mac.append(entry('c'));
    await mac.flushMirror();
    const p = tmp();
    await new JsonlStore(p).replaceWith([(await mac.snapshot())[0]]); // this computer saw only the first turn
    const cloud = new Journal({ taskId: 't1', workspaceId: 'w', clock: sequentialClock('2026-10-02T00:00:00.000Z'),
      jsonl: new JsonlStore(p), mirror, hydrateFromMirror: true, autoFlushMs: 2000 });
    await cloud.append(entry('x'));                              // on the stale copy: its auto-flush (and max wait) is armed
    expect(vi.getTimerCount()).toBe(2);
    expect(await cloud.catchUp({ maxSeq: top.seq, lastUuid: top.uuid })).toBe('rehydrated');
    expect(vi.getTimerCount()).toBe(0);
    expect(cloud.pendingMirrorCount).toBe(0);
  });
});
