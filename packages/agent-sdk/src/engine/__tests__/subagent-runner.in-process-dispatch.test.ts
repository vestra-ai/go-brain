import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';

/**
 * Slice 2b Task 8 (Gap A) — the subagent loop threads an IN-PROCESS dispatcher onto
 * every tool's execute ctx, exactly like the top-level native loop. A tool dispatched
 * inside the subagent (execute_code) re-enters the SAME gate->execute pipeline via
 * `ctx.dispatchInProcessTool`, scoped to the subagent's OWN toolset:
 *   - a known tool routes through the gate and executes;
 *   - an unknown name returns the "Unknown tool" sentinel (never an implicit allow);
 *   - the RE-ENTERED tool's ctx OMITS dispatchInProcessTool (recursion guard — a
 *     nested tool cannot recurse back into execute_code).
 */
function makeScriptedTransport(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => {
      (h as unknown[]).push({});
    },
    pushAssistant: (h) => {
      (h as unknown[]).push({});
    },
    pushToolResult: (h) => {
      (h as unknown[]).push({});
    },
    buildTools: (raw) => raw as unknown[],
    callModel: () =>
      (rounds[i++] ?? [
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]) as unknown as ProviderStream,
    // eslint-disable-next-line require-yield
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
  };
  return t as Transport;
}

const allowHarness = {
  gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }),
};
const onPause = async (): Promise<string> => 'PAUSED';
const doneEv = (): StreamEvent => ({
  kind: 'done',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe('runSubagentLoop — Gap A: in-process dispatcher threaded onto subagent tools', () => {
  it('re-enters the gate pipeline for in-code calls, errors on unknown, and guards recursion', async () => {
    let probeCtx: ToolExecuteContext | undefined;
    let innerSawDispatcher: boolean | undefined;
    const results: Record<string, { text: string; isError: boolean }> = {};

    const echo: RawToolOptions = {
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async (input) => `echo:${(input as { msg: string }).msg}`,
    };
    const inner: RawToolOptions = {
      name: 'inner',
      description: 'inner',
      parameters: z.object({}),
      execute: async (_input, ctx) => {
        // Recursion guard: a tool RE-ENTERED via the in-process dispatcher must NOT
        // itself receive dispatchInProcessTool (so it cannot recurse into execute_code).
        innerSawDispatcher = ctx.dispatchInProcessTool !== undefined;
        return 'inner-ran';
      },
    };
    const probe: RawToolOptions = {
      name: 'probe',
      description: 'probe',
      parameters: z.object({}),
      execute: async (_input, ctx) => {
        probeCtx = ctx;
        const k = await ctx.dispatchInProcessTool!('echo', { msg: 'hi' });
        const u = await ctx.dispatchInProcessTool!('nope', {});
        const ir = await ctx.dispatchInProcessTool!('inner', {});
        results.echo = { text: k.text, isError: k.isError };
        results.nope = { text: u.text, isError: u.isError };
        results.inner = { text: ir.text, isError: ir.isError };
        return 'probe-done';
      },
    };

    await runSubagentLoop({
      transport: makeScriptedTransport([
        [{ kind: 'tool_use', toolUse: { id: 'tu1', name: 'probe', input: {} } }, doneEv()],
        [{ kind: 'text', text: 'final' }, doneEv()],
      ]),
      model: 'm',
      system: 's',
      userPrompt: 'go',
      tools: [probe, echo, inner],
      harness: allowHarness,
      onPause,
      maxTurns: 5,
      childId: 'child-dispatch-test',
      onEvent: () => {},
    });

    // The dispatcher is present on the subagent tool's execute ctx.
    expect(probeCtx?.dispatchInProcessTool).toBeTypeOf('function');
    // A known tool routes through the gate and executes against the subagent's tools.
    expect(results.echo).toEqual({ text: 'echo:hi', isError: false });
    // An unknown name returns the "Unknown tool" sentinel (never an implicit allow).
    expect(results.nope.isError).toBe(true);
    expect(results.nope.text).toMatch(/unknown tool/i);
    // The re-entered tool ran...
    expect(results.inner.text).toBe('inner-ran');
    expect(results.inner.isError).toBe(false);
    // ...but did NOT receive the in-process dispatcher (recursion guard).
    expect(innerSawDispatcher).toBe(false);
  });
});
