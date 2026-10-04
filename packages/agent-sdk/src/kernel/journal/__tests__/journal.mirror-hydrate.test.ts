import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { NewEntry } from '../../../contract/journal.js';

/**
 * Bedrock S5 Phase 4 — hydrate ordering (the mirror-read write-through).
 *
 * hydrate order = volume-JSONL-if-present-and-nonempty ELSE mirror-fetch-with-
 * write-through-to-local-JSONL, gated by the `hydrateFromMirror` dep (wired to
 * KERNEL_JOURNAL_MIRROR in query-manager). So:
 *  - populated volume ................ mirror NOT consulted (byte-identical to today)
 *  - empty volume + flag on .......... mirror hydrates + writes through, contiguous seqs
 *  - empty volume + flag off ......... mirror NOT consulted (byte-identical: today's empty)
 */

const dir = join(tmpdir(), `journal-mirror-hydrate-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

let n = 0;
const path = (): string => join(dir, `t-${n++}.jsonl`);
const userMsg = (text: string): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: '',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});
const clock = (): ReturnType<typeof sequentialClock> => sequentialClock('2026-01-01T00:00:00.000Z');

describe('Journal hydrate — mirror write-through (Bedrock S5 P4)', () => {
  it('empty volume + flag ON: hydrates from the mirror and WRITES THROUGH to the local JSONL, contiguous seqs', async () => {
    // Seed a shared mirror by running a "prior host" journal that flushes to it.
    const mirror = new InMemorySessionStore();
    const priorPath = path();
    const prior = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(priorPath), mirror, clock: clock() });
    await prior.append(userMsg('one'));
    await prior.append(userMsg('two'));
    await prior.append(userMsg('three'));
    await prior.flushMirror();

    // Fresh machine: empty local JSONL, same mirror, flag ON.
    const freshPath = path();
    const fresh = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(freshPath), mirror, clock: clock(), hydrateFromMirror: true });

    const state = await fresh.project();
    expect(state.messages.map((m) => (m.payload as { blocks: Array<{ text: string }> }).blocks[0].text)).toEqual(['one', 'two', 'three']);
    expect(state.messages.map((m) => m.seq)).toEqual([0, 1, 2]); // contiguous, no gaps/dups

    // WRITE-THROUGH: the entries are now on the local disk — a fresh Journal over the
    // same file (no mirror) reconstructs identically, proving persistence.
    const reread = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(freshPath), mirror: new InMemorySessionStore(), clock: clock() });
    const rereadState = await reread.project();
    expect(rereadState.messages).toHaveLength(3);

    // The NEXT append continues the chain from the hydrated leaf: seq 3, no restart.
    const next = await fresh.append(userMsg('four'));
    expect(next.seq).toBe(3);
    expect(next.parentUuid).toBe(state.messages[2].uuid);
  });

  it('populated volume: the mirror is NEVER consulted (byte-identical to today)', async () => {
    const mirror = new InMemorySessionStore();
    const loadSpy = vi.spyOn(mirror, 'load');
    // A local JSONL that already has entries.
    const p = path();
    const seed = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(), clock: clock() });
    await seed.append(userMsg('local-a'));
    await seed.append(userMsg('local-b'));

    // Same file, flag ON, but the volume is populated → mirror must be skipped.
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock(), hydrateFromMirror: true });
    const state = await j.project();
    expect(state.messages).toHaveLength(2);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('empty volume + flag OFF: the mirror is NEVER consulted (byte-identical: empty stays empty)', async () => {
    const mirror = new InMemorySessionStore();
    await mirror.appendBatch('t', [{ ...userMsg('ghost'), uuid: 'x', parentUuid: null, seq: 0 } as never]);
    const loadSpy = vi.spyOn(mirror, 'load');

    // Flag OFF (hydrateFromMirror omitted) — the default path never touches the mirror.
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock() });
    const state = await j.project();
    expect(state.messages).toHaveLength(0);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('empty volume + flag ON but EMPTY mirror: stays empty (fresh task), no throw', async () => {
    const mirror = new InMemorySessionStore();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true });
    const state = await j.project();
    expect(state.messages).toHaveLength(0);
    // A first append on a genuinely-fresh task starts at seq 0.
    const first = await j.append(userMsg('hi'));
    expect(first.seq).toBe(0);
    expect(first.parentUuid).toBeNull();
  });

  /**
   * 2026-09-28. `load` used to answer null for "unreachable" too, and null reads as "the
   * mirror holds nothing", so a task whose local journal the tidy sweeper had pruned came
   * back as a new conversation at seq 0 — and those seqs collided with the ones the mirror
   * still held, so the new turns never mirrored either. A read that cannot answer now
   * throws: the call (and its turn) fails, nothing is written, and the next call retries.
   */
  it('a mirror read that fails fails the call, writes NOTHING, and the retry hydrates everything', async () => {
    const mirror = new InMemorySessionStore();
    const prior = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock() });
    for (const text of ['one', 'two', 'three']) await prior.append(userMsg(text));
    await prior.flushMirror();

    // The local journal is gone (the sweeper pruned it: the mirror holds it whole), and the
    // relay is out when the task wakes.
    const pruned = path();
    const load = vi.spyOn(mirror, 'load').mockRejectedValueOnce(new Error('relay unreachable'));
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(pruned), mirror, clock: clock(), hydrateFromMirror: true });

    await expect(j.append(userMsg('four'))).rejects.toThrow('relay unreachable');
    await expect(fs.stat(pruned)).rejects.toMatchObject({ code: 'ENOENT' }); // no seq-0 file

    // The relay is back; the same Journal (the task's actor keeps it) tries again.
    const next = await j.append(userMsg('four'));
    expect(next.seq).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
    const texts = (await j.project()).messages.map((m) => (m.payload as { blocks: Array<{ text: string }> }).blocks[0].text);
    expect(texts).toEqual(['one', 'two', 'three', 'four']);
  });

  /**
   * #3975 re-review. The write-through appended line by line, so a hydration that died after k
   * lines (ENOSPC, EIO, a kill) left a NON-empty file: the retry skipped the mirror, resumed
   * from the prefix, and its new entries collided with the seqs the mirror holds (dropped by
   * ignoreDuplicates). Now the file appears whole or not at all.
   */
  it('a hydration that fails mid-write leaves NO journal file, and the retry hydrates all of it', async () => {
    const mirror = new InMemorySessionStore();
    const prior = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock() });
    for (const text of ['one', 'two', 'three']) await prior.append(userMsg(text));
    await prior.flushMirror();
    const held = (await mirror.load('t'))!;
    // The second entry cannot be written (what ENOSPC does to the real write).
    const dying = [held[0], { ...held[1], toJSON: () => { throw new Error('ENOSPC: no space left on device'); } }, held[2]];
    vi.spyOn(mirror, 'load').mockResolvedValueOnce(dying as never);

    const p = path();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock(), hydrateFromMirror: true });
    await expect(j.append(userMsg('four'))).rejects.toThrow('ENOSPC');
    await expect(fs.stat(p)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${p}.hydrating`)).rejects.toMatchObject({ code: 'ENOENT' });

    const next = await j.append(userMsg('four'));
    expect(next.seq).toBe(3);
    const reread = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(), clock: clock() });
    const texts = (await reread.project()).messages.map((m) => (m.payload as { blocks: Array<{ text: string }> }).blocks[0].text);
    expect(texts).toEqual(['one', 'two', 'three', 'four']);
  });

  it('a leftover .hydrating from a hydration that was killed is never read', async () => {
    const mirror = new InMemorySessionStore();
    const prior = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock() });
    for (const text of ['one', 'two']) await prior.append(userMsg(text));
    await prior.flushMirror();
    const p = path();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${p}.hydrating`, `${JSON.stringify({ ...(await mirror.load('t'))![0], seq: 0 })}\n`); // a prefix

    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock(), hydrateFromMirror: true });
    expect((await j.project()).messages).toHaveLength(2);
    await expect(fs.stat(`${p}.hydrating`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readFile(p, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  /**
   * Two tasks the mirror cannot hold, so its read may not decide whether they start (the
   * callers name them: Journal.hintNew). A teammate or helper this process MINTED: the read
   * is not even asked, because the child's tasks row does not exist yet and the server
   * refuses it (403), which failed every spawn. And a task's FIRST message: a read that fails
   * starts it fresh, loudly, when no local file exists.
   */
  it('a MINTED task never asks the mirror: a refusing read cannot fail its spawn', async () => {
    const mirror = new InMemorySessionStore();
    const load = vi.spyOn(mirror, 'load').mockRejectedValue(new Error('RelaySessionStore.load: 403'));
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true });

    j.hintNew('minted');
    const first = await j.append(userMsg('the def'));

    expect(first.seq).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('a FIRST turn whose mirror read fails starts fresh when no local file exists, and says so once', async () => {
    const mirror = new InMemorySessionStore();
    vi.spyOn(mirror, 'load').mockRejectedValue(new Error('relay unreachable'));
    const events: unknown[] = [];
    const j = new Journal({
      taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true,
      onIntegrityEvent: (e) => events.push(e),
    });

    j.hintNew('first-turn');
    const first = await j.append(userMsg('hello'));

    expect(first.seq).toBe(0);
    expect(events).toEqual([{ kind: 'mirror_unreadable_started_fresh', detail: 'relay unreachable' }]);
  });

  it('a first-turn hint never overrides a local file: with one present, a failed read still fails', async () => {
    const mirror = new InMemorySessionStore();
    vi.spyOn(mirror, 'load').mockRejectedValue(new Error('relay unreachable'));
    const p = path();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p, ''); // present but empty: hydrate asks the mirror, and cannot tell
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock(), hydrateFromMirror: true });

    j.hintNew('first-turn');

    await expect(j.append(userMsg('hello'))).rejects.toThrow('relay unreachable');
  });

  it('with no hint (a later turn of a pruned task), a failed read still fails', async () => {
    const mirror = new InMemorySessionStore();
    vi.spyOn(mirror, 'load').mockRejectedValue(new Error('relay unreachable'));
    const p = path();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clock(), hydrateFromMirror: true });

    await expect(j.append(userMsg('again'))).rejects.toThrow('relay unreachable');
    await expect(fs.stat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a first-turn hint does not demote a minted one', async () => {
    const mirror = new InMemorySessionStore();
    const load = vi.spyOn(mirror, 'load').mockRejectedValue(new Error('RelaySessionStore.load: 403'));
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true });

    j.hintNew('minted');
    j.hintNew('first-turn');
    await j.append(userMsg('the def'));

    expect(load).not.toHaveBeenCalled();
  });

  it('consults the mirror at most once (hydration is memoized)', async () => {
    const mirror = new InMemorySessionStore();
    const loadSpy = vi.spyOn(mirror, 'load');
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path()), mirror, clock: clock(), hydrateFromMirror: true });
    await j.project();
    await j.leaf();
    await j.project();
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
