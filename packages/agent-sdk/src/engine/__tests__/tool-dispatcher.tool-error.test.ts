/**
 * tool-dispatcher.tool-error.test.ts — Hardening-G (tool-error taxonomy).
 *
 * A tool may return a typed error SENTINEL (`toolError(code, message)`) instead of a
 * plain error string. Exercised through the REAL `gateAndDispatchTool` chokepoint so
 * a passing test proves the actual mapping, not a stub.
 *
 * Three flag axes (the dark-ship contract):
 *  - OFF (absent / false): sentinel → `.message` string, isError:false — BYTE-IDENTICAL
 *    to a tool that returns that plain string today.
 *  - ON: sentinel → isError:true, text stamped with `[error:<code>]`, PostToolUseFailure
 *    fires, blocks stays undefined.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { toolError, parseToolErrorCode, isTransientToolErrorCode } from '../../tools/tool-types.js';
import { TOOL_OUTPUT_MAX_CHARS } from '../tool-output-guard.js';
import type { RawToolOptions, ToolErrorCode } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

/** A tool whose execute returns a sentinel (never throws). */
function sentinelTool(code: ToolErrorCode, message: string, name = 'Bash'): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => toolError(code, message)),
  };
}

/** A tool that returns the plain error string (today's behavior — the byte-identity oracle). */
function stringTool(message: string, name = 'Bash'): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => message),
  };
}

describe('gateAndDispatchTool — tool-error taxonomy, flag ON', () => {
  it('maps a sentinel to isError:true with the code stamped on the text tail', async () => {
    const tool = sentinelTool('exec_failed', 'Command failed: boom');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-on-1', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Command failed: boom [error:exec_failed]');
    expect(r.blocks).toBeUndefined();
  });

  it('carries the specific code (timeout) through the stamp', async () => {
    const tool = sentinelTool('timeout', 'Command failed: slept too long');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-on-2', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(r.text).toBe('Command failed: slept too long [error:timeout]');
    expect(r.isError).toBe(true);
  });

  it('routes through PostToolUseFailure (message, NOT the stamped text) when a dispatcher is present', async () => {
    const failureInputs: unknown[] = [];
    const dispatcher = {
      dispatch: vi.fn(async (event: string, input: unknown) => {
        if (event === 'PreToolUse') return { decision: 'continue' as const, permissionDecision: 'allow' as const };
        if (event === 'PostToolUseFailure') failureInputs.push(input);
        return { decision: 'continue' as const };
      }),
    };
    const tool = sentinelTool('not_found', 'Could not read /x: ENOENT', 'Read');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-on-3', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true, dispatcher: dispatcher as never },
    );
    expect(r.isError).toBe(true);
    const events = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    expect(events).toContain('PostToolUseFailure');
    // The hook receives the raw message (the trained error channel), not the stamp.
    expect(failureInputs[0]).toMatchObject({ error: 'Could not read /x: ENOENT', tool_name: 'Read' });
  });

  it('ON base behavior: a NON-sentinel tool is unaffected by the flag (string result stays isError:false)', async () => {
    // The third flag axis — turning the flag ON must NOT change any tool that does not
    // return a sentinel (every tool except the two converted ones stays byte-identical).
    const tool = stringTool('ran the command\nline 2');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-on-base', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe('ran the command\nline 2');
    expect(r.blocks).toBeUndefined();
  });
});

describe('gateAndDispatchTool — taxonomy ON: guard-then-stamp (P2.2 charter b)', () => {
  it('caps an OVERSIZED sentinel message through guardToolOutput, stamp surviving at the tail', async () => {
    const huge = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10_000);
    const tool = sentinelTool('too_large', huge);
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-guard-1', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(r.isError).toBe(true);
    // The guard capped the MESSAGE (stamp excluded from the cap arithmetic)…
    expect(r.text.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + ' [error:too_large]'.length);
    expect(r.text).toContain('…[truncated: tool output exceeded');
    // …and the stamp SURVIVES at the tail (stamp-then-guard would have cut it off).
    expect(r.text.endsWith(' [error:too_large]')).toBe(true);
    expect(parseToolErrorCode(r.text)).toBe('too_large');
  });

  it('a normal-sized sentinel message is byte-identical to the pre-charter stamp (guard is identity)', async () => {
    const tool = sentinelTool('exec_failed', 'Command failed: boom');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-guard-2', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: true },
    );
    expect(r.text).toBe('Command failed: boom [error:exec_failed]');
  });
});

describe('parseToolErrorCode / isTransientToolErrorCode (P2.2 charter a — the retry consumer decode)', () => {
  it('decodes a tail stamp into its code', () => {
    expect(parseToolErrorCode('Command failed: slept too long [error:timeout]')).toBe('timeout');
    expect(parseToolErrorCode('nope [error:unavailable]')).toBe('unavailable');
  });

  it('rejects non-tail stamps, unknown codes, and prose', () => {
    expect(parseToolErrorCode('[error:timeout] but then more prose')).toBeUndefined();
    expect(parseToolErrorCode('failed [error:made_up_code]')).toBeUndefined();
    expect(parseToolErrorCode('a plain error message')).toBeUndefined();
    expect(parseToolErrorCode('')).toBeUndefined();
  });

  it('tolerates trailing whitespace (trimEnd before the tail anchor)', () => {
    expect(parseToolErrorCode('boom [error:timeout]  \n')).toBe('timeout');
  });

  it('classifies ONLY timeout/unavailable as transient', () => {
    expect(isTransientToolErrorCode('timeout')).toBe(true);
    expect(isTransientToolErrorCode('unavailable')).toBe(true);
    for (const code of ['exec_failed', 'not_found', 'invalid_input', 'permission', 'aborted', 'too_large', 'unknown'] as const) {
      expect(isTransientToolErrorCode(code)).toBe(false);
    }
    expect(isTransientToolErrorCode(undefined)).toBe(false);
  });
});

describe('gateAndDispatchTool — tool-error taxonomy, flag OFF (byte-identical)', () => {
  it('absent flag: sentinel unwraps to its .message string, isError:false', async () => {
    const tool = sentinelTool('exec_failed', 'Command failed: boom');
    const r = await gateAndDispatchTool(tool, {}, 'tu-off-1', allowGate() as never, NOOP_PAUSE);
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Command failed: boom');
    expect(r.blocks).toBeUndefined();
  });

  it('explicit false: same as absent', async () => {
    const tool = sentinelTool('timeout', 'Command failed: slept too long');
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-off-2', allowGate() as never, NOOP_PAUSE, undefined,
      { toolErrorTaxonomy: false },
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Command failed: slept too long');
  });

  it('the sentinel is NEVER JSON.stringified into the text under OFF', async () => {
    const tool = sentinelTool('exec_failed', 'Command failed: boom');
    const r = await gateAndDispatchTool(tool, {}, 'tu-off-3', allowGate() as never, NOOP_PAUSE);
    expect(r.text).not.toContain('__toolError');
  });

  it('byte-identity: an OFF sentinel is indistinguishable from a tool that returns the plain string', async () => {
    const msg = 'Command failed: boom';
    const viaSentinel = await gateAndDispatchTool(sentinelTool('exec_failed', msg), {}, 'tu-s', allowGate() as never, NOOP_PAUSE);
    const viaString = await gateAndDispatchTool(stringTool(msg), {}, 'tu-p', allowGate() as never, NOOP_PAUSE);
    expect({ text: viaSentinel.text, isError: viaSentinel.isError, blocks: viaSentinel.blocks })
      .toEqual({ text: viaString.text, isError: viaString.isError, blocks: viaString.blocks });
  });

  it('PostToolUseFailure does NOT fire under OFF (a sentinel is a success-path string)', async () => {
    const dispatcher = {
      dispatch: vi.fn(async (event: string) => {
        if (event === 'PreToolUse') return { decision: 'continue' as const, permissionDecision: 'allow' as const };
        return { decision: 'continue' as const };
      }),
    };
    const tool = sentinelTool('exec_failed', 'Command failed: boom');
    await gateAndDispatchTool(
      tool, {}, 'tu-off-hook', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    const events = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    expect(events).not.toContain('PostToolUseFailure');
    // OFF still runs PostToolUse (the normal success rewrite surface).
    expect(events).toContain('PostToolUse');
  });
});
