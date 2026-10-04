import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate, compileAccessConfig } from '../../index.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { AccessConfig } from '../access-config.js';
import { ACCESS_LEVELS } from '../access-level.js';

// B1b — the gate consumes a CompiledAccessConfig. The three load-bearing
// guarantees, in order of blast radius:
//   1. PRESET EQUIVALENCE: {accessConfig: compile({level: L})} decides exactly
//      like {accessLevel: L} — the config path is a strict generalization.
//   2. OFF/ON-base byte-identity: flag off ⇒ a threaded config changes nothing;
//      flag on without a config ⇒ the preset level path is untouched.
//   3. Custom semantics: family toggles (soft, grant-decayable — except the
//      hard delete floor), per-app ask/allow/block pins (block beats
//      everything; ask-pin is hard; allow-pin silences), payment untouchable.

const WS = '/app/workspace';
// Every toolkit the corpus touches, marked connected so the classifier's
// composio_auth gate never fires — isolating the CONFIG/LEVEL decision under test.
const CONNECTED = new Set(['gmail', 'slack', 'stripe', 'github', 'notion']);

const bash = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });
const tool = (toolName: string, toolInput: unknown = {}): ToolCall => ({ toolName, toolInput, toolCallId: 't' });

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

afterEach(() => { delete process.env.ACCESS_LEVELS_V1; });

// One representative call per side-effect family (the plan's call matrix).
const MATRIX: { name: string; call: ToolCall }[] = [
  { name: 'Read (readonly)', call: tool('Read', { file_path: 'a.txt' }) },
  { name: 'Write (workspace_write)', call: tool('Write', { file_path: 'a.txt' }) },
  { name: 'GMAIL_SEND_EMAIL (external_send)', call: tool('mcp__composio__GMAIL_SEND_EMAIL') },
  { name: 'NOTION_UPDATE_PAGE (external_mutation)', call: tool('mcp__composio__NOTION_UPDATE_PAGE') },
  { name: 'Bash(rm -rf scratch/) (dangerous_delete)', call: bash('rm -rf scratch/') },
  { name: 'STRIPE_CREATE_CHARGE (payment)', call: tool('mcp__composio__STRIPE_CREATE_CHARGE') },
];
const MODES = ['bypassPermissions', 'default'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRESET EQUIVALENCE (property): for every level × call × mode, the config
//    path with compile({level}) is indistinguishable from the level path —
//    decision, interactionKind, reasonType, message, everything.
// ─────────────────────────────────────────────────────────────────────────────

describe('preset equivalence: {accessConfig: compile({level})} ≡ {accessLevel} (flag ON)', () => {
  for (const level of ACCESS_LEVELS) {
    for (const { name, call } of MATRIX) {
      for (const mode of MODES) {
        it(`${level} × ${name} × ${mode}`, () => {
          process.env.ACCESS_LEVELS_V1 = '1';
          const viaLevel = gate(call, { accessLevel: level, mode });
          const viaConfig = gate(call, { accessConfig: compileAccessConfig({ level }), mode });
          expect(viaConfig).toEqual(viaLevel);
        });
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OFF byte-identity: with the flag unset, a threaded accessConfig changes
//    NOTHING. The Careful compile is the strongest leak detector (it would ask
//    on every write/send/mutation if it leaked through).
// ─────────────────────────────────────────────────────────────────────────────

describe('flag OFF → accessConfig is ignored entirely (byte-identical)', () => {
  for (const { name, call } of MATRIX) {
    for (const mode of MODES) {
      it(`${name} × ${mode}`, () => {
        delete process.env.ACCESS_LEVELS_V1;
        const without = gate(call, { mode });
        const withCfg = gate(call, { mode, accessConfig: compileAccessConfig({ level: 'careful' }) });
        expect(withCfg).toEqual(without);
      });
    }
  }

  it('an app block pin changes nothing when the flag is off', () => {
    delete process.env.ACCESS_LEVELS_V1;
    const cfg = compileAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'block' } } });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessConfig: cfg }).decision).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ON base: flag on, accessLevel set, NO config ⇒ today's level path,
//    cell-for-cell (regression cells from decide-tool-gate.access-level.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

describe('flag ON + accessLevel + NO config → level path unchanged (regression)', () => {
  it('Careful asks before a workspace edit; Balanced runs it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(tool('Write', { file_path: 'a.txt' }), { accessLevel: 'careful' }).decision).toBe('needs_human');
    expect(gate(tool('Write', { file_path: 'a.txt' }), { accessLevel: 'balanced' }).decision).toBe('allow');
  });
  it('Balanced asks before a Gmail send; Relaxed runs it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessLevel: 'balanced' }).decision).toBe('needs_human');
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessLevel: 'relaxed' }).decision).toBe('allow');
  });
  it('an Always-allow rule silences the Balanced send (soft), never a payment (hard)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessLevel: 'balanced', permissionRules: allowRule('mcp__composio__GMAIL_SEND_EMAIL'),
    }).decision).toBe('allow');
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), {
      accessLevel: 'autopilot', permissionRules: allowRule('mcp__composio__STRIPE_CREATE_CHARGE'),
    }).decision).toBe('needs_human');
  });
  it('Autopilot runs a dangerous rm but still asks for a payment', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(bash('rm -rf scratch/'), { accessLevel: 'autopilot' }).decision).toBe('allow');
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), { accessLevel: 'autopilot' }).decision).toBe('needs_human');
  });
  it('bypassPermissions does not swallow the Balanced send ask', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessLevel: 'balanced', mode: 'bypassPermissions',
    }).decision).toBe('needs_human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Custom semantics — global family toggles.
// ─────────────────────────────────────────────────────────────────────────────

describe('custom config — family toggles', () => {
  it('families.workspace_write=ask ⇒ Write asks SOFT (a matching allow rule silences it)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', families: { workspace_write: 'ask' } });
    expect(gate(tool('Write', { file_path: 'a.txt' }), { accessConfig: cfg }).decision).toBe('needs_human');
    expect(gate(tool('Write', { file_path: 'a.txt' }), {
      accessConfig: cfg, permissionRules: allowRule('Write'),
    }).decision).toBe('allow');
  });

  it('families.dangerous_delete=allow ⇒ a dangerous rm runs silent', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', families: { dangerous_delete: 'allow' } });
    expect(gate(bash('rm -rf scratch/'), { accessConfig: cfg }).decision).toBe('allow');
  });

  it('the delete ask is HARD when not lifted — an allow rule does NOT silence it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom' }); // base: delete asks
    expect(gate(bash('rm -rf scratch/'), {
      accessConfig: cfg, permissionRules: allowRule('Bash'),
    }).decision).toBe('needs_human');
  });

  it('payment always asks HARD — no config, rule, or mode can silence it', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: {
        readonly: 'allow', workspace_write: 'allow', external_send: 'allow',
        external_mutation: 'allow', dangerous_delete: 'allow',
      },
      apps: { stripe: { payment: 'allow' } },
    } as AccessConfig);
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
      permissionRules: allowRule('mcp__composio__STRIPE_CREATE_CHARGE'),
    }).decision).toBe('needs_human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Custom semantics — per-app pins.
// ─────────────────────────────────────────────────────────────────────────────

describe('custom config — per-app pins', () => {
  it('apps.gmail.external_send=block ⇒ DENIED past an Always-allow rule AND bypassPermissions', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'block' } } });
    const r = gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessConfig: cfg,
      mode: 'bypassPermissions',
      permissionRules: allowRule('mcp__composio__GMAIL_SEND_EMAIL'),
    });
    expect(r).toEqual({
      decision: 'deny',
      message: 'Blocked by your settings: sending on Gmail.',
      reasonType: 'rule',
    });
  });

  it('the block message uses the shared toolkit display name (multi-word toolkits)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', apps: { googledrive: { readonly: 'block' } } });
    const r = gate(tool('mcp__composio__GOOGLEDRIVE_GET_FILE_METADATA'), { accessConfig: cfg });
    expect(r).toEqual({
      decision: 'deny',
      message: 'Blocked by your settings: reading on Google Drive.',
      reasonType: 'rule',
    });
  });

  it('apps.gmail.external_send=ask pins a HARD ask (allow rule does not decay it); slack stays silent', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    // custom base = relaxed: external_send is globally SILENT — the pin re-gates gmail only.
    const cfg = compileAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'ask' } } });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessConfig: cfg, permissionRules: allowRule('mcp__composio__GMAIL_SEND_EMAIL'),
    }).decision).toBe('needs_human');
    expect(gate(tool('mcp__composio__SLACK_POST_MESSAGE'), { accessConfig: cfg }).decision).toBe('allow');
  });

  it('apps.notion.external_mutation=allow silences notion while the global ask gates others', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_mutation: 'ask' },
      apps: { notion: { external_mutation: 'allow' } },
    });
    expect(gate(tool('mcp__composio__NOTION_UPDATE_PAGE'), { accessConfig: cfg }).decision).toBe('allow');
    expect(gate(tool('mcp__composio__GITHUB_CREATE_ISSUE'), { accessConfig: cfg }).decision).toBe('needs_human');
  });

  it('app entries never affect non-Composio tools', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      apps: { write: { workspace_write: 'block' }, bash: { dangerous_delete: 'allow' } },
    });
    // builtin Write is NOT toolkit 'write' → not blocked (base runs writes silent)
    expect(gate(tool('Write', { file_path: 'a.txt' }), { accessConfig: cfg }).decision).toBe('allow');
    // builtin Bash is NOT toolkit 'bash' → the delete floor is NOT lifted
    expect(gate(bash('rm -rf scratch/'), { accessConfig: cfg }).decision).toBe('needs_human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Precedence: app block > app ask > app allow > global family toggle;
//    config presence beats accessLevel.
// ─────────────────────────────────────────────────────────────────────────────

describe('precedence', () => {
  it('an app block beats a global family allow (and every mode)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'allow' },
      apps: { gmail: { external_send: 'block' } },
    });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessConfig: cfg, mode: 'bypassPermissions',
    }).decision).toBe('deny');
  });

  it('an app ask-pin beats a global family allow', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'allow' },
      apps: { gmail: { external_send: 'ask' } },
    });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessConfig: cfg }).decision).toBe('needs_human');
  });

  it('an app allow-pin beats a global family ask', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({
      level: 'custom',
      families: { external_send: 'ask' },
      apps: { gmail: { external_send: 'allow' } },
    });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessConfig: cfg }).decision).toBe('allow');
  });

  it('config wins when both accessLevel and accessConfig are set — in BOTH directions', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    // loose config beats a strict level: careful would ask on a Write; the custom base runs it
    expect(gate(tool('Write', { file_path: 'a.txt' }), {
      accessLevel: 'careful', accessConfig: compileAccessConfig({ level: 'custom' }),
    }).decision).toBe('allow');
    // strict config beats a loose level: autopilot would run the send; careful-config asks
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), {
      accessLevel: 'autopilot', accessConfig: compileAccessConfig({ level: 'careful' }),
    }).decision).toBe('needs_human');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. dontAsk interplay: every config ask (hard AND soft) becomes the same
//    mode-reason deny the level path produces.
// ─────────────────────────────────────────────────────────────────────────────

describe('dontAsk — config asks become mode denies (mirrors the level path)', () => {
  const DONT_ASK_DENY = {
    decision: 'deny',
    message: 'Denied: this task is set to never ask for permission.',
    reasonType: 'mode',
  };

  it('hard payment ask → deny (mode)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom' });
    expect(gate(tool('mcp__composio__STRIPE_CREATE_CHARGE'), { accessConfig: cfg, mode: 'dontAsk' }))
      .toEqual(DONT_ASK_DENY);
  });

  it('hard delete ask → deny (mode)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom' });
    expect(gate(bash('rm -rf scratch/'), { accessConfig: cfg, mode: 'dontAsk' })).toEqual(DONT_ASK_DENY);
  });

  it('hard app ask-pin → deny (mode)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', apps: { gmail: { external_send: 'ask' } } });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessConfig: cfg, mode: 'dontAsk' }))
      .toEqual(DONT_ASK_DENY);
  });

  it('soft family ask → deny (mode)', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const cfg = compileAccessConfig({ level: 'custom', families: { external_send: 'ask' } });
    expect(gate(tool('mcp__composio__GMAIL_SEND_EMAIL'), { accessConfig: cfg, mode: 'dontAsk' }))
      .toEqual(DONT_ASK_DENY);
  });

  it('mirrors the level path cell-for-cell across the matrix', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    for (const level of ACCESS_LEVELS) {
      for (const { call } of MATRIX) {
        const viaLevel = gate(call, { accessLevel: level, mode: 'dontAsk' });
        const viaConfig = gate(call, { accessConfig: compileAccessConfig({ level }), mode: 'dontAsk' });
        expect(viaConfig).toEqual(viaLevel);
      }
    }
  });
});
