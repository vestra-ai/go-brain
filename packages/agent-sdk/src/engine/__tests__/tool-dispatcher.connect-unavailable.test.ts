/**
 * The native arm's half of "an app with no connect flow is said out loud":
 * a MANAGE_CONNECTIONS result whose toolkit failed with no link carries the
 * harness note AFTER the untrusted-content fence closes, never inside it (the
 * 09-20 ruling: a directive inside the fence is data, and a page could forge it).
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { UNTRUSTED_CONTENT_CLOSE, type RawToolOptions } from '../../tools/tool-types.js';
import { connectUnavailableTrailer } from '../../policy/composio-result.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const allowGate = () => ({ gateTool: vi.fn(async (_call: ToolCall): Promise<GateResult> => ({ decision: 'allow' })) });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

const mcp = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

function composioTool(name: string, result: unknown): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    untrustedContent: true,
    execute: vi.fn(async () => result),
  };
}

const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS';
const FAILED = mcp({ data: { results: { spotify: { toolkit: 'spotify', status: 'failed' } } }, successful: true });

describe('gateAndDispatchTool: a connect that could not be made is said, outside the fence', () => {
  it('appends the note after the close marker', async () => {
    const r = await gateAndDispatchTool(composioTool(MANAGE, FAILED), { toolkits: ['spotify'] }, 'tu-1', allowGate() as never, NOOP_PAUSE);
    const trailer = connectUnavailableTrailer(['spotify']);
    expect(r.text.endsWith(`${UNTRUSTED_CONTENT_CLOSE}\n${trailer}`)).toBe(true);
    expect(r.text.indexOf(trailer)).toBeGreaterThan(r.text.lastIndexOf(UNTRUSTED_CONTENT_CLOSE));
    expect(r.pausedHalt).toBeUndefined();
  });

  it('an ordinary MANAGE_CONNECTIONS result carries no note', async () => {
    const active = mcp({ data: { results: { slack: { toolkit: 'slack', status: 'active' } } } });
    const r = await gateAndDispatchTool(composioTool(MANAGE, active), {}, 'tu-2', allowGate() as never, NOOP_PAUSE);
    expect(r.text.endsWith(UNTRUSTED_CONTENT_CLOSE)).toBe(true);
    expect(r.text).not.toContain('harness note');
  });

  it('another tool whose result merely looks like one carries no note', async () => {
    const r = await gateAndDispatchTool(composioTool('mcp__composio__SPOTIFY_CREATE_PLAYLIST', FAILED), {}, 'tu-3', allowGate() as never, NOOP_PAUSE);
    expect(r.text).not.toContain('harness note');
  });
});
