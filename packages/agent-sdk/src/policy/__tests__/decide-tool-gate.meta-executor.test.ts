import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, compileAccessConfig, classifySideEffect } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessConfig } from '../access-config.js';
import { ACCESS_LEVELS } from '../access-level.js';

// ─────────────────────────────────────────────────────────────────────────────
// META-EXECUTOR UNWRAP — the live-incident pin (staging task 6aa39a0d, 2026-07-09).
//
// COMPOSIO_MULTI_EXECUTE_TOOL executes OTHER tools named in its payload
// (`toolInput.tools[].tool_slug`). Classifying it by its own NAME (toolkit
// 'composio', action 'MULTI_EXECUTE_TOOL' → external_mutation) let an inner
// GMAIL_SEND_EMAIL ride a user's external_mutation=allow straight past their
// external_send=ask — a REAL email sent with zero prompts. The same hole would
// let an inner STRIPE_CREATE_CHARGE skip the payment hard floor, and per-app
// Block pins never fire because the call's toolkit reads 'composio'.
//
// The fix: executor meta-calls classify by their INNER tools (strictest family
// wins), app pins evaluate across ALL inner toolkits, and an unparseable
// payload fails toward 'unknown' (asks at every level, like payment; since
// 2026-09-21 a tools[] list that cannot run is denied back to the agent).
// ─────────────────────────────────────────────────────────────────────────────

const WS = '/app/workspace';
const CONNECTED = new Set(['gmail', 'slack', 'stripe', 'github', 'notion', 'composio']);
const META = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL';

const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't',
});

/** A MULTI_EXECUTE call in the real payload shape the incident trace carried. */
const multiExecute = (...slugs: string[]): ToolCall =>
  tool(META, { tools: slugs.map((s) => ({ tool_slug: s, arguments: {} })) });

const classify = (call: ToolCall) => classifySideEffect(call, { workspaceRoot: WS });

function gate(call: ToolCall, extra: Partial<ToolGateContext> = {}) {
  const ctx: ToolGateContext = {
    mode: 'default',
    cwd: WS,
    connectedComposioToolkits: CONNECTED,
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  };
  return decideToolGate(call, ctx);
}

const allowRule = (toolName: string) => ({ allow: [{ toolName }], ask: [], deny: [] });

/** The incident user's exact config: sends ask, generic mutations run silent. */
const INCIDENT_CONFIG = compileAccessConfig({
  level: 'custom',
  families: { external_send: 'ask', external_mutation: 'allow' },
});

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Classifier: executor payloads classify by their inner tools
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySideEffect — meta-executor unwrap', () => {
  it('INCIDENT: inner GMAIL_SEND_EMAIL classifies the call external_send, not external_mutation', () => {
    expect(classify(multiExecute('GMAIL_SEND_EMAIL'))).toBe('external_send');
  });

  it('inner STRIPE_CREATE_CHARGE classifies payment (the hard floor must see it)', () => {
    expect(classify(multiExecute('STRIPE_CREATE_CHARGE'))).toBe('payment');
  });

  it('inner GITHUB_DELETE_REPO classifies dangerous_delete', () => {
    expect(classify(multiExecute('GITHUB_DELETE_REPO'))).toBe('dangerous_delete');
  });

  it('all-read payload classifies readonly', () => {
    expect(classify(multiExecute('GMAIL_FETCH_EMAILS', 'AIRTABLE_LIST_RECORDS'))).toBe('readonly');
  });

  it('STRICTEST wins on a mixed payload (read + send → send; read + charge → payment)', () => {
    expect(classify(multiExecute('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'))).toBe('external_send');
    expect(classify(multiExecute('GMAIL_FETCH_EMAILS', 'STRIPE_CREATE_CHARGE'))).toBe('payment');
    expect(classify(multiExecute('GMAIL_SEND_EMAIL', 'GITHUB_DELETE_REPO'))).toBe('dangerous_delete');
  });

  it('tolerates the field-name variants the sandbox display extractor accepts', () => {
    for (const field of ['tool_slug', 'tool_name', 'toolName', 'name', 'action', 'action_name', 'slug']) {
      expect(classify(tool(META, { tools: [{ [field]: 'GMAIL_SEND_EMAIL' }] }))).toBe('external_send');
    }
  });

  it('tolerates string entries and lowercase slugs', () => {
    expect(classify(tool(META, { tools: ['GMAIL_SEND_EMAIL'] }))).toBe('external_send');
    expect(classify(tool(META, { tools: [{ tool_slug: 'gmail_send_email' }] }))).toBe('external_send');
  });

  it('UNPARSEABLE payload fails toward payment (never silently downgrades), and never throws', () => {
    const garbage: ToolCall[] = [
      tool(META, {}),                                   // no tools key
      tool(META, { tools: [] }),                        // empty payload
      tool(META, { tools: 'GMAIL_SEND_EMAIL' }),        // not an array
      tool(META, { tools: [{}] }),                      // entry without a slug
      tool(META, { tools: [{ tool_slug: 42 }] }),       // non-string slug
      tool(META, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }, {}] }), // ONE bad entry poisons all
      tool(META, null),
      tool(META, undefined),
    ];
    // 2026-09-21: unreadable is its OWN family now — same floor, honest words.
    for (const call of garbage) {
      expect(classify(call)).toBe('unknown');
    }
  });

  it('NON-executor meta-tools keep their name-based classification', () => {
    // SEARCH_TOOLS carries a tools-shaped payload too, but it only discovers —
    // it must not start classifying by payload.
    expect(classify(tool('mcp__composio__COMPOSIO_SEARCH_TOOLS', { tools: [{ tool_slug: 'STRIPE_CREATE_CHARGE' }] })))
      .toBe('readonly');
    expect(classify(tool('mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'))).toBe('external_mutation');
    expect(classify(tool('mcp__composio__COMPOSIO_CHECK_ACTIVE_CONNECTION'))).toBe('external_mutation');
  });

  it('REGRESSION: direct (non-meta) calls classify byte-identically', () => {
    expect(classify(tool('mcp__composio__GMAIL_SEND_EMAIL'))).toBe('external_send');
    expect(classify(tool('mcp__composio__GMAIL_FETCH_EMAILS'))).toBe('readonly');
    expect(classify(tool('mcp__composio__NOTION_UPDATE_PAGE'))).toBe('external_mutation');
    expect(classify(tool('mcp__composio__STRIPE_CREATE_CHARGE'))).toBe('payment');
    expect(classify(tool('mcp__composio__GITHUB_DELETE_REPO'))).toBe('dangerous_delete');
    expect(classify(tool('Read', { file_path: 'a.txt' }))).toBe('readonly');
    expect(classify(tool('Write', { file_path: 'a.txt' }))).toBe('workspace_write');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gate: the incident cell, the payment floor, app pins, levels
// ─────────────────────────────────────────────────────────────────────────────

describe('decideToolGate — meta-executor (flag ON)', () => {
  it('INCIDENT PIN: MULTI_EXECUTE(GMAIL_SEND_EMAIL) under {external_send: ask, external_mutation: allow} + bypassPermissions ASKS', () => {
    // This exact cell sent a real Gmail email with zero prompts on staging.
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessConfig: INCIDENT_CONFIG,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('parity: the meta call decides the same as the direct inner call under the incident config', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const direct = gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessConfig: INCIDENT_CONFIG,
      mode: 'bypassPermissions',
    });
    const wrapped = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessConfig: INCIDENT_CONFIG,
      mode: 'bypassPermissions',
    });
    expect(wrapped).toEqual(direct);
    expect(wrapped.decision).toBe('needs_human');
  });

  it('PAYMENT FLOOR: inner STRIPE_CREATE_CHARGE hard-asks at EVERY level, past an allow rule, under bypassPermissions', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const level of ACCESS_LEVELS) {
      const r = gate(multiExecute('STRIPE_CREATE_CHARGE'), {
        accessLevel: level,
        mode: 'bypassPermissions',
        permissionRules: allowRule(META),
      });
      expect(r, `level=${level}`).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });

  it('PAYMENT FLOOR: the config path cannot silence an inner charge either', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const everythingAllowed = compileAccessConfig({
      level: 'custom',
      families: {
        readonly: 'allow', workspace_write: 'allow', external_send: 'allow',
        external_mutation: 'allow', dangerous_delete: 'allow',
      },
    });
    const r = gate(multiExecute('STRIPE_CREATE_CHARGE'), {
      accessConfig: everythingAllowed,
      mode: 'bypassPermissions',
      permissionRules: allowRule(META),
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
  });

  it('APP BLOCK: gmail send blocked → inner GMAIL_SEND_EMAIL denies at deny-rule strength', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      apps: { gmail: { external_send: 'block' } },
    });
    const r = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
      permissionRules: allowRule(META),
    });
    expect(r).toEqual({
      decision: 'deny',
      message: 'Blocked by your settings: sending on Gmail.',
      reasonType: 'rule',
    });
  });

  it('APP BLOCK: ANY-block-wins on a mixed payload (only notion blocked → whole call denied)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'allow', external_mutation: 'allow' },
      apps: { notion: { external_mutation: 'block' } },
    });
    const r = gate(multiExecute('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
    });
    // The deny names the cell that blocked — the inner tool's own app + family.
    expect(r).toEqual({
      decision: 'deny',
      message: 'Blocked by your settings: changes on Notion.',
      reasonType: 'rule',
    });
  });

  it('APP ASK pin is HARD for an inner tool: pinned gmail send asks past an allow rule + silent global', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'allow' },
      apps: { gmail: { external_send: 'ask' } },
    });
    const r = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
      permissionRules: allowRule(META),
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
  });

  it('APP ALLOW pins silence only when EVERY inner toolkit is covered', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const asking = { external_send: 'ask', external_mutation: 'ask' } as const;
    const bothPinned = compileAccessConfig({
      level: 'custom',
      families: asking,
      apps: { gmail: { external_send: 'allow' }, notion: { external_mutation: 'allow' } },
    });
    const onlyGmail = compileAccessConfig({
      level: 'custom',
      families: asking,
      apps: { gmail: { external_send: 'allow' } },
    });
    const call = multiExecute('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE');
    expect(gate(call, { accessConfig: bothPinned, mode: 'bypassPermissions' }).decision).toBe('allow');
    expect(gate(call, { accessConfig: onlyGmail, mode: 'bypassPermissions' })).toEqual({
      decision: 'needs_human',
      interactionKind: 'tool_permission',
    });
  });

  it('LEVELS path: inner send asks at Careful + Balanced, runs at Relaxed + Autopilot (send semantics)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const call = multiExecute('GMAIL_SEND_EMAIL');
    expect(gate(call, { accessLevel: 'careful' }).decision).toBe('needs_human');
    expect(gate(call, { accessLevel: 'balanced' }).decision).toBe('needs_human');
    expect(gate(call, { accessLevel: 'balanced', mode: 'bypassPermissions' }).decision).toBe('needs_human');
    expect(gate(call, { accessLevel: 'relaxed' }).decision).toBe('allow');
    expect(gate(call, { accessLevel: 'autopilot' }).decision).toBe('allow');
  });

  it('LEVELS path: inner delete hard-asks below Autopilot', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const call = multiExecute('GITHUB_DELETE_REPO');
    for (const level of ['careful', 'balanced', 'relaxed'] as const) {
      const r = gate(call, { accessLevel: level, mode: 'bypassPermissions', permissionRules: allowRule(META) });
      expect(r.decision, `level=${level}`).toBe('needs_human');
    }
    expect(gate(call, { accessLevel: 'autopilot', mode: 'bypassPermissions' }).decision).toBe('allow');
  });

  it('UNPARSEABLE payload never runs, even at Autopilot: it goes back to the agent, stricter than an ask', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const garbage = tool(META, { tools: 'not-an-array' });
    const r = gate(garbage, {
      accessLevel: 'autopilot',
      mode: 'bypassPermissions',
      permissionRules: allowRule(META),
    });
    expect(r.decision).toBe('deny');
  });

  it('soft asks still decay via a persisted allow rule (ladder semantics unchanged)', () => {
    // The protection against durable blanket grants is SUGGESTION suppression,
    // not a rule-engine carve-out: a hand-written allow rule keeps its power
    // over the SOFT step (never over the hard floor — pinned above).
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessLevel: 'balanced',
      permissionRules: allowRule(META),
    });
    expect(r.decision).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NON-MONOTONE custom configs — the ANY-inner-asks contract. A custom config
//    can silence a HIGHER-severity family while asking a LOWER one, so folding
//    the payload to one strictest family and gating THAT family is unsound: the
//    asking inner tool rides the silent family free. Each inner tool must be
//    gated at its own family; the call asks iff ANY inner asks.
// ─────────────────────────────────────────────────────────────────────────────

describe('decideToolGate — meta-executor under NON-MONOTONE custom configs (flag ON)', () => {
  it('REPRO 1: {external_send: allow, external_mutation: ask} + send+mutation payload ASKS', () => {
    // Strictest inner family (external_send) is the SILENT one — the asking
    // NOTION_UPDATE_PAGE must still gate the call.
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'allow', external_mutation: 'ask' },
    });
    const r = gate(multiExecute('GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('REPRO 2: single-toggle {external_mutation: ask} on the Relaxed base + send+mutation payload ASKS', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_mutation: 'ask' },
    });
    const r = gate(multiExecute('SLACK_SEND_MESSAGE', 'NOTION_UPDATE_PAGE'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('REPRO 3: {external_send: ask, dangerous_delete: allow} + delete+send payload ASKS', () => {
    // The delete lift makes the strictest inner family (dangerous_delete)
    // silent — the asking GMAIL_SEND_EMAIL must still gate the call.
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'ask', dangerous_delete: 'allow' },
    });
    const r = gate(multiExecute('GITHUB_DELETE_REPO', 'GMAIL_SEND_EMAIL'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('no over-ask: an all-readonly payload stays silent under the incident config', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(multiExecute('GMAIL_FETCH_EMAILS', 'GITHUB_GET_REPO'), {
      accessConfig: INCIDENT_CONFIG,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'allow' });
  });

  // The real contract, pinned as a PROPERTY: wrapping can never LOOSEN the
  // gate. For every inner tool, the meta call decides at least as strictly as
  // the equivalent direct call, across a config × payload × mode matrix that
  // includes the non-monotone shapes above.
  const rank = (d: { decision: string }) =>
    d.decision === 'deny' ? 2 : d.decision === 'needs_human' ? 1 : 0;
  const CONFIGS: [string, AccessConfig][] = [
    ['careful', { level: 'careful' }],
    ['balanced', { level: 'balanced' }],
    ['relaxed', { level: 'relaxed' }],
    ['autopilot', { level: 'autopilot' }],
    ['incident', { level: 'custom', families: { external_send: 'ask', external_mutation: 'allow' } }],
    ['send-allow mutation-ask', { level: 'custom', families: { external_send: 'allow', external_mutation: 'ask' } }],
    ['send-ask delete-allow', { level: 'custom', families: { external_send: 'ask', dangerous_delete: 'allow' } }],
    ['mutation-ask only', { level: 'custom', families: { external_mutation: 'ask' } }],
    ['all-allow', {
      level: 'custom',
      families: {
        readonly: 'allow', workspace_write: 'allow', external_send: 'allow',
        external_mutation: 'allow', dangerous_delete: 'allow',
      },
    }],
    ['gmail-send blocked', { level: 'custom', apps: { gmail: { external_send: 'block' } } }],
  ];
  const SLUGS = [
    'GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'NOTION_UPDATE_PAGE',
    'GITHUB_DELETE_REPO', 'STRIPE_CREATE_CHARGE',
  ];
  const PAYLOADS: string[][] = [
    ...SLUGS.map((s) => [s]),
    ...SLUGS.flatMap((a, i) => SLUGS.slice(i + 1).map((b) => [a, b])),
    SLUGS,
  ];

  for (const [name, cfg] of CONFIGS) {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      it(`PROPERTY: meta is at least as strict as every direct inner (config=${name}, mode=${mode})`, () => {
        process.env.ACCESS_LEVELS_V1 = '1';
        const compiled = compileAccessConfig(cfg);
        for (const payload of PAYLOADS) {
          const meta = rank(gate(multiExecute(...payload), { accessConfig: compiled, mode }));
          for (const slug of payload) {
            const direct = rank(gate(tool(`mcp__composio__${slug}`), { accessConfig: compiled, mode }));
            expect(meta, `payload=[${payload.join(',')}] inner=${slug}`).toBeGreaterThanOrEqual(direct);
          }
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WORKBENCH PROXY EXECUTORS — same incident class, different payload shape:
//    they run agent-authored CODE (a `code`/`code_to_execute` payload, not a
//    tools[] list) that proxies real tools via run_composio_tool()/proxy_execute().
//    THE RULING (founder 2026-07-15 — at Relaxed only deletes/payments ask): the
//    classifier scans the code so a proxied SEND runs as silently as a direct send,
//    while a proxied DELETE/PAYMENT — and any dynamic/unreadable slug — still asks.
//    Pure local compute (no proxy markers) is a workspace_write.
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySideEffect — workbench code scan', () => {
  const WORKBENCH = [
    'mcp__composio__COMPOSIO_REMOTE_WORKBENCH',
    'mcp__composio__COMPOSIO_WORKSPACE_EXECUTE',
    'mcp__composio__COMPOSIO_WORKSPACE_CREATE',
  ];
  const wb = (code: string, field = 'code') => tool(WORKBENCH[0], { [field]: code });

  it('pure local compute (no proxy markers) → workspace_write, across all three tools + code fields', () => {
    for (const name of WORKBENCH) {
      expect(classify(tool(name, { code: 'import pandas as pd\ndf = pd.read_csv("x.csv")\nprint(df.head())' })), name)
        .toBe('workspace_write');
    }
    for (const field of ['code', 'code_to_execute', 'code_to_run']) {
      expect(classify(wb('x = 1 + 1', field)), field).toBe('workspace_write');
    }
  });

  it('proxied READ → readonly (silent at Relaxed like a direct read)', () => {
    expect(classify(wb('rows = run_composio_tool("GMAIL_FETCH_EMAILS", {"q": "x"})'))).toBe('readonly');
  });

  it('THE RULING: proxied SEND → external_send (positional, single-quote/proxy_execute, and slug keyword)', () => {
    expect(classify(wb('run_composio_tool("GMAIL_SEND_EMAIL", {"to": "a@b.c"})'))).toBe('external_send');
    expect(classify(tool(WORKBENCH[1], { code: "proxy_execute('SLACK_SEND_MESSAGE', {})" }))).toBe('external_send');
    expect(classify(wb('run_composio_tool(tool_slug="TWITTER_POST_TWEET", arguments={})'))).toBe('external_send');
  });

  it('proxied DELETE → dangerous_delete; proxied PAYMENT → payment', () => {
    expect(classify(wb('run_composio_tool("GITHUB_DELETE_REPO", {})'))).toBe('dangerous_delete');
    expect(classify(wb('proxy_execute("STRIPE_CREATE_CHARGE", {})'))).toBe('payment');
  });

  it('STRICTEST wins across multiple proxied calls in one script', () => {
    expect(classify(wb('a = run_composio_tool("GMAIL_FETCH_EMAILS", {})\nb = run_composio_tool("GMAIL_SEND_EMAIL", {})')))
      .toBe('external_send');
    expect(classify(wb('run_composio_tool("GMAIL_SEND_EMAIL", {})\nrun_composio_tool("GITHUB_DELETE_REPO", {})')))
      .toBe('dangerous_delete');
    expect(classify(wb('run_composio_tool("GMAIL_FETCH_EMAILS", {})\nproxy_execute("STRIPE_CREATE_CHARGE", {})')))
      .toBe('payment');
  });

  it('DYNAMIC slug (variable / f-string / non-slug leading keyword) fails toward unknown, the same floor', () => {
    expect(classify(wb('slug = pick()\nrun_composio_tool(slug, {})'))).toBe('unknown');
    expect(classify(wb('run_composio_tool(f"{prefix}_SEND", {})'))).toBe('unknown');
    expect(classify(wb('run_composio_tool(thought="do it", tool_slug="GMAIL_SEND_EMAIL")'))).toBe('unknown');
  });

  it('missing / empty / non-string code fails toward unknown; a bare mention (no call) fails closed too', () => {
    expect(classify(tool(WORKBENCH[0]))).toBe('unknown');                 // no code field
    expect(classify(wb(''))).toBe('unknown');                             // empty
    expect(classify(tool(WORKBENCH[0], { code: 42 }))).toBe('unknown');   // non-string
    expect(classify(wb('# could use run_composio_tool here\nprint(1)'))).toBe('unknown'); // marker present, no call
  });

  it('never throws on malformed workbench input', () => {
    expect(() => classify(tool(WORKBENCH[0], null))).not.toThrow();
    expect(() => classify(tool(WORKBENCH[0], { code: { nested: true } }))).not.toThrow();
  });
});

describe('decideToolGate — workbench executors under THE RULING (flag ON)', () => {
  const WB = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';
  const wbTool = (code: string) => tool(WB, { code });

  it('RELAXED: a proxied send + pure compute + a proxied read all run SILENT (only deletes/payments ask)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const silentAtRelaxed = [
      wbTool('run_composio_tool("GMAIL_SEND_EMAIL", {})'),   // proxied send
      wbTool('run_composio_tool("GMAIL_FETCH_EMAILS", {})'), // proxied read
      wbTool('df = process(data)'),                          // pure local compute
    ];
    for (const call of silentAtRelaxed) {
      expect(gate(call, { accessLevel: 'relaxed', mode: 'bypassPermissions' }).decision).toBe('allow');
    }
  });

  it('RELAXED: a proxied delete / charge / dynamic-slug / missing-code all ASK', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const asksAtRelaxed = [
      wbTool('run_composio_tool("GITHUB_DELETE_REPO", {})'), // proxied delete
      wbTool('proxy_execute("STRIPE_CREATE_CHARGE", {})'),   // proxied payment
      wbTool('run_composio_tool(slug, {})'),                 // dynamic slug
      tool(WB),                                              // missing code
    ];
    for (const call of asksAtRelaxed) {
      expect(gate(call, { accessLevel: 'relaxed', mode: 'bypassPermissions' }))
        .toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });

  it('PAYMENT FLOOR: a proxied charge hard-asks at EVERY level, past an allow rule, under bypass', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const level of ACCESS_LEVELS) {
      const r = gate(wbTool('proxy_execute("STRIPE_CREATE_CHARGE", {})'), {
        accessLevel: level, mode: 'bypassPermissions', permissionRules: allowRule(WB),
      });
      expect(r, `level=${level}`).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });

  it('proxied DELETE hard-asks below Autopilot (runs at Autopilot); proxied SEND asks Careful+Balanced (runs Relaxed+Autopilot)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const del = wbTool('run_composio_tool("GITHUB_DELETE_REPO", {})');
    for (const level of ['careful', 'balanced', 'relaxed'] as const) {
      expect(gate(del, { accessLevel: level, mode: 'bypassPermissions', permissionRules: allowRule(WB) }).decision, `del ${level}`)
        .toBe('needs_human');
    }
    expect(gate(del, { accessLevel: 'autopilot', mode: 'bypassPermissions' }).decision).toBe('allow');

    const send = wbTool('run_composio_tool("GMAIL_SEND_EMAIL", {})');
    expect(gate(send, { accessLevel: 'careful' }).decision).toBe('needs_human');
    expect(gate(send, { accessLevel: 'balanced', mode: 'bypassPermissions' }).decision).toBe('needs_human');
    expect(gate(send, { accessLevel: 'relaxed', mode: 'bypassPermissions' }).decision).toBe('allow');
    expect(gate(send, { accessLevel: 'autopilot', mode: 'bypassPermissions' }).decision).toBe('allow');
  });

  it('DYNAMIC / opaque payload hard-asks even at Autopilot (payment-severity fail-closed)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const call of [wbTool('run_composio_tool(slug, {})'), tool(WB)]) {
      const r = gate(call, { accessLevel: 'autopilot', mode: 'bypassPermissions', permissionRules: allowRule(WB) });
      expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });

  it('CONFIG path: a proxied send asks under {external_send: ask}; a proxied read stays silent', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const send = gate(wbTool('run_composio_tool("GMAIL_SEND_EMAIL", {})'), {
      accessConfig: INCIDENT_CONFIG, mode: 'bypassPermissions',
    });
    expect(send).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
    const read = gate(wbTool('run_composio_tool("GMAIL_FETCH_EMAILS", {})'), {
      accessConfig: INCIDENT_CONFIG, mode: 'bypassPermissions',
    });
    expect(read).toEqual({ decision: 'allow' });
  });
});

describe('decideToolGate — meta-executor (flag OFF stays byte-identical)', () => {
  it('flag OFF: the config is inert and MULTI_EXECUTE allows under bypassPermissions (today\'s behavior)', () => {
    // The unwrap rides ACCESS_LEVELS_V1 — with the flag off the ladder never
    // consults the classifier, so the legacy path is untouched (and unprotected;
    // the flag is ON where permissions v2 runs).
    const r = gate(multiExecute('GMAIL_SEND_EMAIL'), {
      accessConfig: INCIDENT_CONFIG,
      mode: 'bypassPermissions',
    });
    expect(r).toEqual({ decision: 'allow' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A BATCH ITEM THAT NAMES NO TOOL goes back to the agent (prod 2026-09-20, task
// 46f85398, routine "AI Trend Logger"). The agent batched two Notion row upserts
// and put the second row's data in as a sibling ITEM ({match, create, update},
// no tool_slug) instead of inside the first item's arguments. The classifier
// could not vouch for that item, failed toward 'payment', and the person got
// "Approve a payment" for a Notion write; the unattended routine sat 12.5 h on
// it. An item with no tool cannot run anyway, so nothing is asked: the agent is
// told which item is unnamed and the shape to resend, at every level and mode.
// ─────────────────────────────────────────────────────────────────────────────
describe('decideToolGate × a batch item that names no tool', () => {
  const row = (key: string) => ({ match: { equals: key, property: 'Source key' }, create: { properties: {} }, update: { properties: {} } });
  const incident = tool(META, {
    tools: [
      { tool_slug: 'NOTION_UPSERT_ROW_DATABASE', arguments: { database_id: 'db', items: [row('hn:49776183')] } },
      row('hn:49775968'),
    ],
  });

  it('INCIDENT: denied back to the agent with the item and the shape named, never asked as a payment', () => {
    const r = gate(incident);
    expect(r.decision).toBe('deny');
    const message = r.decision === 'deny' ? r.message : '';
    expect(message).toMatch(/nothing ran/i);
    expect(message).toMatch(/item 2/i);
    expect(message).toContain('tool_slug');
    expect(message).toContain('NOTION_UPSERT_ROW_DATABASE');
    expect(message).not.toMatch(/payment/i);
  });

  it('holds at every level and mode, a routine run included: an allow rule or Autopilot cannot run an unnamed item', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const accessLevel of ACCESS_LEVELS) {
      for (const mode of ['default', 'bypassPermissions'] as const) {
        const r = gate(incident, { accessLevel, mode, permissionRules: allowRule(META), routineRun: { routineId: 'r1' } as never });
        expect(r.decision, `${accessLevel}/${mode}`).toBe('deny');
      }
    }
  });

  it('a payload with no usable list says so and names the shape', () => {
    for (const toolInput of [{}, { tools: [] }, { tools: 'NOTION_UPSERT_ROW_DATABASE' }, null, undefined]) {
      const r = gate(tool(META, toolInput));
      expect(r.decision, JSON.stringify(toolInput)).toBe('deny');
      if (r.decision === 'deny') expect(r.message).toContain('tool_slug');
    }
  });

  it('a well-named batch is untouched: it is classified and decided exactly as before', () => {
    const ok = tool(META, { tools: [{ tool_slug: 'NOTION_UPSERT_ROW_DATABASE', arguments: {} }, { tool_slug: 'NOTION_UPSERT_ROW_DATABASE', arguments: {} }] });
    expect(gate(ok).decision).not.toBe('deny');
  });

  it('the incident payload is never classified payment: underneath the deny it reads unknown', () => {
    expect(classify(incident)).toBe('unknown');
  });

  it('a readable charge in a batch is still a payment and still hard-asks at every level, past an allow rule', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const charge = multiExecute('NOTION_UPSERT_ROW_DATABASE', 'STRIPE_CREATE_CHARGE');
    expect(classify(charge)).toBe('payment');
    for (const accessLevel of ACCESS_LEVELS) {
      const r = gate(charge, { accessLevel, mode: 'bypassPermissions', permissionRules: allowRule(META) });
      expect(r, accessLevel).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A WORKBENCH script whose proxied slug cannot be resolved CAN still run (it is
// code, not a list), so it stays an ask — but as 'unknown', never as a payment.
// ─────────────────────────────────────────────────────────────────────────────
describe('unreadable is its own family, at payment strength', () => {
  const WB = 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH';
  const dynamic = tool(WB, { code_to_execute: 'slug = pick()\nrun_composio_tool(slug, {})' });

  it('a dynamic proxied slug classifies unknown, not payment', () => {
    expect(classify(dynamic)).toBe('unknown');
  });

  it('it still hard-asks at every level and under bypassPermissions + an allow rule', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const accessLevel of ACCESS_LEVELS) {
      const r = gate(dynamic, { accessLevel, mode: 'bypassPermissions', permissionRules: allowRule(WB) });
      expect(r, `${accessLevel}`).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
    }
  });

  it('a custom config cannot silence it either (it is not a configurable family)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', families: { external_mutation: 'allow' } } as never);
    const r = gate(dynamic, { accessConfig: cfg, mode: 'bypassPermissions', permissionRules: allowRule(WB) } as never);
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission', unsilenceable: true });
  });

  it('a readable proxied charge still classifies payment', () => {
    expect(classify(tool(WB, { code_to_execute: 'proxy_execute("STRIPE_CREATE_CHARGE", {})' }))).toBe('payment');
  });
});
