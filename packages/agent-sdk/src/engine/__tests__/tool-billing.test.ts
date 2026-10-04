import { describe, it, expect } from 'vitest';
import { AGENT_TOOL_BILLING_EVENT, toolBillingEvent } from '../tool-billing.js';

const CALL = { taskId: 'task-1', toolName: 'mcp__composio__GMAIL_SEND_EMAIL', toolUseId: 'toolu_1' };

describe('toolBillingEvent: the one action-billing frame', () => {
  it("is the relay's AGENT_TOOL_BILLING frame, byte for byte what the round loops always sent", () => {
    expect(AGENT_TOOL_BILLING_EVENT).toBe('agent:tool_billing');
    expect(toolBillingEvent(CALL, {})).toEqual({
      kind: 'raw',
      engine: 'native',
      event: 'agent:tool_billing',
      data: { taskId: 'task-1', toolName: 'mcp__composio__GMAIL_SEND_EMAIL', toolUseId: 'toolu_1', isSubagent: false },
    });
  });

  it('bills a call that ran, error or not', () => {
    expect(toolBillingEvent(CALL, { pausedHalt: false })).toBeDefined();
  });

  it('bills nothing for a call that paused (it bills on resume), a node the fuel tank never ran, or a call that was refused', () => {
    expect(toolBillingEvent(CALL, { pausedHalt: true })).toBeUndefined();
    expect(toolBillingEvent(CALL, { fuelDenied: true })).toBeUndefined();
    expect(toolBillingEvent(CALL, { refused: true })).toBeUndefined();
  });
});
