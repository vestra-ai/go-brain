import { describe, it, expect } from 'vitest';
import { decideToolGate } from '../../index.js';
import { DeliverLedger } from '../deliver-ledger.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';

// ─────────────────────────────────────────────────────────────────────────────
// DELIVER-GUARD THREADING — the double-post pin (prod task 832d60fd, 2026-08-12).
//
// One user intent ("send the image to #marketing") executed as TWO Composio
// writes: SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK then SLACK_SEND_MESSAGE to the
// same channel, 8s apart, both ok:true. The guard threads into the gate as
// ctx.deliverGuard and must sit ABOVE the mode ladder: the incident ran under
// permission_mode=bypassPermissions, and the only gate stages that fired there
// were the ones beside security. A guard below the ladder is no guard.
// ─────────────────────────────────────────────────────────────────────────────

const TASK = 'task-1';
const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const CONNECTED = new Set(['slack', 'composio']);

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't',
});
const send = (channel: string, text: string): ToolCall =>
  tool(META, { tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel, text } }] });

const gate = (call: ToolCall, extra: Partial<ToolGateContext> = {}) =>
  decideToolGate(call, { connectedComposioToolkits: CONNECTED, ...extra });

const boundGuard = (ledger: DeliverLedger) => ({
  check: (call: ToolCall) => ledger.check(TASK, call),
});

describe('decideToolGate — deliverGuard threading', () => {
  it('denies a duplicate delivery with reasonType "delivery"', () => {
    const ledger = new DeliverLedger();
    ledger.record(TASK, send('C1', 'hello'), undefined);
    const result = gate(send('C1', 'hello'), { deliverGuard: boundGuard(ledger) });
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') {
      expect(result.reasonType).toBe('delivery');
      expect(result.message).toContain('duplicate');
    }
  });

  it('still denies under bypassPermissions (the guard sits above the mode ladder)', () => {
    const ledger = new DeliverLedger();
    ledger.record(TASK, send('C1', 'hello'), undefined);
    const result = gate(send('C1', 'hello'), {
      deliverGuard: boundGuard(ledger),
      mode: 'bypassPermissions',
    });
    expect(result.decision).toBe('deny');
  });

  it('a clean delivery passes through to the normal pipeline', () => {
    const ledger = new DeliverLedger();
    const result = gate(send('C1', 'hello'), { deliverGuard: boundGuard(ledger), mode: 'bypassPermissions' });
    expect(result.decision).toBe('allow');
  });

  it('absent guard ⇒ byte-identical gate (no new behavior)', () => {
    const withOut = gate(send('C1', 'hello'), { mode: 'bypassPermissions' });
    expect(withOut.decision).toBe('allow');
  });

  it('the guard never intercepts non-delivery tools', () => {
    const ledger = new DeliverLedger();
    ledger.record(TASK, send('C1', 'hello'), undefined);
    const result = gate(tool('Read', { file_path: '/app/workspace/x' }), {
      deliverGuard: boundGuard(ledger),
      mode: 'bypassPermissions',
    });
    expect(result.decision).toBe('allow');
  });
});
