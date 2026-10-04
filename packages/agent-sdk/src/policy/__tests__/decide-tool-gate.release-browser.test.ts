/**
 * Lifecycle v2: release_browser ALWAYS asks. The tool pulls the browser away
 * from another live task, so a human approves every call — regardless of mode,
 * access level, or allow rules. Only the capability deny outranks it (an
 * ungranted task cannot even ask). Test-only file.
 */

import { describe, it, expect } from 'vitest';
import { decideToolGate } from '../decide-tool-gate.js';
import { BROWSER_CONTROL_DENY_MESSAGE } from '../engine-constants.js';
import type { ToolCall } from '../../contract/harness.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

const call = (toolName: string): ToolCall => ({ toolName, toolInput: {}, toolCallId: 't' });

describe('decideToolGate — release_browser hard-ask (lifecycle v2)', () => {
  it.each(['release_browser', 'mcp__browser-control__release_browser'])(
    '%s needs a human with a bare ctx',
    (name) => {
      const result = decideToolGate(call(name), {});
      expect(result).toMatchObject({
        decision: 'needs_human',
        interactionKind: 'tool_permission',
      });
    },
  );

  it('asks even under an explicit permission mode (the ladder never auto-allows it)', () => {
    const ctx: ToolGateContext = { mode: 'default' };
    const result = decideToolGate(call('mcp__browser-control__release_browser'), ctx);
    expect(result).toMatchObject({
      decision: 'needs_human',
      interactionKind: 'tool_permission',
    });
  });

  it('capability deny still wins when browser.control is ungranted', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(),
      capabilityRequirements: new Map([
        ['mcp__browser-control__release_browser', 'browser.control'],
      ]),
    };
    const result = decideToolGate(call('mcp__browser-control__release_browser'), ctx);
    expect(result.decision).toBe('deny');
    if (result.decision !== 'deny') throw new Error('expected deny');
    expect(result.message).toBe(BROWSER_CONTROL_DENY_MESSAGE);
  });

  it('asks when browser.control IS granted (capability satisfied, ask still stands)', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(['browser.control']),
      capabilityRequirements: new Map([
        ['mcp__browser-control__release_browser', 'browser.control'],
      ]),
    };
    const result = decideToolGate(call('mcp__browser-control__release_browser'), ctx);
    expect(result).toMatchObject({
      decision: 'needs_human',
      interactionKind: 'tool_permission',
    });
  });
});
