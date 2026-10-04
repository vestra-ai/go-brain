import { describe, it, expect } from 'vitest';
import type { RawToolOptions, ToolExecuteContext, ToolDispatchResult, ToolErrorSentinel } from '../../index.js';
import { toolError, isToolError } from '../../index.js';

describe('tool-definition types (relocated into the SDK)', () => {
  it('RawToolOptions is constructible and execute receives a ToolExecuteContext', async () => {
    const opt: RawToolOptions = {
      name: 'Echo',
      description: 'echoes',
      parameters: { type: 'object' },
      execute: async (args: unknown, ctx: ToolExecuteContext) => {
        ctx.pushEvent?.({ kind: 'raw', engine: 'test', event: 'X', data: args });
        return String((args as { text?: string }).text ?? '');
      },
    };
    const out = await opt.execute({ text: 'hi' }, { toolCallId: 't1' });
    expect(out).toBe('hi');
  });

  it('ToolDispatchResult carries the dispatch outcome shape', () => {
    const r: ToolDispatchResult = { toolUseId: 't1', text: 'ok', isError: false };
    const paused: ToolDispatchResult = { toolUseId: 't2', text: '', isError: false, pausedHalt: true };
    expect([r.isError, paused.pausedHalt]).toEqual([false, true]);
  });
});

describe('Hardening-G — tool-error sentinel helpers', () => {
  it('toolError builds the typed { __toolError: { code, message } } sentinel', () => {
    const s: ToolErrorSentinel = toolError('timeout', 'ran too long');
    expect(s).toEqual({ __toolError: { code: 'timeout', message: 'ran too long' } });
  });

  it('isToolError narrows a well-formed sentinel', () => {
    expect(isToolError(toolError('exec_failed', 'boom'))).toBe(true);
  });

  it('isToolError rejects non-sentinels (string, plain object, content envelope, null)', () => {
    expect(isToolError('Command failed: nope')).toBe(false);
    expect(isToolError({ ok: true })).toBe(false);
    expect(isToolError({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(isToolError({ __toolError: 'not-an-object' })).toBe(false);
    expect(isToolError({ __toolError: { code: 'exec_failed' } })).toBe(false); // missing message
    expect(isToolError(null)).toBe(false);
    expect(isToolError(undefined)).toBe(false);
  });
});
