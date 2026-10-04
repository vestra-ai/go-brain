import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, sensitivityFloorAsks } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessLevel } from '../access-level.js';

const WS = '/app/workspace';
// Every toolkit the corpus touches, marked connected so the classifier's
// composio_auth gate never fires — isolating the FLOOR/LEVEL decision under test.
const CONNECTED = new Set([
  'gmail', 'slack', 'stripe', 'paypal', 'github', 'airtable', 'notion',
  'twitter', 'linkedin', 'bank', 'wallet', 'shop', 'db', 'cache', 'server',
]);

const bash = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });
const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });

function gate(
  call: ToolCall,
  level: AccessLevel | undefined,
  extra: Partial<ToolGateContext> = {},
) {
  const ctx: ToolGateContext = {
    mode: 'default',
    cwd: WS,
    connectedComposioToolkits: CONNECTED,
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  };
  if (level !== undefined) ctx.accessLevel = level;
  return decideToolGate(call, ctx);
}

const asksAt = (call: ToolCall, level: AccessLevel, extra?: Partial<ToolGateContext>) =>
  gate(call, level, extra).decision === 'needs_human';

// exactOptionalPropertyTypes: only thread shellCwd when a fixture actually sets it.
const ctxExtra = (cwd: string, shellCwd: string | null | undefined): Partial<ToolGateContext> =>
  shellCwd === undefined ? { cwd } : { cwd, shellCwd };

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

// ─────────────────────────────────────────────────────────────────────────────
// FLAG-OFF byte-identity: with ACCESS_LEVELS_V1 off, threading a level changes
// NOTHING (the level machinery is fully skipped).
// ─────────────────────────────────────────────────────────────────────────────

describe('flag OFF → level is ignored entirely (byte-identical to legacy)', () => {
  it('a Balanced Gmail send is NOT asked when the flag is off', () => {
    delete process.env.ACCESS_LEVELS_V1;
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'balanced').decision).toBe('allow');
  });
  it('a Careful workspace edit is NOT asked when the flag is off', () => {
    delete process.env.ACCESS_LEVELS_V1;
    expect(gate(tool('Write', { file_path: 'a.txt' }), 'careful').decision).toBe('allow');
  });
  it('the floor still fires with the flag off (dangerous rm asks regardless of level)', () => {
    delete process.env.ACCESS_LEVELS_V1;
    // rm -rf /  is a SECURITY deny (above the floor); use a non-catastrophic
    // recursive rm that reaches the floor so this asserts the FLOOR, not security.
    expect(gate(bash('rm -rf scratch/'), 'autopilot').decision).toBe('needs_human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EQUIVALENCE: flag ON + level Relaxed ≡ today's sensitivity floor, over a corpus.
// This is the load-bearing "Relaxed = zero behavior change" guarantee (spec §6).
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture { call: ToolCall; cwd?: string; shellCwd?: string | null }
const CORPUS: Fixture[] = [
  // reads / benign
  { call: tool('Read', { file_path: 'a.txt' }) },
  { call: bash('ls -la') },
  { call: bash('cat form.txt') },
  { call: bash('echo perform') },
  { call: tool('mcp__composio__GMAIL_FETCH_EMAILS') },
  { call: tool('mcp__composio__AIRTABLE_LIST_RECORDS') },
  { call: tool('mcp__server__get_list') },
  // writes (floor does NOT ask)
  { call: tool('Write', { file_path: 'a.txt' }) },
  { call: bash('echo hi > out.txt') },
  { call: bash('mkdir foo') },
  { call: bash('rm scratch.txt') },            // SAFE delete — floor admits
  { call: bash('rm /app/workspace/files/a.png 2>/dev/null; echo ok') },
  // sends / mutations (floor does NOT ask)
  { call: tool('mcp__composio__GMAIL_SEND_EMAIL') },
  { call: tool('mcp__composio__SLACK_SEND_MESSAGE') },
  { call: tool('mcp__composio__NOTION_UPDATE_PAGE') },
  { call: tool('mcp__composio__GITHUB_CREATE_ISSUE') },
  { call: tool('mcp__composio__STRIPE_DELETE_CUSTOMER') }, // payment toolkit, non-payment verb → floor admits
  { call: tool('mcp__server__publish') },
  // payments (floor ASKS)
  { call: tool('mcp__composio__STRIPE_CREATE_CHARGE') },
  { call: tool('mcp__composio__PAYPAL_CREATE_PAYOUT') },
  { call: tool('mcp__composio__SOMEPAY_CHARGE_CARD') },
  { call: tool('mcp__bank__transfer_funds') },
  { call: tool('mcp__wallet__withdraw_balance') },
  // dangerous deletes (floor ASKS)
  { call: bash('rm -rf /') },
  { call: bash('rm *.md') },
  { call: bash('sudo rm -rf x') },
  { call: bash('ls && rm -rf scratch/') },
  { call: bash('rm hostname'), cwd: WS, shellCwd: '/etc' }, // escapes workspace
  { call: bash('echo $(rm -rf /)') },                        // unparseable + delete token
  { call: tool('mcp__composio__GITHUB_DELETE_REPO') },
  { call: tool('mcp__composio__AIRTABLE_DELETE_RECORD') },
  { call: tool('mcp__db__delete_row') },
  { call: tool('Patch', { input: '*** Delete File: a.ts' }) },
  { call: tool('Patch', { input: '*** Update File: a.ts\n@@\n-x\n+y' }) }, // pure write — admits
];

describe('flag OFF gate ≡ flag ON + Relaxed gate (Relaxed = zero behavior change)', () => {
  for (const { call, cwd, shellCwd } of CORPUS) {
    const cmd = call.toolName === 'Bash' ? `(${String((call.toolInput as { command?: string }).command)})` : '';
    it(`${call.toolName}${cmd}`, () => {
      // Same ctx, flag toggled: the outcome must be IDENTICAL (security, rules,
      // and the classifier/hard-floor at Relaxed all agree with the legacy floor).
      delete process.env.ACCESS_LEVELS_V1;
      const off = gate(call, undefined, ctxExtra(cwd ?? WS, shellCwd));
      process.env.ACCESS_LEVELS_V1 = '1';
      const on = gate(call, 'relaxed', ctxExtra(cwd ?? WS, shellCwd));
      expect(on).toEqual(off);
    });
  }
});

// The plan's explicit tie: for calls that REACH the floor (not caught by security
// or a rule first), the Relaxed gate asks exactly when the sensitivity floor does.
describe('Relaxed gate asks exactly when the sensitivity floor asks (floor-reaching subset)', () => {
  const FLOOR_SUBSET: Fixture[] = [
    { call: bash('ls -la') },                                   // run
    { call: bash('rm scratch.txt') },                           // safe delete → run
    { call: tool('mcp__composio__GMAIL_SEND_EMAIL') },          // send → run at Relaxed
    { call: bash('rm -rf scratch/') },                          // dangerous → ask
    { call: bash('rm hostname'), cwd: WS, shellCwd: '/etc' },   // escapes → ask
    { call: tool('mcp__composio__STRIPE_CREATE_CHARGE') },      // payment → ask
    { call: tool('mcp__composio__GITHUB_DELETE_REPO') },        // delete → ask
  ];
  for (const { call, cwd, shellCwd } of FLOOR_SUBSET) {
    const cmd = call.toolName === 'Bash' ? `(${String((call.toolInput as { command?: string }).command)})` : '';
    it(`${call.toolName}${cmd}`, () => {
      const floorAsks = sensitivityFloorAsks(call, { workspaceRoot: cwd ?? WS, shellCwd });
      process.env.ACCESS_LEVELS_V1 = '1';
      const asks = gate(call, 'relaxed', ctxExtra(cwd ?? WS, shellCwd)).decision === 'needs_human';
      expect(asks).toBe(floorAsks);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FLAG-ON feature behavior across the levels.
// ─────────────────────────────────────────────────────────────────────────────

describe('flag ON — level behavior', () => {
  it('Careful asks before a workspace edit; Balanced runs it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(asksAt(tool('Write', { file_path: 'a.txt' }), 'careful')).toBe(true);
    expect(asksAt(tool('Write', { file_path: 'a.txt' }), 'balanced')).toBe(false);
  });

  it('Balanced asks before a Gmail send; Relaxed runs it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(asksAt(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'balanced')).toBe(true);
    expect(asksAt(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'relaxed')).toBe(false);
  });

  it('an Always-allow rule silences the Balanced send (level ask sits BELOW allow rules)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'balanced', {
      permissionRules: { allow: [{ toolName: 'mcp__composio__GMAIL_SEND_EMAIL' }], ask: [], deny: [] },
    });
    expect(r.decision).toBe('allow');
  });

  it('NO allow rule can silence a payment (hard floor sits ABOVE allow rules)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), 'autopilot', {
      permissionRules: { allow: [{ toolName: 'mcp__composio__STRIPE_CREATE_CHARGE' }], ask: [], deny: [] },
    });
    expect(r.decision).toBe('needs_human');
  });

  it('Autopilot runs a dangerous rm but still asks for a payment', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(bash('rm -rf scratch/'), 'autopilot').decision).toBe('allow');
    expect(asksAt(tool('mcp__composio__STRIPE_CREATE_CHARGE'), 'autopilot')).toBe(true);
  });

  it('dontAsk converts BOTH the hard floor and the level ask to a hard deny', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    // hard floor (payment) under dontAsk → deny
    const pay = gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), 'relaxed', { mode: 'dontAsk' });
    expect(pay.decision).toBe('deny');
    // level ask (Balanced send) under dontAsk → deny
    const send = gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'balanced', { mode: 'dontAsk' });
    expect(send.decision).toBe('deny');
  });

  it('a deny rule still beats the level machinery (deny wins)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const r = gate(bash('ls'), 'autopilot', {
      permissionRules: { allow: [], ask: [], deny: [{ toolName: 'Bash', ruleContent: 'ls:*' }] },
    });
    expect(r.decision).toBe('deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODE × LEVEL — the permissive modes (bypassPermissions / acceptEdits) must NOT
// swallow the soft LEVEL ASKS when a level is active. The sandbox's PRODUCTION
// default mode IS bypassPermissions, so without this the level asks never fire in
// prod and Careful/Balanced are inert. The hard floor sits ABOVE mode and is
// unaffected. `dontAsk`/`plan` semantics are unchanged. (Regression for the A1
// post-merge bug — mode step short-circuited above the level-asks step.)
// ─────────────────────────────────────────────────────────────────────────────

describe('level asks survive bypassPermissions / acceptEdits (flag ON)', () => {
  it('Balanced + bypassPermissions: a Gmail send still asks', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(asksAt(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'balanced', { mode: 'bypassPermissions' })).toBe(true);
  });

  it('Careful + acceptEdits: an Edit still asks', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(asksAt(tool('Edit', { file_path: 'a.txt' }), 'careful', { mode: 'acceptEdits' })).toBe(true);
  });

  it('Careful + bypassPermissions: a workspace-write Bash still asks', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(asksAt(bash('mkdir foo'), 'careful', { mode: 'bypassPermissions' })).toBe(true);
  });

  it('Relaxed + bypassPermissions: equivalence holds (payment/delete ask, send/read run)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const m = { mode: 'bypassPermissions' as const };
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), 'relaxed', m).decision).toBe('needs_human');
    expect(gate(bash('rm -rf scratch/'), 'relaxed', m).decision).toBe('needs_human');
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), 'relaxed', m).decision).toBe('allow');
    expect(gate(bash('ls -la'), 'relaxed', m).decision).toBe('allow');
  });

  it('Autopilot + bypassPermissions: mutation runs, dangerous rm runs, payment asks', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const m = { mode: 'bypassPermissions' as const };
    expect(gate(tool('mcp__composio__NOTION_UPDATE_PAGE'), 'autopilot', m).decision).toBe('allow');
    expect(gate(bash('rm -rf scratch/'), 'autopilot', m).decision).toBe('allow');
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), 'autopilot', m).decision).toBe('needs_human');
  });

  it('flag OFF: bypassPermissions still auto-allows everything past the floor (level ignored, byte-identical)', () => {
    delete process.env.ACCESS_LEVELS_V1;
    expect(gate(tool('Write', { file_path: 'a.txt' }), 'careful', { mode: 'bypassPermissions' }).decision).toBe('allow');
    expect(gate(tool('Edit', { file_path: 'a.txt' }), 'careful', { mode: 'acceptEdits' }).decision).toBe('allow');
    expect(gate(bash('mkdir foo'), 'balanced', { mode: 'bypassPermissions' }).decision).toBe('allow');
  });
});
