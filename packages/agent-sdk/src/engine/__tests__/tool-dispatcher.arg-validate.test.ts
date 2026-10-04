/**
 * tool-dispatcher.arg-validate.test.ts — the schema gate at the ONE dispatch boundary
 * (ring 4d, tool-arg-validate.ts).
 *
 * Pins:
 *  1. A call violating the tool's Zod params is refused with isError:true and the
 *     exact issues — execute() never runs.
 *  2. A valid call passes the SAME input reference to execute (validate-only: nulls
 *     and unknown keys intact — byte-identical to the pre-gate path).
 *  3. With the tool-error taxonomy on, the refusal is stamped `[error:invalid_input]`.
 *  4. JSON-Schema (MCP) tools have no safeParse — untouched, straight to execute.
 *  5. With a HookDispatcher present, the refusal fires PostToolUseFailure (the same
 *     seam as the execute-throw path) and never reaches PreToolUse.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { TOOL_OUTPUT_MAX_CHARS } from '../tool-output-guard.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

// ── Helpers (copied verbatim from tool-dispatcher.action-report.test.ts) ─────
const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

describe('gateAndDispatchTool — schema gate (tool-arg-validate)', () => {
  it('refuses a call that violates the tool schema: isError, issues named, execute never runs', async () => {
    const execute = vi.fn(async () => 'should not run');
    const tool = { name: 'Read', description: 'd', parameters: z.object({ path: z.string() }), execute };
    const out = await gateAndDispatchTool(tool as never, { limit: 3 }, 'tu-1', allowGate() as never, NOOP_PAUSE);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^Invalid arguments for Read: path: /);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a valid call passes the SAME input reference to execute (byte-identical path)', async () => {
    const execute = vi.fn(async (_input: unknown) => 'ok');
    const tool = { name: 'Read', description: 'd', parameters: z.object({ path: z.string(), limit: z.number().optional() }), execute };
    const input = { path: '/a', limit: null, extra: 'kept' };
    await gateAndDispatchTool(tool as never, input, 'tu-2', allowGate() as never, NOOP_PAUSE);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe(input); // same reference, nulls + unknown keys intact
  });

  it('stamps [error:invalid_input] when the taxonomy is on', async () => {
    const tool = { name: 'Read', description: 'd', parameters: z.object({ path: z.string() }), execute: vi.fn() };
    const out = await gateAndDispatchTool(tool as never, {}, 'tu-3', allowGate() as never, NOOP_PAUSE, undefined, { toolErrorTaxonomy: true });
    expect(out.text.endsWith('[error:invalid_input]')).toBe(true);
  });

  it('JSON-Schema (MCP) tools are untouched — no safeParse, straight to execute', async () => {
    const execute = vi.fn(async () => 'ok');
    const tool = { name: 'GMAIL_FETCH', description: 'd', parameters: { type: 'object', properties: {} }, execute };
    await gateAndDispatchTool(tool as never, { anything: 1 }, 'tu-4', allowGate() as never, NOOP_PAUSE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('with a HookDispatcher present, a refusal fires PostToolUseFailure and never reaches PreToolUse', async () => {
    const execute = vi.fn(async () => 'should not run');
    const tool = { name: 'Read', description: 'd', parameters: z.object({ path: z.string() }), execute };
    const dispatcher = { dispatch: vi.fn(async (_event: string, _input: unknown) => ({ decision: 'continue' as const })) };
    const input = { limit: 3 };
    const out = await gateAndDispatchTool(
      tool as never, input, 'tu-5', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never, sessionId: 'sess-1' },
    );
    expect(out.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const events = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    expect(events).toEqual(['PostToolUseFailure']);
    const failureInput = dispatcher.dispatch.mock.calls[0][1] as Record<string, unknown>;
    expect(failureInput.tool_name).toBe('Read');
    expect(failureInput.tool_use_id).toBe('tu-5');
    expect(failureInput.session_id).toBe('sess-1');
    expect(failureInput.tool_input).toBe(input);
    expect(failureInput.error).toMatch(/^Invalid arguments for Read: path: /);
  });
});

describe('gateAndDispatchTool — schema gate refusal text is guarded and stamped', () => {
  // A z.record issue path carries the MODEL-AUTHORED key, so the refusal text is
  // unbounded unless it rides guardToolOutput like every other error return.
  const hugeKey = 'k'.repeat(TOOL_OUTPUT_MAX_CHARS + 1024);
  const recordTool = () => ({
    name: 'Tally', description: 'd', parameters: z.record(z.string(), z.number()), execute: vi.fn(async () => 'ok'),
  });

  it('caps an oversized refusal and keeps the [error:invalid_input] stamp intact (taxonomy on)', async () => {
    const out = await gateAndDispatchTool(
      recordTool() as never, { [hugeKey]: 'not-a-number' }, 'tu-6', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(out.isError).toBe(true);
    expect(out.text.endsWith(' [error:invalid_input]')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + ' [error:invalid_input]'.length);
    expect(out.text).toContain('[truncated: tool output exceeded');
  });

  it('caps an oversized refusal with the taxonomy off too', async () => {
    const out = await gateAndDispatchTool(
      recordTool() as never, { [hugeKey]: 'not-a-number' }, 'tu-7', allowGate() as never, NOOP_PAUSE,
    );
    expect(out.isError).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(out.text).toContain('[truncated: tool output exceeded');
  });

  it('does NOT stamp [error:invalid_input] when the taxonomy flag is absent (regression pin)', async () => {
    const tool = { name: 'Read', description: 'd', parameters: z.object({ path: z.string() }), execute: vi.fn() };
    const out = await gateAndDispatchTool(tool as never, {}, 'tu-8', allowGate() as never, NOOP_PAUSE);
    expect(out.isError).toBe(true);
    expect(out.text.endsWith('[error:invalid_input]')).toBe(false);
    expect(out.text).toBe('Invalid arguments for Read: path: Invalid input: expected string, received undefined. Fix the arguments and call the tool again.');
  });
});
