/**
 * tool-dispatcher.paused.test.ts — a HITL pause is a TYPED outcome, never an error.
 *
 * The `ask`/`defer` gate verdict and the subagent `markPausedHalt` propagation both
 * pause the turn. Before this change they returned `isError:true` (a sentinel the web
 * had to special-case away from a red error chip); now they return `isError:false`
 * with `pausedHalt:true` — the pause rides the typed flag, not the error channel.
 * Exercised through the REAL `gateAndDispatchTool` chokepoint.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';
import type { ToolExecuteContext } from '../../tools/tool-types.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const PAUSE_TEXT = 'PAUSED_HALT';
const onPause = async () => PAUSE_TEXT;

const okTool = (name = 'Bash'): RawToolOptions => ({
  name,
  description: 'test',
  parameters: { type: 'object', properties: {} },
  execute: vi.fn(async () => 'ran'),
});

describe('gateAndDispatchTool — typed paused outcome', () => {
  it('an ask gate verdict returns isError:false + pausedHalt:true (pause is not an error)', async () => {
    const r = await gateAndDispatchTool(
      okTool(), {}, 'tu-ask',
      gateOf({ decision: 'needs_human', interactionKind: 'tool_permission' }) as never,
      onPause,
    );
    expect(r.pausedHalt).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.text).toBe(PAUSE_TEXT);
  });

  it('a subagent markPausedHalt propagation returns isError:false + pausedHalt:true', async () => {
    // The Agent subagent tool signals a nested HITL pause by calling
    // ctx.markPausedHalt(); the dispatcher surfaces it as a pausedHalt on the
    // PARENT tool_use — no longer stamped as an error.
    const subTool: RawToolOptions = {
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async (_args, ctx: ToolExecuteContext) => {
        (ctx as { markPausedHalt?: () => void }).markPausedHalt?.();
        return 'Subagent paused awaiting human approval.';
      }),
    };
    const r = await gateAndDispatchTool(
      subTool, {}, 'tu-sub',
      gateOf({ decision: 'allow' }) as never,
      onPause, undefined,
      { markPausedHalt: () => {} } as never,
    );
    expect(r.pausedHalt).toBe(true);
    expect(r.isError).toBe(false);
  });
});
