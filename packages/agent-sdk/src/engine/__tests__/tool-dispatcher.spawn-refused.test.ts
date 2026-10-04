/**
 * tool-dispatcher.spawn-refused.test.ts — follow-up D item 1: the STRUCTURED signal that a
 * spawn tool turned a spawn away on its own grounds.
 *
 * The root wall must be able to tell "this hand-off ran" from "the Agent tool refused this
 * call" without reading the refusal's prose. The tool says so by calling
 * `ctx.markSpawnRefused()` (the `markPausedHalt` shape: the loop supplies a no-op sentinel to
 * opt in, the dispatcher substitutes its own capturing closure), and the dispatcher stamps
 * `spawnAdmitted: false` onto the result the round engine reads.
 *
 * Exercised through the REAL `gateAndDispatchTool` chokepoint.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { toolError } from '../../tools/tool-types.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const allow = { gateTool: vi.fn(async (_call: ToolCall): Promise<GateResult> => ({ decision: 'allow' })) };
const onPause = async (): Promise<string> => 'PAUSED';

/** A spawn tool that refuses on its own grounds — the unknown-tools shape from the drill. */
const REFUSAL = 'Unknown or unavailable tools: web_search. Available: WebSearch';
const refusingAgent: RawToolOptions = {
  name: 'Agent',
  description: 'subagent',
  parameters: { type: 'object', properties: {} },
  execute: async (_args: unknown, ctx: ToolExecuteContext) => {
    ctx.markSpawnRefused?.();
    return REFUSAL;
  },
};
const okAgent: RawToolOptions = {
  name: 'Agent',
  description: 'subagent',
  parameters: { type: 'object', properties: {} },
  execute: async (_args: unknown, ctx: ToolExecuteContext) => {
    ctx.markSpawnAdmitted?.();
    return 'child done';
  },
};
/** A tool that says NOTHING: the future refusal nobody remembered to mark, and the shape
 *  every non-participating tool has. */
const silentAgent: RawToolOptions = {
  name: 'Agent',
  description: 'subagent',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'said nothing',
};
const opted = { markSpawnRefused: () => {}, markSpawnAdmitted: () => {} };

describe('gateAndDispatchTool — a refused spawn is marked, never inferred from its text', () => {
  it('a tool that marks its refusal stamps spawnAdmitted:false, and the text rides through', async () => {
    const r = await gateAndDispatchTool(
      refusingAgent, {}, 'tu-refused', allow as never, onPause, undefined, opted as never,
    );

    expect(r.spawnAdmitted).toBe(false);
    // A refusal is a TYPED outcome the model reads as an ordinary result, not an error.
    expect(r.text).toBe(REFUSAL);
    expect(r.isError).toBe(false);
  });

  it('a spawn that RAN stamps spawnAdmitted:true — the arming reads THIS, not the absence of a refusal', async () => {
    const r = await gateAndDispatchTool(
      okAgent, {}, 'tu-ran', allow as never, onPause, undefined, opted as never,
    );

    expect(r.spawnAdmitted).toBe(true);
    expect(r.text).toBe('child done');
  });

  it('a tool that says NOTHING leaves the key absent, which the arming reads as not admitted', async () => {
    const r = await gateAndDispatchTool(
      silentAgent, {}, 'tu-silent', allow as never, onPause, undefined, opted as never,
    );

    expect(r.spawnAdmitted).toBeUndefined();
    expect('spawnAdmitted' in r).toBe(false);
  });

  it('an ADMISSION outranks a refusal in the same call: a batch that started children and refused one', async () => {
    // L3 — the marker is per CALL. `children[]` runs several children through one tool_use,
    // so a batch where three ran and the fourth hit the budget wall started helpers, and
    // must not report that it started none. Order-independent: admitted wins either way.
    const mixed = (order: 'refuse-last' | 'admit-last'): RawToolOptions => ({
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx: ToolExecuteContext) => {
        if (order === 'refuse-last') { ctx.markSpawnAdmitted?.(); ctx.markSpawnRefused?.(); }
        else { ctx.markSpawnRefused?.(); ctx.markSpawnAdmitted?.(); }
        return 'three ran, one refused';
      },
    });

    for (const order of ['refuse-last', 'admit-last'] as const) {
      const r = await gateAndDispatchTool(mixed(order), {}, `tu-${order}`, allow as never, onPause, undefined, opted as never);
      expect(r.spawnAdmitted, order).toBe(true);
    }
  });

  it('a tool that marked and then THREW keeps its verdict: the child ran, the tool failed after', async () => {
    // L2 — the catch built a fresh literal without the stamp, so the fact was dropped.
    const throwsAfterSpawn: RawToolOptions = {
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx: ToolExecuteContext) => {
        ctx.markSpawnAdmitted?.();
        throw new Error('the relay died after the child ran');
      },
    };

    const r = await gateAndDispatchTool(throwsAfterSpawn, {}, 'tu-threw', allow as never, onPause, undefined, opted as never);
    expect(r.isError).toBe(true);
    expect(r.spawnAdmitted).toBe(true);
  });

  it('a child that ran and then PAUSED for a human keeps its verdict: the helper started', async () => {
    // R142 — the pausedHalt return built its own literal without the stamp, so a lone spawn
    // whose child pauses reported that nothing started for a child that had.
    const pausesAfterSpawn: RawToolOptions = {
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx: ToolExecuteContext) => {
        ctx.markSpawnAdmitted?.();
        ctx.markPausedHalt?.();
        return 'Subagent paused awaiting human approval.';
      },
    };

    const r = await gateAndDispatchTool(
      pausesAfterSpawn, {}, 'tu-paused', allow as never, onPause, undefined,
      { ...opted, markPausedHalt: () => {} } as never,
    );
    expect(r.pausedHalt).toBe(true);
    expect(r.spawnAdmitted).toBe(true);
  });

  it('a refusal returned as a typed error SENTINEL keeps its verdict too', async () => {
    // L2's other half: nothing returns a sentinel from a marked path today, but the stamp
    // must not be a property of WHICH return the tool happened to take.
    const sentinelRefusal: RawToolOptions = {
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx: ToolExecuteContext) => {
        ctx.markSpawnRefused?.();
        return toolError('invalid_input', REFUSAL);
      },
    };

    const r = await gateAndDispatchTool(
      sentinelRefusal, {}, 'tu-sentinel', allow as never, onPause, undefined,
      { ...opted, toolErrorTaxonomy: true } as never,
    );
    expect(r.spawnAdmitted).toBe(false);
  });

  it('a caller that did not opt in never even sees the hook: every other dispatch is unchanged', async () => {
    let seen: unknown = 'not-read';
    const peekingTool: RawToolOptions = {
      name: 'Bash',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx: ToolExecuteContext) => {
        seen = ctx.markSpawnRefused;
        return 'ran';
      },
    };

    const r = await gateAndDispatchTool(peekingTool, {}, 'tu-bare', allow as never, onPause);

    expect(seen).toBeUndefined();
    expect(r).toEqual({ toolUseId: 'tu-bare', text: 'ran', isError: false });
  });
});
