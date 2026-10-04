/**
 * T11b (durable subagent deep-HITL, Phase B) — the kernel seams the depth-1 subagent
 * RE-ENTRY relies on:
 *
 *  1. `reconcileInteractions` STAMPS the bound tool_use's `agentPath` onto its
 *     `re_execute` directive. A flag-ON subagent inner pause binds the interaction to
 *     the LEAF inner tool (C1), whose journal entry is scope-tagged (T10). The directive
 *     must carry that path so the sandbox routes to subagent RE-ENTRY (not a main-level
 *     leaf re-dispatch). A main-agent pause (no agentPath) yields a path-less directive,
 *     byte-identical to today.
 *
 *  2. `project()` lets a LATER tool_result for a tool_use_id SUPERSEDE an earlier one
 *     (keep-last-per-id). On re-entry COMPLETION the parent `Agent` tool_use (A1) is
 *     answered for real, but A1 already carries a `{status:'deferred'}` placeholder from
 *     the pause — two tool_results for one id would make the next main turn a malformed
 *     request. Keep-last keeps the REAL answer. Identity for every journal without a
 *     duplicate (so flag-off / depth-0 deferred / normal turns are byte-identical).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry, JournalPayload } from '../../../contract/journal.js';
import type { InteractionOutcome } from '../../../contract/interaction.js';
import type { SubagentPathSegment } from '../../../contract/subagent-path.js';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { buildDeferredResultContent } from '../../interaction/strategy.js';

const dir = join(tmpdir(), `t11b-reentry-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
  principal: { kind: 'system' as const }, timestamp: '',
};
const path1: SubagentPathSegment[] = [{ depth: 1, agentToolUseId: 'A1', agentSlug: 's', agentName: 's' }];
const allow = (): InteractionOutcome => ({ behavior: 'allow' });
const deny = (): InteractionOutcome => ({ behavior: 'deny', reason: 'user_declined' });

const make = (taskId = 't') => new Journal({
  taskId, workspaceId: 'w',
  jsonl: new JsonlStore(join(dir, `${taskId}-${Math.random()}.jsonl`)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-06-29T00:00:00.000Z'),
});

/** Append a payload with an optional agentPath scope tag. */
function ap(j: Journal, payload: JournalPayload, agentPath?: SubagentPathSegment[]): Promise<JournalEntry> {
  return j.append({ ...base, ...(agentPath ? { agentPath } : {}), payload });
}

describe('T11b — reconcileInteractions stamps the bound tool_use agentPath onto the directive', () => {
  it('a flag-ON subagent leaf pause (bound to a scope-tagged C1) yields a re_execute directive carrying C1.agentPath', async () => {
    const j = make('t-reconcile');
    // The parent leaves the journal exactly like a depth-1 flag-ON subagent inner pause:
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'p' } }); // main scope
    await ap(j, { type: 'tool_use', toolUseId: 'C1', name: 'Bash', input: { cmd: 'ls' } }, path1);               // subagent scope (scope-tagged)
    // The pause binds to the LEAF inner tool C1, carrying the path in `data`.
    await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C1', toolName: 'Bash', subagentPath: path1, subagentId: 'A1' } });
    // A1 (the main Agent tool_use) carries a {status:'deferred'} placeholder (main scope).
    await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });

    const { reExecute } = await j.reconcileInteractions(async () => allow());

    // EXACTLY ONE directive — for the leaf C1 (A1 is already answered by its deferred
    // placeholder, so it is idempotently skipped, never re-executed here).
    expect(reExecute).toHaveLength(1);
    const d = reExecute[0];
    expect(d.toolUseId).toBe('C1');
    expect(d.toolName).toBe('Bash');
    expect(d.kind).toBe('tool_permission');
    // THE NEW FACT: the directive carries the bound tool_use's scope path so the sandbox
    // routes to subagent RE-ENTRY (subagentIdFromPath(d.agentPath) === 'A1').
    expect(d.agentPath).toEqual(path1);
  });

  it('a MAIN-agent leaf pause (no agentPath) yields a path-less directive (byte-identical to today)', async () => {
    const j = make('t-main');
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'B1', name: 'Bash', input: { cmd: 'ls' } }); // main scope, NO agentPath
    await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'B1', toolName: 'Bash' } });

    const { reExecute } = await j.reconcileInteractions(async () => allow());
    expect(reExecute).toHaveLength(1);
    expect(reExecute[0].toolUseId).toBe('B1');
    expect(reExecute[0].agentPath).toBeUndefined();
  });

  // ── The Phase-B DENY gap: a scope-tagged leaf that is DENIED must ALSO route to
  //    subagent RE-ENTRY (a re_execute directive carrying the path), not be diverted to
  //    the resolution_is_result branch that materializes the leaf's declined result
  //    UNSCOPED into the MAIN journal (an orphan — its tool_use is scope-tagged away) and
  //    strands the parent `Agent` tool_use forever on its {status:'deferred'} placeholder.
  it('a DENIED scope-tagged subagent leaf ALSO yields a re_execute directive carrying C1.agentPath (NOT an unscoped declined result in the main journal)', async () => {
    const j = make('t-reconcile-deny');
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: { subagent_type: 's', prompt: 'p' } }); // main scope
    await ap(j, { type: 'tool_use', toolUseId: 'C1', name: 'Bash', input: { cmd: 'ls' } }, path1);               // subagent scope (scope-tagged)
    await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'C1', toolName: 'Bash', subagentPath: path1, subagentId: 'A1' } });
    await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false }); // A1 deferred placeholder

    const before = (await j.project()).messages.length;
    const { reExecute } = await j.reconcileInteractions(async () => deny());

    // The deny is ROUTED to re-entry (the directive carries the scope path) — the engine
    // re-enters the subagent with a scope-tagged declined leaf result and settles A1.
    expect(reExecute).toHaveLength(1);
    expect(reExecute[0].toolUseId).toBe('C1');
    expect(reExecute[0].agentPath).toEqual(path1);

    // NO declined tool_result for C1 was materialized into the journal here (the re_execute
    // branch appends nothing — the engine appends the result SCOPE-TAGGED on re-entry). So
    // the MAIN projection gains NO orphan C1 result, and C1's tool_use stays unanswered.
    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    const c1Results = all.filter((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'C1');
    expect(c1Results).toHaveLength(0);
    // The main projection is unchanged in size — no orphan declined leaf result leaked in
    // (C1's tool_use is scope-tagged out, so a materialized C1 result would be an orphan).
    expect((await j.project()).messages.length).toBe(before);
  });

  it('a DENIED MAIN-agent leaf (no agentPath) still materializes the declined result in place — NO directive (byte-identical to today)', async () => {
    const j = make('t-main-deny');
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'B1', name: 'Bash', input: { cmd: 'ls' } }); // main scope, NO agentPath
    await ap(j, { type: 'interaction', interactionId: 'i1', resolved: false, data: { kind: 'tool_permission', toolUseId: 'B1', toolName: 'Bash' } });

    const { reExecute } = await j.reconcileInteractions(async () => deny());

    // A main-agent deny is NEVER a re_execute — it materializes the structured declined
    // tool_result in place and settles the row (the historic resolution_is_result path).
    expect(reExecute).toHaveLength(0);
    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    const b1Result = all.find((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'B1');
    expect(b1Result).toBeDefined();
    const text = ((b1Result!.payload as { blocks: Array<{ text?: string }> }).blocks ?? []).map((b) => b.text ?? '').join('');
    expect(text).toContain('DECLINED');
    expect(all.some((e) => e.payload.type === 'interaction' && (e.payload as { resolved: boolean }).resolved === true)).toBe(true);
  });
});

describe('T11b — project() keeps the LAST tool_result per tool_use id (real result supersedes the deferred placeholder)', () => {
  it('a real A1 result appended after its deferred placeholder is the ONLY A1 tool_result projected', async () => {
    const j = make('t-supersede');
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'A1', name: 'Agent', input: {} });
    await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: buildDeferredResultContent() } as never], isError: false });
    await ap(j, { type: 'tool_result', toolUseId: 'A1', blocks: [{ type: 'text', text: 'REAL SUBAGENT OUTPUT' } as never], isError: false });

    const { messages } = await j.project();
    const a1Results = messages.filter(
      (e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === 'A1',
    );
    expect(a1Results).toHaveLength(1);
    const text = ((a1Results[0].payload as { blocks: Array<{ text?: string }> }).blocks ?? []).map((b) => b.text ?? '').join('');
    expect(text).toBe('REAL SUBAGENT OUTPUT');
  });

  it('a journal with one result per id is unchanged (identity — flag-off / normal turns byte-identical)', async () => {
    const j = make('t-identity');
    await ap(j, { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] });
    await ap(j, { type: 'tool_use', toolUseId: 'X', name: 'Bash', input: {} });
    await ap(j, { type: 'tool_result', toolUseId: 'X', blocks: [{ type: 'text', text: 'out' } as never], isError: false });

    const { messages } = await j.project();
    expect(messages.filter((e) => e.payload.type === 'tool_result')).toHaveLength(1);
    expect(messages.map((e) => e.payload.type)).toEqual(['user', 'tool_use', 'tool_result']);
  });
});
