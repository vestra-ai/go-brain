// B6 (harness to nine, MCP_INVOKE_RESOLVED_GATE_V1): an mcp_invoke call is judged as the MCP
// tool it runs. Before, the wrapper's name fell to the classifier's builtin default
// (workspace_write), so the access level never asked about an MCP delete or payment and the
// injection screen (which screens only outward families) never screened an MCP send a page
// asked for. Revert-proof: with the classifier branch removed, every "flag on" case below
// reads workspace_write and goes red.
import { describe, it, expect, afterEach } from 'vitest';
import { classifySideEffect, decideToolGate, isSideEffectingFamily, mcpInvokeTarget, parseToolSpecifier } from '../../index.js';
import type { McpToolHints, SideEffectFamily } from '../side-effect-classifier.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessLevel } from '../access-level.js';

const WS = '/app/workspace';
const invoke = (server: unknown, tool: unknown, args: unknown = {}): ToolCall =>
  ({ toolName: 'mcp_invoke', toolInput: { server, tool, args }, toolCallId: 't' });
const family = (call: ToolCall, mcpToolHints?: McpToolHints): SideEffectFamily =>
  classifySideEffect(call, { workspaceRoot: WS, ...(mcpToolHints && { mcpToolHints }) });
const hints = (name: string, hint: { readOnly?: boolean; destructive?: boolean }): McpToolHints => new Map([[name, hint]]);

const on = () => { process.env.MCP_INVOKE_RESOLVED_GATE_V1 = 'true'; };
afterEach(() => {
  delete process.env.MCP_INVOKE_RESOLVED_GATE_V1;
  delete process.env.ACCESS_LEVELS_V1;
});

describe('mcpInvokeTarget: the one reading of an mcp_invoke call', () => {
  it('names the server, the tool and the inner view the rules see', () => {
    expect(mcpInvokeTarget(invoke('github', 'delete_repo', { repo: 'a/b' }))).toEqual({
      server: 'github', tool: 'delete_repo',
      view: { toolName: 'mcp__github__delete_repo', toolInput: { repo: 'a/b' }, toolCallId: 't' },
    });
  });

  it('is null for any other tool, or a call that names no server or tool', () => {
    expect(mcpInvokeTarget({ toolName: 'mcp__github__delete_repo', toolInput: {}, toolCallId: 't' })).toBeNull();
    expect(mcpInvokeTarget(invoke('', 'x'))).toBeNull();
    expect(mcpInvokeTarget(invoke('github', 7))).toBeNull();
    expect(mcpInvokeTarget({ toolName: 'mcp_invoke', toolInput: 'x', toolCallId: 't' })).toBeNull();
  });
});

describe('classifySideEffect(mcp_invoke)', () => {
  it('flag off: the wrapper stays a workspace write, whatever it runs (byte-identical)', () => {
    for (const t of ['send_message', 'delete_repo', 'create_charge', 'search']) {
      expect(family(invoke('srv', t), hints(`mcp__srv__${t}`, { readOnly: true }))).toBe('workspace_write');
    }
  });

  it.each([
    ['send_message', 'external_send'],
    ['delete_repo', 'dangerous_delete'],
    ['create_charge', 'payment'],
    ['create_issue', 'external_mutation'],
    ['search_issues', 'readonly'],
    // kebab, camel and dotted names read as their words, not as one unknown word
    ['notion-search', 'readonly'],
    ['deleteRepo', 'dangerous_delete'],
    ['slack.postMessage', 'external_send'],
  ] as const)('flag on, name rule: %s → %s', (tool, expected) => {
    on();
    expect(family(invoke('srv', tool))).toBe(expected);
  });

  it('flag on: a call that names no server or tool runs nothing, so it keeps the wrapper family', () => {
    on();
    expect(family(invoke(undefined, 'send_message'))).toBe('workspace_write');
    expect(family(invoke('srv', ''))).toBe('workspace_write');
  });

  it('flag on: a read-only declaration that reaches the classifier makes it a read (the registry passes one only from a first-party server)', () => {
    on();
    expect(family(invoke('fal', 'run_query'), hints('mcp__fal__run_query', { readOnly: true }))).toBe('readonly');
    expect(family(invoke('fal', 'run_query'), hints('mcp__fal__run_query', { readOnly: true, destructive: false }))).toBe('readonly');
  });

  it('flag on: no word list decides belief; payment and a destructive declaration still come first', () => {
    on();
    // the old ACTING_VERBS clause is gone: a trusted read-only claim is believed whatever the name says
    expect(family(invoke('fal', 'notify_team'), hints('mcp__fal__notify_team', { readOnly: true }))).toBe('readonly');
    expect(family(invoke('m', 'refund_charge'), hints('mcp__m__refund_charge', { readOnly: true }))).toBe('payment');
    // read-only AND destructive (an opaque executor): can destroy beats can read
    expect(family(invoke('m', 'run_query'), hints('mcp__m__run_query', { readOnly: true, destructive: true }))).toBe('dangerous_delete');
  });

  it('flag on: with no believable read-only claim a third-party tool falls to the name rule', () => {
    on();
    // what the registry hands over for a third party that declared readOnlyHint: nothing
    expect(family(invoke('slack', 'notify_team'))).toBe('external_mutation');
    expect(isSideEffectingFamily(family(invoke('slack', 'notify_team')))).toBe(true);
  });

  it('flag on: a declared readOnly:false beats a read verb in the name', () => {
    on();
    expect(family(invoke('crm', 'search_and_update'), hints('mcp__crm__search_and_update', { readOnly: false }))).toBe('external_mutation');
    expect(family(invoke('mail', 'get_and_archive'), hints('mcp__mail__get_and_archive', { readOnly: false }))).toBe('external_mutation');
    expect(family(invoke('crm', 'search_and_update'))).toBe('readonly'); // no declaration: the name rule, as before
    expect(family(invoke('crm', 'send_digest'), hints('mcp__crm__send_digest', { readOnly: false }))).toBe('external_send');
  });

  it('flag on: a destructive declaration only ever tightens', () => {
    on();
    expect(family(invoke('n', 'update_page'), hints('mcp__n__update_page', { destructive: true }))).toBe('dangerous_delete');
    expect(family(invoke('n', 'delete_page'), hints('mcp__n__delete_page', { destructive: false }))).toBe('dangerous_delete');
    expect(family(invoke('n', 'transfer_funds'), hints('mcp__n__transfer_funds', { destructive: true }))).toBe('payment');
  });

  it("flag on: a hint for another tool is never read (keyed by the inner view's name)", () => {
    on();
    expect(family(invoke('db', 'create_row'), hints('mcp__db__run_query', { readOnly: true }))).toBe('external_mutation');
  });

  it('flag on: the injection screen screens an MCP write and leaves an MCP read alone', () => {
    on();
    expect(isSideEffectingFamily(family(invoke('slack', 'send_message')))).toBe(true);
    expect(isSideEffectingFamily(family(invoke('notion', 'notion-create-pages')))).toBe(true);
    expect(isSideEffectingFamily(family(invoke('notion', 'notion-search')))).toBe(false);
    expect(isSideEffectingFamily(family(invoke('db', 'run_query'), hints('mcp__db__run_query', { readOnly: true })))).toBe(false);
  });
});

describe('decideToolGate sees the tool mcp_invoke runs (access levels on)', () => {
  const gate = (call: ToolCall, accessLevel: AccessLevel, extra: Partial<ToolGateContext> = {}) => {
    process.env.ACCESS_LEVELS_V1 = '1';
    return decideToolGate(call, {
      mode: 'bypassPermissions', cwd: WS, accessLevel,
      permissionRules: { allow: [], ask: [], deny: [] }, ...extra,
    });
  };

  it('an MCP delete hard-asks at Relaxed, past an allow rule; flag off it ran silently', () => {
    const call = invoke('github', 'delete_repo');
    const permissionRules = { allow: [parseToolSpecifier('mcp_invoke')], ask: [], deny: [] };
    expect(gate(call, 'relaxed', { permissionRules })).toEqual({ decision: 'allow' });
    on();
    expect(gate(call, 'relaxed', { permissionRules })).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    expect(gate(call, 'autopilot')).toEqual({ decision: 'allow' });
  });

  it('an MCP payment hard-asks at every level', () => {
    on();
    for (const level of ['careful', 'balanced', 'relaxed', 'autopilot'] as const) {
      expect(gate(invoke('stripe', 'create_charge'), level), level).toMatchObject({ decision: 'needs_human', unsilenceable: true });
    }
  });

  it('an MCP send asks at Balanced and runs at Relaxed (the Relaxed ruling holds)', () => {
    on();
    expect(gate(invoke('slack', 'send_message'), 'balanced')).toMatchObject({ decision: 'needs_human' });
    expect(gate(invoke('slack', 'send_message'), 'relaxed')).toEqual({ decision: 'allow' });
  });

  it('a read-only MCP tool runs at every level, Careful included', () => {
    on();
    const mcpToolHints = hints('mcp__db__run_query', { readOnly: true });
    for (const level of ['careful', 'balanced', 'relaxed', 'autopilot'] as const) {
      expect(gate(invoke('notion', 'notion-search'), level), level).toEqual({ decision: 'allow' });
      expect(gate(invoke('db', 'run_query'), level, { mcpToolHints }), level).toEqual({ decision: 'allow' });
    }
  });

  it("the server's declaration reaches the gate: declared destructive asks at Relaxed", () => {
    on();
    const call = invoke('notion', 'update_page');
    expect(gate(call, 'relaxed')).toEqual({ decision: 'allow' });
    expect(gate(call, 'relaxed', { mcpToolHints: hints('mcp__notion__update_page', { destructive: true }) }))
      .toMatchObject({ decision: 'needs_human', unsilenceable: true });
  });

  it('a deny rule on the MCP tool still denies (rules ride innerViewRules, unchanged)', () => {
    on();
    const deny = [parseToolSpecifier('mcp__github__delete_*')];
    expect(gate(invoke('github', 'delete_repo'), 'autopilot', { innerViewRules: { ask: [], deny } }))
      .toMatchObject({ decision: 'deny', reasonType: 'rule' });
  });
});
