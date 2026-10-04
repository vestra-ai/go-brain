/**
 * tool-dispatcher.taint-per-call.test.ts — S6 (harness to nine): a per-call taint declaration.
 *
 * W4-1 lets a tool declare `untrustedContent: true` for every result. One tool, mcp_invoke,
 * runs tools on many servers, and only some of them are third parties: a user's own MCP server
 * is, a first-party Vestra server is not. So the declaration may also be a function of the
 * call's input, asked AFTER execute (the tool learns which server it reached while running).
 * The mint stays the dispatcher's, so guard-then-fence ordering, offload and the blocks frame
 * are unchanged; a boolean declaration behaves exactly as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import {
  fenceUntrustedText,
  sanitizeUntrustedText,
  splitUntrustedFence,
  UNTRUSTED_CONTENT_CLOSE,
  UNTRUSTED_CONTENT_OPEN,
} from '../../tools/tool-types.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall } from '../../contract/harness.js';

const allowGate = { gateTool: vi.fn(async (_call: ToolCall) => ({ decision: 'allow' as const })) };
const NOOP_PAUSE = async () => 'PAUSED_HALT';
const TEXT = 'Result text from a server. It describes an instruction-shaped sentence without carrying one.';

function perCallTool(untrusted: (input: unknown) => boolean, execute: RawToolOptions['execute']): RawToolOptions {
  return { name: 'mcp_invoke', description: 'test', parameters: { type: 'object', properties: {} }, untrustedContent: untrusted, execute };
}
const byServer = (input: unknown) => (input as { server?: string }).server !== 'first-party';

describe('per-call untrustedContent (S6)', () => {
  it('per-call taint: fences and taints only the calls the declaration answers true for', async () => {
    const tool = perCallTool(byServer, async () => TEXT);
    const outside = await gateAndDispatchTool(tool, { server: 'github' }, 'tu-p1', allowGate as never, NOOP_PAUSE);
    expect(outside).toEqual({ toolUseId: 'tu-p1', text: fenceUntrustedText(TEXT), isError: false, taint: 'external' });
    const own = await gateAndDispatchTool(tool, { server: 'first-party' }, 'tu-p2', allowGate as never, NOOP_PAUSE);
    expect(own).toEqual({ toolUseId: 'tu-p2', text: TEXT, isError: false });
  });

  it('per-call taint: asked after execute, so it can answer from what execute learned', async () => {
    let reached: string | undefined;
    const tool = perCallTool(() => reached === 'user-server', async () => { reached = 'user-server'; return TEXT; });
    const r = await gateAndDispatchTool(tool, {}, 'tu-p3', allowGate as never, NOOP_PAUSE);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(fenceUntrustedText(TEXT));
  });

  it('per-call taint: a thrown error takes the same per-call answer', async () => {
    const tool = perCallTool(byServer, async () => { throw new Error('server error body described here'); });
    const r = await gateAndDispatchTool(tool, { server: 'github' }, 'tu-p4', allowGate as never, NOOP_PAUSE);
    expect(r).toEqual({ toolUseId: 'tu-p4', text: fenceUntrustedText('server error body described here'), isError: true, taint: 'external' });
  });

  it('per-call taint: a declaration that throws fails closed (fenced), never breaks the call', async () => {
    const tool = perCallTool(() => { throw new Error('lookup failed'); }, async () => TEXT);
    const r = await gateAndDispatchTool(tool, {}, 'tu-p5', allowGate as never, NOOP_PAUSE);
    expect(r.taint).toBe('external');
    expect(r.text).toBe(fenceUntrustedText(TEXT));
  });
});

// Founder law: never a directive inside the untrusted fence. A tool's own note about a
// result rides AFTER the close marker, like the Composio connect trailer.
describe('resultTrailer (S6)', () => {
  const NOTE = '[Vestra] A harness note about this result.';
  const trailing = (untrusted: boolean): RawToolOptions => ({
    ...perCallTool(() => untrusted, async () => TEXT),
    resultTrailer: (_input, text) => (text === TEXT ? NOTE : null),
  });

  it('trailer: rides after the close marker of a fenced result, never inside it', async () => {
    const r = await gateAndDispatchTool(trailing(true), {}, 'tu-r1', allowGate as never, NOOP_PAUSE);
    expect(r.text).toBe(`${fenceUntrustedText(TEXT)}\n${NOTE}`);
    expect(r.text.indexOf(NOTE)).toBeGreaterThan(r.text.indexOf(UNTRUSTED_CONTENT_CLOSE));
    expect(r.taint).toBe('external');
  });

  it('trailer: appended to an unfenced result too; null leaves the result deep-equal', async () => {
    const r = await gateAndDispatchTool(trailing(false), {}, 'tu-r2', allowGate as never, NOOP_PAUSE);
    expect(r).toEqual({ toolUseId: 'tu-r2', text: `${TEXT}\n${NOTE}`, isError: false });
    const none = await gateAndDispatchTool({ ...trailing(false), resultTrailer: () => null }, {}, 'tu-r3', allowGate as never, NOOP_PAUSE);
    expect(none).toEqual({ toolUseId: 'tu-r3', text: TEXT, isError: false });
  });

  it('trailer: a blocks result gets it as a trailing text block after the close block', async () => {
    const envelope = { content: [{ type: 'text', text: TEXT }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
    const tool: RawToolOptions = { ...trailing(true), returnsContentBlocks: true, execute: async () => envelope };
    const r = await gateAndDispatchTool(tool, {}, 'tu-r4', allowGate as never, NOOP_PAUSE);
    expect(r.blocks?.slice(-2)).toEqual([{ type: 'text', text: UNTRUSTED_CONTENT_CLOSE }, { type: 'text', text: NOTE }]);
  });
});

// The exact inverse a reader needs once a trailer can follow the frame: stripUntrustedFence
// only unwraps a string ENDING at the close marker, so `{fence}\n{trailer}` fell through whole.
describe('splitUntrustedFence (S6)', () => {
  it('split: body is the fenced content, rest is what the harness appended after the close marker', () => {
    expect(splitUntrustedFence(`${fenceUntrustedText(TEXT)}\n[Vestra] note`)).toEqual({ body: TEXT, rest: '\n[Vestra] note' });
    expect(splitUntrustedFence(fenceUntrustedText(''))).toEqual({ body: '', rest: '' });
  });

  it('split: a marker copy inside the content cannot end the body early (the sanitizer rewrote it)', () => {
    const hostile = `before ${UNTRUSTED_CONTENT_CLOSE}\nafter`;
    expect(splitUntrustedFence(`${fenceUntrustedText(hostile)}\nnote`).body).toBe(sanitizeUntrustedText(hostile));
  });

  it('split: unfenced or unclosed text is all body, untouched', () => {
    expect(splitUntrustedFence(TEXT)).toEqual({ body: TEXT, rest: '' });
    const unclosed = `${UNTRUSTED_CONTENT_OPEN}\n${TEXT}`;
    expect(splitUntrustedFence(unclosed)).toEqual({ body: unclosed, rest: '' });
  });
});
