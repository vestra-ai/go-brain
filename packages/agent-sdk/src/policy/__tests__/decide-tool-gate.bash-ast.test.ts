import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';

// `deny Bash(rm:*)`. Rules are the PARSED PermissionRuleValue form the gate
// matcher consumes (`{ toolName, ruleContent }`), not the raw specifier string —
// matchRule reads `rule.toolName` and never re-parses a `'Bash(rm:*)'` string.
const ctx: ToolGateContext = {
  mode: 'default',
  permissionRules: { allow: [], ask: [], deny: [{ toolName: 'Bash', ruleContent: 'rm:*' }] },
};
const decide = (command: string) =>
  decideToolGate({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' }, ctx).decision;

describe('deny/allow rule-matching over analyzer command positions', () => {
  it('deny Bash(rm:*) catches a backgrounded rm', () => {
    expect(decide('sleep 1 & rm scratch.txt')).toBe('deny');
  });
  it('deny Bash(rm:*) catches an rm in process substitution', () => {
    expect(decide('cat <(rm scratch.txt)')).toBe('deny');
  });
  it('deny still catches the classic && chain', () => {
    expect(decide('ls && rm scratch.txt')).toBe('deny');
  });
  it('allow-coverage refuses to vouch for an unparseable command', () => {
    const allowCtx: ToolGateContext = {
      mode: 'default',
      permissionRules: { allow: [{ toolName: 'Bash', ruleContent: 'rm:*' }], ask: [], deny: [] },
    };
    const r = decideToolGate({ toolName: 'Bash', toolInput: { command: 'rm $(cat $(echo x))' }, toolCallId: 't' }, allowCtx);
    expect(r.decision).not.toBe('allow'); // !parsedSafely → not fully covered
  });
});

// Since 2026-09-25 the analyzer reads subshells and substitutions. The rule
// engine takes the new inner positions for DENY/ASK (tighter) but never lets an
// ALLOW rule cover such a command (`nested` counts as unvouched, exactly as the
// same command was unparseable before), so "Always allow" cannot widen.
describe('rule-matching over subshells and substitutions', () => {
  afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

  const rulesCtx = (allow: string[], deny: string[] = []): ToolGateContext => ({
    mode: 'default',
    cwd: '/app/workspace',
    accessLevel: 'careful', // workspace writes ask at Careful unless an allow rule covers them
    permissionRules: {
      allow: allow.map((ruleContent) => ({ toolName: 'Bash', ruleContent })),
      ask: [],
      deny: deny.map((ruleContent) => ({ toolName: 'Bash', ruleContent })),
    },
  });
  const decideWith = (command: string, c: ToolGateContext) =>
    decideToolGate({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' }, c).decision;

  it('deny Bash(rm:*) now catches an rm inside $( ) and inside a group', () => {
    expect(decideWith('echo $(rm scratch.txt)', rulesCtx([], ['rm:*']))).toBe('deny');
    expect(decideWith('(ls; rm scratch.txt)', rulesCtx([], ['rm:*']))).toBe('deny');
    expect(decideWith('echo `rm scratch.txt`', rulesCtx([], ['rm:*']))).toBe('deny');
  });

  it('an Always-allow rule never covers a command carrying a substitution', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    // Control: the plain command IS covered at Careful.
    expect(decideWith('npm test', rulesCtx(['npm test:*']))).toBe('allow');
    // The brief's example, and a non-delete twin the floor does not catch first.
    expect(decideWith('npm test $(rm -rf ~)', rulesCtx(['npm test:*']))).not.toBe('allow');
    expect(decideWith('npm test $(touch pwned)', rulesCtx(['npm test:*']))).not.toBe('allow');
    // Even when every position is individually allowed, as before this change.
    expect(decideWith('echo $(touch x)', rulesCtx(['echo:*', 'touch:*']))).not.toBe('allow');
    expect(decideWith('(touch x)', rulesCtx(['touch:*']))).not.toBe('allow');
  });
});

describe('deny rule-matching — flag OFF is byte-identical to the legacy per-segment split', () => {
  afterEach(() => { delete process.env.VESTRA_BASH_AST_GATE; });

  it('legacy still catches an rm in the classic && chain (per-segment split)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(decide('ls && rm scratch.txt')).toBe('deny');
  });

  it('legacy does NOT catch a backgrounded rm (legacy does not split on &)', () => {
    process.env.VESTRA_BASH_AST_GATE = '0';
    expect(decide('sleep 1 & rm scratch.txt')).not.toBe('deny');
  });
});
