import { describe, it, expect } from 'vitest';
import type { ToolStatus, ToolUseBlock, TurnFooterBlock } from '../blocks.js';

describe('ToolStatus — D3 interrupt status', () => {
  it("admits 'interrupted' as a ToolStatus value", () => {
    const status: ToolStatus = 'interrupted';
    expect(status).toBe('interrupted');
  });

  it("a ToolUseBlock can carry status 'interrupted'", () => {
    const block: ToolUseBlock = {
      type: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', toolInput: {},
      status: 'interrupted', startTime: new Date(),
    };
    expect(block.status).toBe('interrupted');
  });
});

describe("TurnFooterBlock — why the turn was interrupted", () => {
  // A COMPILE-TIME pin (same shape as the ToolStatus pins above): drop the value
  // from the union in blocks.ts and `tsc --noEmit` fails on this file. It is the
  // only pin the interface itself can carry, and the one that matters — every
  // other layer's reason is a string until this union admits it.
  it("admits 'credits_exhausted' beside the person's Stop and the dropped link", () => {
    const credits: TurnFooterBlock = { type: 'turn_footer', durationMs: 0, interrupted: true, interruptReason: 'credits_exhausted' };
    const user: TurnFooterBlock = { type: 'turn_footer', durationMs: 0, interrupted: true, interruptReason: 'user' };
    const dropped: TurnFooterBlock = { type: 'turn_footer', durationMs: 0, interrupted: true, interruptReason: 'disconnected' };
    expect([credits.interruptReason, user.interruptReason, dropped.interruptReason])
      .toEqual(['credits_exhausted', 'user', 'disconnected']);
  });

  it("a footer with no reason is still a footer — the person's Stop stays byte-identical", () => {
    const bare: TurnFooterBlock = { type: 'turn_footer', durationMs: 0, interrupted: true };
    expect('interruptReason' in bare).toBe(false);
  });
});
