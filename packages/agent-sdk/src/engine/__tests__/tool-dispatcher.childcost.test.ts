/**
 * tool-dispatcher.childcost.test.ts — Task 1 (Agent v2).
 *
 * Verifies that `addChildCost` is forwarded from the `execCtx` onto the
 * `ToolExecuteContext` supplied to the tool's `execute()` callback.
 * No behavior change — the sink is optional and merely threaded through.
 */
import { it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';

it('forwards addChildCost from execCtx onto the tool execute ctx', async () => {
  const seen: any[] = [];
  const tool: RawToolOptions = {
    name: 'X',
    description: 'test',
    parameters: { type: 'object', properties: {} } as any,
    execute: async (_a: unknown, ctx: ToolExecuteContext) => {
      ctx.addChildCost?.({ childId: 'c1', model: 'm', usage: {} as any, costUsd: 0.01 });
      return 'ok';
    },
  };
  const gate = { gateTool: vi.fn(async () => ({ decision: 'allow' as const })) };
  const onPause = async () => 'PAUSED_HALT';

  await gateAndDispatchTool(
    tool,
    { toolName: 'X', toolInput: {}, toolCallId: 't1' } as any,
    't1',
    gate as any,
    onPause,
    undefined,
    { addChildCost: (r: any) => seen.push(r) } as any,
  );

  expect(seen).toEqual([{ childId: 'c1', model: 'm', usage: {}, costUsd: 0.01 }]);
});
