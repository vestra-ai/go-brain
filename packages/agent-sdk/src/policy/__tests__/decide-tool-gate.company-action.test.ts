import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { companyActionAsks, companyToolOf, decideToolGate, parseToolSpecifier, type CompanyAction } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { PermissionMode } from '../../contract/permission.js';
import { ACCESS_LEVELS } from '../access-level.js';

// A company action waits for the customer's yes (Keshav, 2 Oct; company-action.ts): a company's own MCP tool asks
// before it runs unless its server declares it read-only or the version lets it run without asking. Below the deny
// rules, the ask rules and plan; above the floor, the other modes and every allow rule. Explicit flags only, defaulting
// to asking: never the words in a tool's name.

const WS = '/app/workspace';
const SERVER = 'api-staging-vestra-ai';
const invoke = (tool: string, args: unknown = {}): ToolCall => ({ toolName: 'mcp_invoke', toolInput: { server: SERVER, tool, args }, toolCallId: 't' });
const action = (tool: string, over: Partial<CompanyAction> = {}): CompanyAction => ({ server: SERVER, tool, readOnly: false, runsWithoutAsking: false, ...over });

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  return decideToolGate(call, { mode: 'bypassPermissions', cwd: WS, permissionRules: { allow: [], ask: [], deny: [] }, ...extra });
}
const rules = (allow: string[], ask: string[] = [], deny: string[] = []) => {
  const p = (l: string[]) => l.map(parseToolSpecifier);
  return { permissionRules: { allow: p(allow), ask: p(ask), deny: p(deny) }, innerViewRules: { ask: p(ask), deny: p(deny) } };
};
const CANCEL = invoke('cancel', { pnr: 'PNR100002' });

beforeEach(() => { process.env.ACCESS_LEVELS_V1 = '1'; });
afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

describe('a company action at the gate', () => {
  it('asks before a company tool its server does not mark read-only, whatever the name says, in every mode but dontAsk and plan', () => {
    for (const tool of ['cancel', 'book', 'get_status', 'list_trains', 'refresh']) {
      for (const mode of ['bypassPermissions', 'default', 'acceptEdits'] as PermissionMode[]) {
        expect(gate(invoke(tool), { mode, companyAction: action(tool) }), `${tool}/${mode}`).toMatchObject({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
      }
    }
    expect(gate(CANCEL, { mode: 'dontAsk', companyAction: action('cancel') })).toMatchObject({ decision: 'deny', reasonType: 'mode' });
  });

  it('sits below plan: the most restrictive mode steers to the plan instead of asking (review Minor 1)', () => {
    const planned = gate(CANCEL, { mode: 'plan', companyAction: action('cancel') });
    expect(planned).toMatchObject({ decision: 'deny', reasonType: 'mode' });
    expect(planned).toEqual(gate(CANCEL, { mode: 'plan' }));
  });

  it('asks at every access level, and no allow rule (an Always allow) silences it', () => {
    for (const accessLevel of ACCESS_LEVELS) {
      expect(gate(CANCEL, { accessLevel, companyAction: action('cancel') }), accessLevel).toMatchObject({ decision: 'needs_human' });
    }
    expect(gate(CANCEL, { ...rules([`mcp__${SERVER}__cancel`, 'mcp_invoke']), companyAction: action('cancel') })).toMatchObject({ decision: 'needs_human' });
  });

  it('runs a tool its server marks read-only, and one the version lets run without asking', () => {
    expect(gate(invoke('search'), { companyAction: action('search', { readOnly: true }) })).toEqual({ decision: 'allow' });
    expect(gate(invoke('pnr_status'), { companyAction: action('pnr_status', { runsWithoutAsking: true }) })).toEqual({ decision: 'allow' });
  });

  it('a deny still wins, and require_approval still asks, even before a read-only tool or one that runs without asking', () => {
    const denied = rules([], [], [`mcp__${SERVER}__cancel`]);
    expect(gate(CANCEL, { ...denied, companyAction: action('cancel', { runsWithoutAsking: true }) })).toMatchObject({ decision: 'deny', reasonType: 'rule' });
    const asked = rules([], [`mcp__${SERVER}__search`]);
    expect(gate(invoke('search'), { ...asked, companyAction: action('search', { readOnly: true }) })).toMatchObject({ decision: 'needs_human' });
  });

  it('a call that is no company action (the box resolves none) keeps today’s verdict', () => {
    // Without the field the same mcp_invoke runs, as it did before the ruling; with it, it asks.
    expect(gate(CANCEL)).toEqual({ decision: 'allow' });
    expect(gate(CANCEL, { companyAction: action('cancel') })).toMatchObject({ decision: 'needs_human' });
    expect(gate({ toolName: 'Read', toolInput: { file_path: `${WS}/a.txt` }, toolCallId: 't' })).toEqual({ decision: 'allow' });
  });
});

describe('companyToolOf and companyActionAsks', () => {
  it("reads an mcp_invoke on a company server, and a direct mcp__<server>__<tool> call; nothing else", () => {
    expect(companyToolOf(CANCEL, [SERVER])).toEqual({ server: SERVER, tool: 'cancel' });
    expect(companyToolOf({ toolName: `mcp__${SERVER}__book`, toolInput: {}, toolCallId: 't' }, ['crm', SERVER])).toEqual({ server: SERVER, tool: 'book' });
    expect(companyToolOf(CANCEL, ['crm'])).toBeNull();
    expect(companyToolOf({ toolName: 'mcp__composio__GMAIL_SEND_EMAIL', toolInput: {}, toolCallId: 't' }, [SERVER])).toBeNull();
    expect(companyToolOf({ toolName: `mcp__${SERVER}__`, toolInput: {}, toolCallId: 't' }, [SERVER])).toBeNull();
  });

  it('asks only for a company action that is neither read-only nor let run without asking', () => {
    expect(companyActionAsks(undefined)).toBe(false);
    expect(companyActionAsks(action('cancel'))).toBe(true);
    expect(companyActionAsks(action('search', { readOnly: true }))).toBe(false);
    expect(companyActionAsks(action('pnr_status', { runsWithoutAsking: true }))).toBe(false);
  });
});

// Ruling of 3 Oct: a company's function tool (its own code answers it, `tools:` in vestra.yaml) is a company action by
// the same rule, with its own read_only and run_without_asking marks as the two flags (objective drill F1: extend_rental
// charged on a typed chat "yes", with no approval to settle).
describe('a company function tool at the gate', () => {
  const EXTEND: ToolCall = { toolName: 'extend_rental', toolInput: { rental_id: 'R-1042' }, toolCallId: 't' };
  const fn = (over: Partial<CompanyAction> = {}): CompanyAction => ({ tool: 'extend_rental', readOnly: false, runsWithoutAsking: false, ...over });
  // The box registers it as a client tool too (L16 D5), which skips the access level's asks: never this one.
  const registered = { clientToolNames: new Set(['extend_rental']) };

  it('asks before an unmarked function, in every mode but dontAsk and plan, at every access level, past an allow rule', () => {
    for (const mode of ['bypassPermissions', 'default', 'acceptEdits'] as PermissionMode[]) {
      expect(gate(EXTEND, { ...registered, mode, companyAction: fn() }), mode).toMatchObject({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
    for (const accessLevel of ACCESS_LEVELS) {
      expect(gate(EXTEND, { ...registered, accessLevel, companyAction: fn() }), accessLevel).toMatchObject({ decision: 'needs_human' });
    }
    expect(gate(EXTEND, { ...registered, ...rules(['extend_rental']), companyAction: fn() })).toMatchObject({ decision: 'needs_human' });
    expect(gate(EXTEND, { ...registered, mode: 'dontAsk', companyAction: fn() })).toMatchObject({ decision: 'deny', reasonType: 'mode' });
  });

  it('runs a function marked read_only, and one marked run_without_asking, straight away', () => {
    expect(gate(EXTEND, { ...registered, companyAction: fn({ readOnly: true }) })).toEqual({ decision: 'allow' });
    expect(gate(EXTEND, { ...registered, companyAction: fn({ runsWithoutAsking: true }) })).toEqual({ decision: 'allow' });
  });

  it('without the resolved action, the same call runs at once, as it did before the ruling (the drill)', () => {
    expect(gate(EXTEND, registered)).toEqual({ decision: 'allow' });
  });
});
