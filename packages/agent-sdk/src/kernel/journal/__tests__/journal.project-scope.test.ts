/**
 * T11a (durable subagent deep-HITL, Phase B) — the READER half of T11.
 *
 *  1. `projectScope(entries, target)` — the pure, EXACT-LEAF-MATCH scoped reader,
 *     ordering each scope's entries by `seq` (NOT `parentUuid`, which the single
 *     per-task Journal threads globally so siblings interleave into one chain).
 *  2. `Journal.project()` (the MAIN context projection) EXCLUDES subagent-scoped
 *     entries (those carrying an `agentPath`), so a subagent's inner conversation
 *     never leaks into the main agent's model context.
 *
 * Safety invariant proven here: a journal with NO subagent entries projects
 * IDENTICALLY to before this change (flag-off / no-subagent path unchanged).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, projectScope, liveSuspendedToolUseIds } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { isContextEntry, type JournalEntry, type NewEntry } from '../../../contract/journal.js';
import type { SubagentPathSegment } from '../../../contract/subagent-path.js';
import { buildDeferredResultContent } from '../../interaction/strategy.js';

const dir = join(tmpdir(), `journal-project-scope-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const seg = (depth: number, id: string): SubagentPathSegment =>
  ({ depth, agentToolUseId: id, agentSlug: 'researcher', agentName: 'Researcher' });

// ── payload helpers ──
type Payload = JournalEntry['payload'];
const user = (text: string): Payload => ({ type: 'user', blocks: [{ type: 'text', text } as never] });
const asst = (text: string): Payload => ({ type: 'assistant', blocks: [{ type: 'text', text } as never] });
const tuse = (id: string, name = 'echo'): Payload => ({ type: 'tool_use', toolUseId: id, name, input: {} });
const tres = (id: string, text = 'ok'): Payload => ({ type: 'tool_result', toolUseId: id, blocks: [{ type: 'text', text } as never] });

const toolId = (m: JournalEntry): string | undefined => (m.payload as { toolUseId?: string }).toolUseId;
const blocksJson = (m: JournalEntry): string => JSON.stringify((m.payload as { blocks?: unknown }).blocks ?? null);
const firstText = (m: JournalEntry): string | undefined =>
  (m.payload as { blocks?: Array<{ text?: string }> }).blocks?.[0]?.text;

// A full JournalEntry for the PURE projectScope tests (no store needed).
const mk = (
  seq: number,
  payload: Payload,
  agentPath?: SubagentPathSegment[],
  parentUuid: string | null = null,
): JournalEntry => ({
  uuid: `e${seq}`,
  parentUuid,
  seq,
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
  agentId: 'g', principal: { kind: 'system' }, timestamp: '',
  ...(agentPath ? { agentPath } : {}),
  payload,
});

// A NewEntry for the Journal-backed tests (the store assigns uuid/parentUuid/seq).
const baseNew = (payload: Payload, agentPath?: SubagentPathSegment[]): NewEntry => ({
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w',
  agentId: 'g', principal: { kind: 'system' }, timestamp: '',
  ...(agentPath ? { agentPath } : {}),
  payload,
});

const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
};

describe('projectScope — exact-leaf-match scoping', () => {
  it('A keeps the grandchild Agent tool_use+result but NOT the grandchild inner rounds', () => {
    const A = [seg(1, 'A')];
    const AG = [seg(1, 'A'), seg(2, 'G')];
    const all: JournalEntry[] = [
      // main agent (no agentPath)
      mk(0, user('go')),
      mk(1, asst('main thinking')),
      mk(2, tuse('agent-A', 'Agent')), // main spawns A
      mk(3, tres('agent-A', 'A done')),
      // A's OWN conversation
      mk(4, asst('A thinking'), A),
      mk(5, tuse('a-echo'), A),
      mk(6, tres('a-echo'), A),
      mk(7, tuse('agent-G', 'Agent'), A), // A spawns grandchild G — a single entry at A's scope
      mk(8, tres('agent-G', 'G done'), A), // grandchild's result — at A's scope
      // G's INNER rounds (the grandchild's own scope)
      mk(9, asst('G thinking'), AG),
      mk(10, tuse('g-echo'), AG),
      mk(11, tres('g-echo'), AG),
    ];

    // A's scope = its own rounds incl. the G-spawning Agent tool_use+result, NOT G's inner.
    expect(projectScope(all, 'A').map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
    // G's scope = only the grandchild's inner rounds.
    expect(projectScope(all, 'G').map((e) => e.seq)).toEqual([9, 10, 11]);
    // main scope = only main entries.
    expect(projectScope(all, undefined).map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    // The three scopes partition the journal exactly (total + disjoint).
    expect(
      projectScope(all, 'A').length +
      projectScope(all, 'G').length +
      projectScope(all, undefined).length,
    ).toBe(all.length);
  });

  it('recovers within-scope seq order for interleaved siblings, ignoring cross-scope parentUuid + input order', () => {
    const A = [seg(1, 'A')];
    const B = [seg(1, 'B')];
    // ONE linear chain: parentUuid = the GLOBAL prior leaf, so it crosses scopes.
    const e0 = mk(0, tuse('a1'), A, null); // A
    const e1 = mk(1, tuse('b1'), B, e0.uuid); // B — parent is an A entry
    const e2 = mk(2, tres('a1'), A, e1.uuid); // A — parent is a B entry
    const e3 = mk(3, tres('b1'), B, e2.uuid); // B — parent is an A entry
    // Pass the entries OUT of seq order to prove projectScope sorts by seq, not input order.
    const shuffled = [e3, e1, e0, e2];

    expect(projectScope(shuffled, 'A').map((e) => e.seq)).toEqual([0, 2]);
    expect(projectScope(shuffled, 'B').map((e) => e.seq)).toEqual([1, 3]);
    // Within A, the tool_use precedes its tool_result even though their parentUuids
    // chain THROUGH B's entries.
    const a = projectScope(shuffled, 'A');
    expect(a.map((e) => e.payload.type)).toEqual(['tool_use', 'tool_result']);
    // projectScope never mutates its input.
    expect(shuffled.map((e) => e.seq)).toEqual([3, 1, 0, 2]);
  });
});

describe('Journal.project — scoped to the MAIN agent', () => {
  it('excludes subagent-scoped inner entries; keeps the main Agent tool_use/result', async () => {
    const j = make('t-main-scope');
    const A = [seg(1, 'A')];
    await j.append(baseNew(user('go')));
    await j.append(baseNew(asst('main thinking')));
    await j.append(baseNew(tuse('agent-A', 'Agent')));
    // subagent A journals its inner rounds, scope-tagged:
    await j.append(baseNew(asst('A thinking'), A));
    await j.append(baseNew(tuse('a-echo'), A));
    await j.append(baseNew(tres('a-echo'), A));
    // main's Agent tool_use gets answered:
    await j.append(baseNew(tres('agent-A', 'A result')));

    const { messages } = await j.project();
    // Keeps the main content + the Agent tool_use/result.
    expect(messages.some((m) => m.payload.type === 'tool_use' && toolId(m) === 'agent-A')).toBe(true);
    expect(messages.some((m) => m.payload.type === 'tool_result' && toolId(m) === 'agent-A')).toBe(true);
    expect(messages.some((m) => m.payload.type === 'assistant' && blocksJson(m).includes('main thinking'))).toBe(true);
    // Drops EVERY subagent inner entry.
    expect(messages.some((m) => toolId(m) === 'a-echo')).toBe(false);
    expect(messages.some((m) => m.payload.type === 'assistant' && blocksJson(m).includes('A thinking'))).toBe(false);
  });

  it('a journal with NO subagent entries projects IDENTICALLY (the exclusion is a no-op)', async () => {
    const j = make('t-no-sub');
    await j.append(baseNew(user('go')));
    await j.append(baseNew(asst('thinking')));
    await j.append(baseNew(tuse('x')));
    await j.append(baseNew(tres('x')));
    await j.append(baseNew({ type: 'usage', intelligence: 1, actions: 0, compute: 0 })); // non-context

    const all = await readAll(j);
    const state = await j.project();
    // With no compaction/suspension/screenshots the pipeline reduces to
    // all.filter(isContextEntry) — exactly the pre-change projection.
    expect(state.messages).toEqual(all.filter(isContextEntry));
    expect(state.compactionSummaryLeading).toBe(false);
    // The scope exclusion changes nothing on a journal that carries no agentPath.
    expect(projectScope(all, undefined)).toEqual(all);
  });
});

describe('whole-journal suspension scans stay depth-blind (NOT re-scoped by T11a)', () => {
  it('liveSuspendedToolUseIds still flags the inner paused tool; main projection shows the Agent slot answered-by-deferred', async () => {
    const j = make('t-paused-sub');
    const A = [seg(1, 'A')];
    await j.append(baseNew(user('go')));
    await j.append(baseNew(tuse('agent-A', 'Agent'))); // main spawns A
    await j.append(baseNew(tuse('inner-1'), A)); // A's inner tool_use (paused)
    // A's pause binding (resolved:false) — bound to the inner tool_use:
    await j.append(baseNew(
      { type: 'interaction', interactionId: 'i1', resolved: false, data: { toolUseId: 'inner-1', kind: 'tool_permission', toolName: 'echo' } },
      A,
    ));
    // main's Agent slot answered with a deferred result (continue-alongside):
    await j.append(baseNew(tres('agent-A', buildDeferredResultContent())));

    const all = await readAll(j);
    // Whole-journal scan still sees the DEEP paused tool — proves it was NOT re-scoped.
    expect(liveSuspendedToolUseIds(all).has('inner-1')).toBe(true);

    const { messages } = await j.project();
    // The main Agent tool_use is present + answered (not main-suspended / not dropped).
    expect(messages.some((m) => m.payload.type === 'tool_use' && toolId(m) === 'agent-A')).toBe(true);
    const deferred = messages.find((m) => m.payload.type === 'tool_result' && toolId(m) === 'agent-A');
    expect(deferred).toBeDefined();
    expect(firstText(deferred!)).toBe(buildDeferredResultContent());
    // The subagent's inner paused tool_use is absent from the main projection.
    expect(messages.some((m) => toolId(m) === 'inner-1')).toBe(false);
  });
});
