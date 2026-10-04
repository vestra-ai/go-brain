import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { CHECKPOINT_KEY } from '../checkpoint.js';
import {
  FORK_ORIGIN_KEY, FORKED_ASK_CLOSED, ForkTargetExistsError, forkCutIndex, forkEntries, forkOriginOf, forkStartsPaused,
  mirrorForkedJournal, writeForkedJournal,
} from '../fork.js';
import { buildDeferredResultContent, computeSuspendedToolUseIds } from '../../interaction/strategy.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../../contract/journal.js';

// R3 (TASK_FORK_V1) — a task forked at the end of one of its turns. The child's journal is the
// parent's through that turn (ids unchanged, relabelled as the child's), then a fork header; it
// carries the conversation, never the bill; the parent's file is never touched.

const dir = join(tmpdir(), `journal-fork-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const fileFor = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId: string, mirror = new InMemorySessionStore()) =>
  new Journal({
    taskId, workspaceId: 'w',
    jsonl: new JsonlStore(fileFor(taskId)),
    mirror,
    // Ids prefixed by task, so a child's own entries can never collide with the ids it inherited.
    clock: { now: sequentialClock('2026-10-02T00:00:00.000Z').now, uuid: ((n: number) => () => `${taskId}-${n++}`)(0) },
  });

const base = (taskId: string) => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'user' as const, userId: 'u' }, timestamp: '',
});
const P = {
  user: (text: string): JournalPayload => ({ type: 'user', blocks: [{ type: 'text', text } as never] }),
  assistant: (text: string): JournalPayload => ({ type: 'assistant', blocks: [{ type: 'text', text } as never] }),
  toolUse: (id: string): JournalPayload => ({ type: 'tool_use', toolUseId: id, name: 'Bash', input: {} }),
  toolResult: (id: string, text: string): JournalPayload => ({ type: 'tool_result', toolUseId: id, blocks: [{ type: 'text', text } as never] }),
  usage: (costUsd: number, inputTokens = 1000): JournalPayload => ({
    type: 'usage', intelligence: costUsd, actions: 0, compute: 0,
    raw: { costUsd, model: 'm', inputTokens, outputTokens: 50 },
  }),
};
const entry = (taskId: string, payload: JournalPayload): NewEntry => ({ ...base(taskId), payload });
const texts = (es: JournalEntry[]): string[] =>
  es.map((e) => ((e.payload as { blocks?: { text?: string }[] }).blocks?.[0]?.text ?? ''));
async function collect(it: AsyncIterable<JournalEntry>): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const costOf = (es: JournalEntry[]): number =>
  es.reduce((sum, e) => sum + (e.payload.type === 'usage' ? ((e.payload.raw as { costUsd?: number }).costUsd ?? 0) : 0), 0);
const sha = async (path: string) => createHash('sha256').update(await fs.readFile(path)).digest('hex');

/** Four turns on task `p`; answers the anchor each turn's end recorded (Journal.leafNow). */
async function fourTurns(j: Journal): Promise<string[]> {
  const anchors: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    await j.append(entry('p', P.user(`q${n}`)));
    await j.append(entry('p', P.assistant(`a${n}`)));
    await j.append(entry('p', P.usage(0.5, 1000 * n)));
    anchors.push(j.leafNow as string);
  }
  return anchors;
}

describe('R3 — forkCutIndex: through the anchor and what its turn wrote just after', () => {
  it('cuts at the anchor when the next entry is the next turn', async () => {
    const j = make('p');
    const anchors = await fourTurns(j);
    const all = await collect(j.read());
    expect(all[forkCutIndex(all, anchors[2])].uuid).toBe(anchors[2]);
  });

  it('answers -1 for an anchor the journal does not hold (never a guess)', async () => {
    const j = make('p');
    await fourTurns(j);
    expect(forkCutIndex(await collect(j.read()), 'not-in-this-journal')).toBe(-1);
  });

  it('runs on over the seal of a call the turn left open, past the state records between', async () => {
    const j = make('p');
    await j.append(entry('p', P.user('q1')));
    await j.append(entry('p', P.toolUse('t1')));
    const anchor = await j.append(entry('p', P.usage(0.1)));
    await j.append(entry('p', { type: 'mode', key: 'k', value: 1 }));
    const seal = await j.append(entry('p', P.toolResult('t1', 'Interrupted by user.')));
    await j.append(entry('p', P.user('q2')));
    const all = await collect(j.read());
    expect(all[forkCutIndex(all, anchor.uuid)].uuid).toBe(seal.uuid);
  });

  it('stops at the next context entry or a rewind marker, even with a call still open', async () => {
    const j = make('p');
    await j.append(entry('p', P.user('q1')));
    await j.append(entry('p', P.toolUse('t1')));
    const anchor = await j.append(entry('p', P.usage(0.1)));
    await j.append(entry('p', { type: 'rewind_boundary', pivotUuid: anchor.uuid }));
    await j.append(entry('p', P.toolResult('t1', 'late')));
    const all = await collect(j.read());
    expect(forkCutIndex(all, anchor.uuid)).toBe(all.findIndex((e) => e.uuid === anchor.uuid));
  });
});

describe('R3 — forkEntries: the conversation, relabelled, never the bill', () => {
  it('copies through the cut with ids unchanged, relabelled as the child, then the header', async () => {
    const j = make('p');
    const anchors = await fourTurns(j);
    const all = await collect(j.read());
    const cut = forkCutIndex(all, anchors[2]);
    const child = forkEntries(all, cut, { taskId: 'c', uuid: 'hdr', timestamp: '2026-10-02T01:00:00.000Z' });

    expect(child).toHaveLength(cut + 2);
    child.slice(0, cut + 1).forEach((e, i) => {
      expect({ uuid: e.uuid, parentUuid: e.parentUuid, seq: e.seq }).toEqual({ uuid: all[i].uuid, parentUuid: all[i].parentUuid, seq: all[i].seq });
      expect(e.taskId).toBe('c');
      expect(e.rootTaskId).toBe('c');
    });
    const header = child[child.length - 1];
    expect(header).toMatchObject({ uuid: 'hdr', parentUuid: anchors[2], seq: all[cut].seq + 1, taskId: 'c', rootTaskId: 'c' });
    expect(header.payload).toMatchObject({ type: 'custom', key: FORK_ORIGIN_KEY });
    expect(forkOriginOf(header)).toEqual({
      parentTaskId: 'p', parentUuid: anchors[2], parentSeq: all[cut].seq,
      // The context the child inherits, as the provider last counted it: turn 3's round.
      latestUsage: { inputTokens: 3000, outputTokens: 50, model: 'm', atSeq: all[cut].seq },
    });
  });

  it('the header\'s usage is the latest MAIN-loop round at or before the cut, never a helper\'s', () => {
    const at = (seq: number, payload: JournalPayload, extra: Partial<JournalEntry> = {}): JournalEntry => ({
      ...base('p'), uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, payload, ...extra,
    });
    const parent = [
      at(0, P.user('q1')),
      at(1, P.usage(0.1, 4200)),
      at(2, P.usage(0.2, 99_000), { agentPath: [{ depth: 1, agentToolUseId: 'a1', agentSlug: 'researcher', agentName: 'R' }] }),
      at(3, P.assistant('a1')),
      at(4, P.usage(0.3, 7777)), // after the cut: not inherited
    ];
    // A compaction or epilogue call measures another request (the pre-compaction size): never the context.
    const withCompaction = [...parent.slice(0, 4), at(4, { type: 'usage', intelligence: 0, actions: 0, compute: 0, raw: { costUsd: 0.4, model: 'm', source: 'compaction', inputTokens: 180_000, outputTokens: 900 } })];
    const compacted = forkEntries(withCompaction, 4, { taskId: 'c', uuid: 'hdr', timestamp: 'x' });
    expect(forkOriginOf(compacted[compacted.length - 1])?.latestUsage?.inputTokens).toBe(4200);
    const child = forkEntries(parent, 3, { taskId: 'c', uuid: 'hdr', timestamp: 'x' });
    expect(forkOriginOf(child[child.length - 1])?.latestUsage).toEqual({ inputTokens: 4200, outputTokens: 50, model: 'm', atSeq: 1 });
    const none = forkEntries(parent.slice(0, 1), 0, { taskId: 'c', uuid: 'hdr', timestamp: 'x' });
    expect(forkOriginOf(none[none.length - 1])).not.toHaveProperty('latestUsage');
  });

  it('zeroes every inherited cost, keeps the token counts, and never mutates the parent entries', async () => {
    const j = make('p');
    const anchors = await fourTurns(j);
    const all = await collect(j.read());
    const before = JSON.stringify(all);
    const child = forkEntries(all, forkCutIndex(all, anchors[2]), { taskId: 'c', uuid: 'hdr', timestamp: 'x' });

    expect(costOf(all)).toBe(2);
    expect(costOf(child)).toBe(0);
    const usage = child.find((e) => e.payload.type === 'usage');
    expect(usage?.payload).toMatchObject({ intelligence: 0, raw: { costUsd: 0, inputTokens: 1000, outputTokens: 50 } });
    expect(JSON.stringify(all)).toBe(before);
  });

  it('drops a checkpoint\'s data (its embedded copies would carry the costs back in)', () => {
    const at = (seq: number, payload: JournalPayload): JournalEntry => ({
      ...base('p'), uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, payload,
    });
    const parent = [
      at(0, P.user('q1')),
      at(1, { type: 'custom', key: CHECKPOINT_KEY, data: { boundaryUuid: 'b', entries: [at(9, P.usage(3))] } }),
      at(2, P.assistant('a1')),
    ];
    const child = forkEntries(parent, 2, { taskId: 'c', uuid: 'hdr', timestamp: 'x' });
    expect(child[1].payload).toEqual({ type: 'custom', key: CHECKPOINT_KEY, data: null });
  });
});

describe('R3 — the child resumes from the fork; the parent is untouched', () => {
  it('the child projects turns 1..3, continues from the header, and the parent file is byte-identical', async () => {
    const parent = make('p');
    const anchors = await fourTurns(parent);
    const parentBefore = await sha(fileFor('p'));
    const parentProjection = texts((await parent.project()).messages);

    const all = await collect(new JsonlStore(fileFor('p')).read());
    const entries = forkEntries(all, forkCutIndex(all, anchors[2]), { taskId: 'c', uuid: 'hdr', timestamp: 'x' });
    const mirror = new InMemorySessionStore();
    await writeForkedJournal(new JsonlStore(fileFor('c')), fileFor('c'), entries);
    await mirrorForkedJournal(mirror, 'c', entries);

    const child = make('c');
    expect(texts((await child.project()).messages)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
    const next = await child.append(entry('c', P.user('child q4')));
    expect(next).toMatchObject({ parentUuid: 'hdr', seq: entries[entries.length - 1].seq + 1 });
    expect(texts((await child.project()).messages)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'child q4']);

    // Both continue independently: the parent's own turn 4 and its file are exactly as they were.
    expect(await sha(fileFor('p'))).toBe(parentBefore);
    expect(texts((await make('p').project()).messages)).toEqual(parentProjection);
    expect(parentProjection).toContain('q4');
    // The child's mirror holds the inherited history too (a cold box rebuilds it from there).
    expect((await mirror.load('c'))?.map((e) => e.uuid)).toEqual(entries.map((e) => e.uuid));
  });

  it('refuses to write over an existing journal', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fileFor('c'), 'already here\n');
    const header: JournalEntry = { ...base('c'), uuid: 'hdr', parentUuid: null, seq: 0, payload: { type: 'label', name: 'x' } };
    await expect(writeForkedJournal(new JsonlStore(fileFor('c')), fileFor('c'), [header])).rejects.toBeInstanceOf(ForkTargetExistsError);
    expect(await fs.readFile(fileFor('c'), 'utf8')).toBe('already here\n');
  });

  it('the mirror upload sends every entry in windows, apart from the local write', async () => {
    const mirror = new InMemorySessionStore();
    const batches: number[] = [];
    const counting = { ...mirror, appendBatch: async (t: string, es: JournalEntry[]) => { batches.push(es.length); await mirror.appendBatch(t, es); }, load: (t: string) => mirror.load(t) } as unknown as InMemorySessionStore;
    const many = Array.from({ length: 450 }, (_, seq): JournalEntry => ({ ...base('c'), uuid: `m${seq}`, parentUuid: seq ? `m${seq - 1}` : null, seq, payload: { type: 'label', name: `l${seq}` } }));
    await mirrorForkedJournal(counting, 'c', many);
    expect(batches).toEqual([200, 200, 50]);
    expect((await mirror.load('c'))?.length).toBe(450);
  });

  it('leafNow is the newest uuid without waiting, null before the journal is opened', async () => {
    const j = make('p');
    expect(j.leafNow).toBeNull();
    const last = await j.append(entry('p', P.user('q1')));
    expect(j.leafNow).toBe(last.uuid);
  });
});

describe('R3 — a fork never starts paused (the 28 Sep stale-approval brick)', () => {
  const at = (seq: number, payload: JournalPayload): JournalEntry => ({
    ...base('p'), uuid: `e${seq}`, parentUuid: seq === 0 ? null : `e${seq - 1}`, seq, payload,
  });
  const ask = { type: 'interaction', interactionId: 'i-1', resolved: false, data: { toolUseId: 'ask-1', kind: 'tool_permission', toolName: 'Bash' } } as JournalPayload;
  /** A turn that ended on an approval nobody has answered: the call waits, its ask is open. */
  const paused = [
    at(0, P.user('delete the old builds')),
    at(1, P.assistant('I will run the cleanup.')),
    at(2, P.toolUse('ask-1')),
    at(3, ask),
  ];

  it('a turn that ended on an ask still waiting is no fork point', () => {
    expect(forkStartsPaused(paused, 3)).toBe(true);
    // The turn before it ended settled: that one forks.
    expect(forkStartsPaused(paused, 1)).toBe(false);
  });

  it('once the slot is answered (the parent carried on alongside), the turn forks, and the open ask is copied closed', () => {
    const deferred = [...paused, at(4, P.toolResult('ask-1', buildDeferredResultContent())), at(5, P.user('and then the logs')), at(6, P.assistant('done'))];
    expect(forkStartsPaused(deferred, 6)).toBe(false);
    const child = forkEntries(deferred, 6, { taskId: 'c', uuid: 'hdr', timestamp: '2026-10-02T02:00:00.000Z' });
    // The child holds no open ask: it is the parent's to answer, closed here with the parent's ids kept.
    expect(child[3]).toMatchObject({ uuid: 'e3', seq: 3, payload: { type: 'interaction', interactionId: 'i-1', resolved: true, data: { outcome: FORKED_ASK_CLOSED } } });
    expect(child.some((e) => e.payload.type === 'interaction' && e.payload.resolved === false)).toBe(false);
    expect(computeSuspendedToolUseIds(child)).toEqual(new Set());
    // The parent's own entry is untouched: its ask stays open for its own card.
    expect(deferred[3].payload).toEqual(ask);
  });

  it('an ask the person answered inside the copy keeps its record: never also closed as the fork\'s', () => {
    const answer = { type: 'interaction', interactionId: 'i-1', resolved: true, data: { outcome: { behavior: 'allow' }, resolvedAt: '2026-10-02T01:00:00.000Z' } } as JournalPayload;
    const answered = [...paused, at(4, answer), at(5, P.toolResult('ask-1', 'cleaned')), at(6, P.assistant('done'))];
    const child = forkEntries(answered, 6, { taskId: 'c', uuid: 'hdr', timestamp: '2026-10-02T02:00:00.000Z' });
    expect(child[3]!.payload).toEqual(ask); // the ask as it was asked
    expect(child[4]!.payload).toEqual(answer); // and as it was answered
    expect(JSON.stringify(child)).not.toContain(JSON.stringify(FORKED_ASK_CLOSED));
    expect(computeSuspendedToolUseIds(child)).toEqual(new Set());
  });

  it('the child opened from such a fork reports nothing live-suspended', async () => {
    const deferred = [...paused, at(4, P.toolResult('ask-1', buildDeferredResultContent())), at(5, P.assistant('carried on'))];
    await writeForkedJournal(new JsonlStore(fileFor('c')), fileFor('c'), forkEntries(deferred, 5, { taskId: 'c', uuid: 'hdr', timestamp: 'x' }));
    expect((await make('c').liveSuspendedIds()).size).toBe(0);
  });
});
