/**
 * A task asked for in Slack never acts as its owner in Slack unasked, and never posts into its own
 * chat with Bash (staging 2026-10-03, task d6cd2177).
 *
 * Asked in his DM to "voice message me", a task at Relaxed uploaded the voice note AS HIM into that DM
 * through MULTI_EXECUTE, nothing asked, and Slack handed the post back to Bash as his own message. The
 * server now gives such a task its own config (slackBornConfig, access-config.ts): his level,
 * Slack's sends and changes pinned to a hard ask, and his chats with Bash named. These cases pin what
 * the gate does with it, on the incident's own payloads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, allowRuleCanSilence } from '../decide-tool-gate.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import { clampConfig, compileAccessConfig, parseAccessConfig, type AccessConfig } from '../access-config.js';
import { BASH_CHAT_DENY_MESSAGE } from '../bash-chats.js';

const WS = '/app/workspace';
const DM = 'D0C6QCFME80'; // his DM with Bash (the incident's)
const BOT = 'U0C5QN75TAR'; // Bash's own user in that workspace
const LAUNCH = 'C0LAUNCH01';
const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';
const WORKBENCH = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });
const multi = (tool_slug: string, args: Record<string, unknown>): ToolCall => tool(META, { tools: [{ tool_slug, arguments: args }] });
const workbench = (code: string): ToolCall => tool(WORKBENCH, { code_to_execute: code });

/** What the server writes for a task born in his Slack DM, at his own level. */
const SLACK_BORN: AccessConfig = {
  level: 'relaxed',
  apps: { slack: { external_send: 'ask', external_mutation: 'ask' } },
  bashChats: [DM, BOT],
};

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  process.env.ACCESS_LEVELS_V1 = '1';
  return decideToolGate(call, {
    // The sandbox's production default: bypassPermissions, the mode the incident ran under.
    mode: 'bypassPermissions',
    cwd: WS,
    connectedComposioToolkits: new Set(['slack', 'notion', 'gmail']),
    permissionRules: { allow: [], ask: [], deny: [] },
    accessConfig: compileAccessConfig(SLACK_BORN),
    ...extra,
  });
}

/** The incident's upload: SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK, as him, into a channel. */
const upload = (channels: string) => multi('SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK', { channels, initial_comment: 'Your voice reply', file: { s3key: 'k' } });

afterEach(() => {
  delete process.env.ACCESS_LEVELS_V1;
});

describe('a post as the owner into the chat Bash answers the task in is refused', () => {
  it('the incident upload into his DM with Bash is denied, with words the agent can act on', () => {
    expect(gate(upload(DM))).toEqual({ decision: 'deny', message: BASH_CHAT_DENY_MESSAGE, reasonType: 'own_chat' });
    expect(BASH_CHAT_DENY_MESSAGE).toBe('Not sent. Your result reaches this chat through Bash; save it as a file instead.');
  });

  it('whatever spells it: a direct send, a lowercased id, a list of channels, Bash as the recipient, any mode, an allow rule', () => {
    const allowAll = { allow: [{ toolName: META }, { toolName: 'mcp__composio__SLACK_SEND_MESSAGE' }], ask: [], deny: [] };
    const calls = [
      tool('mcp__composio__SLACK_SEND_MESSAGE', { channel: DM, text: 'hi' }),
      tool('mcp__composio__SLACK_SEND_MESSAGE', { channel: DM.toLowerCase(), text: 'hi' }),
      upload(`${LAUNCH},${DM}`),
      multi('SLACK_SEND_MESSAGE', { channel: BOT, text: 'hi' }),
    ];
    for (const call of calls) {
      for (const mode of ['bypassPermissions', 'default', 'acceptEdits'] as const) {
        expect(gate(call, { mode, permissionRules: allowAll })).toMatchObject({ decision: 'deny', reasonType: 'own_chat' });
      }
    }
  });

  it('a workbench script that posts there is refused too', () => {
    const code = `run_composio_tool("SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK", {"channels": "${DM}", "file": f})`;
    expect(gate(workbench(code))).toMatchObject({ decision: 'deny', message: BASH_CHAT_DENY_MESSAGE });
  });

  it('reading the chat stays open: the task may look at what was said there', () => {
    expect(gate(multi('SLACK_FETCH_CONVERSATION_HISTORY', { channel: DM, limit: 20 }))).toEqual({ decision: 'allow' });
    expect(gate(tool('mcp__composio__SLACK_SEARCH_MESSAGES', { query: `in:<#${DM}>` }))).toEqual({ decision: 'allow' });
  });

  it('a task not born in a chat is unchanged: no config, no refusal, and Relaxed runs the same upload silently', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const noConfig = decideToolGate(upload(DM), {
      mode: 'bypassPermissions', cwd: WS, connectedComposioToolkits: new Set(['slack']), permissionRules: { allow: [], ask: [], deny: [] }, accessLevel: 'relaxed',
    });
    expect(noConfig).toEqual({ decision: 'allow' });
    expect(gate(upload(DM), { accessConfig: compileAccessConfig({ level: 'relaxed' }) })).toEqual({ decision: 'allow' });
  });

  it('with access levels off the config is ignored entirely, as every config is', () => {
    process.env.ACCESS_LEVELS_V1 = '0';
    const verdict = decideToolGate(upload(DM), {
      mode: 'bypassPermissions', cwd: WS, connectedComposioToolkits: new Set(['slack']), accessConfig: compileAccessConfig(SLACK_BORN),
    });
    expect(verdict).toEqual({ decision: 'allow' });
  });
});

describe('every other Slack write as the owner asks first, and nothing silences the ask', () => {
  it('"post in #launch as me": one hard ask, never a refusal', () => {
    const verdict = gate(upload(LAUNCH));
    expect(verdict).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    expect(gate(tool('mcp__composio__SLACK_SEND_MESSAGE', { channel: LAUNCH, text: 'We launch Monday' }))).toMatchObject({ decision: 'needs_human', unsilenceable: true });
  });

  it('an Always-allow for the exact tool cannot silence it, and the card does not offer one', () => {
    const call = upload(LAUNCH);
    const permissionRules = { allow: [{ toolName: META }], ask: [], deny: [] };
    expect(gate(call, { permissionRules })).toMatchObject({ decision: 'needs_human', unsilenceable: true });
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(allowRuleCanSilence(call, { cwd: WS, permissionRules, accessConfig: compileAccessConfig(SLACK_BORN) } as ToolGateContext)).toBe(false);
  });

  it('a workbench script posting as him asks too: code there can reach Slack (remote-code-pins.ts)', () => {
    const code = `run_composio_tool("SLACK_SEND_MESSAGE", {"channel": "${LAUNCH}", "text": "hi"})`;
    expect(gate(workbench(code))).toMatchObject({ decision: 'needs_human', unsilenceable: true });
    // The same script with no pin is today's verdict: silent at Relaxed.
    expect(gate(workbench(code), { accessConfig: compileAccessConfig({ level: 'relaxed' }) })).toEqual({ decision: 'allow' });
  });

  it('not Balanced: his other apps and his reads run exactly as at his own level', () => {
    expect(gate(tool('mcp__composio__NOTION_UPDATE_PAGE', { page_id: 'p' }))).toEqual({ decision: 'allow' });
    expect(gate(multi('GMAIL_SEND_EMAIL', { to: 'rahul@example.com' }))).toEqual({ decision: 'allow' });
    expect(gate(tool('Write', { file_path: 'files/voice.mp3' }))).toEqual({ decision: 'allow' });
    expect(gate(multi('SLACK_LIST_ALL_CHANNELS', {}))).toEqual({ decision: 'allow' });
  });
});

describe('bashChats in the config', () => {
  it('parse keeps the chats, drops what is not an id, and compile lowercases them', () => {
    const parsed = parseAccessConfig({ ...SLACK_BORN, bashChats: [DM, '', 7, ` ${BOT} `] });
    expect(parsed).toEqual({ ...SLACK_BORN, bashChats: [DM, BOT] });
    expect([...(compileAccessConfig(parsed!).bashChats ?? [])]).toEqual([DM.toLowerCase(), BOT.toLowerCase()]);
    expect(compileAccessConfig({ level: 'relaxed' }).bashChats).toBeUndefined();
  });

  it("a teammate of a Slack-born task keeps its lead's chats closed and its Slack asks", () => {
    const child = clampConfig({ level: 'relaxed' }, SLACK_BORN);
    const compiled = compileAccessConfig(child);
    expect([...(compiled.bashChats ?? [])].sort()).toEqual([BOT.toLowerCase(), DM.toLowerCase()].sort());
    expect(compiled.apps.get('slack')).toEqual({ external_send: 'ask', external_mutation: 'ask' });
    // A child already carrying them comes back by reference.
    expect(clampConfig(SLACK_BORN, SLACK_BORN)).toBe(SLACK_BORN);
  });
});
