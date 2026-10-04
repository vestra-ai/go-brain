import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideToolGate,
  allowRuleCanSilence,
  compileAccessConfig,
  describePermissionAsk,
  remoteCodePinOf,
  extractInnerComposioTools,
} from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessConfig } from '../access-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// PER-APP PINS HOLD THROUGH COMPOSIO'S META-TOOLS (staging RCA, 2026-10-03, item 2).
//
// An owner pins Slack or Gmail to block or ask. A task that reached the app
// through COMPOSIO_REMOTE_WORKBENCH was read as toolkit 'composio', so no Slack
// or Gmail pin was consulted: `run_composio_tool("SLACK_SEND_MESSAGE", …)` in a
// workbench script did exactly what the owner forbade. MULTI_EXECUTE already held
// each item to its own app; the pins below pin that too, as regressions.
//
// The workbench rule (remote-code-pins.ts): any app block pin refuses a call that
// runs code in Composio's remote sandbox; otherwise any app ask pin hard-asks it;
// no block or ask pin leaves it unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const WS = '/app/workspace';
const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const WB = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';
const REMOTE_BASH = 'mcp__composio__COMPOSIO_REMOTE_BASH_TOOL';
const REMOTE_CODE = [
  WB,
  'mcp__composio__COMPOSIO_WORKSPACE_EXECUTE',
  'mcp__composio__COMPOSIO_WORKSPACE_CREATE',
  REMOTE_BASH,
];

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const multiExecute = (...slugs: string[]): ToolCall =>
  tool(META, { tools: slugs.map((s) => ({ tool_slug: s, arguments: {} })) });
const workbench = (code: string, extra: Record<string, unknown> = {}): ToolCall =>
  tool(WB, { code_to_execute: code, ...extra });

const SLACK_SEND_IN_CODE = 'run_composio_tool("SLACK_SEND_MESSAGE", {"channel": "D0C6QCFME80", "text": "hi"})';
/** A Slack send the code scan cannot see: the helper's name is built at run time. */
const HIDDEN_SLACK_SEND = 'f = globals()["run_" + "composio_tool"]\nf("SLACK_SEND_MESSAGE", {"channel": "C1", "text": "hi"})';
const PURE_COMPUTE = 'import json\nprint(json.dumps({"n": 1}))';

const SLACK_BLOCK: AccessConfig = { level: 'custom', apps: { slack: { external_send: 'block' } } };
const GMAIL_ASK: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' } } };

const allowRule = (toolName: string) => ({ allow: [{ toolName }], ask: [], deny: [] });

/** The production default mode, an allow rule on the wrapper itself: nothing permissive is missing. */
function gate(call: ToolCall, cfg: AccessConfig | undefined, extra: Partial<ToolGateContext> = {}) {
  return decideToolGate(call, {
    mode: 'bypassPermissions',
    cwd: WS,
    connectedComposioToolkits: new Set(['gmail', 'slack', 'notion', 'github', 'composio']),
    permissionRules: allowRule(call.toolName),
    ...(cfg ? { accessConfig: compileAccessConfig(cfg) } : {}),
    ...extra,
  });
}

const HARD_ASK = { decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true };
const SLACK_SEND_BLOCKED = 'Blocked by your settings: sending on Slack.';
const WORKBENCH_REFUSED =
  "Blocked by your settings: sending on Slack. Code in the remote workbench can reach every app, so it does not run " +
  "while one is blocked. Use the app's own tools, and run code in this workspace.";

beforeEach(() => { process.env.ACCESS_LEVELS_V1 = '1'; });
afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

describe('MULTI_EXECUTE: each item answers to its own app', () => {
  it('a Slack block pin refuses SLACK_SEND_MESSAGE inside a batch', () => {
    expect(gate(multiExecute('SLACK_SEND_MESSAGE'), SLACK_BLOCK)).toEqual({
      decision: 'deny', message: SLACK_SEND_BLOCKED, reasonType: 'rule',
    });
  });

  it('a Gmail ask pin asks for GMAIL_SEND_EMAIL inside a batch, past bypass and an allow rule', () => {
    expect(gate(multiExecute('GMAIL_SEND_EMAIL'), GMAIL_ASK)).toEqual(HARD_ASK);
  });

  it('unrelated toolkits in a batch are unaffected by another app\'s pins', () => {
    expect(gate(multiExecute('NOTION_UPDATE_PAGE', 'GMAIL_SEND_EMAIL'), SLACK_BLOCK)).toEqual({ decision: 'allow' });
    expect(gate(multiExecute('NOTION_UPDATE_PAGE', 'SLACK_FETCH_CONVERSATION_HISTORY'), GMAIL_ASK)).toEqual({ decision: 'allow' });
    // A Slack READ is a different cell from the pinned Slack send.
    expect(gate(multiExecute('SLACK_FETCH_CONVERSATION_HISTORY'), SLACK_BLOCK)).toEqual({ decision: 'allow' });
  });

  it('one pinned item governs the batch, and the strictest verdict wins', () => {
    expect(gate(multiExecute('NOTION_UPDATE_PAGE', 'SLACK_SEND_MESSAGE'), SLACK_BLOCK)).toEqual({
      decision: 'deny', message: SLACK_SEND_BLOCKED, reasonType: 'rule',
    });
    expect(gate(multiExecute('NOTION_UPDATE_PAGE', 'GMAIL_SEND_EMAIL'), GMAIL_ASK)).toEqual(HARD_ASK);
    const both: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' }, slack: { external_send: 'block' } } };
    expect(gate(multiExecute('GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'), both).decision).toBe('deny');
  });

  it('a workbench named inside a batch answers to every pin, like a direct one', () => {
    const nested = tool(META, { tools: [{ tool_slug: 'COMPOSIO_REMOTE_WORKBENCH', arguments: { code_to_execute: SLACK_SEND_IN_CODE } }] });
    expect(gate(nested, SLACK_BLOCK)).toEqual({ decision: 'deny', message: WORKBENCH_REFUSED, reasonType: 'rule' });
    expect(gate(nested, GMAIL_ASK)).toEqual(HARD_ASK);
  });
});

describe('the remote workbench: every app pin holds against code that can reach any app', () => {
  it('INCIDENT SHAPE: a Slack block pin refuses a workbench Slack send', () => {
    expect(gate(workbench(SLACK_SEND_IN_CODE), SLACK_BLOCK)).toEqual({
      decision: 'deny', message: WORKBENCH_REFUSED, reasonType: 'rule',
    });
  });

  it('the refusal does not depend on reading the script: a hidden send and pure compute are refused too', () => {
    for (const code of [HIDDEN_SLACK_SEND, PURE_COMPUTE]) {
      expect(gate(workbench(code), SLACK_BLOCK), code).toEqual({
        decision: 'deny', message: WORKBENCH_REFUSED, reasonType: 'rule',
      });
    }
  });

  it('every door into the remote sandbox is held the same way (the workbench trio and the remote shell)', () => {
    for (const name of REMOTE_CODE) {
      const call = name === REMOTE_BASH ? tool(name, { command: 'python3 send.py' }) : tool(name, { code: PURE_COMPUTE });
      expect(gate(call, SLACK_BLOCK).decision, name).toBe('deny');
      expect(gate(call, GMAIL_ASK), name).toEqual(HARD_ASK);
    }
  });

  it('a Gmail ask pin hard-asks any workbench call, past bypass and an allow rule on the workbench', () => {
    for (const code of ['run_composio_tool("GMAIL_SEND_EMAIL", {})', HIDDEN_SLACK_SEND, PURE_COMPUTE]) {
      expect(gate(workbench(code), GMAIL_ASK), code).toEqual(HARD_ASK);
    }
  });

  it('a block anywhere beats an ask elsewhere: the call is refused, never asked', () => {
    const both: AccessConfig = { level: 'custom', apps: { gmail: { external_send: 'ask' }, slack: { external_send: 'block' } } };
    expect(gate(workbench(PURE_COMPUTE), both)).toEqual({ decision: 'deny', message: WORKBENCH_REFUSED, reasonType: 'rule' });
  });

  it('the block copy names the pinned cell', () => {
    const notion: AccessConfig = { level: 'custom', apps: { notion: { external_mutation: 'block' } } };
    const r = gate(workbench(PURE_COMPUTE), notion);
    expect(r.decision === 'deny' ? r.message : '').toMatch(/^Blocked by your settings: changes on Notion\. Code in the remote workbench/);
  });

  it('dontAsk turns the pin\'s ask into a deny, as it does for every hard ask', () => {
    expect(gate(workbench(PURE_COMPUTE), GMAIL_ASK, { mode: 'dontAsk' })).toEqual({
      decision: 'deny', message: 'Denied: this task is set to never ask for permission.', reasonType: 'mode',
    });
  });

  it('no Always-allow is offered: an allow rule can never silence the pin\'s ask', () => {
    const base = { permissionRules: { allow: [], ask: [], deny: [] }, cwd: WS, shellCwd: WS };
    expect(allowRuleCanSilence(workbench(PURE_COMPUTE), { ...base, accessConfig: compileAccessConfig(GMAIL_ASK) })).toBe(false);
    expect(allowRuleCanSilence(workbench(PURE_COMPUTE), { ...base, accessConfig: compileAccessConfig({ level: 'custom' }) })).toBe(true);
  });

  it('a tools[] list beside workbench code is a decoy the gate never reads', () => {
    const decoy = workbench('run_composio_tool("GMAIL_SEND_EMAIL", {})', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] });
    expect(extractInnerComposioTools(decoy)).toBeNull();
    // Sends ask (no pins at all): the decoy read made this a silent read before.
    const sendsAsk: AccessConfig = { level: 'custom', families: { external_send: 'ask' } };
    expect(gate(decoy, sendsAsk, { permissionRules: { allow: [], ask: [], deny: [] } })).toEqual({
      decision: 'needs_human', interactionKind: 'tool_permission',
    });
    expect(gate(decoy, SLACK_BLOCK).decision).toBe('deny');
  });
});

describe('no block or ask pin: the workbench is unchanged', () => {
  const calls = [workbench(SLACK_SEND_IN_CODE), workbench(PURE_COMPUTE), tool(REMOTE_BASH, { command: 'ls' })];

  it('a custom config with no app pins runs them as before', () => {
    for (const call of calls) expect(gate(call, { level: 'custom' }), JSON.stringify(call.toolInput)).toEqual({ decision: 'allow' });
  });

  it('allow pins only loosen, so they never count', () => {
    const allowOnly: AccessConfig = { level: 'custom', apps: { slack: { external_send: 'allow' }, gmail: { external_mutation: 'allow' } } };
    for (const call of calls) expect(gate(call, allowOnly)).toEqual({ decision: 'allow' });
  });

  it('a preset level (no config) runs them as before', () => {
    for (const call of calls) expect(gate(call, undefined, { accessLevel: 'relaxed' })).toEqual({ decision: 'allow' });
  });

  it('flag off: the config is inert', () => {
    delete process.env.ACCESS_LEVELS_V1;
    expect(gate(workbench(SLACK_SEND_IN_CODE), SLACK_BLOCK)).toEqual({ decision: 'allow' });
  });

  it('every other Composio tool is outside the rule', () => {
    const cfg = compileAccessConfig(SLACK_BLOCK);
    for (const name of [META, 'mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__NOTION_UPDATE_PAGE', 'Bash']) {
      expect(remoteCodePinOf(cfg, name), name).toBeNull();
    }
  });
});

describe('remoteCodePinOf', () => {
  it('a block anywhere wins over an earlier ask; with no block, the first ask', () => {
    const cfg = compileAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'ask' }, slack: { external_mutation: 'block' } } });
    expect(remoteCodePinOf(cfg, WB)).toEqual({ toolkit: 'slack', family: 'external_mutation', action: 'block' });
    expect(remoteCodePinOf(compileAccessConfig(GMAIL_ASK), WB)).toEqual({ toolkit: 'gmail', family: 'external_send', action: 'ask' });
    expect(remoteCodePinOf(compileAccessConfig({ level: 'custom' }), WB)).toBeNull();
  });
});

describe('the ask card names the workbench', () => {
  it('a pinned workbench ask reads as running code in the remote workbench', () => {
    const ask = describePermissionAsk(workbench(SLACK_SEND_IN_CODE), { family: 'external_send', floor: 'rule', remoteCode: true });
    expect(ask).toEqual({
      headline: 'Run code in the remote workbench',
      details: [],
      actionLabel: 'Allow once',
      reasonLine: 'Code there can reach any of your apps, and you asked me to check before some of them act.',
    });
  });

  it('an always-ask family keeps its own, truer card', () => {
    const ask = describePermissionAsk(workbench('proxy_execute("STRIPE_CREATE_CHARGE", {})'), { family: 'payment', floor: 'hard', remoteCode: true });
    expect(ask.headline).toBe('Approve a payment');
  });

  it('without the flag the card is the family card, as before', () => {
    const ask = describePermissionAsk(workbench(SLACK_SEND_IN_CODE), { family: 'external_send', floor: 'rule' });
    expect(ask.headline).toBe('Send a message');
  });
});
