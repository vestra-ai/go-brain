// packages/agent-sdk/src/policy/__tests__/decide-tool-gate.inner-tool-rules.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, parseToolSpecifier } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';

// mcp_invoke({ server, tool, args }) runs another tool by name, and Composio's
// MULTI_EXECUTE runs every tool in its tools[] payload. A server-pushed deny or ask
// rule written for such a tool in the tool-specifier spelling (mcp__<server>__<tool>:
// a company's deny and approval rules, L8's app-tool rules, the permission_rules
// table) must see the call, or a deny never bites and an approval never asks. The
// product passes those rules as ctx.innerViewRules (ruling, 28 Sep); allow
// rules never see inner tools.

const invoke = (server: unknown, tool: unknown, args: unknown = {}): ToolCall =>
  ({ toolName: 'mcp_invoke', toolInput: { server, tool, args }, toolCallId: 't' });
const rules = (r: { allow?: string[]; ask?: string[]; deny?: string[] }) => ({
  allow: (r.allow ?? []).map(parseToolSpecifier),
  ask: (r.ask ?? []).map(parseToolSpecifier),
  deny: (r.deny ?? []).map(parseToolSpecifier),
});
// The rules under test ride both ways the product sends a server-pushed rule: in the
// merged permissionRules and as innerViewRules.
const gate = (call: ToolCall, extra: Partial<ToolGateContext> = {}) => {
  const permissionRules = extra.permissionRules ?? rules({});
  return decideToolGate(call, {
    mode: 'bypassPermissions', cwd: '/app/workspace', ...extra,
    permissionRules, innerViewRules: { ask: permissionRules.ask, deny: permissionRules.deny },
  });
};

describe('rules see the tool mcp_invoke runs', () => {
  it('asks for the tool an ask rule names, and only that tool', () => {
    const permissionRules = rules({ ask: ['mcp__ixigo__book'] });
    expect(gate(invoke('ixigo', 'book'), { permissionRules })).toMatchObject({ decision: 'needs_human' });
    expect(gate(invoke('ixigo', 'search'), { permissionRules })).toMatchObject({ decision: 'allow' });
    expect(gate(invoke('other', 'book'), { permissionRules })).toMatchObject({ decision: 'allow' });
  });

  it('denies through a deny rule, globs included', () => {
    expect(gate(invoke('github', 'delete_repo'), { permissionRules: rules({ deny: ['mcp__github__delete_*'] }) })).toMatchObject({ decision: 'deny' });
  });

  it('still matches a rule written for mcp_invoke itself', () => {
    expect(gate(invoke('ixigo', 'search'), { permissionRules: rules({ ask: ['mcp_invoke'] }) })).toMatchObject({ decision: 'needs_human' });
  });

  it('turns the ask into a deny under dontAsk, as for any ask rule', () => {
    expect(gate(invoke('ixigo', 'book'), { mode: 'dontAsk', permissionRules: rules({ ask: ['mcp__ixigo__book'] }) })).toMatchObject({ decision: 'deny' });
  });

  it('gives a malformed payload no inner view', () => {
    const permissionRules = rules({ ask: ['mcp__ixigo__book'] });
    expect(gate(invoke(undefined, 'book'), { permissionRules })).toMatchObject({ decision: 'allow' });
    expect(gate(invoke('ixigo', ''), { permissionRules })).toMatchObject({ decision: 'allow' });
    expect(gate({ toolName: 'mcp_invoke', toolInput: 'x', toolCallId: 't' }, { permissionRules })).toMatchObject({ decision: 'allow' });
  });

  it('leaves every other tool matched as itself', () => {
    expect(gate({ toolName: 'mcp__ixigo__book', toolInput: {}, toolCallId: 't' }, { permissionRules: rules({ ask: ['mcp__ixigo__book'] }) })).toMatchObject({ decision: 'needs_human' });
  });
});

const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const multi = (...slugs: string[]): ToolCall =>
  ({ toolName: META, toolInput: { tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) }, toolCallId: 't' });

describe('rules see every tool a Composio MULTI_EXECUTE runs', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  it('asks for a Gmail send inside MULTI_EXECUTE that an ask rule names', () => {
    const permissionRules = rules({ ask: ['mcp__composio__GMAIL_SEND*'] });
    expect(gate(multi('GMAIL_SEND_EMAIL'))).toMatchObject({ decision: 'allow' });
    expect(gate(multi('GMAIL_SEND_EMAIL'), { permissionRules })).toMatchObject({ decision: 'needs_human' });
  });

  it('asks when any one inner tool asks', () => {
    expect(gate(multi('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'), { permissionRules: rules({ ask: ['mcp__composio__GMAIL_SEND*'] }) }))
      .toMatchObject({ decision: 'needs_human' });
  });

  it('denies the whole call when one inner tool is denied, over an ask on another', () => {
    const permissionRules = rules({ ask: ['mcp__composio__GMAIL_SEND*'], deny: ['mcp__composio__SLACK_SEND_MESSAGE'] });
    expect(gate(multi('GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'), { permissionRules })).toMatchObject({ decision: 'deny' });
  });

  it('never lets an allow rule on an inner tool silence the call (allow rules never see inner tools)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const permissionRules = rules({ allow: ['mcp__composio__GMAIL_SEND*'] });
    expect(gate(multi('GMAIL_SEND_EMAIL'), { accessLevel: 'balanced', permissionRules })).toMatchObject({ decision: 'needs_human' });
  });

  it('still matches a rule written for the wrapper itself', () => {
    expect(gate(multi('GMAIL_FETCH_EMAILS'), { permissionRules: rules({ ask: [META] }) })).toMatchObject({ decision: 'needs_human' });
  });
});
