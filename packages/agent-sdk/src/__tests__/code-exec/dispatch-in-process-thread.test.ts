// dispatch-in-process-thread.test.ts
import { describe, it, expect } from 'vitest';
import { gateAndDispatchTool } from '../../engine/tool-dispatcher.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

const allowHarness = { gateTool: async () => ({ decision: 'allow' as const }) };
const noPause = async () => 'PAUSED';

describe('ctx.dispatchInProcessTool threading', () => {
  it('is visible inside execute() when supplied on execCtx', async () => {
    let seen: unknown;
    const tool: RawToolOptions = {
      name: 'probe', description: 'p', parameters: undefined,
      execute: async (_args, ctx) => { seen = ctx.dispatchInProcessTool; return 'ok'; },
    };
    const fakeDispatch = async () => ({ toolUseId: 'inner', text: 'inner', isError: false });
    await gateAndDispatchTool(tool, {}, 'id-1', allowHarness, noPause, undefined, { dispatchInProcessTool: fakeDispatch });
    expect(typeof seen).toBe('function');
  });
});
