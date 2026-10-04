/**
 * P2.8 — Journal.snapshot() + Journal.liveSuspendedIds().
 *
 * snapshot() must return the in-memory read-model BYTE-IDENTICAL to draining read()
 * (the disease fix: no fresh whole-file disk drain per per-dispatch scan). And the
 * leaf-keyed live-suspended memo must be PROVABLY equal to a fresh scan after any
 * suspend/resume/compaction sequence — the invariant the O(1) routing gate rests on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload, NewEntry } from '../../../contract/journal.js';
import { Journal, liveSuspendedToolUseIds } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';

const dir = join(tmpdir(), `journal-snapshot-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  toolUse: (id: string, name = 'GMAIL_SEND_EMAIL'): JournalPayload => ({ type: 'tool_use', toolUseId: id, name, input: {} }),
  toolResult: (id: string, isError = false): JournalPayload => ({ type: 'tool_result', toolUseId: id, blocks: [], isError }),
  pending: (interactionId: string, toolUseId: string): JournalPayload =>
    ({ type: 'interaction', interactionId, resolved: false, data: { kind: 'composio_auth', toolUseId, toolName: 'X' } }),
  resolve: (interactionId: string): JournalPayload =>
    ({ type: 'interaction', interactionId, resolved: true, data: { outcome: { behavior: 'allow' }, materializedAt: 'iso' } }),
};

const make = (taskId = 't', jsonl = new JsonlStore(join(dir, `${taskId}.jsonl`))) => new Journal({
  taskId, workspaceId: 'w', jsonl, mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-06-15T00:00:00.000Z'),
});

const drainRead = async (j: Journal): Promise<JournalEntry[]> => {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
};

describe('Journal.snapshot()', () => {
  it('returns entries BYTE-IDENTICAL to draining read()', async () => {
    const j = make();
    await j.append(newEntry(P.user('hi')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.toolResult('tu1')));
    expect(await j.snapshot()).toEqual(await drainRead(j));
  });

  it('reflects appends made after a prior snapshot (live read-model, not a stale copy)', async () => {
    const j = make();
    await j.append(newEntry(P.user('one')));
    expect((await j.snapshot()).length).toBe(1);
    await j.append(newEntry(P.user('two')));
    expect((await j.snapshot()).length).toBe(2);
    expect(await j.snapshot()).toEqual(await drainRead(j));
  });

  it('does NOT re-open the JSONL on repeat calls — reads disk ONCE at hydration', async () => {
    const jsonl = new JsonlStore(join(dir, 'once.jsonl'));
    const j = make('once', jsonl);
    await j.append(newEntry(P.user('a')));
    await j.append(newEntry(P.user('b')));
    const readSpy = vi.spyOn(jsonl, 'read');
    // Three snapshots + a construction-params-style scan must hit ZERO disk reads:
    // the read-model was materialized at hydration (before the spy).
    await j.snapshot();
    await j.snapshot();
    await j.snapshot();
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('cold resume (fresh Journal over the same file) hydrates the read-model once', async () => {
    const path = join(dir, 'resume.jsonl');
    const j1 = make('resume', new JsonlStore(path));
    await j1.append(newEntry(P.user('persisted')));
    await j1.append(newEntry(P.toolUse('tu1')));
    // Fresh process: a new Journal over the same on-disk file.
    const j2 = make('resume', new JsonlStore(path));
    expect(await j2.snapshot()).toEqual(await drainRead(j1));
  });
});

describe('Journal.liveSuspendedIds() — the O(1) routing memo', () => {
  it('memoizes: two calls with no intervening append return the SAME Set reference', async () => {
    const j = make();
    await j.append(newEntry(P.user('do it')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.pending('i1', 'tu1')));
    const a = await j.liveSuspendedIds();
    const b = await j.liveSuspendedIds();
    expect(a).toBe(b); // cache hit — no recompute
  });

  it('invalidates on append (a resolve drops the count back to zero)', async () => {
    const j = make();
    await j.append(newEntry(P.user('do it')));
    await j.append(newEntry(P.toolUse('tu1')));
    await j.append(newEntry(P.pending('i1', 'tu1')));
    expect((await j.liveSuspendedIds()).size).toBe(1); // suspended
    await j.append(newEntry(P.toolResult('tu1')));
    await j.append(newEntry(P.resolve('i1')));
    expect((await j.liveSuspendedIds()).size).toBe(0); // answered + resolved → not live
  });

  it('INVARIANT: memo == fresh liveSuspendedToolUseIds(snapshot) after EVERY step of an arbitrary suspend/resume sequence', async () => {
    const j = make();
    // An arbitrary interleaving: two overlapping pauses, a partial answer, a second
    // tool, a resolve, then a fresh unanswered pause.
    const steps: JournalPayload[] = [
      P.user('go'),
      P.toolUse('tu1'), P.pending('i1', 'tu1'),
      P.toolUse('tu2'), P.pending('i2', 'tu2'),
      P.toolResult('tu1'), P.resolve('i1'),
      P.user('again'),
      P.toolUse('tu3'), P.pending('i3', 'tu3'),
      P.toolResult('tu2'), P.resolve('i2'),
    ];
    for (const payload of steps) {
      await j.append(newEntry(payload));
      const memo = await j.liveSuspendedIds();
      const fresh = liveSuspendedToolUseIds([...await j.snapshot()]);
      expect([...memo].sort()).toEqual([...fresh].sort()); // provably consistent
    }
  });

  it('INVARIANT holds across a cold resume (memo rebuilt from disk == fresh scan)', async () => {
    const path = join(dir, 'inv-resume.jsonl');
    const j1 = make('inv', new JsonlStore(path));
    await j1.append(newEntry(P.user('go')));
    await j1.append(newEntry(P.toolUse('tu1')));
    await j1.append(newEntry(P.pending('i1', 'tu1')));
    const j2 = make('inv', new JsonlStore(path));
    const memo = await j2.liveSuspendedIds();
    const fresh = liveSuspendedToolUseIds([...await j2.snapshot()]);
    expect([...memo].sort()).toEqual([...fresh].sort());
    expect(memo.size).toBe(1);
  });
});
