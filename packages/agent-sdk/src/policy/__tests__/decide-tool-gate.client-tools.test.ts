import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decideToolGate, compileAccessConfig } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { PermissionMode } from '../../contract/permission.js';
import { ACCESS_LEVELS } from '../access-level.js';
import { classifySideEffect } from '../side-effect-classifier.js';

// Platform API v1 (L16 D5). A company's client tool is the company's own code, run in its own
// system; the company's approvals and its deny/ask rules are the controls that apply to it. So
// the access level (and a custom access config) never asks about it, while deny and ask rules
// still do, and no other tool moves. The classifier stays honest: it is still workspace_write.

const WS = '/app/workspace';
const CLIENT = 'lookup_pnr';
const CONNECTED = new Set(['gmail', 'stripe', 'notion']);
const MODES: PermissionMode[] = ['bypassPermissions', 'default', 'acceptEdits', 'dontAsk', 'plan'];

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const client = tool(CLIENT, { pnr: 'ABC123' });

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  const ctx: ToolGateContext = {
    mode: 'bypassPermissions',
    cwd: WS,
    connectedComposioToolkits: CONNECTED,
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  };
  return decideToolGate(call, ctx);
}

const company = (extra: Partial<ToolGateContext> = {}): Partial<ToolGateContext> => ({ clientToolNames: new Set([CLIENT]), ...extra });

beforeEach(() => { process.env.ACCESS_LEVELS_V1 = '1'; });
afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

describe('a company client tool at the gate (L16 D5)', () => {
  it('runs with no ask at every access level, in the production mode and in default', () => {
    for (const accessLevel of ACCESS_LEVELS) {
      for (const mode of ['bypassPermissions', 'default'] as const) {
        expect(gate(client, company({ accessLevel, mode })), `${accessLevel}/${mode}`).toEqual({ decision: 'allow' });
      }
    }
  });

  it('a custom access config that asks about writes, sends and changes does not ask about it either', () => {
    const accessConfig = compileAccessConfig({
      level: 'custom',
      families: { workspace_write: 'ask', external_send: 'ask', external_mutation: 'ask' },
    });
    expect(gate(client, company({ accessConfig }))).toEqual({ decision: 'allow' });
  });

  it('nor does a custom access config that asks about reads and allows writes', () => {
    const accessConfig = compileAccessConfig({ level: 'custom', families: { readonly: 'ask', workspace_write: 'allow' } });
    for (const mode of ['bypassPermissions', 'default'] as const) {
      expect(gate(client, company({ accessConfig, mode })), mode).toEqual({ decision: 'allow' });
    }
  });

  it('the classifier stays honest: a client tool is still workspace_write to it', () => {
    expect(classifySideEffect(client, { workspaceRoot: WS })).toBe('workspace_write');
  });

  it('a company ask rule still asks, and a deny rule still denies, at every level', () => {
    for (const accessLevel of ACCESS_LEVELS) {
      const ask = { allow: [], ask: [{ toolName: CLIENT }], deny: [] };
      const deny = { allow: [], ask: [], deny: [{ toolName: CLIENT }] };
      expect(gate(client, company({ accessLevel, permissionRules: ask }))).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
      expect(gate(client, company({ accessLevel, permissionRules: deny }))).toMatchObject({ decision: 'deny', reasonType: 'rule' });
    }
  });

  it('dontAsk still turns a company ask rule into a deny', () => {
    const ask = { allow: [], ask: [{ toolName: CLIENT }], deny: [] };
    expect(gate(client, company({ accessLevel: 'careful', mode: 'dontAsk', permissionRules: ask }))).toMatchObject({ decision: 'deny', reasonType: 'mode' });
  });

  it('without the set (a person, or a task with no platform context) the same name asks at Careful exactly as before', () => {
    expect(gate(client, { accessLevel: 'careful' })).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
    expect(gate(client, { accessLevel: 'careful', clientToolNames: new Set(['cancel_booking']) })).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('plan mode is untouched: the write taxonomy judges the client tool, as before', () => {
    expect(gate(client, company({ accessLevel: 'careful', mode: 'plan' }))).toEqual(gate(client, { accessLevel: 'careful', mode: 'plan' }));
  });
});

describe('every other tool decides byte-identically with a client-tool set present (L16 D5)', () => {
  // The set holds only names the task's catalog registered as client tools (platform-tools.ts
  // skips any name Bash already uses), so every other tool is absent from it and must not move.
  const others: ToolCall[] = [
    tool('Bash', { command: 'ls' }),
    tool('Bash', { command: 'rm -rf data' }),
    tool('Bash', { command: 'echo hi > out.txt' }),
    tool('Write', { file_path: `${WS}/a.txt`, content: 'x' }),
    tool('Edit', { file_path: `${WS}/a.txt` }),
    tool('Patch', { input: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch' }),
    tool('Read', { file_path: 'a.txt' }),
    tool('WebFetch', { url: 'https://x.com' }),
    tool('web_search', { query: 'x' }),
    tool('AskUserQuestion', { questions: [] }),
    tool('mcp__server__send_msg'),
    tool('mcp__server__delete_item'),
    tool('mcp__server__get_list'),
    tool('mcp__composio__GMAIL_SEND_EMAIL'),
    tool('mcp__composio__STRIPE_CREATE_CHARGE'),
    tool('mcp__composio__NOTION_UPDATE_PAGE'),
    tool('remember', { fact: 'x' }),
    tool('execute_code', { code: '1' }),
    tool('submit_result', { result: {} }),
  ];
  const set = new Set([CLIENT, 'cancel_booking', 'issue_refund']);

  it('across every level, mode and custom configs', () => {
    const configs = [
      undefined,
      compileAccessConfig({ level: 'custom', families: { workspace_write: 'ask', external_send: 'allow' } }),
      compileAccessConfig({ level: 'custom', families: { readonly: 'ask', workspace_write: 'allow' } }),
    ];
    for (const call of others) {
      for (const mode of MODES) {
        for (const accessLevel of [undefined, ...ACCESS_LEVELS]) {
          for (const accessConfig of configs) {
            const base: Partial<ToolGateContext> = { mode };
            if (accessLevel !== undefined) base.accessLevel = accessLevel;
            if (accessConfig !== undefined) base.accessConfig = accessConfig;
            expect(gate(call, { ...base, clientToolNames: set }), `${call.toolName} ${mode} ${accessLevel} cfg=${accessConfig !== undefined}`)
              .toEqual(gate(call, base));
          }
        }
      }
    }
  });
});
