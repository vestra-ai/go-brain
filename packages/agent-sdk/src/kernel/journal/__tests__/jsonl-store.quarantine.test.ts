import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStore, type JsonlBadLineInfo } from '../jsonl-store.js';
import { CURRENT_JOURNAL_VERSION } from '../validate-entry.js';
import type { JournalEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `jsonl-quarantine-test-${process.pid}`);
const goodEntry = (seq: number): JournalEntry => ({
  uuid: `u${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
  workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: 'T',
  payload: { type: 'system', event: 'x' },
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('JsonlStore quarantine (P2.0)', () => {
  it('routes a wrong-shape line to .corrupt and keeps reading', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'shape.jsonl');
    await fs.writeFile(p, JSON.stringify(goodEntry(1)) + '\n' + '{"not":"an entry"}\n' + JSON.stringify(goodEntry(2)) + '\n', 'utf8');
    const store = new JsonlStore(p);
    const seen: number[] = [];
    for await (const e of store.read()) seen.push(e.seq);
    expect(seen).toEqual([1, 2]);
    const sidecar = await fs.readFile(p + '.corrupt', 'utf8');
    expect(sidecar).toContain('"reason":"shape"');
    const record = JSON.parse(sidecar.trim()) as { lineNo: number; line: string };
    expect(record.lineNo).toBe(2);
    expect(record.line).toBe('{"not":"an entry"}'); // the raw line is preserved for recovery
  });

  it('a torn FINAL line keeps the legacy behavior: skipped, NO sidecar, NO callback', async () => {
    // A torn tail is normal crash-mid-append residue, not corruption — quarantining
    // it would sidecar every healthy crash-recovery replay.
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'torn.jsonl');
    await fs.writeFile(p, JSON.stringify(goodEntry(1)) + '\n' + '{"uuid":"torn","par', 'utf8');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    const seen: number[] = [];
    for await (const e of store.read()) seen.push(e.seq);
    expect(seen).toEqual([1]);
    expect(bad).toEqual([]);
    await expect(fs.access(p + '.corrupt')).rejects.toThrow(); // no sidecar written
  });

  it('the same bad mid-file line read 3x by one store quarantines exactly once (idempotent)', async () => {
    // project() re-reads the whole file every round; without dedup the sidecar
    // grows by bad-lines x reads and onBadLine re-fires each pass.
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'dedup.jsonl');
    await fs.writeFile(p, JSON.stringify(goodEntry(1)) + '\n' + '{"not":"an entry"}\n' + JSON.stringify(goodEntry(2)) + '\n', 'utf8');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    for (let i = 0; i < 3; i++) {
      const seen: number[] = [];
      for await (const e of store.read()) seen.push(e.seq);
      expect(seen).toEqual([1, 2]); // every read still skips it
    }
    expect(bad).toHaveLength(1); // callback deduped
    const sidecar = (await fs.readFile(p + '.corrupt', 'utf8')).trim().split('\n');
    expect(sidecar).toHaveLength(1); // sidecar append deduped
  });

  it('a bad last line is quarantined exactly once when the next append comes', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'torn-then-append.jsonl');
    await fs.writeFile(p, JSON.stringify(goodEntry(1)) + '\n' + '{"uuid":"torn","par' + '\n', 'utf8');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    // Read 1: the torn line is the tail → legacy skip, nothing quarantined.
    for await (const e of store.read()) void e;
    expect(bad).toEqual([]);
    // R5: the next append first sets the bad last line aside (sidecar, then cut), so it
    // never becomes mid-file and the new record never shares its line.
    await store.append(goodEntry(2));
    for await (const e of store.read()) void e;
    expect(bad).toEqual([expect.objectContaining({ reason: 'parse', lineNo: 2 })]);
    // Read 3: deduped.
    for await (const e of store.read()) void e;
    expect(bad).toHaveLength(1);
    const sidecar = (await fs.readFile(p + '.corrupt', 'utf8')).trim().split('\n');
    expect(sidecar).toHaveLength(1);
  });

  it('quarantines a FUTURE-version line as version-reason (downgrade safety)', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'future.jsonl');
    const future = { ...goodEntry(1), v: CURRENT_JOURNAL_VERSION + 1 };
    await fs.writeFile(p, JSON.stringify(future) + '\n' + JSON.stringify(goodEntry(2)) + '\n', 'utf8');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    const seen: number[] = [];
    for await (const e of store.read()) seen.push(e.seq);
    expect(seen).toEqual([2]);
    expect(bad).toEqual([expect.objectContaining({ reason: 'version', lineNo: 1 })]);
  });

  it('invokes onBadLine with lineNo + errors for a shape failure', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'callback.jsonl');
    await fs.writeFile(p, '{"hello":"world"}\n' + JSON.stringify(goodEntry(1)) + '\n', 'utf8');
    const bad: JsonlBadLineInfo[] = [];
    const store = new JsonlStore(p, { onBadLine: (info) => bad.push(info) });
    const seen: number[] = [];
    for await (const e of store.read()) seen.push(e.seq);
    expect(seen).toEqual([1]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBe('shape');
    expect(bad[0].lineNo).toBe(1);
    expect(bad[0].errors!.some((e) => e.includes('uuid'))).toBe(true);
  });

  it('a well-formed current-version line (v present) reads through unchanged', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, 'versioned.jsonl');
    const versioned = { ...goodEntry(1), v: CURRENT_JOURNAL_VERSION };
    await fs.writeFile(p, JSON.stringify(versioned) + '\n', 'utf8');
    const store = new JsonlStore(p);
    const seen: JournalEntry[] = [];
    for await (const e of store.read()) seen.push(e);
    expect(seen).toEqual([versioned]);
  });
});
