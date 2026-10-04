/**
 * R2 (harness to nine) — rebuild from a checkpoint (JOURNAL_CHECKPOINT_V1).
 *
 * A compaction writes its replacement history right behind its boundary; a fresh process reads
 * the journal backwards to the newest checkpoint and never touches the bytes before it.
 *
 * Revert-proof: without the writer (Journal.compact's checkpoint) the 10k-entry journal is read
 * back to its first line (10,013 lines instead of 3); without the reader (doHydrate's
 * readFromCheckpoint) the checkpoint is never consulted (0). Either fails the "bounded" test; the
 * equality tests pin that the faster rebuild is the same history.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore, type SessionStore } from '../session-store.js';
import type { Clock } from '../clock.js';
import { CHECKPOINT_KEY, checkpointOf, turnStartSeq } from '../checkpoint.js';
import { clampForMirror } from '../mirror-clamp.js';
import { buildDeferredResultContent } from '../../interaction/strategy.js';
import { currentTurnKey } from '../../../policy/injection-screen.js';
import { RECALL_FENCE_OPEN } from '../../../contract/injected-user-text.js';
import { isContextEntry, type JournalEntry, type JournalPayload, type NewEntry } from '../../../contract/journal.js';

const dir = join(tmpdir(), `journal-checkpoint-test-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const USER = { kind: 'user', userId: 'u' } as const;
const BASE: Omit<NewEntry, 'payload'> = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '',
};
const text = (t: string) => [{ type: 'text', text: t } as never];

/** Counts the lines a hydrate parses: the rebuild's cost. */
class CountingStore extends JsonlStore {
  linesRead = 0;
  override async readBack(stop: (e: JournalEntry) => boolean) {
    const r = await super.readBack(stop);
    this.linesRead = r?.linesRead ?? -1;
    return r;
  }
}

type Draft = { payload: JournalPayload; principal?: JournalEntry['principal']; agentPath?: JournalEntry['agentPath'] };
function build(drafts: Draft[]): JournalEntry[] {
  return drafts.map((d, seq) => ({
    uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0,
    workspaceId: 'w', agentId: 'g', principal: d.principal ?? { kind: 'system' }, timestamp: 'T',
    ...(d.agentPath ? { agentPath: d.agentPath } : {}),
    payload: d.payload,
  }));
}

/** Eight entries every size shares (state, and entries something points at), then `rounds` rounds of four. */
function prefix(rounds: number, bigLast = false): Draft[] {
  const out: Draft[] = [
    { principal: USER, payload: { type: 'user', blocks: text('the first ask') } }, // e0: preserved by the compaction
    { principal: USER, payload: { type: 'user', blocks: text('the conversation it had elsewhere'), injected: 'engine_handover' } },
    { payload: { type: 'plan', op: 'create', id: 'p1', content: 'write the report', status: 'pending' } },
    { payload: { type: 'usage', intelligence: 1, actions: 0, compute: 0 } },
    { payload: { type: 'tool_use', toolUseId: 'ask-1', name: 'AskUserQuestion', input: {} } },
    { payload: { type: 'tool_result', toolUseId: 'ask-1', blocks: text(buildDeferredResultContent()) } },
    { payload: { type: 'interaction', interactionId: 'i-1', resolved: false, data: { toolUseId: 'ask-1', kind: 'ask_question', toolName: 'AskUserQuestion' } } },
    {
      agentPath: [{ depth: 1, agentToolUseId: 'agent-1', agentSlug: 'researcher', agentName: 'Researcher' }],
      payload: { type: 'assistant', blocks: text('a helper speaks in its own scope') },
    },
  ];
  for (let r = 0; r < rounds; r++) {
    const body = bigLast && r === rounds - 1 ? 'x'.repeat(1_500_000) : `contents of file ${r} `.repeat(20);
    out.push(
      { principal: USER, payload: { type: 'user', blocks: text(`ask ${r}`) } },
      { payload: { type: 'tool_use', toolUseId: `t${r}`, name: 'Read', input: { file_path: `/f${r}` } } },
      { payload: { type: 'tool_result', toolUseId: `t${r}`, blocks: text(body) } },
      { payload: { type: 'assistant', blocks: text(`answer ${r}`) } },
    );
  }
  return out;
}

/** Each journal mints its own uuids (two processes never share a counter). */
let opened = 0;
function clock(): Clock {
  const tag = `j${++opened}`;
  let n = 0;
  return { now: () => '2026-10-02T00:00:00.000Z', uuid: () => `${tag}-${n++}` };
}

function open(path: string, checkpoint: boolean, jsonl: JsonlStore = new JsonlStore(path), mirror: SessionStore = new InMemorySessionStore()): Journal {
  return new Journal({
    taskId: 't', workspaceId: 'w', jsonl, mirror, clock: clock(),
    ...(checkpoint ? { checkpoint: true } : {}),
  });
}

/** A task the previous process wrote: `rounds` rounds, one compaction (kept window = the last round), one more turn. */
async function longJournal(name: string, rounds: number, opts: { bigLast?: boolean; writer?: boolean } = {}): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const drafts = prefix(rounds, opts.bigLast);
  await fs.writeFile(path, build(drafts).map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
  const j = open(path, opts.writer ?? true);
  const summary = await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('SUMMARY of the work so far') } });
  await j.compact({
    summaryUuid: summary.uuid, preservedUuids: ['e0'], firstKeptId: `e${drafts.length - 4}`,
    trigger: 'auto', preTokens: 1000, postTokens: 100, base: BASE,
  });
  await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('and now this') } });
  await j.append({ ...BASE, payload: { type: 'assistant', blocks: text('done') } });
  return path;
}

async function lines(path: string): Promise<JournalEntry[]> {
  return (await fs.readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as JournalEntry);
}
const checkpoints = (es: JournalEntry[]) => es.filter((e) => e.payload.type === 'custom' && e.payload.key === CHECKPOINT_KEY);

describe('Journal rebuild from a checkpoint (R2)', () => {
  it('rebuild cost is flat: 48 entries or 10,008 before the checkpoint, the same 3 lines are read', async () => {
    const small = await longJournal('small', 10);
    const large = await longJournal('large', 2500);
    expect((await lines(large)).length).toBe(8 + 2500 * 4 + 5);

    const read = async (path: string) => {
      const store = new CountingStore(path);
      const j = open(path, true, store);
      const snapshot = await j.snapshot();
      return { linesRead: store.linesRead, size: snapshot.length, uuids: new Set(snapshot.map((e) => e.uuid)) };
    };
    const a = await read(small);
    const b = await read(large);
    expect(a.linesRead).toBe(3); // the checkpoint and the two entries after it
    expect(b.linesRead).toBe(3);
    expect(b.size).toBe(a.size); // the read-model is bounded too
    // Carried whatever the size: state, what an interaction names, the marker, the helper's scope.
    for (const id of ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) expect(b.uuids.has(id)).toBe(true);
    expect(b.uuids.has('e8')).toBe(false); // round 0's ask: compacted away in an earlier turn
  });

  it('the rebuilt history is identical to a full replay (projection, todos, leaf, live pauses)', async () => {
    for (const rounds of [3, 10, 400]) { // 3: too small for a checkpoint (the guard), read in full
      const path = await longJournal(`equal-${rounds}`, rounds);
      const fromCheckpoint = open(path, true);
      const full = open(path, false);
      expect(await fromCheckpoint.project()).toEqual(await full.project());
      expect(await fromCheckpoint.liveSuspendedIds()).toEqual(await full.liveSuspendedIds());
      expect((await fromCheckpoint.project()).todos).toHaveLength(1);
    }
  });

  it('flag off writes no checkpoint and reads the whole file (byte-identical)', async () => {
    const path = await longJournal('off', 5, { writer: false });
    expect(checkpoints(await lines(path))).toEqual([]);
    const store = new CountingStore(path);
    await open(path, false, store).project();
    expect(store.linesRead).toBe(0); // readBack is never asked
  });

  it('a checkpoint line bigger than one read (1 MB) is put back together', async () => {
    const path = await longJournal('big', 8, { bigLast: true });
    const store = new CountingStore(path);
    const j = open(path, true, store);
    expect(await j.project()).toEqual(await open(path, false).project());
    expect(store.linesRead).toBe(3);
  });

  it('a second compaction supersedes the first: its checkpoint never carries the old one', async () => {
    const path = await longJournal('twice', 6);
    const j = open(path, true);
    for (let r = 0; r < 3; r++) {
      await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text(`later ask ${r}`) } });
      await j.append({ ...BASE, payload: { type: 'assistant', blocks: text(`later answer ${r}`) } });
    }
    const keep = await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('the newest ask') } });
    const summary = await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('SECOND SUMMARY') } });
    await j.compact({ summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid, trigger: 'auto', preTokens: 9, postTokens: 1, base: BASE });
    const all = await lines(path);
    const newest = checkpointOf(checkpoints(all).at(-1)!);
    expect(newest).not.toBeNull();
    expect(checkpoints(newest!.entries)).toEqual([]);
    expect(await open(path, true).project()).toEqual(await open(path, false).project());
  });

  it('a rewind to a pivot the checkpoint dropped reads the whole file first, and stays identical', async () => {
    const path = await longJournal('rewind', 30);
    const j = open(path, true);
    await j.project();
    await j.rewindTo('e20'); // round 3's ask: dropped by the checkpoint
    await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('a different path') } });
    const live = await j.project();
    expect(live).toEqual(await open(path, false).project());
    expect(await open(path, true).project()).toEqual(live); // a fresh rebuild cannot place the pivot: full read
  });

  it('a line after the checkpoint that does not parse makes the rebuild read forwards (it quarantines there)', async () => {
    const path = await longJournal('bad-tail', 5);
    const late: JournalEntry = { ...build([{ principal: USER, payload: { type: 'user', blocks: text('late') } }])[0], uuid: 'late', seq: 999 };
    await fs.appendFile(path, 'not json at all\n' + JSON.stringify(late) + '\n', 'utf8');
    const store = new CountingStore(path);
    expect(await open(path, true, store).project()).toEqual(await open(path, false).project());
    expect(store.linesRead).toBe(-1); // readBack gave up; the forward read answered
  });

  it("a lossless mirror is still asked about the whole file, off the hydrate", async () => {
    const path = await longJournal('owed', 5);
    const owed = vi.fn(async (_taskId: string, _local: readonly JournalEntry[]): Promise<JournalEntry[]> => []);
    const mirror: SessionStore = { appendBatch: async () => {}, load: async () => null, listTasks: async () => [], owed };
    const j = open(path, true, new JsonlStore(path), mirror);
    await j.project();
    await j.flushMirror();
    expect(owed).toHaveBeenCalledTimes(1);
    expect(owed.mock.calls[0]![1]).toHaveLength((await lines(path)).length);
  });

  it("the current turn's start is the injection screen's (currentTurnKey), so the screened window is never dropped", () => {
    const cases: JournalEntry[][] = [
      build(prefix(3)),
      build([...prefix(2), { principal: USER, payload: { type: 'user', blocks: text(`${RECALL_FENCE_OPEN}source="nami">a memory</recalled_memory>`) } }]),
      build([...prefix(1), { principal: USER, payload: { type: 'user', blocks: text('SUMMARY') } },
        { payload: { type: 'compact_boundary', summaryUuid: 'e12', preservedUuids: [], firstKeptId: 'e8', trigger: 'auto', preTokens: 1, postTokens: 1 } }]),
      build([{ principal: USER, payload: { type: 'user', blocks: text('remember this'), control: 'memory' } }]),
      build([{ principal: { kind: 'system' }, payload: { type: 'user', blocks: text('a breadcrumb') } }]),
      build([{ payload: { type: 'assistant', blocks: text('no user at all') } }]),
    ];
    for (const es of cases) {
      const key = currentTurnKey(es);
      expect(turnStartSeq(es)).toBe(key ? es.find((e) => e.uuid === key)!.seq : -Infinity);
    }
  });
  it('a checkpoint that would not drop half the read-model is not written, and the rebuild is still identical', async () => {
    const path = await longJournal('small-guard', 3); // 22 entries at the compaction, 14 still needed
    expect(checkpoints(await lines(path))).toEqual([]); // the revert writes one anyway
    const store = new CountingStore(path);
    expect(await open(path, true, store).project()).toEqual(await open(path, false).project());
    expect(store.linesRead).toBe((await lines(path)).length); // read whole on the way back, once
  });

  it('the boundary and its checkpoint are one unit: an append issued during compact() lands after both', async () => {
    // Review R2-1: a helper's scope-tagged append used to slip between them and be in neither.
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, 'unit.jsonl');
    const drafts = prefix(10);
    await fs.writeFile(path, build(drafts).map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
    const j = open(path, true);
    const summary = await j.append({ ...BASE, principal: USER, payload: { type: 'user', blocks: text('SUMMARY') } });
    const compacting = j.compact({
      summaryUuid: summary.uuid, preservedUuids: ['e0'], firstKeptId: `e${drafts.length - 4}`,
      trigger: 'auto', preTokens: 1, postTokens: 1, base: BASE,
    });
    const helper = j.append({
      ...BASE,
      agentPath: [{ depth: 1, agentToolUseId: 'agent-1', agentSlug: 'researcher', agentName: 'Researcher' }],
      payload: { type: 'assistant', blocks: text('a helper wrote this mid-compaction') },
    });
    const [boundary, late] = await Promise.all([compacting, helper]);
    const cp = checkpoints(await lines(path))[0]!;
    expect(cp.seq).toBe(boundary.seq + 1); // the revert lets the helper's append in between
    expect(cp.parentUuid).toBe(boundary.uuid);
    expect(late.seq).toBe(boundary.seq + 2);
    expect(await open(path, true).snapshot()).toContainEqual(late);
  });

  it('a checkpoint not written right behind its boundary is never trusted: the rebuild reads in full', async () => {
    const path = await longJournal('gap', 10);
    const all = await lines(path);
    const b = all.findIndex((e) => e.payload.type === 'compact_boundary');
    const boundary = all[b]!;
    const cp = all[b + 1]!;
    const intruder: JournalEntry = {
      ...cp, uuid: 'intruder', seq: boundary.seq + 1, parentUuid: boundary.uuid,
      agentPath: [{ depth: 1, agentToolUseId: 'agent-1', agentSlug: 'researcher', agentName: 'Researcher' }],
      payload: { type: 'assistant', blocks: text('written between them') },
    };
    const moved: JournalEntry = { ...cp, seq: boundary.seq + 2, parentUuid: 'intruder' };
    const rest = all.slice(b + 2).map((e) => ({ ...e, seq: e.seq + 1 }));
    await fs.writeFile(path, [...all.slice(0, b + 1), intruder, moved, ...rest].map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
    const snapshot = await open(path, true).snapshot();
    expect(snapshot.map((e) => e.uuid)).toContain('intruder'); // the revert trusts the checkpoint: the intruder is in neither
    expect(await open(path, true).project()).toEqual(await open(path, false).project());
  });

  it('a plain mirror clamps an oversize checkpoint to data: null (never a context note); a journal hydrated from it reads in full', async () => {
    // Review R2-2: the old clamp made it a `system` entry, which the model would see after every compaction.
    const path = await longJournal('mirror', 10);
    const all = await lines(path);
    const largestOther = Math.max(...all.filter((e) => checkpoints([e]).length === 0).map((e) => JSON.stringify(e).length));
    expect(JSON.stringify(checkpoints(all)[0]).length).toBeGreaterThan(largestOther);
    const rows = all.map((e) => clampForMirror(e, largestOther + 1));
    const clamped = checkpoints(rows)[0]!;
    expect(clamped.payload).toEqual({ type: 'custom', key: CHECKPOINT_KEY, data: null });
    expect(isContextEntry(clamped)).toBe(false);
    const mirror = new InMemorySessionStore();
    await mirror.appendBatch('t', rows);
    const fromMirror = new Journal({
      taskId: 't', workspaceId: 'w', jsonl: new JsonlStore(join(dir, 'fresh-box.jsonl')), mirror,
      clock: clock(), hydrateFromMirror: true, checkpoint: true,
    });
    const state = await fromMirror.project();
    expect(state.messages.some((m) => m.payload.type === 'system')).toBe(false);
    expect(state).toEqual(await open(path, false).project());
  });
});
