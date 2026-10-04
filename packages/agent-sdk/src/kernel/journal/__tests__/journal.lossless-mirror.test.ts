/**
 * JOURNAL_LOSSLESS_MIRROR_V1 (harness to nine, R1): the mirror gives a journal back WHOLE.
 *
 * Before this, the mirror was not a full copy by design: a pasted image became a text
 * placeholder, an entry over 250 KB became a `system` note (a tool_result kept only its slot),
 * and a queue past 5,000 entries shed its OLDEST while the mirror was unreachable. A task
 * hydrated on a fresh box came back with its pictures and its big results missing.
 *
 * With a LosslessSessionStore as the mirror: an entry the clamp would change is kept WHOLE in
 * the task's storage and mirrored as a stand-in naming it, hydrate swaps the stand-in back, the
 * queue is never shed (an alert fires instead), and what the mirror still lacks when a journal
 * next opens is sent again from the local file. A plain store keeps today's bytes exactly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore, MirrorSeqConflictError, type SessionStore } from '../session-store.js';
import { LosslessSessionStore, type MirrorBlobStore } from '../lossless-mirror.js';
import { clampForMirror, mirrorWindow, MIRROR_MAX_ENTRY_BYTES } from '../mirror-clamp.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `journal-lossless-mirror-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** The flag-off wire, recorded from the journal BEFORE this change (staging d4b93c06d). */
const GOLDEN = join(__dirname, 'fixtures', 'mirror-off.golden.json');

let n = 0;
const path = (): string => join(dir, `t-${n++}.jsonl`);
const base = { taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '' } as const;
const IMAGE = 'A'.repeat(1_400_000); // a pasted ~1 MB image, as base64
const FIVE_MB = 'x'.repeat(5 * 1024 * 1024);

/** A turn with a pasted image, a 5 MB tool result, and the small entries around them. */
function conversation(): NewEntry[] {
  const agent = { kind: 'agent', agentId: 'g' } as const;
  return [
    { ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [
      { type: 'image', data: IMAGE, mediaType: 'image/png', filename: 'shot.png', sizeBytes: 1_050_000 },
      { type: 'text', text: 'what is in this picture' },
    ] } },
    { ...base, principal: agent, payload: { type: 'tool_use', toolUseId: 'tu1', name: 'read', input: { path: 'big.log' } } },
    { ...base, principal: agent, payload: { type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text', text: FIVE_MB }] } },
    { ...base, principal: agent, payload: { type: 'assistant', blocks: [{ type: 'text', text: 'a screenshot and a long log' }] } },
  ] as NewEntry[];
}
const small = (i: number): NewEntry => ({ ...base, principal: { kind: 'system' }, payload: { type: 'system', event: `e${i}` } });

/** Storage as the relay keeps it: JSON text per (task, seq, uuid). It refuses for good (the
 *  relay's 413) anything over `limit`, and records how many uploads ran at once. */
class MemoryBlobs implements MirrorBlobStore {
  readonly objects = new Map<string, string>();
  inFlight = 0;
  maxInFlight = 0;
  puts = 0;
  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}
  async put(taskId: string, entry: JournalEntry): Promise<boolean> {
    this.puts++;
    const text = JSON.stringify(entry);
    if (text.length > this.limit) return false;
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.inFlight--;
    this.objects.set(`${taskId}/${entry.seq}-${entry.uuid}`, text);
    return true;
  }
  async get(taskId: string, seq: number, uuid: string): Promise<JournalEntry | null> {
    const text = this.objects.get(`${taskId}/${seq}-${uuid}`);
    return text === undefined ? null : (JSON.parse(text) as JournalEntry);
  }
}

/** A mirror that can be down, recording every row it accepts. */
class FlakyMirror extends InMemorySessionStore {
  down = false;
  override async appendBatch(taskId: string, entries: JournalEntry[]): Promise<void> {
    if (this.down) throw new Error('mirror unreachable');
    return super.appendBatch(taskId, entries);
  }
}

const journal = (mirror: SessionStore, file: string, extra: { onIntegrityEvent?: (e: JournalIntegrityEvent) => void; hydrateFromMirror?: boolean } = {}): Journal =>
  new Journal({ taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(file), mirror, clock: sequentialClock('2026-01-01T00:00:00.000Z'), ...extra });

/** Flush until nothing is queued (a turn boundary sends at most two windows). */
async function drain(j: Journal): Promise<void> {
  for (let i = 0; i < 200 && j.pendingMirrorCount > 0; i++) await j.flushMirror();
  expect(j.pendingMirrorCount).toBe(0);
}

const lines = async (file: string): Promise<JournalEntry[]> =>
  (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);

/** Hydrate the task on a fresh box (an empty local file) and read back what it wrote. */
async function hydrateFresh(mirror: SessionStore): Promise<JournalEntry[]> {
  const file = path();
  await journal(mirror, file, { hydrateFromMirror: true }).leaf();
  return lines(file);
}

describe('JOURNAL_LOSSLESS_MIRROR_V1', () => {
  it('mirror: hydrate is identical — a pasted image and a 5 MB entry come back whole on a fresh store', async () => {
    const blobs = new MemoryBlobs();
    const inner = new InMemorySessionStore();
    const mirror = new LosslessSessionStore(inner, blobs);
    const file = path();
    const j = journal(mirror, file);
    for (const e of conversation()) await j.append(e);
    await drain(j);

    // The rows hold no image bytes and no 5 MB text: those two are stand-ins, their whole
    // entries in storage.
    const rows = (await inner.load('t'))!;
    expect(JSON.stringify(rows)).not.toContain('AAAA');
    expect(JSON.stringify(rows).length).toBeLessThan(10_000);
    expect(rows.filter((r) => (r as { mirrorRef?: string }).mirrorRef === 'storage').map((r) => r.seq)).toEqual([0, 2]);
    expect(blobs.objects.size).toBe(2);
    // Each stand-in records its whole entry's size, so the read back gets a deadline to match.
    expect((rows[2] as { mirrorBytes?: number }).mirrorBytes).toBe(blobs.objects.get(`t/2-${rows[2]!.uuid}`)!.length);

    const original = await lines(file);
    expect(original).toHaveLength(4);
    expect(await hydrateFresh(mirror)).toEqual(original);
  });

  it('mirror: outage loses nothing — past the 5,000-entry buffer, and across a restart', async () => {
    const inner = new FlakyMirror();
    const mirror = new LosslessSessionStore(inner, new MemoryBlobs());
    const events: JournalIntegrityEvent[] = [];
    const onIntegrityEvent = (e: JournalIntegrityEvent): number => events.push(e);
    const file = path();

    // A box whose mirror never got its file (an outage longer than its process): the image, the
    // 5 MB result and 5,100 more entries sit on disk only. Seeded in one write, not 5,104 appends.
    const scratch = journal(new InMemorySessionStore(), path());
    for (const e of conversation()) await scratch.append(e);
    const seeded = [...(await scratch.snapshot())];
    for (let i = 0; i < 5_100; i++) {
      seeded.push({ ...small(i), timestamp: 'T', uuid: `s${i}`, parentUuid: seeded[seeded.length - 1]!.uuid, seq: seeded.length });
    }
    await new JsonlStore(file).replaceWith(seeded);

    // Opened while the mirror is still down: the whole file is owed, the flush fails, and the
    // queue is past the old cap. Nothing is shed; the alert fires instead.
    inner.down = true;
    const j = journal(mirror, file, { onIntegrityEvent });
    await j.leaf();
    await j.flushMirror();
    expect(events.filter((e) => e.kind === 'mirror_overflow_dropped')).toEqual([]);
    expect(events).toContainEqual({ kind: 'mirror_backlog', count: 5_104 });
    expect(j.pendingMirrorCount).toBe(5_104);

    // The mirror comes back: the same journal drains every entry.
    inner.down = false;
    await drain(j);
    expect((await inner.load('t'))!.map((r) => r.seq)).toEqual(seeded.map((e) => e.seq));

    // Down again for a turn, and the runner is killed mid-turn before it is back: the queue in
    // memory is gone, the turn's crash-resume `open` marker (RUNNER_CRASH_RESUME_V1) with it.
    // The next open asks the mirror what it lacks and sends it from the local file.
    inner.down = true;
    const before = journal(mirror, file, { onIntegrityEvent });
    const mark = { turnKey: 'm1', phase: 'open', fingerprint: 'f', bootId: 'b' };
    await before.append({ ...base, principal: { kind: 'system' }, payload: { type: 'custom', key: 'crash_resume', data: mark } } as NewEntry);
    for (let i = 0; i < 2; i++) await before.append(small(9_000 + i));
    await before.flushMirror();
    expect(before.pendingMirrorCount).toBe(3);
    inner.down = false;
    const k = journal(mirror, file, { onIntegrityEvent });
    await k.append(small(9_003));
    await drain(k);

    const original = await lines(file);
    expect(original).toHaveLength(5_108);
    expect((await inner.load('t'))!.map((r) => r.seq)).toEqual(original.map((e) => e.seq));
    const hydrated = await hydrateFresh(mirror);
    expect(hydrated).toEqual(original);
    expect(hydrated.find((e) => e.payload.type === 'custom')!.payload).toEqual({ type: 'custom', key: 'crash_resume', data: mark });
    expect(events.filter((e) => e.kind === 'mirror_overflow_dropped')).toEqual([]);
  }, 30_000);

  it('owed: a mirror with holes is sent exactly the seqs it lacks, and a hole the file cannot fill is not resent on every open', async () => {
    const entryAt = (i: number): JournalEntry => ({ ...small(i), timestamp: 'T', uuid: `h${i}`, parentUuid: null, seq: i }) as JournalEntry;
    const inner = new InMemorySessionStore();
    await inner.appendBatch('t', [entryAt(0), entryAt(2), entryAt(5)]); // holes at 1, 3 and 4
    const store = new LosslessSessionStore(inner, new MemoryBlobs());
    // The local file has lost seq 3 itself (a quarantined line): 1 and 4 can be filled, 3 cannot.
    const local = [0, 1, 2, 4, 5, 6].map(entryAt);
    const first = await store.owed('t', local);
    expect(first.map((e) => e.seq)).toEqual([1, 4, 6]);
    await inner.appendBatch('t', first);
    expect(await store.owed('t', local)).toEqual([]); // the next open: nothing, not the whole file
  });

  it('owed: an unanswered ask is [] and never rejects', async () => {
    const local = [{ ...small(0), timestamp: 'T', uuid: 'h0', parentUuid: null, seq: 0 } as JournalEntry];
    const unreachable = Object.assign(new InMemorySessionStore(), { holding: async () => { throw new Error('down'); } });
    await expect(new LosslessSessionStore(unreachable, new MemoryBlobs()).owed('t', local)).resolves.toEqual([]);
  });

  it('turn-end bound: an awaited window uploads at most 768 KB of whole entries, four at a time', async () => {
    // Twelve pasted images of ~300 KB each: the clamp makes every one a small row, so a window
    // budgeted by the ROW size would carry all twelve (3.6 MB) on the turn's critical path.
    const shots = Array.from({ length: 12 }, (_, i) => ({ ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [
      { type: 'image', data: String(i).repeat(400_000), mediaType: 'image/png', filename: `s${i}.png` },
    ] } }) as NewEntry);
    const pending = [];
    for (const [i, e] of shots.entries()) pending.push({ ...e, timestamp: 'T', uuid: `s${i}`, parentUuid: null, seq: i } as JournalEntry);
    expect(mirrorWindow(pending, true).batch.length).toBe(1);
    expect(mirrorWindow(pending, false).batch.length).toBe(12); // flag off: unchanged
    const smallShots = pending.map((e) => ({ ...e, payload: { type: 'user', blocks: [{ type: 'image', data: 'B'.repeat(20_000), mediaType: 'image/png' }] } }) as JournalEntry);
    const window = mirrorWindow(smallShots, true);
    expect(window.batch.length).toBe(12); // 12 x 20 KB fits the budget
    const blobs = new MemoryBlobs();
    await new LosslessSessionStore(new InMemorySessionStore(), blobs).appendBatch('t', window.wire);
    expect(blobs.objects.size).toBe(12);
    expect(blobs.maxInFlight).toBeLessThanOrEqual(4);
  });

  it('an entry storage refuses for good (413) is mirrored as its plain clamp, loudly, and the queue moves on', async () => {
    const inner = new InMemorySessionStore();
    const reports: JournalIntegrityEvent[] = [];
    const mirror = new LosslessSessionStore(inner, new MemoryBlobs(4 * 1024 * 1024), (_t, e) => { reports.push(e); });
    const j = journal(mirror, path());
    for (const e of conversation()) await j.append(e);
    await drain(j);
    const rows = (await inner.load('t'))!;
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect((rows[0] as { mirrorRef?: string }).mirrorRef).toBe('storage'); // the image fits
    expect(rows[2]).not.toHaveProperty('mirrorRef'); // the 5 MB result does not
    expect(rows[2]!.payload).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', blocks: [{ type: 'text' }] });
    expect(reports).toEqual([{ kind: 'mirror_whole_entry_refused', seq: 2, bytes: expect.any(Number) }]);
  });

  it('a refused entry is uploaded and reported once, however often its window is retried', async () => {
    const inner = new FlakyMirror();
    const blobs = new MemoryBlobs(4 * 1024 * 1024);
    const reports: JournalIntegrityEvent[] = [];
    const store = new LosslessSessionStore(inner, blobs, (_t, e) => { reports.push(e); });
    const big = { ...conversation()[2]!, uuid: 'u2', parentUuid: null, seq: 2, timestamp: 'T' } as JournalEntry;
    inner.down = true;
    await expect(store.appendBatch('t', [big])).rejects.toThrow(/unreachable/);
    inner.down = false;
    await store.appendBatch('t', [big]);
    expect(blobs.puts).toBe(1);
    expect(reports).toHaveLength(1);
    expect((await inner.load('t'))![0]).not.toHaveProperty('mirrorRef');
  });

  it('turn end: a lossless mirror is waited on at most its cap and the drain lands after; a plain one is waited on as before', async () => {
    class SlowMirror extends InMemorySessionStore {
      release!: () => void;
      private readonly gate = new Promise<void>((r) => { this.release = r; });
      override async appendBatch(taskId: string, entries: JournalEntry[]): Promise<void> {
        await this.gate;
        return super.appendBatch(taskId, entries);
      }
    }
    const slow = new SlowMirror();
    const j = journal(new LosslessSessionStore(slow, new MemoryBlobs()), path());
    await j.append(small(0));
    await j.append(small(1));
    const started = Date.now();
    await j.flushMirrorAtTurnEnd(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(j.pendingMirrorCount).toBe(2); // nothing left the queue unsent
    slow.release();
    await j.flushMirror(); // the same drain, still in flight
    expect((await slow.load('t'))!.map((r) => r.seq)).toEqual([0, 1]);
    expect(j.pendingMirrorCount).toBe(0);

    const plainSlow = new SlowMirror();
    const k = journal(plainSlow, path());
    await k.append(small(0));
    const first = await Promise.race([
      k.flushMirrorAtTurnEnd(50).then(() => 'flushed'),
      new Promise((r) => setTimeout(() => r('waiting'), 200)),
    ]);
    expect(first).toBe('waiting'); // flag off: the turn end waits for the flush, exactly as before
    plainSlow.release();
    await k.flushMirror();
    expect(k.pendingMirrorCount).toBe(0);
  });

  it('a stand-in row stays under the server row cap, so capEntry never cuts its mirrorRef', async () => {
    const inner = new InMemorySessionStore();
    const j = journal(new LosslessSessionStore(inner, new MemoryBlobs()), path());
    // A pasted image whose words bring the placeholder entry to 10 bytes under the cap: the
    // placeholder alone fits, the placeholder plus `"mirrorRef":"storage"` would not.
    const pasted = (words: number): NewEntry => ({ ...base, principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [
      { type: 'image', data: IMAGE, mediaType: 'image/png', filename: 'shot.png' }, { type: 'text', text: 'w'.repeat(words) },
    ] } } as NewEntry);
    const envelope = { uuid: 'entry-0', parentUuid: null, seq: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    const sizeAt = (words: number): number => JSON.stringify(clampForMirror({ ...pasted(words), ...envelope } as JournalEntry, MIRROR_MAX_ENTRY_BYTES)).length;
    const words = 1_000 + (MIRROR_MAX_ENTRY_BYTES - 10 - sizeAt(1_000));
    expect(sizeAt(words)).toBe(MIRROR_MAX_ENTRY_BYTES - 10);
    await j.append(pasted(words));
    await drain(j);
    const row = (await inner.load('t'))![0]!;
    expect((row as { mirrorRef?: string }).mirrorRef).toBe('storage');
    expect(JSON.stringify(row).length).toBeLessThanOrEqual(MIRROR_MAX_ENTRY_BYTES);
  });

  it('a stand-in whose whole entry is gone from storage hydrates as the stand-in, never a hole', async () => {
    const blobs = new MemoryBlobs();
    const inner = new InMemorySessionStore();
    const mirror = new LosslessSessionStore(inner, blobs);
    const j = journal(mirror, path());
    for (const e of conversation()) await j.append(e);
    await drain(j);
    blobs.objects.clear();

    const got = await hydrateFresh(mirror);
    expect(got.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(got[2]!.payload).toMatchObject({ type: 'tool_result', toolUseId: 'tu1' });
    expect(JSON.stringify(got)).not.toContain('AAAA');
  });

  it('a whole-entry upload that fails keeps the window queued: no row is written without its entry', async () => {
    const inner = new InMemorySessionStore();
    let fail = true;
    const blobs = new MemoryBlobs();
    const flaky: MirrorBlobStore = {
      put: async (t, e) => { if (fail) throw new Error('storage down'); return blobs.put(t, e); },
      get: (t, s, u) => blobs.get(t, s, u),
    };
    const j = journal(new LosslessSessionStore(inner, flaky), path());
    for (const e of conversation()) await j.append(e);
    await j.flushMirror();
    expect(await inner.load('t')).toBeNull();
    expect(j.pendingMirrorCount).toBe(4);
    fail = false;
    await drain(j);
    expect((await inner.load('t'))!.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });
});

/**
 * Continue anywhere (spec §6.2), the history-checked resend. The server refuses only the seqs it
 * already holds, so what a fresh journal resends ABOVE the mirror's top was never checked: a Mac's
 * blind tail, written after another computer took the task over, was spliced into the conversation.
 * Now nothing above the top goes unless the local entry AT the top is the mirror's own (same seq,
 * same uuid: rewind-safe, no parent chain asked), and a journal that fails it is refused as for a 409.
 */
describe('owed: the resend above the top checks history (§6.2)', () => {
  const at = (seq: number, uuid: string, parentUuid: string | null): JournalEntry =>
    ({ ...small(seq), timestamp: 'T', uuid, parentUuid, seq }) as JournalEntry;
  /** The mirror after another computer took the task over at seq 2. */
  const theirs = [at(0, 'a0', null), at(1, 'a1', 'a0'), at(2, 'cloud-2', 'a1')];
  /** This computer's file: the shared head, its own seq 2, and a seq 3 written blind after the move. */
  const blindTail = [at(0, 'a0', null), at(1, 'a1', 'a0'), at(2, 'mac-2', 'a1'), at(3, 'mac-3', 'mac-2')];

  async function opened(local: JournalEntry[], store: (inner: InMemorySessionStore) => SessionStore) {
    const inner = new InMemorySessionStore();
    await inner.appendBatch('t', theirs);
    const sent: JournalEntry[] = [];
    const appendBatch = inner.appendBatch.bind(inner);
    inner.appendBatch = async (t, b) => { sent.push(...b); return appendBatch(t, b); };
    const file = path();
    await fs.mkdir(dir, { recursive: true });
    await new JsonlStore(file).replaceWith(local);
    const events: JournalIntegrityEvent[] = [];
    const j = journal(store(inner), file, { onIntegrityEvent: (e) => { events.push(e); } });
    await j.leaf(); // opened as a fresh process opens it: owed is asked here, its answer awaited by the flush
    await j.flushMirror();
    return { inner, sent, events, j };
  }

  it('a fresh journal whose entry at the mirror\'s top is another: the flush sends nothing, it is refused, and needs a catch-up', async () => {
    const { inner, sent, events, j } = await opened(blindTail, (inner) => new LosslessSessionStore(inner, new MemoryBlobs()));
    expect(sent).toEqual([]);
    expect(j.needsCatchUp).toBe(true);
    expect(events).toEqual([{ kind: 'mirror_seq_conflict', seqs: [2] }]);
    expect((await inner.load('t'))!.map((e) => e.uuid)).toEqual(['a0', 'a1', 'cloud-2']);
    await j.flushMirror(); // refused: nothing more until a catch-up rebuilds it
    expect(sent).toEqual([]);
  });

  it('the same uuid at the top: the entries above it go as before', async () => {
    const same = [...theirs, at(3, 'next-3', 'cloud-2')];
    const { inner, sent, events, j } = await opened(same, (inner) => new LosslessSessionStore(inner, new MemoryBlobs()));
    expect(sent.map((e) => e.uuid)).toEqual(['next-3']);
    expect(j.needsCatchUp).toBe(false);
    expect(events).toEqual([]);
    expect((await inner.load('t'))!.map((e) => e.uuid)).toEqual(['a0', 'a1', 'cloud-2', 'next-3']);
  });

  it('owed rejects with the conflict at the top; a strict prefix owes nothing and is no conflict', async () => {
    const inner = new InMemorySessionStore();
    await inner.appendBatch('t', theirs);
    const store = new LosslessSessionStore(inner, new MemoryBlobs());
    const err = await store.owed('t', blindTail).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MirrorSeqConflictError);
    expect((err as MirrorSeqConflictError).conflicts).toEqual([{ seq: 2, heldUuid: 'cloud-2' }]);
    // A file left behind below the top (even on another history there) has nothing above it to send.
    await expect(store.owed('t', [at(0, 'a0', null), at(1, 'other-1', 'a0')])).resolves.toEqual([]);
    // Entries above the top with no readable entry at it cannot prove their history either.
    await expect(store.owed('t', [at(0, 'a0', null), at(1, 'a1', 'a0'), at(3, 'mac-3', 'mac-2')])).rejects.toBeInstanceOf(MirrorSeqConflictError);
  });

  it('unchecked (the runner with CONTINUITY_JOURNAL_V1 off), or a mirror that names no uuid: as before', async () => {
    const inner = new InMemorySessionStore();
    await inner.appendBatch('t', theirs);
    const off = new LosslessSessionStore(inner, new MemoryBlobs(), undefined, () => false);
    expect((await off.owed('t', blindTail)).map((e) => e.uuid)).toEqual(['mac-3']);
    const nameless = Object.assign(new InMemorySessionStore(), { holding: async () => ({ minSeq: 0, maxSeq: 2, rowCount: 3 }) });
    expect((await new LosslessSessionStore(nameless, new MemoryBlobs()).owed('t', blindTail)).map((e) => e.uuid)).toEqual(['mac-3']);
  });
});

describe('mirror off: byte-identical', () => {
  it('a plain mirror receives exactly the rows it did before the lossless mirror existed', async () => {
    const sent: JournalEntry[][] = [];
    const mirror: SessionStore = { appendBatch: async (_t, b) => { sent.push(b); }, load: async () => null, listTasks: async () => [] };
    const j = journal(mirror, path());
    for (const e of conversation()) await j.append(e);
    await drain(j);
    expect(JSON.stringify(sent)).toBe(readFileSync(GOLDEN, 'utf8').trim());
  });
});
