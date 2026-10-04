/**
 * Orchestration walls — the PER-DEPTH shrinking drain grace.
 *
 * RED pin (pre-fix): a nested dispatch used the SAME `cfg.drainTimeoutMs ?? DRAIN_DEFAULT_MS`
 * (5000) as its parent, so when a child's tool ignored abort for the whole grace the child's
 * drain and the parent's expired together. The parent seals first, the child's late END is
 * dropped, and the lane reads "done" over a child that never finished. Under the walls the
 * nested round runs on `nestedDrainTimeoutMs(parent)` — strictly shorter at every depth — so
 * a child always settles INSIDE its parent's window. Flag off ⇒ the shared 5000, as today.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream, NormalizedUsage } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { nestedDrainTimeoutMs, NESTED_DRAIN_FRACTION, NESTED_DRAIN_MIN_MS } from '../subagent-walls.js';
import { DRAIN_DEFAULT_MS } from '../abort-drain.js';

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
const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const stuckCall: StreamEvent[] = [
  { kind: 'tool_use', toolUse: { id: 'stuck-1', name: 'Bash', input: { cmd: 'sleep 999' } } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];

/** A tool that IGNORES the abort and never settles — the only thing the grace bounds. */
function wedgedTool(started: { yes: boolean }): RawToolOptions {
  return {
    name: 'Bash', description: 'wedges', parameters: z.object({}).passthrough(),
    execute: () => { started.yes = true; return new Promise<string>(() => {}); },
  };
}

/** Drive a walled child whose one tool wedges, then abort. Returns the seal probe. */
function startWedgedChild(parentDrainMs: number | undefined): {
  run: Promise<{ text: string; stopReason: string }>;
  controller: AbortController;
  started: { yes: boolean };
  sealed: () => Entry['r'] | undefined;
} {
  const controller = new AbortController();
  const started = { yes: false };
  const { t, history } = scripted([stuckCall]);
  const run = runSubagentLoop({
    transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [wedgedTool(started)],
    harness: allow, onPause: async () => 'PAUSED', signal: controller.signal,
    maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
    ...(parentDrainMs !== undefined ? { drainTimeoutMs: parentDrainMs } : {}),
  } as never) as Promise<{ text: string; stopReason: string }>;
  return { run, controller, started, sealed: () => history().find((e) => e.role === 'tool_result')?.r };
}

describe('nestedDrainTimeoutMs — the arithmetic', () => {
  it('shrinks by the fraction and floors at the minimum', () => {
    expect(nestedDrainTimeoutMs(DRAIN_DEFAULT_MS)).toBe(3000);
    expect(nestedDrainTimeoutMs(3000)).toBe(1800);
    expect(nestedDrainTimeoutMs(1800)).toBe(1080);
    // Every level is STRICTLY shorter than its parent until the floor.
    expect(nestedDrainTimeoutMs(DRAIN_DEFAULT_MS)).toBeLessThan(DRAIN_DEFAULT_MS);
    expect(NESTED_DRAIN_FRACTION).toBeLessThan(1);
    // ...and never collapses to zero: a wedged grandchild still gets a real window.
    expect(nestedDrainTimeoutMs(1)).toBe(NESTED_DRAIN_MIN_MS);
  });
});

describe('nested drain grace — a child seals before its parent\'s window closes', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('walls ON: a wedged nested tool seals at the SHRUNKEN grace, not at the parent\'s 5000', async () => {
    vi.useFakeTimers();
    const { run, controller, started, sealed } = startWedgedChild(DRAIN_DEFAULT_MS);
    await vi.advanceTimersByTimeAsync(10);
    expect(started.yes).toBe(true);          // the tool is in flight when the stop lands
    controller.abort();

    // The LITERAL, not nestedDrainTimeoutMs(...): a pin that recomputes its own goalpost
    // from the constant it is guarding moves with the mutation and proves nothing.
    const grace = 3000; // = nestedDrainTimeoutMs(DRAIN_DEFAULT_MS)
    await vi.advanceTimersByTimeAsync(grace - 1);
    expect(sealed()).toBeUndefined();        // still inside the window at 2999ms
    await vi.advanceTimersByTimeAsync(1);
    expect(sealed()).toMatchObject({ toolUseId: 'stuck-1', isError: true });
    expect(sealed()!.text).toMatch(/^Interrupted by user\./);

    // The run RETURNS (a throw here would lose the whole child's cost and its lane).
    const res = await run;
    expect(res.stopReason).toBe('stopped_by_user');
  });

  it('walls ON: it is NOT sealed at the parent\'s own grace boundary minus one, i.e. it is strictly earlier', async () => {
    vi.useFakeTimers();
    const { run, controller, started, sealed } = startWedgedChild(DRAIN_DEFAULT_MS);
    await vi.advanceTimersByTimeAsync(10);
    expect(started.yes).toBe(true);
    controller.abort();
    // The whole point: by the time the PARENT's 5000ms window would expire, this child
    // has already sealed and reported. Sealing at the parent's boundary is the bug.
    await vi.advanceTimersByTimeAsync(DRAIN_DEFAULT_MS - 1);
    expect(sealed()).toBeDefined();
    await run;
  });

  it('flag OFF: the nested dispatch keeps the shared 5000 (no key, byte-identical)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const started = { yes: false };
    const { t, history } = scripted([stuckCall]);
    const run = runSubagentLoop({
      transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [wedgedTool(started)],
      harness: allow, onPause: async () => 'PAUSED', signal: controller.signal,
      maxTurns: 5, onEvent: () => {}, sharedLoop: true, drainTimeoutMs: DRAIN_DEFAULT_MS,
    } as never) as Promise<{ stopReason: string }>;
    await vi.advanceTimersByTimeAsync(10);
    expect(started.yes).toBe(true);
    controller.abort();
    const sealed = (): Entry['r'] | undefined => history().find((e) => e.role === 'tool_result')?.r;
    await vi.advanceTimersByTimeAsync(DRAIN_DEFAULT_MS - 1);
    expect(sealed()).toBeUndefined();        // still waiting at 4999ms — the old, shared grace
    await vi.advanceTimersByTimeAsync(1);
    expect(sealed()).toBeDefined();
    await run;
  });
});
