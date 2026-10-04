/**
 * R5 (harness to nine) — crash-safe append. A kill -9 (or a full disk) in the middle of a write
 * leaves a partial last line. The journal must load every complete record, keep the partial one
 * aside in the `.corrupt` sidecar (never deleted), and never write the next record onto it.
 *
 * Revert-proof: without JsonlStore.repairTail, the first append after the crash lands on the
 * same line as the partial bytes, the merged line does not parse, and that entry is lost: the
 * "appends after the crash" assertions below then see one entry fewer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type JournalIntegrityEvent } from '../journal.js';
import { JsonlStore, type JsonlBadLineInfo } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `jsonl-crash-safe-test-${process.pid}`);
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const entry = (seq: number, text = `entry number ${seq}`): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: seq === 0 ? null : `u${seq - 1}`, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'user', userId: 'u' }, timestamp: 'T',
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});
const line = (e: JournalEntry): string => JSON.stringify(e) + '\n';
const userMsg = (text: string): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', timestamp: '',
  principal: { kind: 'user', userId: 'u' },
  payload: { type: 'user', blocks: [{ type: 'text', text } as never] },
});

/** A journal the previous process left: `n` whole records, then `tail` (what the kill cut). */
async function crashedFile(name: string, n: number, tail: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = join(dir, name);
  let body = '';
  for (let i = 0; i < n; i++) body += line(entry(i));
  await fs.writeFile(p, body + tail, 'utf8');
  return p;
}
async function seqs(p: string): Promise<number[]> {
  const out: number[] = [];
  for await (const e of new JsonlStore(p).read()) out.push(e.seq);
  return out;
}
async function sidecar(p: string): Promise<Array<{ lineNo: number; reason: string; line: string }>> {
  try {
    return (await fs.readFile(`${p}.corrupt`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('JsonlStore crash-safe append (R5)', () => {
  it('kill -9 mid-write: the journal loads every complete record, sets the partial one aside, and appends after it', async () => {
    const whole = line(entry(5, 'the record the kill cut in half')).trimEnd();
    const partial = whole.slice(0, Math.floor(whole.length / 2));
    const p = await crashedFile('killed.jsonl', 5, partial);

    // The next process opens the task.
    const events: JournalIntegrityEvent[] = [];
    const j = new Journal({
      taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(p), mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-10-02T00:00:00.000Z'), onIntegrityEvent: (e) => events.push(e),
    });
    const loaded = await j.snapshot();
    expect(loaded.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);

    // Kept aside (whole: ASCII here), never deleted; the file now ends on the last whole record.
    expect(await sidecar(p)).toEqual([{ lineNo: 6, reason: 'torn', line: partial }]);
    let expected = '';
    for (let i = 0; i < 5; i++) expected += line(entry(i));
    expect(await fs.readFile(p, 'utf8')).toBe(expected);
    expect(events).toEqual([{ kind: 'journal_line_quarantined', lineNo: 6, reason: 'torn' }]);

    // The first append after the crash is a whole, readable record (the revert loses it).
    await j.append(userMsg('after the crash'));
    const after: JournalEntry[] = [];
    for await (const e of new JsonlStore(p).read()) after.push(e);
    expect(after.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(after[5].parentUuid).toBe('u4');
    expect(after[5].payload).toEqual({ type: 'user', blocks: [{ type: 'text', text: 'after the crash' }] });
  });

  it('wherever the kill cuts the record, the complete ones load and the next append is whole', async () => {
    const whole = line(entry(3, 'a record cut at every point')).trimEnd();
    const cuts = new Set<number>([1, 2, whole.length - 1]);
    for (let c = 1; c < whole.length; c += Math.ceil(whole.length / 24)) cuts.add(c);
    for (const cut of cuts) {
      const p = await crashedFile(`cut-${cut}.jsonl`, 3, whole.slice(0, cut));
      const store = new JsonlStore(p);
      await store.append(entry(3, 'written after the restart'));
      expect(await seqs(p)).toEqual([0, 1, 2, 3]);
      expect(await sidecar(p)).toEqual([{ lineNo: 4, reason: 'torn', line: whole.slice(0, cut) }]);
    }
  });

  it('a whole record that lost only its newline is sealed and kept, never set aside', async () => {
    const p = await crashedFile('no-newline.jsonl', 2, line(entry(2)).trimEnd());
    await new JsonlStore(p).append(entry(3));
    expect(await seqs(p)).toEqual([0, 1, 2, 3]);
    expect(await sidecar(p)).toEqual([]);
  });

  it('a tail of NULs (what a power cut can leave) is set aside and the records before it load', async () => {
    const p = await crashedFile('nuls.jsonl', 2, '\0'.repeat(4096));
    const store = new JsonlStore(p);
    await store.repairTail();
    expect(await seqs(p)).toEqual([0, 1]);
    expect(await sidecar(p)).toEqual([{ lineNo: 3, reason: 'torn', line: '\0'.repeat(4096) }]);
    await store.append(entry(2));
    expect(await seqs(p)).toEqual([0, 1, 2]);
  });

  it('a whole but unparseable last line is corruption: set aside as parse, and cut', async () => {
    const p = await crashedFile('corrupt-last.jsonl', 2, '{"uuid":"u2","seq":2,garbage}\n');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    await store.append(entry(2));
    expect(await seqs(p)).toEqual([0, 1, 2]);
    expect(bad).toEqual([{ lineNo: 3, reason: 'parse', line: '{"uuid":"u2","seq":2,garbage}' }]);
    expect(await sidecar(p)).toEqual([{ lineNo: 3, reason: 'parse', line: '{"uuid":"u2","seq":2,garbage}' }]);
  });

  it('a large torn record (several reads backwards) is set aside whole', async () => {
    const big = line(entry(1, 'x'.repeat(300_000))).trimEnd();
    const partial = big.slice(0, 200_000);
    const p = await crashedFile('big.jsonl', 1, partial);
    await new JsonlStore(p).append(entry(1, 'small'));
    expect(await seqs(p)).toEqual([0, 1]);
    const kept = await sidecar(p);
    expect(kept).toHaveLength(1);
    expect(kept[0].line).toBe(partial);
  });

  it('if the sidecar cannot be written, nothing is cut and the append fails; the next one retries', async () => {
    const whole = line(entry(2)).trimEnd();
    const p = await crashedFile('no-sidecar.jsonl', 2, whole.slice(0, 40));
    await fs.mkdir(`${p}.corrupt`); // a directory where the sidecar file must go: the write fails
    const before = await fs.readFile(p, 'utf8');
    const store = new JsonlStore(p);
    await expect(store.append(entry(2))).rejects.toThrow();
    expect(await fs.readFile(p, 'utf8')).toBe(before); // never a deletion of what was not kept
    await fs.rm(`${p}.corrupt`, { recursive: true });
    await store.append(entry(2));
    expect(await seqs(p)).toEqual([0, 1, 2]);
    expect(await sidecar(p)).toEqual([{ lineNo: 3, reason: 'torn', line: whole.slice(0, 40) }]);
  });

  it('a short write inside this process (ENOSPC) makes the next append check the tail again', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'short-write.jsonl');
    const store = new JsonlStore(p);
    await store.append(entry(0)); // the tail is checked once, here
    const realAppend = fs.appendFile.bind(fs);
    const half = line(entry(1)).slice(0, 30);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async () => {
      await realAppend(p, half, 'utf8'); // the part that reached the disk
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    await expect(store.append(entry(1))).rejects.toThrow('ENOSPC');
    await store.append(entry(2)); // space is back
    expect(await seqs(p)).toEqual([0, 2]);
    expect(await sidecar(p)).toEqual([{ lineNo: 2, reason: 'torn', line: half }]);
  });

  it('concurrent first appends share one repair: one sidecar record, both entries whole', async () => {
    const p = await crashedFile('concurrent.jsonl', 1, '{"uuid":"torn","par');
    const store = new JsonlStore(p);
    await Promise.all([store.append(entry(1)), store.append(entry(2))]);
    expect((await seqs(p)).sort()).toEqual([0, 1, 2]);
    expect(await sidecar(p)).toHaveLength(1);
  });

  it('a clean file is left byte-identical (the repair only reads), and a missing file is a no-op', async () => {
    const p = await crashedFile('clean.jsonl', 3, '');
    const before = await fs.readFile(p, 'utf8');
    await new JsonlStore(p).repairTail();
    expect(await fs.readFile(p, 'utf8')).toBe(before);
    expect(await sidecar(p)).toEqual([]);
    await expect(new JsonlStore(join(dir, 'absent.jsonl')).repairTail()).resolves.toBeUndefined();
    await expect(fs.access(join(dir, 'absent.jsonl'))).rejects.toThrow(); // and creates nothing
  });

  it('a reader never repairs: read() leaves a torn tail in the file (it may be an append in flight)', async () => {
    const p = await crashedFile('reader.jsonl', 2, '{"uuid":"in-flight","par');
    const before = await fs.readFile(p, 'utf8');
    expect(await seqs(p)).toEqual([0, 1]);
    expect(await fs.readFile(p, 'utf8')).toBe(before);
    expect(await sidecar(p)).toEqual([]);
  });
  it('a line another writer is still finishing is never cut: the file grew, so the repair stands down', async () => {
    // Review R5-1: a disposed actor's Journal whose append is still landing while the task's
    // next Journal hydrates. Simulated: the other write completes while the sidecar is written.
    const whole = line(entry(2)).trimEnd();
    const p = await crashedFile('in-flight.jsonl', 2, whole.slice(0, 50));
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('.corrupt')) await fs.appendFile(p, whole.slice(50) + '\n', 'utf8');
      return realOpen(...args);
    });
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    await store.repairTail();
    vi.restoreAllMocks();
    expect(await seqs(p)).toEqual([0, 1, 2]); // the record the other writer finished is whole (the revert cuts it)
    expect(bad).toEqual([]); // nothing was set aside after all (the copy kept is a harmless extra)
    await store.append(entry(3)); // and the next append looks at the tail again: clean now
    expect(await seqs(p)).toEqual([0, 1, 2, 3]);
  });

  it('a cut inside a multi-byte character keeps the exact bytes beside the decoded line', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'multibyte.jsonl');
    const whole = Buffer.from(line(entry(2, 'naive cafe \u2615 and more')).trimEnd(), 'utf8');
    const cutAt = whole.indexOf(Buffer.from('\u2615', 'utf8')) + 1; // one byte into a 3-byte character
    const torn = whole.subarray(0, cutAt);
    await fs.writeFile(p, Buffer.concat([Buffer.from(line(entry(0)) + line(entry(1)), 'utf8'), torn]));
    await new JsonlStore(p).repairTail();
    const kept = JSON.parse((await fs.readFile(`${p}.corrupt`, 'utf8')).trim()) as { line: string; bytesBase64?: string };
    expect(kept.line).toContain('\uFFFD');
    expect(Buffer.from(kept.bytesBase64 ?? '', 'base64').equals(torn)).toBe(true);
    expect(await seqs(p)).toEqual([0, 1]);
  });

  it("a replacement Journal hydrates only after its predecessor's appends land (Journal.settled / deps.after)", async () => {
    // Review R5-1: disposeActor leaves the old journal's tail; the next Journal waits on it.
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'handover.jsonl');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let landed = false;
    class SlowStore extends JsonlStore {
      override async append(e: JournalEntry): Promise<void> {
        await gate;
        await super.append(e);
        landed = true;
      }
    }
    let landedWhenRead: boolean | undefined;
    class WatchedStore extends JsonlStore {
      override read(): AsyncIterable<JournalEntry> {
        landedWhenRead ??= landed;
        return super.read();
      }
    }
    const deps = (jsonl: JsonlStore) => ({
      taskId: 't', workspaceId: 'w', jsonl, mirror: new InMemorySessionStore(), clock: sequentialClock('2026-10-02T00:00:00.000Z'),
    });
    const old = new Journal(deps(new SlowStore(p)));
    const pending = old.append(userMsg('the last word of the old actor'));
    const next = new Journal({ ...deps(new WatchedStore(p)), after: old.settled() });
    const snapshot = next.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 50)); // the next journal would have read by now
    release();
    await pending;
    expect((await snapshot).map((e) => e.payload)).toEqual([{ type: 'user', blocks: [{ type: 'text', text: 'the last word of the old actor' }] }]);
    expect(landedWhenRead).toBe(true); // the revert reads the file before the old append lands
  });
});
