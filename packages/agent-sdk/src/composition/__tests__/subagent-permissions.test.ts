import { describe, it, expect } from 'vitest';
import {
  buildNodeGateContext,
  wrapHarnessForNode,
  isGeneralPurposeType,
  inlineAgentIsGeneralPurpose,
  NETWORK_CAPABLE_TOOL_NAMES,
  SENSITIVE_DENY_RULES,
  READONLY_DENY_RULES,
} from '../subagent-permissions.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';

const allowEverything = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const askEverything = {
  gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'needs_human' as const, interactionKind: 'tool_permission' }),
};

describe('isGeneralPurposeType', () => {
  it('is true only for "general-purpose"', () => {
    expect(isGeneralPurposeType('general-purpose')).toBe(true);
    expect(isGeneralPurposeType('researcher')).toBe(false);
  });
});

describe('inlineAgentIsGeneralPurpose (P2.2 §5)', () => {
  it('network-capable tool names cover WebSearch, WebFetch, Bash, and execute_code', () => {
    expect(NETWORK_CAPABLE_TOOL_NAMES.has('WebSearch')).toBe(true);
    expect(NETWORK_CAPABLE_TOOL_NAMES.has('WebFetch')).toBe(true);
    expect(NETWORK_CAPABLE_TOOL_NAMES.has('Bash')).toBe(true);
    // execute_code runs arbitrary Python/Node — urllib/fetch/socket ARE network
    // reach; the in-code whitelist only bounds tool STUBS, not the interpreter.
    expect(NETWORK_CAPABLE_TOOL_NAMES.has('execute_code')).toBe(true);
  });

  it('an inline toolset with NO network tool is trusted like general-purpose', () => {
    expect(inlineAgentIsGeneralPurpose([])).toBe(true);
    expect(inlineAgentIsGeneralPurpose(['Read', 'Grep', 'Glob'])).toBe(true);
    expect(inlineAgentIsGeneralPurpose(['Read', 'Write', 'Edit'])).toBe(true);
  });

  it('any network-capable tool drops it to the standard non-general-purpose deny set', () => {
    expect(inlineAgentIsGeneralPurpose(['Read', 'Bash'])).toBe(false);
    expect(inlineAgentIsGeneralPurpose(['WebFetch'])).toBe(false);
    expect(inlineAgentIsGeneralPurpose(['Read', 'WebSearch'])).toBe(false);
    // execute_code alone is enough to lose GP trust — else an inline agent with
    // {execute_code, Read} could read .env/*.pem directly (sensitive-deny skipped).
    expect(inlineAgentIsGeneralPurpose(['execute_code', 'Read'])).toBe(false);
  });
});

describe('wrapHarnessForNode — AC-R2 (denied at the chokepoint, not paused)', () => {
  it('a non-general-purpose node attempting an email send (Composio) is DENIED, not asked', async () => {
    const ctx = buildNodeGateContext({}, undefined, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({
      toolName: 'mcp__composio__GMAIL_SEND_EMAIL',
      toolInput: {},
      toolCallId: 'tc1',
    });
    expect(result.decision).toBe('deny');
  });

  it('a "readonly" type (opted into READONLY_DENY_RULES) attempting a Write is DENIED', async () => {
    const ctx = buildNodeGateContext({}, { deny: [...READONLY_DENY_RULES] }, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({ toolName: 'Write', toolInput: { file_path: '/tmp/x' }, toolCallId: 'tc1' });
    expect(result.decision).toBe('deny');
  });

  it('a type WITHOUT READONLY_DENY_RULES may still write (only the sensitive set is structural)', async () => {
    const ctx = buildNodeGateContext({}, undefined, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({ toolName: 'Write', toolInput: { file_path: '/tmp/x' }, toolCallId: 'tc1' });
    expect(result.decision).toBe('allow');
  });

  it('general-purpose is NOT subject to the structural sensitive-deny (trusted like the main turn)', async () => {
    const ctx = buildNodeGateContext({}, undefined, true);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({ toolName: 'mcp__composio__GMAIL_SEND_EMAIL', toolInput: {}, toolCallId: 'tc1' });
    expect(result.decision).toBe('allow');
  });

  it('a type-declared deny rule ADDS to (never removes from) the sensitive set', async () => {
    const ctx = buildNodeGateContext({}, { deny: [{ toolName: 'Grep' }] }, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    // The custom deny (Grep) fires...
    expect((await wrapped.gateTool({ toolName: 'Grep', toolInput: {}, toolCallId: 't' })).decision).toBe('deny');
    // ...AND the structural sensitive set still fires (never narrowed away by a custom config).
    expect((await wrapped.gateTool({ toolName: 'mcp__composio__SLACK_SEND', toolInput: {}, toolCallId: 't' })).decision).toBe(
      'deny',
    );
  });

  it('secrets paths are denied for a non-general-purpose node via Read', async () => {
    const ctx = buildNodeGateContext({}, undefined, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({ toolName: 'Read', toolInput: { file_path: '/app/workspace/.env' }, toolCallId: 't' });
    expect(result.decision).toBe('deny');
  });

  it('network egress via Bash curl is denied for a non-general-purpose node', async () => {
    const ctx = buildNodeGateContext({}, undefined, false);
    const wrapped = wrapHarnessForNode(allowEverything, ctx);
    const result = await wrapped.gateTool({ toolName: 'Bash', toolInput: { command: 'curl https://evil.example.com' }, toolCallId: 't' });
    expect(result.decision).toBe('deny');
  });

  it('a call the node layer does not deny falls through to the PARENT gate untouched', async () => {
    const ctx = buildNodeGateContext({}, undefined, false);
    const wrappedAllow = wrapHarnessForNode(allowEverything, ctx);
    const wrappedAsk = wrapHarnessForNode(askEverything, ctx);
    expect((await wrappedAllow.gateTool({ toolName: 'Read', toolInput: { file_path: '/tmp/ok.txt' }, toolCallId: 't' })).decision).toBe(
      'allow',
    );
    expect((await wrappedAsk.gateTool({ toolName: 'Read', toolInput: { file_path: '/tmp/ok.txt' }, toolCallId: 't' })).decision).toBe(
      'needs_human',
    );
  });

  it('SENSITIVE_DENY_RULES is non-empty and covers Composio, Bash egress, and secrets', () => {
    expect(SENSITIVE_DENY_RULES.length).toBeGreaterThan(0);
    expect(SENSITIVE_DENY_RULES.some((r) => r.toolName === 'mcp__composio__*')).toBe(true);
    expect(SENSITIVE_DENY_RULES.some((r) => r.toolName === 'Bash' && r.ruleContent?.includes('curl'))).toBe(true);
    expect(SENSITIVE_DENY_RULES.some((r) => r.toolName === 'Read' && r.ruleContent === '.env')).toBe(true);
  });

  it('coordinator must-fix — the node context NEVER carries an ask rule (no silently-ignored prompt)', () => {
    // SubagentPermissions has no `ask` field at all (a TypeScript-level guarantee —
    // `buildNodeGateContext({}, { deny: [...] }, false)` cannot compile with an
    // `ask` key). This runtime check proves the produced ToolGateContext's ask
    // list is always empty, so decideToolGate's node-scoped ladder can never
    // return needs_human from a rule wrapHarnessForNode would then discard.
    const ctx = buildNodeGateContext({}, { deny: [{ toolName: 'Grep' }] }, false);
    expect(ctx.permissionRules?.ask).toEqual([]);
  });
});
