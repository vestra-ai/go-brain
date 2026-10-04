import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../../contract/journal.js';
import type { InteractionOutcome } from '../../../contract/interaction.js';

// P2.6 Task 11 — incremental journal materialization.
//
// The Journal keeps a private in-memory read-model (`entries`) filled once at
// hydrate and appended in-memory thereafter, so project()/heal/reconcile/defer no
// longer re-scan the JSONL from disk every round. This is a PURE PERFORMANCE
// refactor: every projection/heal/reconcile/defer output must deep-equal the old
// disk-scanning implementation. The equality oracle below is the review gate —
// the "truth" is always a FRESH cold-hydrate instance over the same on-disk file
// (which reads + validates from disk), compared against a LIVE instance whose
// read-model was built incrementally by appends.

const dir = join(tmpdir(), `journal-incremental-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const fileFor = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId: string) =>
  new Journal({
    taskId,
    workspaceId: 'w',
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
  toolUse: (id: string, name = 'Bash'): JournalPayload => ({ type: 'tool_use', toolUseId: id, name, input: {} }),
  toolResult: (id: string, isError = false): JournalPayload => ({ type: 'tool_result', toolUseId: id, blocks: [], isError }),
  interaction: (interactionId: string, resolved: boolean, data: unknown): JournalPayload =>
    ({ type: 'interaction', interactionId, resolved, data }),
};
const newEntry = (payload: JournalPayload): NewEntry => ({ ...base, payload });
/** One full agent round: a paired user/assistant/tool_use/tool_result quad. */
const round = (r: number): NewEntry[] => [
  newEntry(P.user(`q${r}`)),
  newEntry(P.assistant(`think ${r}`)),
  newEntry(P.toolUse(`t${r}`)),
  newEntry(P.toolResult(`t${r}`)),
];

async function collect(it: AsyncIterable<JournalEntry>): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const payloads = (es: JournalEntry[]): JournalPayload[] => es.map((e) => e.payload);
const texts = (es: JournalEntry[]): string[] =>
  es.map((e) => ((e.payload as { blocks?: { text?: string }[] }).blocks?.[0]?.text ?? ''));
const allow = (updatedInput?: unknown): InteractionOutcome => ({ behavior: 'allow', updatedInput });

// ─── The headline RED test: no full re-scan on the append→project path ──────────

describe('P2.6 — incremental materialization (behavioral)', () => {
  it('project() after an append serves the in-memory read-model WITHOUT re-scanning the journal from disk', async () => {
    const live = make('norescan');
    for (let r = 0; r < 10; r++) for (const e of round(r)) await live.append(e);
    await live.project(); // materialize + warm the derived cache

    const spy = vi.spyOn(JsonlStore.prototype, 'read');
    await live.append(newEntry(P.user('one more'))); // invalidates the derived cache
    const state = await live.project(); // must recompute from the read-model, not disk

    expect(spy).not.toHaveBeenCalled(); // TODAY re-scans disk here; the read-model must not
    expect(state.messages.at(-1)?.payload).toEqual(P.user('one more'));
  });
});

// ─── The equality oracle: live read-model === fresh cold-hydrate, everywhere ────

describe('P2.6 — projection equality oracle (read-model vs cold hydrate)', () => {
  it('200-entry journal + 50 in-memory appends: project() deep-equals a fresh cold-hydrate project()', async () => {
    const live = make('oracle');
    for (let r = 0; r < 50; r++) for (const e of round(r)) await live.append(e); // 200 entries
    await live.project(); // warm
    for (let i = 0; i < 50; i++) await live.append(newEntry(P.user(`extra${i}`))); // 50 in-memory appends
    const liveState = await live.project();

    const cold = make('oracle'); // fresh instance over the same on-disk file
    const coldState = await cold.project();

    expect(liveState.messages).toEqual(coldState.messages);
    expect(liveState.todos).toEqual(coldState.todos);
    expect(liveState.leaf).toEqual(coldState.leaf);
    expect(liveState.compactionSummaryLeading).toEqual(coldState.compactionSummaryLeading);
    expect(liveState.messages).toHaveLength(250); // all context entries survive (no compaction/suspend)
  });

  it('equality under a quarantined corrupt line: the read-model skips it exactly like a raw read', async () => {
    await fs.mkdir(dir, { recursive: true });
    const p = fileFor('quar');
    const g1 = { ...base, uuid: 'e0', parentUuid: null, seq: 0, payload: P.user('first') };
    const g2 = { ...base, uuid: 'e1', parentUuid: 'e0', seq: 1, payload: P.user('second') };
    // A well-formed JSON line that fails shape validation, wedged between two good lines.
    await fs.writeFile(p, JSON.stringify(g1) + '\n' + '{"garbage":true}\n' + JSON.stringify(g2) + '\n');

    const j = make('quar');
    const state = await j.project();
    expect(texts(state.messages)).toEqual(['first', 'second']); // corrupt middle line quarantined
    // The read-model matches a raw quarantined disk read.
    const raw = (await collect(j.read())).filter((e) => e.payload.type === 'user');
    expect(state.messages).toEqual(raw);
  });

  it('equality under a compaction boundary: live vs cold projection match (summary leads)', async () => {
    const live = make('compact');
    await live.append(newEntry(P.user('old turn')));
    const keep = await live.append(newEntry(P.user('kept turn')));
    const summary = await live.append(newEntry(P.assistant('[summary of earlier turns]')));
    await live.compact({
      summaryUuid: summary.uuid, preservedUuids: [], firstKeptId: keep.uuid,
      trigger: 'auto', preTokens: 100, postTokens: 10, base,
    });
    await live.append(newEntry(P.user('after compaction')));
    const liveState = await live.project();

    const cold = make('compact');
    const coldState = await cold.project();

    expect(liveState.messages).toEqual(coldState.messages);
    expect(liveState.compactionSummaryLeading).toBe(true);
    expect(liveState.messages[0].uuid).toBe(summary.uuid); // summary leads
  });

  it('equality under a branch() fork: live vs cold projection + leaf match', async () => {
    const live = make('branch');
    const a = await live.append(newEntry(P.user('a')));
    await live.append(newEntry(P.user('b')));
    await live.branch(a.uuid); // fork off `a`
    await live.append(newEntry(P.user('c')));
    const liveState = await live.project();

    const cold = make('branch');
    const coldState = await cold.project();

    expect(liveState.messages).toEqual(coldState.messages);
    expect(liveState.leaf).toEqual(coldState.leaf);
  });

  it('equality under interleaved mirror flushes: live vs cold projection match', async () => {
    const live = make('mirror');
    await live.append(newEntry(P.user('a')));
    await live.flushMirror();
    await live.append(newEntry(P.user('b')));
    await live.flushMirror();
    await live.append(newEntry(P.toolUse('t1')));
    await live.append(newEntry(P.toolResult('t1')));
    await live.flushMirror();
    const liveState = await live.project();

    const cold = make('mirror');
    const coldState = await cold.project();

    expect(liveState.messages).toEqual(coldState.messages);
  });
});

// ─── The mtime-invalidation contract: disk stays the source of truth ────────────

describe('P2.6 — external-mutation invalidation (mtime → quarantine pipeline)', () => {
  it('a cache-missed project() re-reads through the quarantine pipeline after an EXTERNAL append', async () => {
    const live = make('mtime');
    await live.append(newEntry(P.user('a')));
    await live.append(newEntry(P.user('b')));
    await live.project(); // materialize the read-model + record mtime

    // Externally append a GOOD line and a CORRUPT line, then bump the mtime so the
    // change is detected regardless of filesystem timestamp granularity.
    const p = fileFor('mtime');
    const ext = { ...base, uuid: 'ext-1', parentUuid: null, seq: 99, payload: P.user('external') };
    await fs.appendFile(p, JSON.stringify(ext) + '\n' + '{"corrupt":1}\n');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(p, future, future);

    // Force a cache miss WITHOUT an internal append (branch to the current leaf).
    const leaf = await live.leaf();
    await live.branch(leaf!);
    const state = await live.project();

    // The external GOOD line is picked up (re-read); the CORRUPT one is quarantined.
    expect(texts(state.messages)).toEqual(['a', 'b', 'external']);
  });
});

// ─── heal / reconcile / defer equality (the other three read-model consumers) ───

describe('P2.6 — heal / reconcile / defer equality (read-model vs cold hydrate)', () => {
  it('healOrphanedToolUse over the read-model matches a cold-hydrate heal', async () => {
    const live = make('heal-a');
    await live.append(newEntry(P.user('go')));
    await live.append(newEntry(P.toolUse('tu1', 'Bash'))); // orphan
    await live.append(newEntry(P.toolUse('tu2', 'Read'))); // orphan
    await fs.copyFile(fileFor('heal-a'), fileFor('heal-b')); // snapshot the pre-heal disk

    await live.healOrphanedToolUse(); // heal via the live read-model
    const cold = make('heal-b');
    await cold.healOrphanedToolUse(); // heal via a cold-hydrate read-model

    const liveResults = (await collect(live.read())).filter((e) => e.payload.type === 'tool_result');
    const coldResults = (await collect(cold.read())).filter((e) => e.payload.type === 'tool_result');
    expect(payloads(liveResults)).toEqual(payloads(coldResults));
    expect(liveResults).toHaveLength(2); // both orphans sealed, in the same order
  });

  it('reconcileInteractions over the read-model matches a cold-hydrate reconcile', async () => {
    const build = async (j: Journal) => {
      await j.append(newEntry(P.user('pick one')));
      await j.append(newEntry(P.toolUse('tu1', 'AskUserQuestion')));
      await j.append(newEntry(P.interaction('i1', false, { kind: 'ask_question', toolUseId: 'tu1', toolName: 'AskUserQuestion' })));
    };
    const live = make('rec-a');
    await build(live);
    await fs.copyFile(fileFor('rec-a'), fileFor('rec-b'));

    const liveOut = await live.reconcileInteractions(async () => allow({ answers: ['B'] }));
    const cold = make('rec-b');
    const coldOut = await cold.reconcileInteractions(async () => allow({ answers: ['B'] }));

    expect(liveOut).toEqual(coldOut); // same directives
    expect(payloads(await collect(live.read()))).toEqual(payloads(await collect(cold.read()))); // same appended entries
  });

  it('deferSuspended over the read-model matches a cold-hydrate defer', async () => {
    const build = async (j: Journal) => {
      await j.append(newEntry(P.user('send it')));
      await j.append(newEntry(P.toolUse('tu1', 'GMAIL_SEND_EMAIL')));
      await j.append(newEntry(P.interaction('i1', false, { kind: 'composio_auth', toolUseId: 'tu1', toolName: 'GMAIL_SEND_EMAIL' })));
    };
    const live = make('def-a');
    await build(live);
    await fs.copyFile(fileFor('def-a'), fileFor('def-b'));

    const liveIds = await live.deferSuspended('paused');
    const cold = make('def-b');
    const coldIds = await cold.deferSuspended('paused');

    expect(liveIds).toEqual(coldIds);
    expect(payloads(await collect(live.read()))).toEqual(payloads(await collect(cold.read())));
  });
});
