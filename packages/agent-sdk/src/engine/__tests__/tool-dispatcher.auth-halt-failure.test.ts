/**
 * L5 (#3332 site b, SILENT_DEATHS_V1) — a Connect card that could not be raised is an
 * EXPLICIT tool error, never a pause with nothing to answer.
 *
 * On a Composio auth verdict the dispatcher fires `onAuthHalt` (the interaction write
 * behind the Connect card) and halts with `pausedHalt:true`. When that write threw, the
 * catch swallowed it and still paused: a "needs you" with no card, forever. With the flag
 * on the tool ends with an error the model relays; off, today's pause, byte-identical.
 * Driven through the REAL `gateAndDispatchTool` with a real-shaped Composio auth result.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gateAndDispatchTool, authCardFailedText } from '../tool-dispatcher.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const onPause = async () => 'PAUSED';

/** A Composio tool whose result carries the auth wall the classifier recognises. */
const composioTool = (): RawToolOptions => ({
  name: 'mcp__composio__GMAIL_SEND_EMAIL',
  description: 'test',
  parameters: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({
    toolkit: 'gmail',
    authUrl: 'https://connect.composio.dev/link/abc123',
    message: 'Authentication required',
  })),
});

const dispatch = (onAuthHalt: unknown, id: string) =>
  gateAndDispatchTool(composioTool(), {}, id, gateOf({ decision: 'allow' }) as never, onPause, onAuthHalt as never);

describe('gateAndDispatchTool — a Connect card that could not be raised', () => {
  const saved = process.env.SILENT_DEATHS_V1;
  afterEach(() => {
    if (saved === undefined) delete process.env.SILENT_DEATHS_V1;
    else process.env.SILENT_DEATHS_V1 = saved;
  });

  it('flag on: a throwing onAuthHalt returns an explicit error, NOT a pause', async () => {
    process.env.SILENT_DEATHS_V1 = 'true';
    const onAuthHalt = vi.fn(async () => { throw new Error('interactions insert: connection refused'); });
    const r = await dispatch(onAuthHalt, 'tu-auth');
    // Mutation: keep the empty catch → pausedHalt comes back and the turn parks on no card.
    expect(r.pausedHalt).toBeFalsy();
    expect(r.isError).toBe(true);
    expect(r.text).toBe(authCardFailedText('gmail'));
    // The failure's detail is for the runner's log, never the model.
    expect(r.text).not.toContain('connection refused');
    expect(onAuthHalt).toHaveBeenCalledTimes(1);
  });

  it("'1' is on too: the runner reads the same accessor, so the two halves never disagree", async () => {
    process.env.SILENT_DEATHS_V1 = '1';
    const r = await dispatch(vi.fn(async () => { throw new Error('boom'); }), 'tu-auth-1');
    expect(r.pausedHalt).toBeFalsy();
    expect(r.text).toBe(authCardFailedText('gmail'));
  });

  it('flag off: the throw is swallowed and the turn pauses exactly as today', async () => {
    delete process.env.SILENT_DEATHS_V1;
    const r = await dispatch(vi.fn(async () => { throw new Error('boom'); }), 'tu-auth-off');
    expect(r.pausedHalt).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.text).not.toBe(authCardFailedText('gmail'));
  });

  it('either way: an onAuthHalt that succeeds still pauses on the card', async () => {
    for (const flag of ['true', undefined]) {
      if (flag) process.env.SILENT_DEATHS_V1 = flag;
      else delete process.env.SILENT_DEATHS_V1;
      const r = await dispatch(vi.fn(async () => {}), `tu-auth-ok-${flag ?? 'off'}`);
      expect(r.pausedHalt).toBe(true);
    }
  });

  it('the error text names the app and the page it is connected on, and tells the model not to retry', () => {
    expect(authCardFailedText('slack')).toBe(
      'slack is not connected yet, and the connect card could not be shown right now. ' +
      'Stop here and ask the user to connect slack on the Apps page (Connectors), then send their request again. ' +
      'Do not call this tool again in this reply.',
    );
  });
});
