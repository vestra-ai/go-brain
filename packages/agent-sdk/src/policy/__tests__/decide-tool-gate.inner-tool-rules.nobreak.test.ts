// packages/agent-sdk/src/policy/__tests__/decide-tool-gate.inner-tool-rules.nobreak.test.ts
/**
 * NO-BREAK pin for L6 Task 10 ("MAKE SURE NOTHING FROM CURRENT PRODUCT BREAKS").
 * 1. innerViewRules absent = the pre-L6 gate.
 * 2. For every rule set the product writes today, inner views change no decision in any mode or level.
 * 3. Inner views never widen an allow rule.
 * 4. The shipped subagent floor decides exactly as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, parseToolSpecifier } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessLevel } from '../access-level.js';
import { buildNodeGateContext } from '../../composition/subagent-permissions.js';

const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const invoke = (server: string, tool: string): ToolCall => ({ toolName: 'mcp_invoke', toolInput: { server, tool, args: {} }, toolCallId: 't' });
const multi = (...slugs: string[]): ToolCall => ({ toolName: META, toolInput: { tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) }, toolCallId: 't' });
const rules = (r: { allow?: string[]; ask?: string[]; deny?: string[] }) => ({
  allow: (r.allow ?? []).map(parseToolSpecifier), ask: (r.ask ?? []).map(parseToolSpecifier), deny: (r.deny ?? []).map(parseToolSpecifier),
});
const inner = (set: ReturnType<typeof rules>) => ({ innerViewRules: { ask: set.ask, deny: set.deny } });

const CALLS = [invoke('github', 'delete_repo'), invoke('ixigo', 'book'), multi('GMAIL_SEND_EMAIL'), multi('GMAIL_FETCH_EMAILS', 'NOTION_UPDATE_PAGE'), multi('STRIPE_CREATE_CHARGE')];
// What the product writes today (tool-permission-suggestion.ts:35-46, the miner, the subagent floor): nothing names an inner tool.
const TODAY: Array<[string, ReturnType<typeof rules>]> = [
  ['none', rules({})],
  ['always-allow mcp_invoke', rules({ allow: ['mcp_invoke'] })],
  ['always-allow Bash + path', rules({ allow: ['Bash(git push:*)', 'Write(//app/workspace/a.md)'] })],
  ['ask on the wrappers', rules({ ask: [META, 'mcp_invoke'] })],
  ['deny every Composio tool', rules({ deny: ['mcp__composio__*'] })],
];
const MODES = ['default', 'bypassPermissions', 'acceptEdits', 'dontAsk', 'plan'] as const;
const LEVELS: Array<AccessLevel | undefined> = [undefined, 'careful', 'balanced', 'relaxed', 'autopilot'];
const ctxFor = (mode: (typeof MODES)[number], level: AccessLevel | undefined, permissionRules: ReturnType<typeof rules>): ToolGateContext => ({
  mode, cwd: '/app/workspace', connectedComposioToolkits: new Set(['github', 'gmail', 'notion', 'stripe']), permissionRules,
  ...(level ? { accessLevel: level } : {}),
});

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

describe('inner views change nothing for rule sets the product writes today', () => {
  for (const [name, set] of TODAY) {
    it(`same decision with and without inner views (${name})`, () => {
      process.env.ACCESS_LEVELS_V1 = '1';
      for (const mode of MODES) for (const level of LEVELS) for (const call of CALLS) {
        const ctx = ctxFor(mode, level, set);
        expect(decideToolGate(call, { ...ctx, ...inner(set) }), `${mode}/${level}/${call.toolName}`).toEqual(decideToolGate(call, ctx));
      }
    });
  }
});

describe('inner views are off unless passed', () => {
  it('an inner-naming rule matches nothing without innerViewRules (the pre-L6 gate)', () => {
    const ctx = ctxFor('bypassPermissions', undefined, rules({ ask: ['mcp__ixigo__book'], deny: ['mcp__composio__GMAIL_SEND_EMAIL'] }));
    expect(decideToolGate(invoke('ixigo', 'book'), ctx)).toMatchObject({ decision: 'allow' });
    expect(decideToolGate(multi('GMAIL_SEND_EMAIL'), ctx)).toMatchObject({ decision: 'allow' });
  });
});

describe('inner views never widen an allow rule', () => {
  it('a legacy direct-name grant does not silence a Balanced send ask inside MULTI_EXECUTE', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const set = rules({ allow: ['mcp__composio__GMAIL_SEND_EMAIL'] });
    const ctx = ctxFor('bypassPermissions', 'balanced', set);
    const today = decideToolGate(multi('GMAIL_SEND_EMAIL'), ctx);
    expect(today).toMatchObject({ decision: 'needs_human' });
    expect(decideToolGate(multi('GMAIL_SEND_EMAIL'), { ...ctx, ...inner(set) })).toEqual(today);
  });

  it('a bare mcp_invoke grant never silences a company ask', () => {
    const set = rules({ allow: ['mcp_invoke'], ask: ['mcp__ixigo__book'] });
    expect(decideToolGate(invoke('ixigo', 'book'), { ...ctxFor('default', undefined, set), ...inner(set) })).toMatchObject({ decision: 'needs_human' });
  });
});

describe('the shipped subagent floor is unchanged', () => {
  it('SENSITIVE_DENY_RULES decides every call exactly as before', () => {
    const node = buildNodeGateContext({ mode: 'bypassPermissions', cwd: '/app/workspace' }, undefined, false);
    for (const call of CALLS) {
      expect(decideToolGate(call, { ...node, innerViewRules: { ask: [], deny: node.permissionRules!.deny } })).toEqual(decideToolGate(call, node));
    }
  });
});
