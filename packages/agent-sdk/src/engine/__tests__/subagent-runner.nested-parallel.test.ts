/**
 * Orchestration walls (spec §4.2) — parallel at EVERY depth.
 *
 * RED pin (pre-wall): a nested batch always ran sequentially, so two sibling `Agent`
 * calls a helper launched in one message overlapped never — peak in-flight 1. Under
 * the walls the nested batch partitions like the main loop and its ≥2 consecutive
 * Agent run overlaps through a per-run Semaphore. Flag off ⇒ one at a time, as today.
 *
 * The run stays BATCH-ORDERED (a child that settles first does not jump the queue),
 * and a paused child still stops the whole batch — including a LATER segment, which
 * the one-sequential-segment nested batch stopped for free before the walls.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream, NormalizedUsage } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { LONE_CHILD_REFUSAL } from '../subagent-walls.js';

type Entry = { role: string; r?: { toolUseId: string; text: string; isError?: boolean } };
function scripted(rounds: StreamEvent[][]): { t: Transport; history: () => Entry[] } {
  let i = 0;
  let last: Entry[] = [];
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => { last = []; return last as unknown as ProviderHistory; },
    pushUser: () => {}, pushAssistant: () => {},
    pushToolResult: (h, r) => { (h as unknown as Entry[]).push({ role: 'tool_result', r: r as never }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (s) { for (const ev of s as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return { t: t as Transport, history: () => last };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
let inFlight = 0; let peak = 0;
const slowAgent: RawToolOptions = {
  name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
  execute: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await sleep(20); inFlight -= 1; return 'ok'; },
};
let reads = 0;
const fakeRead: RawToolOptions = {
  name: 'Read', description: 'read', parameters: z.object({}).passthrough(),
  execute: async () => { reads += 1; return 'file contents'; },
};
const twoAgents: StreamEvent[] = [
  { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
  { kind: 'tool_use', toolUse: { id: 'b', name: 'Agent', input: { prompt: 'y' } } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];
const finish: StreamEvent[] = [{ kind: 'text', text: 'done' }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }];
const run = (walls: boolean) => runSubagentLoop({
  transport: scripted([twoAgents, finish]).t, model: 'm', system: 'sys', userPrompt: 'go', tools: [slowAgent],
  harness: allow, onPause: async () => 'PAUSED',
  maxTurns: 5, onEvent: () => {}, sharedLoop: true, ...(walls ? { walls: true } : {}),
} as never);

describe('nested batch — siblings run at the same time under the walls', () => {
  it('walls ON: two sibling Agent calls overlap (peak in-flight = 2)', async () => {
    inFlight = 0; peak = 0;
    await run(true);
    expect(peak).toBe(2);
  });
  it('flag OFF: they run one at a time (peak = 1)', async () => {
    inFlight = 0; peak = 0;
    await run(false);
    expect(peak).toBe(1);
  });
  it('results stay BATCH-ORDERED — the child that settles first does not jump the queue', async () => {
    // 'a' is the slow one. Overlapped, it settles LAST; its result must still come first.
    const orderedAgent: RawToolOptions = {
      name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
      execute: async (input) => {
        const slow = (input as { prompt?: string }).prompt === 'x';
        await sleep(slow ? 30 : 1);
        return slow ? 'slow child' : 'fast child';
      },
    };
    const { t, history } = scripted([twoAgents, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [orderedAgent], harness: allow,
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
    } as never);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b']);
    expect(results.map((r) => r.text)).toEqual(['slow child', 'fast child']);
  });
  it('a PAUSED child stops the batch — a later sequential segment never dispatches', async () => {
    reads = 0; inFlight = 0; peak = 0;
    // [Agent a, Agent b, Read r] → concurrent(a,b) then sequential(r). 'a' pauses.
    const mixed: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'tool_use', toolUse: { id: 'b', name: 'Agent', input: { prompt: 'y' } } },
      { kind: 'tool_use', toolUse: { id: 'r', name: 'Read', input: { path: 'a.ts' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t } = scripted([mixed, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [slowAgent, fakeRead],
      harness: {
        gateTool: async (c: ToolCall): Promise<GateResult> =>
          c.toolCallId === 'a' ? { decision: 'needs_human', interactionKind: 'ask' } : { decision: 'allow' },
      },
      onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
    } as never);
    // The pause reaches the caller through the concurrent segment's stop signal, so
    // the barrier behind it holds exactly as it did when the batch was one segment.
    expect(reads).toBe(0);
  });
  it('a lone-child REFUSAL inside a concurrent segment refuses without spawning', async () => {
    // A concurrencySafe sibling makes [Agent, Read] a 2-wide eligible run, so the
    // lone Agent call the D3 wall refuses now rides the CONCURRENT path. The refusal
    // is checked before the tool is resolved there, exactly as runSequentialTool does.
    let spawns = 0; let safeReads = 0;
    const countingAgent: RawToolOptions = {
      name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
      execute: async () => { spawns += 1; return 'ok'; },
    };
    const safeRead: RawToolOptions = {
      name: 'Read', description: 'read', parameters: z.object({}).passthrough(),
      concurrencySafe: true,
      execute: async () => { safeReads += 1; return 'file contents'; },
    };
    const loneAgentPlusRead: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'tool_use', toolUse: { id: 'r', name: 'Read', input: { path: 'a.ts' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const { t, history } = scripted([loneAgentPlusRead, finish]);
    await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [countingAgent, safeRead],
      harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {},
      sharedLoop: true, walls: true,
    } as never);
    expect(spawns).toBe(0);
    expect(safeReads).toBe(1);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'r']);
    expect(results[0]).toMatchObject({ text: LONE_CHILD_REFUSAL, isError: true });
    expect(results[1].text).toBe('file contents');
  });
  it('a LEAF that hallucinates an Agent call gets the unknown-tool answer, never the wall', async () => {
    // D3 binds a holder that CAN delegate. A leaf's toolset has no Agent tool, so there is
    // nothing to "split into two and launch together" — that advice is unfollowable there,
    // and the honest answer is the plain unknown-tool error. The partitioner's eligibility
    // is still NAME-based, so this call rides the CONCURRENT path beside the safe Read;
    // the refusal ordering (decided before `def` is resolved) is unchanged for a real holder.
    let safeReads = 0;
    const safeRead: RawToolOptions = {
      name: 'Read', description: 'read', parameters: z.object({}).passthrough(),
      concurrencySafe: true,
      execute: async () => { safeReads += 1; return 'file contents'; },
    };
    const loneAgentPlusRead: StreamEvent[] = [
      { kind: 'tool_use', toolUse: { id: 'a', name: 'Agent', input: { prompt: 'x' } } },
      { kind: 'tool_use', toolUse: { id: 'r', name: 'Read', input: { path: 'a.ts' } } },
      { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const kinds: string[] = [];
    const { t, history } = scripted([loneAgentPlusRead, finish]);
    await runSubagentLoop({
      // NO Agent tool registered — this helper is a LEAF; `def` is undefined for tool_use 'a'.
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [safeRead],
      harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, onEvent: () => {},
      sharedLoop: true, walls: true,
      onSubagentRefused: (k: string) => kinds.push(k),
    } as never);
    expect(safeReads).toBe(1);
    const results = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'r']);
    expect(results[0]).toMatchObject({ text: 'Unknown tool: Agent', isError: true });
    // ...and it is NOT a lone_child: the tree's refusal tally must not count a leaf's
    // hallucination as a wall the orchestrator hit.
    expect(kinds).toEqual([]);
  });
  it('a THROWING gate never deletes a sibling\'s work — both tool_uses are answered', async () => {
    // gateAndDispatchTool guards only execute(); `harness.gateTool` (and `onPause`)
    // are awaited bare, so a throwing gate REJECTS that child's dispatch. Gathering
    // the batch with Promise.all would reject the whole run before finalization:
    // every sibling's settled result discarded, every opened tool_use left with no
    // tool_result — the same loss class the pause path is forbidden to cause.
    const seenUses: string[] = [];
    const seen: Array<{ id: string; text: string; isError: boolean }> = [];
    const { t, history } = scripted([twoAgents, finish]);
    const res = (await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [slowAgent],
      harness: {
        gateTool: async (c: ToolCall): Promise<GateResult> => {
          if (c.toolCallId === 'a') throw new Error('gate exploded');
          return { decision: 'allow' };
        },
      },
      onPause: async () => 'PAUSED', maxTurns: 5, sharedLoop: true, walls: true,
      onEvent: (ev: { kind: string; subToolUseId?: string; result?: string; isError?: boolean }) => {
        if (ev.kind === 'tool_use') seenUses.push(ev.subToolUseId!);
        if (ev.kind === 'tool_result') seen.push({ id: ev.subToolUseId!, text: ev.result!, isError: ev.isError! });
      },
    } as never)) as { text: string };
    // The throw is SEALED as that child's error result, not propagated: the run
    // finishes its next round normally.
    expect(res.text).toBe('done');
    // Every opened tool_use ends with exactly one result — none left running.
    expect(seenUses).toEqual(['a', 'b']);
    expect(seen.map((r) => r.id)).toEqual(['a', 'b']);
    // The thrower carries the error text; the sibling's real work survives intact.
    expect(seen[0]).toEqual({ id: 'a', text: 'gate exploded', isError: true });
    expect(seen[1]).toEqual({ id: 'b', text: 'ok', isError: false });
    // Both are ANSWERED in the history — a resume re-drives neither.
    const pushed = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(pushed.map((r) => r.toolUseId)).toEqual(['a', 'b']);
  });
  it('a PAUSED child never deletes a sibling\'s work — the completed one still settles', async () => {
    // Both children are dispatched before anyone knows 'a' paused, so breaking at the
    // pause would discard 'b's paid-for result and leave its tool_use unanswered for
    // the resume to re-drive. Every opened tool_use finalizes; only the PAUSED one's
    // journal entry is withheld, which is what keeps it pending.
    const seen: Array<{ id: string; text: string; isError: boolean }> = [];
    const { t, history } = scripted([twoAgents, finish]);
    const res = (await runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [slowAgent],
      harness: {
        gateTool: async (c: ToolCall): Promise<GateResult> =>
          c.toolCallId === 'a' ? { decision: 'needs_human', interactionKind: 'ask' } : { decision: 'allow' },
      },
      onPause: async () => 'PAUSED', maxTurns: 5, sharedLoop: true, walls: true,
      onEvent: (ev: { kind: string; subToolUseId?: string; result?: string; isError?: boolean }) => {
        if (ev.kind === 'tool_result') seen.push({ id: ev.subToolUseId!, text: ev.result!, isError: ev.isError! });
      },
    } as never)) as { pausedHalt?: boolean };
    // The run pauses for the human...
    expect(res.pausedHalt).toBe(true);
    // ...and BOTH tool_results are emitted, in batch order, the sibling's real text intact.
    expect(seen.map((r) => r.id)).toEqual(['a', 'b']);
    expect(seen[0].text).toBe('PAUSED');
    expect(seen[1].text).toBe('ok');
    // Only the PAUSED child's result is withheld from the history: the sibling is
    // ANSWERED, so a resume re-drives the pause alone and never re-runs 'b'.
    const pushed = history().filter((e) => e.role === 'tool_result').map((e) => e.r!);
    expect(pushed.map((r) => r.toolUseId)).toEqual(['b']);
    expect(pushed[0].text).toBe('ok');
  });
});

describe('nested batch — each concurrent call pays its fee once, as the subagent\'s', () => {
  it('walls ON: two overlapping sibling calls send one isSubagent frame each, after their results', async () => {
    const events: Array<{ kind: string; subToolUseId?: string; event?: { data?: unknown } }> = [];
    await runSubagentLoop({
      transport: scripted([twoAgents, finish]).t, model: 'm', system: 'sys', userPrompt: 'go', tools: [slowAgent],
      harness: allow, onPause: async () => 'PAUSED', maxTurns: 5, taskId: 'owner', childId: 'c',
      onEvent: (ev: { kind: string }) => { events.push(ev as never); }, sharedLoop: true, walls: true,
    } as never);
    const fees = events.filter((e) => e.kind === 'billing').map((e) => e.event?.data);
    expect(fees).toEqual([
      { taskId: 'owner', toolName: 'Agent', toolUseId: 'a', isSubagent: true },
      { taskId: 'owner', toolName: 'Agent', toolUseId: 'b', isSubagent: true },
    ]);
    // Each frame follows its own result: the sweep finalizes in batch order.
    const order = events.filter((e) => e.kind === 'tool_result' || e.kind === 'billing').map((e) => e.kind);
    expect(order).toEqual(['tool_result', 'billing', 'tool_result', 'billing']);
  });
});
