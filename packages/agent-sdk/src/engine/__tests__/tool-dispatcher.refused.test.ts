/**
 * The action fee is for an action. A call the harness refused never ran, so it is stamped
 * `refused` and toolBillingEvent sends nothing for it; a call that ran and failed keeps its fee
 * (the vendor may have done the work). Before this, a refused Composio call cost 0.3 on both
 * engines: the deliver-guard's deny of a duplicate GMAIL_SEND was charged like a send.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { toolBillingEvent } from '../tool-billing.js';
import { toolError, type RawToolOptions } from '../../tools/tool-types.js';
import type { InjectionScreenReading } from '../../policy/injection-screen.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_c: ToolCall) => verdict) });
const allow = () => gateOf({ decision: 'allow' });
const pause = async () => 'PAUSED';
const SEND = 'mcp__composio__GMAIL_SEND_EMAIL';
const sendTool = (execute: RawToolOptions['execute']): RawToolOptions => ({
  name: SEND, description: 'Send an email.', parameters: z.object({ to: z.string() }), execute,
});
const fee = (toolUseId: string, res: Parameters<typeof toolBillingEvent>[1]) => toolBillingEvent({ taskId: 't1', toolName: SEND, toolUseId }, res);

describe('a refused call is stamped and bills nothing', () => {
  it('the deliver-guard (any gate deny) refusing a duplicate send', async () => {
    const execute = vi.fn(async () => 'sent');
    const deny = gateOf({ decision: 'deny', message: 'This email already went out in this task.', reasonType: 'delivery' });
    const r = await gateAndDispatchTool(sendTool(execute), { to: 'a@x.com' }, 'tu-dup', deny as never, pause);
    expect(execute).not.toHaveBeenCalled();
    expect(r.refused).toBe(true);
    expect(fee('tu-dup', r)).toBeUndefined();
  });

  it('the schema gate refusing the arguments', async () => {
    const execute = vi.fn(async () => 'sent');
    const r = await gateAndDispatchTool(sendTool(execute), { to: 42 }, 'tu-bad', allow() as never, pause);
    expect(execute).not.toHaveBeenCalled();
    expect(r).toMatchObject({ isError: true, refused: true });
    expect(fee('tu-bad', r)).toBeUndefined();
  });

  it('the injection guard skipping a send a page asked for', async () => {
    const execute = vi.fn(async () => 'sent');
    const reading: InjectionScreenReading = { verdict: 'instructed', reason: 'the page asked', block: true };
    const r = await gateAndDispatchTool(sendTool(execute), { to: 'a@x.com' }, 'tu-inj', allow() as never, pause, undefined, {
      injectionScreen: { maybeScreen: vi.fn(async () => reading) },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(r.refused).toBe(true);
    expect(fee('tu-inj', r)).toBeUndefined();
  });
});

describe('a call that ran is charged, whether it worked or not', () => {
  it('a send that went out', async () => {
    const r = await gateAndDispatchTool(sendTool(async () => 'sent'), { to: 'a@x.com' }, 'tu-ok', allow() as never, pause);
    expect(r).not.toHaveProperty('refused');
    expect(fee('tu-ok', r)).toMatchObject({ event: 'agent:tool_billing', data: { toolName: SEND, toolUseId: 'tu-ok' } });
  });

  it('a send that threw: the vendor call may have happened', async () => {
    const r = await gateAndDispatchTool(sendTool(async () => { throw new Error('502 from the mail server'); }), { to: 'a@x.com' }, 'tu-throw', allow() as never, pause);
    expect(r).toMatchObject({ isError: true });
    expect(r).not.toHaveProperty('refused');
    expect(fee('tu-throw', r)).toBeDefined();
  });

  it('a send that answered with an error', async () => {
    const r = await gateAndDispatchTool(sendTool(async () => toolError('exec_failed', 'quota exceeded')), { to: 'a@x.com' }, 'tu-err', allow() as never, pause, undefined, { toolErrorTaxonomy: true });
    expect(r).toMatchObject({ isError: true });
    expect(r).not.toHaveProperty('refused');
    expect(fee('tu-err', r)).toBeDefined();
  });
});
