/**
 * Regression net: browser-control tools are capability-gated by `decideToolGate`.
 *
 * These tests pin the exact deny/allow behavior introduced in T5 so a future
 * edit to the gate or the capabilityRequirements map can't silently break it.
 * NO production-code changes — test-only file.
 */

import { describe, it, expect } from 'vitest';
import { decideToolGate } from '../decide-tool-gate.js';
import { BROWSER_CONTROL_DENY_MESSAGE } from '../engine-constants.js';
import type { ToolCall } from '../../contract/harness.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

// A representative browser-control tool name matching the `mcp__browser-control__` prefix
// registered by T5 (openai-harness.ts + policy-port.impl.ts).
const BROWSER_TOOL: ToolCall = {
  toolName: 'mcp__browser-control__computer_click',
  toolInput: {},
  toolCallId: 't',
};

// The capability requirement T5 wires for every `mcp__browser-control__` prefixed tool.
const BROWSER_CAPABILITY_REQ: Map<string, string> = new Map([
  ['mcp__browser-control__computer_click', 'browser.control'],
]);

describe('decideToolGate — browser-control capability gating', () => {
  it('denies a browser-control tool when browser.control is NOT in grantedCapabilities', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(), // nothing granted
      capabilityRequirements: BROWSER_CAPABILITY_REQ,
    };

    const result = decideToolGate(BROWSER_TOOL, ctx);

    expect(result.decision).toBe('deny');
    // Narrow to the deny branch to access message + reasonType.
    if (result.decision !== 'deny') throw new Error('expected deny');
    expect(result.message).toBe(BROWSER_CONTROL_DENY_MESSAGE);
    expect(result.reasonType).toBe('capability');
  });

  it('allows a browser-control tool when browser.control IS in grantedCapabilities', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(['browser.control']),
      capabilityRequirements: BROWSER_CAPABILITY_REQ,
    };

    const result = decideToolGate(BROWSER_TOOL, ctx);

    expect(result.decision).toBe('allow');
  });

  it('denies even with other capabilities granted but not browser.control', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(['some.other.cap', 'another.cap']),
      capabilityRequirements: BROWSER_CAPABILITY_REQ,
    };

    const result = decideToolGate(BROWSER_TOOL, ctx);

    expect(result.decision).toBe('deny');
    if (result.decision !== 'deny') throw new Error('expected deny');
    expect(result.reasonType).toBe('capability');
  });

  it('deny message is byte-identical to BROWSER_CONTROL_DENY_MESSAGE (the constant shared with the hook)', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(),
      capabilityRequirements: BROWSER_CAPABILITY_REQ,
    };

    const result = decideToolGate(BROWSER_TOOL, ctx);

    // This test pins that the gate uses the SAME constant the PreToolUse
    // capability hook uses — so the model-visible copy never silently diverges.
    if (result.decision !== 'deny') throw new Error('expected deny');
    expect(result.message).toBe(BROWSER_CONTROL_DENY_MESSAGE);
    expect(result.message).toContain('Browser control');
  });
});
