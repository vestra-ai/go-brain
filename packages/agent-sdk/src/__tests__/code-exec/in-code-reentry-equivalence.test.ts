import { describe, it, expect, vi } from 'vitest';
import { makeInProcessDispatcher, inCodePause } from '../../engine/round-engine.js';
import { PAUSED_HALT } from '../../contract/paused-halt.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

describe('in-code re-entry equivalence', () => {
  it('routes a named in-code call through gate+billing identically to direct dispatch', async () => {
    let billed = 0;
    const web: RawToolOptions = {
      name: 'WebSearch', description: 'w', parameters: undefined,
      execute: async (_a, ctx) => { ctx.addCostUsd?.(0.01); return 'RESULT'; },
    };
    const tools = [web];
    const harness = { gateTool: async () => ({ decision: 'allow' as const }) };
    const dispatch = makeInProcessDispatcher({
      tools, harness, onPause: async () => 'P', onAuthHalt: undefined,
      execCtx: { addCostUsd: (u: number) => { billed += u; } },
    });
    const r = await dispatch('WebSearch', { query: 'q' });
    expect(r.text).toBe('RESULT');
    expect(r.isError).toBeFalsy();
    expect(billed).toBeCloseTo(0.01);
  });

  it('a DENY gate verdict yields an isError result through the in-code path (tool never runs, no pause)', async () => {
    // Strengthens the by-construction equivalence: the in-code path is not just a
    // happy-path passthrough — a hard gate DENY short-circuits BEFORE execute(),
    // surfaces the deny message as an isError result, and is NOT a HITL pause
    // (pausedHalt stays falsy, distinguishing it from a needs_human verdict).
    let ran = false;
    const web: RawToolOptions = {
      name: 'WebSearch', description: 'w', parameters: undefined,
      execute: async () => { ran = true; return 'SHOULD NOT RUN'; },
    };
    const dispatch = makeInProcessDispatcher({
      tools: [web],
      harness: { gateTool: async () => ({ decision: 'deny' as const, message: 'blocked by policy gate' }) },
      onPause: inCodePause, onAuthHalt: undefined, execCtx: {},
    });
    const r = await dispatch('WebSearch', { query: 'q' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('blocked by policy gate');
    expect(r.pausedHalt).toBeFalsy();
    expect(ran).toBe(false);
  });

  it('returns a ToolDispatchResult error for an unknown tool (never throws)', async () => {
    const dispatch = makeInProcessDispatcher({
      tools: [], harness: { gateTool: async () => ({ decision: 'allow' as const }) },
      onPause: async () => 'P', onAuthHalt: undefined, execCtx: {},
    });
    const r = await dispatch('Nope', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown tool/i);
  });

  it('an in-code needs_human verdict pauses WITHOUT minting a durable interaction/journal entry', async () => {
    // The loop's REAL onPause closes over the InteractionPort + the journal append.
    // Firing it from the in-code (execute_code) path mints a durable interaction
    // bound to an unjournaled randomUUID toolCallId — a phantom HITL that corrupts
    // resume. The in-code dispatcher must use a side-effect-free pause instead.
    const requestInteraction = vi.fn(async () => 'interaction_123');
    const appendPending = vi.fn(async () => {});
    const realOnPause = async (call: { toolCallId: string }, kind: string): Promise<string> => {
      const id = await requestInteraction();
      await appendPending();
      void id; void kind; void call;
      return PAUSED_HALT;
    };

    const tools: RawToolOptions[] = [
      { name: 'WebSearch', description: 'w', parameters: undefined, execute: async () => 'SHOULD NOT RUN' },
    ];
    const harness = {
      gateTool: async () => ({ decision: 'needs_human' as const, interactionKind: 'ask' }),
    };

    // In-code path: the exported side-effect-free pause.
    const inCode = makeInProcessDispatcher({
      tools, harness, onPause: inCodePause, onAuthHalt: undefined, execCtx: {},
    });
    const r = await inCode('WebSearch', { query: 'q' });
    expect(r.pausedHalt).toBe(true);
    // A HITL pause is a TYPED outcome — the pause rides pausedHalt, not isError.
    expect(r.isError).toBe(false);
    expect(r.text).toBe(PAUSED_HALT);
    expect(requestInteraction).not.toHaveBeenCalled();
    expect(appendPending).not.toHaveBeenCalled();

    // Contrast: the SAME dispatcher wired with the loop's real onPause WOULD fire
    // the durable interaction — proving the only thing suppressing the side effect
    // is the in-code pause sentinel, not the gate verdict.
    const modelDriven = makeInProcessDispatcher({
      tools, harness, onPause: realOnPause, onAuthHalt: undefined, execCtx: {},
    });
    const r2 = await modelDriven('WebSearch', { query: 'q' });
    expect(r2.pausedHalt).toBe(true);
    expect(requestInteraction).toHaveBeenCalledTimes(1);
    expect(appendPending).toHaveBeenCalledTimes(1);
  });
});
