import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { readFromCheckpoint } from '../checkpoint.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../../contract/journal.js';

// P2.4 Task 9 — rewind_boundary projection pivot.
//
// `Journal.rewindTo(pivotUuid)` appends an append-only `rewind_boundary`
// (CONTEXT_POLICY:false) and forks the leaf. `applyRewind` runs in the projection
// pipeline right before applyCompaction and EXCLUDES the abandoned span from the
// projected CONTEXT — every CONTEXT entry appended AFTER the pivot but BEFORE the
// rewind marker. Pre-pivot context, the post-rewind continuation, and ALL
// non-context state (todos / usage / interactions / boundaries) survive. Disk is
// never rewritten — rewind is projection-only, exactly like compaction.

const dir = join(tmpdir(), `journal-rewind-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const fileFor = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId: string) =>
  new Journal({
    taskId, workspaceId: 'w',
    jsonl: new JsonlStore(fileFor(taskId)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-07-02T00:00:00.000Z'),
  });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  assistant: (text: string): JournalPayload => ({ type: 'assistant', blocks: [{ type: 'text', text } as never] }),
  plan: (op: 'create' | 'update', id: string, fields?: Record<string, unknown>): JournalPayload =>
    ({ type: 'plan', op, id, ...fields } as JournalPayload),
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
const texts = (es: JournalEntry[]): string[] =>
  es.map((e) => ((e.payload as { blocks?: { text?: string }[] }).blocks?.[0]?.text ?? ''));
async function collect(it: AsyncIterable<JournalEntry>): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('P2.4 — rewindTo / applyRewind projection pivot', () => {
  it('rewind to a mid-turn user entry → projection contains only pre-pivot context', async () => {
    const j = make('r1');
    await j.append(newEntry(P.user('q1')));
    await j.append(newEntry(P.assistant('a1')));
    const pivot = await j.append(newEntry(P.user('q2'))); // rewind target
    await j.append(newEntry(P.assistant('a2')));           // abandoned
    await j.append(newEntry(P.user('q3')));                // abandoned

    await j.rewindTo(pivot.uuid);
    const state = await j.project();

    expect(texts(state.messages)).toEqual(['q1', 'a1', 'q2']); // post-pivot context excluded
    // The rewind_boundary itself is non-context — it never appears in the model's messages.
    expect(state.messages.some((m) => m.payload.type === 'rewind_boundary')).toBe(false);
  });

  it('a post-rewind append continues from the pivot (abandoned span stays gone)', async () => {
    const j = make('r2');
    await j.append(newEntry(P.user('q1')));
    const pivot = await j.append(newEntry(P.user('q2')));
    await j.append(newEntry(P.assistant('abandoned')));

    await j.rewindTo(pivot.uuid);
    const cont = await j.append(newEntry(P.user('q2-take-2')));
    const state = await j.project();

    expect(texts(state.messages)).toEqual(['q1', 'q2', 'q2-take-2']);
    expect(cont.parentUuid).toBe(pivot.uuid); // the new turn forks off the pivot
  });

  it('a second rewind supersedes the first (last boundary wins)', async () => {
    const j = make('r3');
    const p0 = await j.append(newEntry(P.user('q1')));
    await j.append(newEntry(P.assistant('a1')));
    const p1 = await j.append(newEntry(P.user('q2')));
    await j.append(newEntry(P.assistant('a2')));

    await j.rewindTo(p1.uuid); // first: back to q2
    await j.rewindTo(p0.uuid); // second: back further to q1 — supersedes
    const state = await j.project();

    expect(texts(state.messages)).toEqual(['q1']); // only the last pivot's pre-context
  });

  it('nested rewinds are CUMULATIVE — a first rewind\'s abandoned span never resurrects under a later one', async () => {
    const j = make('r3b');
    await j.append(newEntry(P.user('c1')));
    await j.append(newEntry(P.user('c2')));
    const p1 = await j.append(newEntry(P.user('c3'))); // first pivot
    await j.append(newEntry(P.user('c4')));            // abandoned by rewind #1
    await j.append(newEntry(P.user('c5')));            // abandoned by rewind #1
    await j.rewindTo(p1.uuid);
    const p2 = await j.append(newEntry(P.user('c7'))); // continuation + second (later) pivot
    await j.append(newEntry(P.user('c8')));            // abandoned by rewind #2
    await j.rewindTo(p2.uuid);
    const state = await j.project();

    expect(texts(state.messages)).toEqual(['c1', 'c2', 'c3', 'c7']);
    // Neither rewind's abandoned span may reappear: c4/c5 (rewind #1) nor c8 (rewind #2).
    for (const ghost of ['c4', 'c5', 'c8']) {
      expect(texts(state.messages)).not.toContain(ghost);
    }
  });

  it('compaction + rewind compose: rewind to a post-compaction entry keeps the summary leading', async () => {
    const j = make('r4');
    await j.append(newEntry(P.user('old turn')));
    const keep = await j.append(newEntry(P.user('kept turn')));
    const summary = await j.append(newEntry(P.assistant('[summary of earlier turns]')));
    await j.compact({
      summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid,
      trigger: 'auto', preTokens: 100, postTokens: 10, base,
    });
    const pivot = await j.append(newEntry(P.user('after compaction — pivot')));
    await j.append(newEntry(P.assistant('abandoned after pivot')));

    await j.rewindTo(pivot.uuid);
    const state = await j.project();

    expect(state.compactionSummaryLeading).toBe(true);
    expect(state.messages[0].uuid).toBe(summary.uuid);            // summary still leads
    expect(texts(state.messages).at(-1)).toBe('after compaction — pivot'); // abandoned tail gone
    expect(texts(state.messages)).not.toContain('abandoned after pivot');
  });

  it('non-context state (todos) survives a rewind', async () => {
    const j = make('r5');
    await j.append(newEntry(P.plan('create', 'a', { content: 'Task A', status: 'pending' })));
    const pivot = await j.append(newEntry(P.user('pivot here')));
    // A todo mutation AFTER the pivot — state, not context, so it must survive the rewind.
    await j.append(newEntry(P.plan('update', 'a', { status: 'completed' })));
    await j.append(newEntry(P.assistant('abandoned')));

    await j.rewindTo(pivot.uuid);
    const state = await j.project();

    expect(state.todos).toEqual([{ id: 'a', content: 'Task A', status: 'completed' }]);
    expect(texts(state.messages)).toEqual(['pivot here']); // context rewound
  });

  it('a missing pivot degrades to no-rewind (identity), never hides everything', async () => {
    const j = make('r6');
    await j.append(newEntry(P.user('q1')));
    await j.append(newEntry(P.user('q2')));
    await j.rewindTo('does-not-exist'); // pivot uuid absent (e.g. quarantined)
    const state = await j.project();
    expect(texts(state.messages)).toEqual(['q1', 'q2']); // full context preserved, no throw
  });

  it('read-model equality under rewind: live projection deep-equals a fresh cold-hydrate', async () => {
    const live = make('r7');
    await live.append(newEntry(P.user('q1')));
    const pivot = await live.append(newEntry(P.user('q2')));
    await live.append(newEntry(P.assistant('abandoned')));
    await live.rewindTo(pivot.uuid);
    await live.append(newEntry(P.user('continue')));
    const liveState = await live.project();

    const cold = make('r7'); // fresh instance over the same on-disk journal
    const coldState = await cold.project();

    expect(liveState.messages).toEqual(coldState.messages);
    expect(liveState.leaf).toEqual(coldState.leaf);
    expect(liveState.compactionSummaryLeading).toEqual(coldState.compactionSummaryLeading);
  });

  it('rewind is projection-only — the durable JSONL keeps every entry', async () => {
    const j = make('r8');
    await j.append(newEntry(P.user('q1')));
    const pivot = await j.append(newEntry(P.user('q2')));
    await j.append(newEntry(P.assistant('abandoned')));
    await j.rewindTo(pivot.uuid);

    const raw = await collect(j.read());
    // 3 originals + 1 rewind_boundary, all still on disk (nothing deleted).
    expect(raw).toHaveLength(4);
    expect(raw.filter((e) => e.payload.type === 'rewind_boundary')).toHaveLength(1);
    expect(raw.some((e) => texts([e])[0] === 'abandoned')).toBe(true); // abandoned entry still durable
  });
});

// R4b (harness to nine) — a rewind past a compaction. The compaction's summary is a context
// entry the rewind's window drops; its boundary must go with it, or applyCompaction (which reads
// only the LAST boundary) finds a boundary with no summary and degrades to the whole uncompacted
// journal, ignoring every earlier compaction, reporting compaction_anchor_missing every round.
describe('R4b — rewinding across compactions', () => {
  async function twoCompactions(taskId: string, onIntegrityEvent: (e: unknown) => void, checkpoint = false) {
    const j = new Journal({
      taskId, workspaceId: 'w', jsonl: new JsonlStore(fileFor(taskId)), mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-10-02T00:00:00.000Z'), onIntegrityEvent, ...(checkpoint ? { checkpoint: true } : {}),
    });
    const at = (p: JournalPayload) => j.append(newEntry(p));
    // The person's messages carry their principal, so a checkpoint finds where the turn started (checkpoint.ts turnStartSeq).
    const ask = (text: string) => j.append({ ...base, principal: { kind: 'user', userId: 'u' }, payload: P.user(text) });
    await ask('q1');
    const a1 = await at(P.assistant('a1'));
    const q2 = await ask('q2');
    await at(P.assistant('a2'));
    const s1 = await at(P.user('summary one'));
    await j.compact({ summaryUuid: s1.uuid, preservedUuids: [], firstKeptId: q2.uuid, trigger: 'auto', preTokens: 9, postTokens: 1, base });
    await ask('q3');
    const a3 = await at(P.assistant('a3'));
    const q4 = await ask('q4');
    const a4 = await at(P.assistant('a4'));
    const s2 = await at(P.user('summary two'));
    await j.compact({ summaryUuid: s2.uuid, preservedUuids: [], firstKeptId: q4.uuid, trigger: 'auto', preTokens: 9, postTokens: 1, base });
    const q5 = await ask('q5');
    await at(P.assistant('a5'));
    return { j, a1, a3, a4, q5 };
  }

  it('before rewinding: the newest compaction leads', async () => {
    const events: unknown[] = [];
    const { j } = await twoCompactions('rc0', (e) => events.push(e));
    const state = await j.project();
    expect(texts(state.messages)).toEqual(['summary two', 'q4', 'a4', 'q5', 'a5']);
    expect(events).toEqual([]);
  });

  it('a rewind between the two: the compaction at or before the pivot leads, and nothing degrades', async () => {
    const events: unknown[] = [];
    const { j, a3 } = await twoCompactions('rc1', (e) => events.push(e));
    await j.rewindTo(a3.uuid);
    const state = await j.project();
    expect(texts(state.messages)).toEqual(['summary one', 'q2', 'a2', 'q3', 'a3']);
    expect(state.compactionSummaryLeading).toBe(true);
    expect(events).toEqual([]); // no compaction_anchor_missing
    // The next turn continues from there, on the same compacted view.
    await j.append(newEntry(P.user('q4 again')));
    expect(texts((await j.project()).messages)).toEqual(['summary one', 'q2', 'a2', 'q3', 'a3', 'q4 again']);
    expect(events).toEqual([]);
  });

  it('a rewind before both: no compaction leads, the plain history to the pivot does', async () => {
    const events: unknown[] = [];
    const { j, a1 } = await twoCompactions('rc2', (e) => events.push(e));
    await j.rewindTo(a1.uuid);
    const state = await j.project();
    expect(texts(state.messages)).toEqual(['q1', 'a1']);
    expect(state.compactionSummaryLeading).toBe(false);
    expect(events).toEqual([]);
  });

  describe('with JOURNAL_CHECKPOINT_V1: a cold open starts from the newer compaction\'s checkpoint (HIGH-3)', () => {
    // The checkpoint keeps every non-context entry, so the older compaction's boundary is in it,
    // but not that compaction's summary, nor anything before the newer one's kept turns.
    let opens = 0;
    /** Each open mints its own ids: a later open never reuses one the file already holds. */
    const open = (taskId: string, checkpoint: boolean, onIntegrityEvent?: (e: unknown) => void) => {
      const prefix = `open${opens++}`;
      let n = 0;
      return new Journal({
        taskId, workspaceId: 'w', jsonl: new JsonlStore(fileFor(taskId)), mirror: new InMemorySessionStore(),
        clock: { now: () => '2026-10-03T00:00:00.000Z', uuid: () => `${prefix}-${n++}` },
        ...(onIntegrityEvent ? { onIntegrityEvent } : {}), ...(checkpoint ? { checkpoint: true } : {}),
      });
    };
    /** The projection a turn is built from. `leaf` is left out: a live rewind moves it to the pivot,
     *  while a cold open takes the file's last entry (the marker); both read the same history. */
    const view = (state: Awaited<ReturnType<Journal['project']>>) => {
      const { leaf: _leaf, ...rest } = state;
      void _leaf;
      return rest;
    };
    const anchorMissing = (events: unknown[]) => events.filter((e) => (e as { kind?: string }).kind === 'compaction_anchor_missing');
    const fromCheckpoint = async (taskId: string) => (await readFromCheckpoint(new JsonlStore(fileFor(taskId))))?.partial;

    it('a rewind into its kept turns reads the whole file first: the older summary leads, as a full read gives', async () => {
      const { a4 } = await twoCompactions('rc3', () => {}, true);
      expect(await fromCheckpoint('rc3')).toBe(true); // the cold open below really is a checkpoint rebuild
      const events: unknown[] = [];
      const j = open('rc3', true, (e) => events.push(e));
      await j.project();
      await j.rewindTo(a4.uuid);
      const live = await j.project();
      expect(texts(live.messages)).toEqual(['summary one', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4']);
      expect(view(live)).toEqual(view(await open('rc3', false).project()));
      expect(anchorMissing(events)).toEqual([]);
      // A fresh cold open cannot rebuild past this rewind from the checkpoint: it reads in full, and agrees.
      expect(await fromCheckpoint('rc3')).toBeUndefined();
      const later: unknown[] = [];
      expect(view(await open('rc3', true, (e) => later.push(e)).project())).toEqual(view(live));
      expect(anchorMissing(later)).toEqual([]);
    });

    it('a rewind after the checkpoint\'s compaction keeps the fast path, and agrees with a full read', async () => {
      const { q5 } = await twoCompactions('rc4', () => {}, true);
      const j = open('rc4', true);
      await j.project();
      await j.rewindTo(q5.uuid);
      const live = await j.project();
      expect(texts(live.messages)).toEqual(['summary two', 'q4', 'a4', 'q5']);
      expect(await fromCheckpoint('rc4')).toBe(true);
      expect(view(await open('rc4', true).project())).toEqual(view(live));
      expect(view(live)).toEqual(view(await open('rc4', false).project()));
    });
  });
});
