import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore, MirrorSeqConflictError, MirrorShortError, type SessionStore } from '../session-store.js';
import type { Clock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

/** Continue anywhere §6.1 — a journal is made at least as new as the mirror's top before a turn. */
const root = join(tmpdir(), `journal-catch-up-${process.pid}`);
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
let n = 0;
const file = (): string => join(root, `d-${n++}`, 't.jsonl');
/** Two computers must mint DIFFERENT uuids, so each clock gets its own prefix. */
const clockFor = (prefix: string): Clock => { let i = 0; return { now: () => '2026-10-02T00:00:00.000Z', uuid: () => `${prefix}-${i++}` }; };
const msg = (text: string): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: '',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});
const make = (path: string, mirror: SessionStore, prefix: string, events?: JournalIntegrityEvent[]): Journal =>
  new Journal({
    taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(path), mirror, clock: clockFor(prefix), hydrateFromMirror: true,
    ...(events ? { onIntegrityEvent: (e: JournalIntegrityEvent) => { events.push(e); } } : {}),
  });
const topOf = async (j: Journal) => { const last = (await j.snapshot()).at(-1)!; return { maxSeq: last.seq, lastUuid: last.uuid }; };
/** A payload type this build does not know (a newer build wrote it): read() quarantines its line. */
const NEWER_PAYLOAD = { type: 'from_a_newer_build', data: 1 } as unknown as JournalEntry['payload'];
/** A whole entry as a previous process wrote it. */
const written = (seq: number, uuid: string, parentUuid: string | null, payload: JournalEntry['payload'] = { type: 'user', blocks: [{ type: 'text', text: uuid } as never] }): JournalEntry => ({
  uuid, parentUuid, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user', userId: 'u' }, timestamp: 'T', payload,
});
const writeLines = async (path: string, lines: string[]): Promise<void> => {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, lines.map((l) => l + '\n').join(''), 'utf8');
};
/** A lossless-shaped mirror: it says which local entries it lacks (owed), so a new process resends them. */
const owing = (inner: InMemorySessionStore): SessionStore => ({
  appendBatch: (t, b) => inner.appendBatch(t, b), load: (t) => inner.load(t), listTasks: (w) => inner.listTasks(w),
  owed: async (t, local) => { const held = await inner.holding(t); return held ? local.filter((e) => e.seq > held.maxSeq) : local.slice(); },
});

describe('Journal.catchUp (continue anywhere §6.1)', () => {
  it('equal tail: current, nothing set aside', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    const j = make(p, mirror, 'mac');
    await j.append(msg('one')); await j.append(msg('two')); await j.flushMirror();
    expect(await j.catchUp(await topOf(j))).toBe('current');
    expect(existsSync(`${p}.superseded`)).toBe(false);
  });

  it('local ahead on the same history: ahead, and the owed entries still flush', async () => {
    const mirror = new InMemorySessionStore();
    const j = make(file(), mirror, 'mac');
    await j.append(msg('one')); await j.flushMirror();
    const top = await topOf(j);
    await j.append(msg('two'));                                   // not flushed yet
    expect(await j.catchUp(top)).toBe('ahead');
    await j.flushMirror();
    expect((await mirror.load('t'))!.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('local behind: set aside, rebuilt from the mirror, the next append follows the mirror', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.append(msg('two')); await mac.append(msg('three')); await mac.flushMirror();
    const macEntries = await mac.snapshot();
    const cloudPath = file();
    await fs.mkdir(join(cloudPath, '..'), { recursive: true });
    await new JsonlStore(cloudPath).replaceWith([macEntries[0]]); // the cloud saw only the first turn
    const events: JournalIntegrityEvent[] = [];
    const cloud = make(cloudPath, mirror, 'cloud', events);
    const top = await topOf(mac);
    expect(await cloud.catchUp(top)).toBe('rehydrated');
    expect(existsSync(`${cloudPath}.superseded`)).toBe(true);
    expect((await cloud.snapshot()).map((e) => e.uuid)).toEqual(macEntries.map((e) => e.uuid));
    const next = await cloud.append(msg('four'));
    expect(next.seq).toBe(top.maxSeq + 1);
    expect(next.parentUuid).toBe(top.lastUuid);
    expect(events).toEqual([{ kind: 'journal_caught_up', verdict: 'behind', mirrorMaxSeq: 2, localMaxSeq: 0 }]);
  });

  it('same top seq, different uuid: diverged, set aside, the mirror wins', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('mac-one')); await mac.flushMirror();
    const cloudPath = file();
    const own = make(cloudPath, new InMemorySessionStore(), 'cloud'); // wrote its own seq 0, never mirrored
    await own.append(msg('cloud-one'));
    const cloud = make(cloudPath, mirror, 'cloud');                    // same file, the real mirror
    const top = await topOf(mac);
    expect(await cloud.catchUp(top)).toBe('diverged');
    expect(existsSync(`${cloudPath}.superseded`)).toBe(true);
    expect((await cloud.snapshot()).map((e) => e.uuid)).toEqual([top.lastUuid]);
    const next = await cloud.append(msg('cloud-two'));
    expect(next.seq).toBe(top.maxSeq + 1);
    expect(next.parentUuid).toBe(top.lastUuid);
  });

  it('empty local with a marker: hydrated through the existing path', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.flushMirror();
    const cloud = make(file(), mirror, 'cloud');
    expect(await cloud.catchUp(await topOf(mac))).toBe('hydrated');
  });

  it('a file a predecessor lands after the catch-up began is still compared: behind is rebuilt, never called hydrated', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.append(msg('two')); await mac.flushMirror();
    const macEntries = await mac.snapshot();
    const cloudPath = file();
    let release!: () => void;
    const predecessor = new Promise<void>((r) => { release = r; });
    const cloud = new Journal({
      taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(cloudPath), mirror, clock: clockFor('cloud'), hydrateFromMirror: true, after: predecessor,
    });
    const caught = cloud.catchUp(await topOf(mac));               // no file yet: the predecessor is still writing
    await new Promise((r) => setTimeout(r, 10));
    await new JsonlStore(cloudPath).replaceWith([macEntries[0]]);  // what it wrote: only the first turn
    release();
    expect(await caught).toBe('rehydrated');
    expect((await cloud.snapshot()).map((e) => e.uuid)).toEqual(macEntries.map((e) => e.uuid));
  });

  it('a journal hinted new still reads the mirror it is rebuilt from (the marker says the mirror holds it)', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.append(msg('two')); await mac.flushMirror();
    const macEntries = await mac.snapshot();
    const cloudPath = file();
    await fs.mkdir(join(cloudPath, '..'), { recursive: true });
    await new JsonlStore(cloudPath).replaceWith([macEntries[0]]);
    const cloud = make(cloudPath, mirror, 'cloud');
    cloud.hintNew('minted');
    expect(await cloud.catchUp(await topOf(mac))).toBe('rehydrated');
    expect((await cloud.snapshot()).map((e) => e.uuid)).toEqual(macEntries.map((e) => e.uuid));
  });

  it('the marker\'s line is a payload this build cannot read, and a readable entry chains from it: ahead, the owed entries flush', async () => {
    // A newer build wrote seq 2; this computer hydrated it, wrote seqs 3-4 on it, and died before the flush.
    const inner = new InMemorySessionStore();
    const m = [written(0, 'm0', null), written(1, 'm1', 'm0'), written(2, 'm2', 'm1', NEWER_PAYLOAD)];
    await inner.appendBatch('t', m);
    const p = file();
    await writeLines(p, [...m, written(3, 'c3', 'm2'), written(4, 'c4', 'c3')].map((e) => JSON.stringify(e)));
    const events: JournalIntegrityEvent[] = [];
    const j = make(p, owing(inner), 'cloud', events);
    expect(await j.catchUp({ maxSeq: 2, lastUuid: 'm2' })).toBe('ahead');
    expect(existsSync(`${p}.superseded`)).toBe(false);
    expect(events.some((e) => e.kind === 'journal_caught_up')).toBe(false);
    await j.flushMirror();
    expect((await inner.load('t'))!.map((e) => e.uuid)).toEqual(['m0', 'm1', 'm2', 'c3', 'c4']);
  });

  it('the marker\'s line is damaged and nothing readable chains from the top: diverged, said to be unverifiable', async () => {
    const mirror = new InMemorySessionStore();
    await mirror.appendBatch('t', [written(0, 'm0', null), written(1, 'm1', 'm0'), written(2, 'm2', 'm1')]);
    const p = file();
    await writeLines(p, [
      JSON.stringify(written(0, 'm0', null)), JSON.stringify(written(1, 'm1', 'm0')),
      '{"uuid":"c2","seq":2,"tor', // damaged in place, with lines after it
      JSON.stringify(written(3, 'c3', 'c2')), JSON.stringify(written(4, 'c4', 'c3')),
    ]);
    const events: JournalIntegrityEvent[] = [];
    const j = make(p, mirror, 'cloud', events);
    expect(await j.catchUp({ maxSeq: 2, lastUuid: 'm2' })).toBe('diverged');
    expect(existsSync(`${p}.superseded`)).toBe(true);
    expect((await j.snapshot()).map((e) => e.uuid)).toEqual(['m0', 'm1', 'm2']);
    expect(events.at(-1)).toEqual({ kind: 'journal_caught_up', verdict: 'diverged', reason: 'unverifiable', mirrorMaxSeq: 2, localMaxSeq: 4 });
  });

  it.each<[string, (rows: JournalEntry[] | null) => JournalEntry[] | null, RegExp, boolean]>([
    ['fewer rows than its marker claims', (rows) => rows!.slice(0, 2), /short of its marker 2/, true],
    ['nothing', () => null, /short of its marker 2/, true],
    ['an error (it cannot tell)', () => { throw new Error('mirror unreachable'); }, /mirror unreachable/, false],
  ])('a rebuild the mirror answers with %s rejects, and the local file is put back byte for byte', async (_, answer, why, short) => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.append(msg('two')); await mac.append(msg('three')); await mac.flushMirror();
    const p = file();
    const own = make(p, new InMemorySessionStore(), 'own');           // this computer's own copy, behind the Mac's
    await own.append(msg('own-one'));
    const before = await fs.readFile(p);
    const shortStore: SessionStore = { appendBatch: (t, b) => mirror.appendBatch(t, b), load: async (t) => answer(await mirror.load(t)), listTasks: (w) => mirror.listTasks(w) };
    const j = make(p, shortStore, 'cloud');
    const err = await j.catchUp(await topOf(mac)).then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toMatch(why);
    expect(err instanceof MirrorShortError).toBe(short); // the runner names this one apart (catchup_failed reason=mirror_short)
    expect((await fs.readFile(p)).equals(before)).toBe(true);
    expect(existsSync(`${p}.superseded`)).toBe(false);
    expect(j.needsCatchUp).toBe(true);                             // that copy stays unflushed
    expect((await j.snapshot()).map((e) => e.uuid)).toEqual(['own-0']);
  });

  it('a failed rebuild that set nothing aside leaves no file, and never takes an older set-aside copy for its own', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.flushMirror();
    const p = file();
    await writeLines(`${p}.superseded`, ['an older set-aside copy']);
    const silent: SessionStore = { appendBatch: async () => {}, load: async () => null, listTasks: async () => [] };
    const j = make(p, silent, 'cloud');
    await expect(j.catchUp(await topOf(mac))).rejects.toThrow(/short of its marker 0/);
    expect(existsSync(p)).toBe(false);
    expect(await fs.readFile(`${p}.superseded`, 'utf8')).toBe('an older set-aside copy\n');
  });

  it('compares the file as it is now: a line written from outside since the hydrate is read, and the next append follows it', async () => {
    const mirror = new InMemorySessionStore();
    await mirror.appendBatch('t', [written(0, 'm0', null), written(1, 'm1', 'm0')]);
    const p = file();
    await writeLines(p, [JSON.stringify(written(0, 'm0', null))]);
    const j = make(p, mirror, 'cloud');
    await j.snapshot();                                            // hydrated: [m0], leaf m0, next seq 1
    // From outside: m1, then a write cut short (a torn tail the next append must not land on).
    await fs.appendFile(p, JSON.stringify(written(1, 'm1', 'm0')) + '\n{"uuid":"tor', 'utf8');
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);
    expect(await j.catchUp({ maxSeq: 1, lastUuid: 'm1' })).toBe('current');
    expect(existsSync(`${p}.superseded`)).toBe(false);
    const next = await j.append(msg('two'));
    expect(next.seq).toBe(2);                                      // local top + 1, never a second seq 1
    expect(next.parentUuid).toBe('m1');
    const onDisk: string[] = [];
    for await (const e of new JsonlStore(p).read()) onDisk.push(e.uuid);
    expect(onDisk).toEqual(['m0', 'm1', next.uuid]);
  });

  it('a file pruned from outside (tidy) right after an append is read again from the mirror: hydrated, the next append follows it', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    const j = make(p, mirror, 'mac');
    await j.append(msg('one'));
    const two = await j.append(msg('two'));                        // no read since: the journal's last act was an append
    await j.flushMirror();
    await fs.rm(p);
    expect(await j.catchUp({ maxSeq: two.seq, lastUuid: two.uuid })).toBe('hydrated');
    const next = await j.append(msg('three'));
    expect(next.seq).toBe(2);
    expect(next.parentUuid).toBe(two.uuid);
    const onDisk: number[] = [];
    for await (const e of new JsonlStore(p).read()) onDisk.push(e.seq);
    expect(onDisk).toEqual([0, 1, 2]);                             // never a file that starts at seq 2
  });

  it('a vanished file with unflushed queued entries: they are sent first, then read back, and the next append follows them', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    const j = make(p, mirror, 'mac');
    await j.append(msg('one'));
    const two = await j.append(msg('two'));
    await j.flushMirror();                                         // the mirror holds 0, 1
    const three = await j.append(msg('three'));                    // queued, never sent
    await fs.rm(p);
    expect(await j.catchUp({ maxSeq: two.seq, lastUuid: two.uuid })).toBe('hydrated');
    const four = await j.append(msg('four'));
    expect(four.seq).toBe(3);
    expect(four.parentUuid).toBe(three.uuid);
    await j.flushMirror();
    const held = (await mirror.load('t'))!;
    expect(held.map((e) => e.seq)).toEqual([0, 1, 2, 3]);          // no seq twice
    expect(held.slice(2).map((e) => e.uuid)).toEqual([three.uuid, four.uuid]);
  });

  it('a vanished file whose queued entries cannot be sent: catch-up rejects, nothing is re-read, the queue stays', async () => {
    const inner = new InMemorySessionStore(); const p = file();
    let down = false;
    const flaky: SessionStore = {
      appendBatch: async (t, b) => { if (down) throw new Error('mirror unreachable'); await inner.appendBatch(t, b); },
      load: (t) => inner.load(t), listTasks: (w) => inner.listTasks(w),
    };
    const j = make(p, flaky, 'mac');
    const one = await j.append(msg('one'));
    await j.flushMirror();
    await j.append(msg('two'));                                    // queued
    down = true;
    await fs.rm(p);
    await expect(j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).rejects.toThrow(/could not be sent; nothing was re-read/);
    expect(j.pendingMirrorCount).toBe(1);
    expect(existsSync(p)).toBe(false);                             // no hydrate wrote the mirror's copy
    expect((await inner.load('t'))!.map((e) => e.uuid)).toEqual([one.uuid]);
  });

  it('a file replaced from outside that does not hold the queued entries: refused, set aside, and nothing of the old queue is sent', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    const sent: string[] = [];
    const watched: SessionStore = {
      appendBatch: async (t, b) => { sent.push(...b.map((e) => e.uuid)); await mirror.appendBatch(t, b); },
      load: (t) => mirror.load(t), listTasks: (w) => mirror.listTasks(w),
    };
    const j = make(p, watched, 'mac');
    const one = await j.append(msg('one'));
    await j.flushMirror();
    await j.append(msg('mine'));                                   // queued as seq 1
    await j.snapshot();                                            // read since: the next change is not ours
    await writeLines(p, [JSON.stringify(one), JSON.stringify(written(1, 'theirs', one.uuid))]);
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);
    expect(await j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).toBe('diverged');
    expect(existsSync(`${p}.superseded`)).toBe(true);
    expect(j.pendingMirrorCount).toBe(0);
    await j.flushMirror();
    expect(sent).toEqual([one.uuid]);
    expect((await j.snapshot()).map((e) => e.uuid)).toEqual([one.uuid]);
  });

  it('a file changed from outside that still holds every queued entry: the queue stays and flushes', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    const j = make(p, mirror, 'mac');
    const one = await j.append(msg('one'));
    await j.flushMirror();
    const two = await j.append(msg('two'));                        // queued
    await j.snapshot();
    await fs.writeFile(p, await fs.readFile(p));                   // rewritten, same entries
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);
    expect(await j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).toBe('ahead');
    expect(j.pendingMirrorCount).toBe(1);
    await j.flushMirror();
    expect((await mirror.load('t'))!.map((e) => e.uuid)).toEqual([one.uuid, two.uuid]);
  });

  it('a refusal (409) that answers the flush a changed-file check waits on stands: the catch-up rebuilds instead of calling it ahead', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    let refuse: ((err: Error) => void) | undefined;
    const held: SessionStore = {
      // The first window goes through; the next is held until the catch-up is waiting on it, then refused.
      appendBatch: async (t, b) => (refuse === undefined && (await mirror.load(t)) === null
        ? mirror.appendBatch(t, b)
        : new Promise<void>((_, reject) => { refuse = reject; })),
      load: (t) => mirror.load(t), listTasks: (w) => mirror.listTasks(w),
    };
    let armed = false;
    class TimedStore extends JsonlStore {
      // The catch-up's own look at the file: the refusal lands just after it, while the check awaits the flush.
      override async mtimeMs(): Promise<number | null> {
        const m = await super.mtimeMs();
        if (armed) { armed = false; setImmediate(() => refuse?.(new MirrorSeqConflictError([{ seq: 1, heldUuid: 'theirs' }]))); }
        return m;
      }
    }
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new TimedStore(p), mirror: held, clock: clockFor('mac'), hydrateFromMirror: true });
    const one = await j.append(msg('one'));
    await j.flushMirror();                                         // the mirror holds 0
    await j.append(msg('two'));                                    // queued as seq 1
    await j.snapshot();                                            // read since: the next change is not ours
    await fs.writeFile(p, await fs.readFile(p));                   // rewritten from outside, same entries
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);
    const flushing = j.flushMirror();                              // seq 1 in flight, held
    armed = true;
    expect(await j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).toBe('diverged');
    await flushing;
    expect(existsSync(`${p}.superseded`)).toBe(true);
    expect((await j.snapshot()).map((e) => e.uuid)).toEqual([one.uuid]);
  });

  it('a file changed from outside whose re-read throws: the queue it never checked is refused, and the next catch-up rebuilds', async () => {
    const mirror = new InMemorySessionStore(); const p = file();
    let broken = false;
    class BrokenStore extends JsonlStore {
      override async *read(): AsyncIterable<JournalEntry> {
        if (broken) throw new Error('EIO: i/o error');
        yield* super.read();
      }
    }
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new BrokenStore(p), mirror, clock: clockFor('mac'), hydrateFromMirror: true });
    const one = await j.append(msg('one'));
    await j.flushMirror();
    await j.append(msg('two'));                                    // queued
    await j.snapshot();
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);                              // touched from outside
    broken = true;
    await expect(j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).rejects.toThrow(/EIO/);
    expect(j.needsCatchUp).toBe(true);                             // never flushed blind against that file
    expect(j.pendingMirrorCount).toBe(1);
    await j.flushMirror();
    expect((await mirror.load('t'))!.map((e) => e.uuid)).toEqual([one.uuid]);
    broken = false;
    expect(await j.catchUp({ maxSeq: one.seq, lastUuid: one.uuid })).toBe('diverged');
    expect(j.pendingMirrorCount).toBe(0);
    expect(existsSync(`${p}.superseded`)).toBe(true);              // the unchecked copy is kept aside
  });

  it('an undo that throws: the rebuild\'s own error surfaces, the set-aside copy is kept, and a later set-aside goes beside it', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('one')); await mac.append(msg('two')); await mac.append(msg('three')); await mac.flushMirror();
    const p = file();
    await make(p, new InMemorySessionStore(), 'own').append(msg('own-one'));
    const before = await fs.readFile(p);
    class StuckStore extends JsonlStore {
      override async undoSetAside(): Promise<void> { throw new Error('EBUSY: cannot put it back'); }
    }
    const short: SessionStore = { appendBatch: (t, b) => mirror.appendBatch(t, b), load: async (t) => (await mirror.load(t))!.slice(0, 2), listTasks: (w) => mirror.listTasks(w) };
    const events: JournalIntegrityEvent[] = [];
    const j = new Journal({
      taskId: 't', workspaceId: 'w', jsonl: new StuckStore(p), mirror: short, clock: clockFor('cloud'), hydrateFromMirror: true,
      onIntegrityEvent: (e) => { events.push(e); },
    });
    const top = await topOf(mac);
    await expect(j.catchUp(top)).rejects.toThrow(/short of its marker 2/);
    expect(events).toContainEqual({ kind: 'journal_catch_up_undo_failed', aside: `${p}.superseded`, detail: 'EBUSY: cannot put it back' });
    expect((await fs.readFile(`${p}.superseded`)).equals(before)).toBe(true);
    await expect(j.catchUp(top)).rejects.toThrow(/short of its marker 2/); // the next copy goes beside it
    expect((await fs.readFile(`${p}.superseded`)).equals(before)).toBe(true);
    expect(existsSync(`${p}.superseded.1`)).toBe(true);
  });

  it('null marker (the mirror holds nothing): current, the local copy stands', async () => {
    const j = make(file(), new InMemorySessionStore(), 'mac');
    await j.append(msg('one'));
    expect(await j.catchUp(null)).toBe('current');
  });

  it('no mirror reads wired (hydrateFromMirror off): current, never sets anything aside', async () => {
    const p = file();
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(), clock: clockFor('x') });
    await j.append(msg('one'));
    expect(await j.catchUp({ maxSeq: 9, lastUuid: 'other' })).toBe('current');
    expect(existsSync(`${p}.superseded`)).toBe(false);
  });

  it('a refused flush marks needsCatchUp, keeps the queue, and the next catch-up rebuilds', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('mac-one')); await mac.flushMirror();
    const refusing = new InMemorySessionStore();
    refusing.appendBatch = async () => { throw new MirrorSeqConflictError([{ seq: 0, heldUuid: 'mac-0' }]); };
    const cloudPath = file();
    const cloud = make(cloudPath, refusing, 'cloud');
    await cloud.append(msg('cloud-one')); await cloud.flushMirror();
    expect(cloud.needsCatchUp).toBe(true);
    expect(cloud.pendingMirrorCount).toBe(1);
    const rebuilt = make(cloudPath, mirror, 'cloud');
    expect(await rebuilt.catchUp(await topOf(mac))).toBe('diverged');
  });

  it('a refused journal stops flushing, and rebuilds even when a stale marker calls it ahead', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('mac-one')); await mac.flushMirror();
    const stale = await topOf(mac);                                // {0, mac-0}: the top before the Mac's next turn
    let sent = 0;
    const refusing: SessionStore = {
      appendBatch: async () => { sent++; throw new MirrorSeqConflictError([{ seq: 1, heldUuid: 'mac-1' }]); },
      load: (t) => mirror.load(t), listTasks: (w) => mirror.listTasks(w),
    };
    const events: JournalIntegrityEvent[] = [];
    const cloudPath = file();
    const cloud = make(cloudPath, refusing, 'cloud', events);
    await cloud.append(msg('cloud-two'));                          // seq 1, on mac-0 hydrated from the mirror
    await mac.append(msg('mac-two')); await mac.flushMirror();      // the Mac wrote its seq 1 first
    await cloud.flushMirror();
    expect(events).toEqual([{ kind: 'mirror_seq_conflict', seqs: [1] }]);
    expect(cloud.needsCatchUp).toBe(true);
    await cloud.flushMirror();                                     // refused: no retry until caught up
    expect(sent).toBe(1);
    expect(await cloud.catchUp(stale)).toBe('diverged');
    expect(existsSync(`${cloudPath}.superseded`)).toBe(true);
    expect((await cloud.snapshot()).map((e) => e.uuid)).toEqual(['mac-0', 'mac-1']);
    expect(cloud.needsCatchUp).toBe(false);
    expect(cloud.pendingMirrorCount).toBe(0);                     // the set-aside copy's queue is dropped
    expect(events.at(-1)).toEqual({ kind: 'journal_caught_up', verdict: 'diverged', mirrorMaxSeq: 0, localMaxSeq: 1 });
  });

  it('a flush in flight when a rebuild starts lands first: its late answer never touches the rebuilt journal', async () => {
    const mirror = new InMemorySessionStore();
    const mac = make(file(), mirror, 'mac');
    await mac.append(msg('mac-one')); await mac.flushMirror();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const racing: SessionStore = {
      // The cloud's first batch is held, then refused (the mirror holds mac's seq 0).
      appendBatch: async (t, b) => {
        if (!first) return mirror.appendBatch(t, b);
        first = false;
        await gate;
        throw new MirrorSeqConflictError([{ seq: 0, heldUuid: 'mac-0' }]);
      },
      // Without the wait, the rebuild's mirror read is what lets the held batch answer: after the reset.
      load: (t) => { release(); return mirror.load(t); },
      listTasks: (w) => mirror.listTasks(w),
    };
    const cloudPath = file();
    await make(cloudPath, new InMemorySessionStore(), 'own').append(msg('own-one')); // its own seq 0, never mirrored
    const cloud = make(cloudPath, racing, 'cloud');
    await cloud.append(msg('cloud-one'));
    const flushing = cloud.flushMirror();
    const timer = setTimeout(() => release(), 100);
    expect(await cloud.catchUp(await topOf(mac))).toBe('diverged');
    clearTimeout(timer);
    await flushing;
    expect(cloud.needsCatchUp).toBe(false);
    await cloud.append(msg('cloud-two'));
    await cloud.flushMirror();
    expect((await mirror.load('t'))!.map((e) => e.uuid)).toEqual(['mac-0', 'cloud-1']);
  });
});

/**
 * R2 (JOURNAL_CHECKPOINT_V1): a journal opened from a checkpoint holds only what its last
 * compaction kept, so the marker's seq may be missing from the read-model. The file decides.
 */
describe('Journal.catchUp over a read-model rebuilt from a checkpoint', () => {
  const USER = { kind: 'user', userId: 'u' } as const;
  const BASE: Omit<NewEntry, 'payload'> = {
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '',
  };
  const text = (t: string) => [{ type: 'text', text: t } as never];
  /** 40 entries e0..e39 the previous process wrote (ask, answer, ...); `unreadable` is a newer build's payload. */
  const history = (unreadable?: number): JournalEntry[] => Array.from({ length: 40 }, (_, seq): JournalEntry => ({
    uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq,
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: 'T',
    principal: seq % 2 === 0 ? USER : { kind: 'system' },
    payload: seq === unreadable ? NEWER_PAYLOAD
      : seq % 2 === 0 ? { type: 'user', blocks: text(`ask ${seq}`) } : { type: 'assistant', blocks: text(`answer ${seq}`) },
  }));

  /** The file: e0..e39, a compaction keeping e36 on (with its checkpoint), then one more turn. */
  async function compacted(unreadable?: number): Promise<string> {
    const p = file();
    await fs.mkdir(join(p, '..'), { recursive: true });
    await fs.writeFile(p, history(unreadable).map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
    const writer = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(), clock: clockFor('w'), checkpoint: true });
    const summary = await writer.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('SUMMARY') } });
    await writer.compact({
      summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: 'e36',
      trigger: 'auto', preTokens: 1000, postTokens: 100, base: BASE,
    });
    await writer.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('and now this') } });
    await writer.append({ ...BASE, payload: { type: 'assistant', blocks: text('done') } });
    return p;
  }
  const reopen = (p: string, mirror: SessionStore): Journal =>
    new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror, clock: clockFor('r'), hydrateFromMirror: true, checkpoint: true });

  it('a re-read from a checkpoint after an outside change: queued entries it dropped are found in the file, the queue stays', async () => {
    const p = file();
    const down = new InMemorySessionStore();
    down.appendBatch = async () => { throw new Error('mirror unreachable'); }; // every append stays queued
    const j = new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: down, clock: clockFor('q'), hydrateFromMirror: true, checkpoint: true });
    const first = await j.append(msg('ask 0'));
    for (let i = 1; i < 40; i++) await j.append(msg(`ask ${i}`));
    const kept = (await j.snapshot()).find((e) => e.seq === 36)!;
    const summary = await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('SUMMARY') } });
    await j.compact({ summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: kept.uuid, trigger: 'auto', preTokens: 1000, postTokens: 100, base: BASE });
    await j.flushMirror();
    const queued = j.pendingMirrorCount;
    await j.snapshot();
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later);                              // touched from outside
    expect(await j.catchUp({ maxSeq: 0, lastUuid: first.uuid })).toBe('ahead');
    expect((await j.snapshot()).some((e) => e.seq === 0)).toBe(false); // the re-read came from the checkpoint
    expect(j.pendingMirrorCount).toBe(queued);
    expect(existsSync(`${p}.superseded`)).toBe(false);
  });

  it('local ahead past a compaction, the marker at a seq the checkpoint dropped: ahead, nothing set aside', async () => {
    const p = await compacted();
    const j = reopen(p, new InMemorySessionStore());
    expect(await j.catchUp({ maxSeq: 20, lastUuid: 'e20' })).toBe('ahead');
    expect((await j.snapshot()).some((e) => e.seq === 20)).toBe(false); // the read-model never held it
    expect(existsSync(`${p}.superseded`)).toBe(false);
    expect((await j.snapshot()).at(-1)!.seq).toBe(44);
  });

  it('the file disagrees at that seq: diverged, set aside, the mirror wins', async () => {
    const p = await compacted();
    const mirror = new InMemorySessionStore();
    await mirror.appendBatch('t', history().slice(0, 21).map((e) => (e.seq === 20 ? { ...e, uuid: 'elsewhere' } : e)));
    const j = reopen(p, mirror);
    expect(await j.catchUp({ maxSeq: 20, lastUuid: 'elsewhere' })).toBe('diverged');
    expect(existsSync(`${p}.superseded`)).toBe(true);
    expect((await j.snapshot()).map((e) => e.uuid).at(-1)).toBe('elsewhere');
    const next = await j.append(msg('next'));
    expect(next.seq).toBe(21);
    expect(next.parentUuid).toBe('elsewhere');
  });

  it('the marker\'s line is unreadable and the checkpoint dropped its child too: the file\'s chain proves it, ahead', async () => {
    const p = await compacted(20);
    const j = reopen(p, new InMemorySessionStore());
    expect((await j.snapshot()).some((e) => e.seq === 21)).toBe(false); // the chain proof is only in the file
    expect(await j.catchUp({ maxSeq: 20, lastUuid: 'e20' })).toBe('ahead');
    expect(existsSync(`${p}.superseded`)).toBe(false);
  });
});

describe('JsonlStore.setAside', () => {
  const entry = (seq: number): JournalEntry => ({
    uuid: `s${seq}`, parentUuid: seq === 0 ? null : `s${seq - 1}`, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
    workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T', payload: { type: 'system', event: 'x' },
  });

  it('never overwrites a copy not put back: three set-asides keep three copies, a fourth replaces the oldest; no file is null', async () => {
    const p = file();
    const store = new JsonlStore(p);
    expect(await store.setAside('.superseded')).toBeNull();        // nothing there yet
    const used: string[] = [];
    for (let i = 0; i < 4; i++) {
      await store.append(entry(i));
      const at = new Date(Date.UTC(2026, 9, 2, 0, 0, i));          // the copy's age: when it was last written
      await fs.utimes(p, at, at);
      used.push((await store.setAside('.superseded'))!);
    }
    expect(used).toEqual([`${p}.superseded`, `${p}.superseded.1`, `${p}.superseded.2`, `${p}.superseded`]);
    expect(existsSync(p)).toBe(false);
    const seqs = async (f: string) => (await fs.readFile(f, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as JournalEntry).seq);
    expect([await seqs(`${p}.superseded`), await seqs(`${p}.superseded.1`), await seqs(`${p}.superseded.2`)]).toEqual([[3], [1], [2]]);
  });

  it('forgets the old file: the next file\'s torn tail is set aside before an append, its bad lines kept aside again', async () => {
    const p = file();
    const store = new JsonlStore(p);
    await store.append(entry(0));                                  // the old file's tail is checked once, here
    await fs.appendFile(p, '{not json\n' + JSON.stringify(entry(2)) + '\n', 'utf8');
    for await (const _ of store.read()) void _;                    // line 2 quarantined (old file)
    await store.setAside('.superseded');
    await fs.rm(`${p}.corrupt`);
    // A new file at the same path: the same bad line 2, and a torn tail.
    await fs.writeFile(p, JSON.stringify(entry(0)) + '\n{not json\n' + JSON.stringify(entry(2)) + '\n{"torn', 'utf8');
    await store.append(entry(3));
    const read: number[] = [];
    for await (const e of store.read()) read.push(e.seq);
    expect(read).toEqual([0, 2, 3]);
    const corrupt = (await fs.readFile(`${p}.corrupt`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { lineNo: number; reason: string });
    expect(corrupt.map((c) => [c.lineNo, c.reason])).toEqual([[4, 'torn'], [2, 'parse']]);
  });
});
