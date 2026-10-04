import { describe, it, expect } from 'vitest';
import { decideToolGate } from '../decide-tool-gate.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { AccountRoster } from '../composio-account-selection.js';

const MULTI = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const roster: AccountRoster = new Map([
  ['gmail', [
    { id: 'ca_work', alias: 'work', status: 'active' },
    { id: 'ca_personal', alias: 'personal', status: 'active' },
  ]],
  ['slack', [{ id: 'ca_s', alias: null, status: 'active' }]],
]);
const connected = new Set(['gmail', 'slack']);
const call = (toolInput: unknown): ToolCall =>
  ({ toolName: MULTI, toolInput, toolCallId: 'tc_1' } as ToolCall);

/** The deny copy, read through a narrow (the allow branch carries no message). */
const denyMessage = (r: GateResult): string => (r as { message: string }).message;
/** The fill payload, read through a narrow (only the allow branch carries it). */
const filledAccount = (r: GateResult): unknown =>
  ((r as { updatedInput?: { tools: Array<Record<string, unknown>> } }).updatedInput)?.tools[0]
    .account;

describe('decideToolGate × account selection', () => {
  it('no roster in ctx → byte-identical allow (meta-tool auto-allows today)', () => {
    const result = decideToolGate(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }),
      { connectedComposioToolkits: connected });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('block: multi-account item without account denies with the roster named', () => {
    const result = decideToolGate(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }),
      { connectedComposioToolkits: connected, composioAccountRoster: roster });
    expect(result.decision).toBe('deny');
    expect(denyMessage(result)).toContain('"work" (ca_work)');
  });

  it('fill: single-account item rides the allow with updatedInput', () => {
    const result = decideToolGate(call({ tools: [{ tool_slug: 'SLACK_SEND_MESSAGE' }] }),
      { connectedComposioToolkits: connected, composioAccountRoster: roster });
    expect(result.decision).toBe('allow');
    expect(filledAccount(result)).toBe('ca_s');
  });

  it('fill also rides a bypassPermissions allow (mode set arms the ladder)', () => {
    const result = decideToolGate(call({ tools: [{ tool_slug: 'SLACK_SEND_MESSAGE' }] }),
      { connectedComposioToolkits: connected, composioAccountRoster: roster, mode: 'bypassPermissions' });
    expect(result.decision).toBe('allow');
    expect(filledAccount(result)).toBe('ca_s');
  });

  it('a valid explicit selection passes with NO updatedInput', () => {
    const result = decideToolGate(call({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'work' }] }),
      { connectedComposioToolkits: connected, composioAccountRoster: roster });
    expect(result.decision).toBe('allow');
    expect((result as { updatedInput?: unknown }).updatedInput).toBeUndefined();
  });

  it('security still wins over selection (a dangerous Bash never reaches selection)', () => {
    const result = decideToolGate(
      { toolName: 'Bash', toolInput: { command: 'rm -rf /' }, toolCallId: 'tc' } as ToolCall,
      { composioAccountRoster: roster });
    expect(result.decision).toBe('deny'); // from gateSecurity, not selection
  });
});
