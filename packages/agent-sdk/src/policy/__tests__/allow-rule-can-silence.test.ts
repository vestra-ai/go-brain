/**
 * `allowRuleCanSilence` — the predicate behind the "Always allow" button.
 *
 * The button promises "tap this and it stops asking". These tests pin the
 * predicate against the ACTUAL LADDER rather than against its own reasoning:
 * for each case they hand `decideToolGate` the very allow rule the button would
 * write, confirm the gate STILL refuses, and confirm the predicate said so.
 *
 * That correspondence is the whole point. The predicate mirrors the ladder
 * instead of running it, so the risk is drift; a test that only asserted the
 * predicate's own opinion would not catch drift at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, allowRuleCanSilence } from '../decide-tool-gate.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import { compileAccessConfig } from '../access-config.js';

const WS = '/app/workspace';
const call = (toolName: string, toolInput: unknown = {}): ToolCall => ({
  toolName,
  toolInput,
  toolCallId: 't',
});

/** Would the gate still refuse even WITH the button's own rule persisted? */
function gateStillRefuses(c: ToolCall, ctx: Partial<ToolGateContext>): boolean {
  const rules = ctx.permissionRules ?? { allow: [], ask: [], deny: [] };
  const verdict = decideToolGate(c, {
    mode: 'default',
    cwd: WS,
    ...ctx,
    // the exact rule buildToolPermissionSuggestion would produce for a bare tool
    permissionRules: { ...rules, allow: [...rules.allow, { toolName: c.toolName }] },
  } as ToolGateContext);
  return verdict.decision !== 'allow';
}

afterEach(() => {
  delete process.env.ACCESS_LEVELS_V1;
});

describe('the predicate agrees with the ladder', () => {
  it('case 1 — a ladder-bypassed ask: gate refuses despite the rule, predicate says false', () => {
    for (const name of [
      'os_takeover',
      'mcp__os-hands__os_takeover',
      'release_browser',
      'mcp__browser-control__release_browser',
    ]) {
      const c = call(name, { app: 'Safari' });
      expect(gateStillRefuses(c, {})).toBe(true);
      expect(allowRuleCanSilence(c, { cwd: WS })).toBe(false);
    }
  });

  it('case 2 — an ASK rule: gate refuses despite the allow rule, predicate says false', () => {
    const c = call('mcp__linear__update_issue');
    const permissionRules = { allow: [], ask: [{ toolName: c.toolName }], deny: [] };
    expect(gateStillRefuses(c, { permissionRules })).toBe(true);
    expect(allowRuleCanSilence(c, { permissionRules, cwd: WS })).toBe(false);
  });

  it('case 2 — a DENY rule: gate refuses despite the allow rule, predicate says false', () => {
    const c = call('mcp__linear__update_issue');
    const permissionRules = { allow: [], ask: [], deny: [{ toolName: c.toolName }] };
    expect(gateStillRefuses(c, { permissionRules })).toBe(true);
    expect(allowRuleCanSilence(c, { permissionRules, cwd: WS })).toBe(false);
  });

  it('case 3 — a per-app ASK pin: gate refuses despite the allow rule, predicate says false', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const c = call('mcp__composio__LINEAR_UPDATE_ISSUE');
    const accessConfig = compileAccessConfig({
      level: 'custom',
      families: { external_mutation: 'allow' },
      apps: { linear: { external_mutation: 'ask' } },
    });
    expect(gateStillRefuses(c, { accessConfig })).toBe(true);
    expect(allowRuleCanSilence(c, { accessConfig, cwd: WS })).toBe(false);
  });

  it('the SOFT half of a custom config is genuinely silenceable — gate ALLOWS, predicate says true', () => {
    // This is the case that must NOT be suppressed. A families toggle asks at
    // step 8b, BELOW allow rules, so the grant really does decay the prompt.
    // Suppressing it would blind the rule miner to the only population that can
    // currently feed it.
    process.env.ACCESS_LEVELS_V1 = '1';
    const c = call('mcp__composio__LINEAR_UPDATE_ISSUE');
    const accessConfig = compileAccessConfig({ level: 'custom', families: { external_mutation: 'ask' } });
    expect(gateStillRefuses(c, { accessConfig })).toBe(false);
    expect(allowRuleCanSilence(c, { accessConfig, cwd: WS })).toBe(true);
  });

  it('an ordinary tool with no rules and no config is silenceable', () => {
    const c = call('mcp__linear__update_issue');
    expect(allowRuleCanSilence(c, { cwd: WS })).toBe(true);
  });

  it('is TOTAL and FAIL-CLOSED — an unjudgeable call is suppressed, never thrown on', () => {
    // The header promises "anything it cannot judge returns false". A nameless
    // call is exactly that, so it must suppress rather than wave the button
    // through — even though the gateway cannot currently produce one.
    expect(
      allowRuleCanSilence({ toolName: '', toolInput: null, toolCallId: '' }, { cwd: WS }),
    ).toBe(false);
    expect(
      allowRuleCanSilence({ toolName: undefined as unknown as string, toolInput: {}, toolCallId: '' }, { cwd: WS }),
    ).toBe(false);
    expect(allowRuleCanSilence(undefined as unknown as ToolCall, { cwd: WS })).toBe(false);
  });
});
