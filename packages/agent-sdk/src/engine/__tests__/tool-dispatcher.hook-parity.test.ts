/**
 * X1 — the tool-gate hook events fire on the native arm, through the REAL
 * `gateAndDispatchTool` chokepoint, with the documented Claude Code payloads and
 * block / allow / rewrite semantics. Fixtures: kernel/hooks/__tests__/fixtures.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { decideToolGate, type ToolGateContext } from '../../policy/decide-tool-gate.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import { toolError } from '../../tools/tool-types.js';
import { toolBillingEvent } from '../tool-billing.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { HookEvent, HookInput, HookJSONOutput } from '../../kernel/index.js';
import {
  CLAUDE_CODE_HOOK_EVENTS as EV,
  CLAUDE_CODE_HOOK_OUTPUTS as OUT,
  shapeMismatches,
} from '../../kernel/hooks/__tests__/fixtures/claude-code-hook-events.js';

const CARD: GateResult = { decision: 'needs_human', interactionKind: 'tool_permission' };
const toolInput = () => ({ ...EV.PreToolUse.stdin.tool_input });
const TOOL_OUTPUT = 'npm test: 42 passing';

afterEach(() => { delete process.env.HOOK_PARITY_V1; delete process.env.ACCESS_LEVELS_V1; delete process.env.SECURITY_PATTERNS_V2; });

type Gate = GateResult | ((call: ToolCall) => GateResult);

/** One tool call through the chokepoint, with `hooks` registered after the floor. */
async function run(
  gate: Gate,
  hooks: Array<[HookEvent, (i: HookInput) => HookJSONOutput]> = [],
  toolName = 'Bash',
  input: Record<string, unknown> = toolInput(),
) {
  const seen: Array<{ event: string; input: Record<string, unknown> }> = [];
  const gated: unknown[] = [];
  const gateTool = async (c: ToolCall): Promise<GateResult> => {
    gated.push(c.toolInput);
    return typeof gate === 'function' ? gate(c) : gate;
  };
  const tool: RawToolOptions = {
    name: toolName, description: 't', parameters: { type: 'object' },
    execute: vi.fn(async (args: unknown) => {
      seen.push({ event: 'execute', input: args as Record<string, unknown> });
      return TOOL_OUTPUT;
    }),
  };
  const dispatcher = createNativeHookDispatcher({ gateTool });
  const record = (event: HookEvent, reply: (i: HookInput) => HookJSONOutput = () => ({})) =>
    dispatcher.register(event, {}, (input) => {
      seen.push({ event, input: input as unknown as Record<string, unknown> });
      return reply(input);
    });
  for (const e of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification'] as const) {
    record(e, hooks.find(([ev]) => ev === e)?.[1]);
  }
  const pushed: HarnessEvent[] = [];
  const onPause = vi.fn(async (_call: ToolCall, _kind: string) => 'PAUSED_HALT');
  const result = await gateAndDispatchTool(tool, input, 'toolu_01ABC123...', { gateTool }, onPause, undefined, {
    dispatcher, sessionId: 'abc123', pushEvent: (ev) => pushed.push(ev),
  });
  return {
    result, seen, onPause, gated, pushed,
    order: seen.map((s) => s.event),
    of: (e: string) => seen.find((s) => s.event === e)?.input,
  };
}

/** Allows the documented rewrite target, cards everything else. */
const allowsLint: Gate = (c) => ((c.toolInput as { command?: string }).command === 'npm run lint' ? { decision: 'allow' } : CARD);

describe('X1 — PreToolUse / PostToolUse fire at the documented moments with the documented payloads', () => {
  it('PreToolUse before the tool runs, PostToolUse after it, each shaped as documented', async () => {
    const r = await run({ decision: 'allow' });
    expect(r.order).toEqual(['PreToolUse', 'execute', 'PostToolUse']);
    expect(shapeMismatches('PreToolUse', r.of('PreToolUse')!)).toEqual([]);
    expect(shapeMismatches('PostToolUse', r.of('PostToolUse')!)).toEqual([]);
    expect(r.of('PreToolUse')).toMatchObject({ session_id: 'abc123', tool_use_id: 'toolu_01ABC123...', tool_input: toolInput() });
    expect(r.of('PostToolUse')).toMatchObject({ tool_response: TOOL_OUTPUT, tool_input: toolInput() });
  });

  it('permissionDecision "deny" blocks: the tool never runs and the model reads the reason', async () => {
    const r = await run({ decision: 'allow' }, [['PreToolUse', () => OUT.preToolUseDeny]]);
    expect(r.order).toEqual(['PreToolUse']);
    expect(r.result).toMatchObject({ isError: true, text: 'Database writes are not allowed' });
  });

  it('updatedInput is applied only with allow', async () => {
    const rewrite = { field_to_modify: 'new value' };
    const allow = await run({ decision: 'allow' }, [['PreToolUse', () => OUT.preToolUseAllowRewrite]]);
    expect(allow.of('execute')).toEqual(rewrite);

    const ask = await run({ decision: 'allow' }, [['PreToolUse', () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: rewrite },
    })]]);
    expect(ask.of('execute')).toBeUndefined();
    // PRE_TOOL_USE_ASK_REWRITE_NOT_SHOWN: the card is for the model's own call.
    expect(ask.onPause.mock.calls[0]![0].toolInput).toEqual(toolInput());

    const deny = await run({ decision: 'allow' }, [['PreToolUse', () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', updatedInput: rewrite },
    })]]);
    expect(deny.of('execute')).toBeUndefined();
  });
});

describe('X1 — HOOK_PARITY_V1 off: byte-identical', () => {
  it('neither PermissionRequest nor Notification fires and the card result is unchanged', async () => {
    const bare = await run(CARD);
    const withHooks = await run(CARD, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]]);
    expect(withHooks.order).toEqual([]); // the floor's ask ends the PreToolUse chain
    expect(withHooks.result).toEqual(bare.result);
    expect(withHooks.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: 'PAUSED_HALT', isError: false, pausedHalt: true });
    expect(withHooks.onPause).toHaveBeenCalledTimes(1);
  });

  it('a PreToolUse top-level block still stops the turn, a PostToolUse block still changes nothing', async () => {
    const pre = await run({ decision: 'allow' }, [['PreToolUse', () => OUT.topLevelBlock]]);
    expect(pre.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: OUT.topLevelBlock.reason, isError: true, pausedHalt: true });
    const post = await run({ decision: 'allow' }, [['PostToolUse', () => OUT.topLevelBlock]]);
    expect(post.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: TOOL_OUTPUT, isError: false });
  });
});

describe('X1 — HOOK_PARITY_V1 on: PermissionRequest answers the card, Notification marks it', () => {
  const on = () => { process.env.HOOK_PARITY_V1 = 'true'; };

  it('fires at the card with the documented payload; allow runs the rewrite (re-gated), no card', async () => {
    on();
    const r = await run(allowsLint, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]]);
    expect(r.order).toEqual(['PermissionRequest', 'execute', 'PostToolUse']);
    expect(shapeMismatches('PermissionRequest', r.of('PermissionRequest')!)).toEqual([]);
    expect(r.of('PermissionRequest')).not.toHaveProperty('tool_use_id');
    expect(r.of('PermissionRequest')).toMatchObject({ session_id: 'abc123', tool_name: 'Bash', tool_input: toolInput() });
    expect(r.gated).toEqual([toolInput(), { command: 'npm run lint' }]);
    expect(r.of('execute')).toEqual({ command: 'npm run lint' });
    expect(r.onPause).not.toHaveBeenCalled();
    expect(r.result).toMatchObject({ isError: false, text: TOOL_OUTPUT });
  });

  it('allow with no rewrite runs the call the floor judged, without gating it again', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })]]);
    expect(r.gated).toHaveLength(1);
    expect(r.of('execute')).toEqual(toolInput());
    expect(r.onPause).not.toHaveBeenCalled();
  });

  it('a rewrite the floor denies is denied, whatever the hook said', async () => {
    on();
    const denyLint: Gate = (c) => ((c.toolInput as { command?: string }).command === 'npm run lint'
      ? { decision: 'deny', message: 'lint is off limits', reasonType: 'rule' } : CARD);
    const r = await run(denyLint, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]]);
    expect(r.of('execute')).toBeUndefined();
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: 'lint is off limits', isError: true, refused: true });
    expect(r.pushed).toEqual([expect.objectContaining({ event: 'permission:denied', data: expect.objectContaining({ reasonType: 'rule' }) })]);
  });

  it('PERMISSION_REQUEST_REWRITE_KEEPS_CARD: a rewrite that still needs a card shows the original card', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]]);
    expect(r.of('execute')).toBeUndefined();
    expect(r.order).toEqual(['PermissionRequest', 'Notification']);
    expect(r.onPause.mock.calls[0]![0].toolInput).toEqual(toolInput());
    expect(r.result).toMatchObject({ pausedHalt: true, text: 'PAUSED_HALT' });
  });

  it('deny blocks with its message, no card', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => OUT.permissionRequestDeny]]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: 'Not on this box', isError: true, refused: true });
    expect(r.onPause).not.toHaveBeenCalled();
    expect(r.of('execute')).toBeUndefined();
    expect(r.order).toEqual(['PermissionRequest']);
  });

  it('unanswered: Notification permission_prompt fires as documented and cannot stop the card', async () => {
    on();
    const r = await run(CARD, [['Notification', () => ({ continue: false })]]);
    expect(r.order).toEqual(['PermissionRequest', 'Notification']);
    expect(shapeMismatches('Notification', r.of('Notification')!)).toEqual([]);
    expect(r.of('Notification')).toMatchObject({ session_id: 'abc123', notification_type: 'permission_prompt', message: 'Needs your permission to use Bash' });
    const { message, title } = r.of('Notification') as { message: string; title: string };
    expect(`${message} ${title}`).not.toMatch(/claude/i);
    expect(r.result).toMatchObject({ pausedHalt: true, text: 'PAUSED_HALT' });
  });

  it('PERMISSION_REQUEST_HALT_IGNORED: continue:false is not an answer, the card shows', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => OUT.stopEverything]]);
    expect(r.onPause).toHaveBeenCalledTimes(1);
    expect(r.order).toEqual(['PermissionRequest', 'Notification']);
  });

  it('PERMISSION_REQUEST_NEVER_FOR_PAYMENTS_DELETES_OR_ASK_RULES: release_browser shows its card whatever a hook would say', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]], 'release_browser');
    expect(r.order).toEqual(['Notification']);
    expect(r.onPause).toHaveBeenCalledTimes(1);
  });

  it('PERMISSION_REQUEST_TOOL_PERMISSION_ONLY: a card that is not a tool permission fires neither', async () => {
    on();
    const r = await run({ decision: 'needs_human', interactionKind: 'credit_approval' }, [['PermissionRequest', () => OUT.permissionRequestAllowRewrite]]);
    expect(r.order).toEqual([]);
    expect(r.onPause).toHaveBeenCalledTimes(1);
  });

  it('a PreToolUse top-level block refuses this one tool and the turn goes on', async () => {
    on();
    const r = await run({ decision: 'allow' }, [['PreToolUse', () => OUT.topLevelBlock]]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: OUT.topLevelBlock.reason, isError: true, refused: true });
    expect(r.of('execute')).toBeUndefined();
  });

  it('a PostToolUse block puts its reason beside the result the model still sees', async () => {
    on();
    const r = await run({ decision: 'allow' }, [['PostToolUse', () => OUT.topLevelBlock]]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: `${TOOL_OUTPUT}\n${OUT.topLevelBlock.reason}`, isError: false });
    const stop = await run({ decision: 'allow' }, [['PostToolUse', () => OUT.stopEverything]]);
    expect(stop.result).toMatchObject({ text: TOOL_OUTPUT });
  });
});

/**
 * The REAL gate ladder (decideToolGate), as production runs it: bypassPermissions (the
 * sandbox default mode) and, where a level is named, ACCESS_LEVELS_V1 on.
 */
function realGate(extra: Partial<ToolGateContext> = {}): Gate {
  const ctx: ToolGateContext = {
    mode: 'bypassPermissions',
    cwd: '/app/workspace',
    connectedComposioToolkits: new Set(['stripe']),
    permissionRules: { allow: [], ask: [], deny: [] },
    ...extra,
  };
  return (c) => decideToolGate(c, ctx);
}
const allowHook: Array<[HookEvent, (i: HookInput) => HookJSONOutput]> = [
  ['PermissionRequest', () => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })],
];

describe('X1 — through the REAL decideToolGate: a hook silences a card only where an allow rule could', () => {
  const on = (levels = true) => { process.env.HOOK_PARITY_V1 = 'true'; if (levels) process.env.ACCESS_LEVELS_V1 = 'true'; };
  const cardStands = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.order).toEqual(['Notification']); // no PermissionRequest dispatch, the card is marked
    expect(r.onPause).toHaveBeenCalledTimes(1);
    expect(r.of('execute')).toBeUndefined();
    expect(r.result).toMatchObject({ pausedHalt: true, text: 'PAUSED_HALT' });
  };

  it('a dangerous delete at Relaxed (the hard floor): the card still shows', async () => {
    on();
    cardStands(await run(realGate({ accessLevel: 'relaxed' }), allowHook, 'Bash', { command: 'rm -rf scratch/' }));
  });

  it('a dangerous delete on the legacy sensitivity floor (no level): the card still shows', async () => {
    on(false);
    cardStands(await run(realGate(), allowHook, 'Bash', { command: 'rm -rf scratch/' }));
  });

  it('a Composio payment at Relaxed: the card still shows', async () => {
    on();
    cardStands(await run(realGate({ accessLevel: 'relaxed' }), allowHook, 'mcp__composio__STRIPE_CREATE_CHARGE', { amount: 5000 }));
  });

  it('the person\'s own ask rule: the card still shows', async () => {
    on();
    const askRule = realGate({ accessLevel: 'relaxed', permissionRules: { allow: [], deny: [], ask: [{ toolName: 'Bash', ruleContent: 'npm publish:*' }] } });
    cardStands(await run(askRule, allowHook, 'Bash', { command: 'npm publish' }));
  });

  it('`rm -rf ./x` never reaches a card: the security gate refuses it first', async () => {
    on();
    delete process.env.SECURITY_PATTERNS_V2;   // today's regex table
    const r = await run(realGate({ accessLevel: 'relaxed' }), allowHook, 'Bash', { command: 'rm -rf ./x' });
    expect(r.order).toEqual([]);
    expect(r.result).toMatchObject({ isError: true, text: expect.stringContaining('Security:') });
  });

  it('SECURITY_PATTERNS_V2 on: `rm -rf ./x` is no catalog member, so it reaches its card, which a hook cannot silence', async () => {
    on();
    process.env.SECURITY_PATTERNS_V2 = 'true';
    cardStands(await run(realGate({ accessLevel: 'relaxed' }), allowHook, 'Bash', { command: 'rm -rf ./x' }));
  });

  it('a level ask an allow rule could silence (Careful, a workspace write): the hook answers it, no card', async () => {
    on();
    const r = await run(realGate({ accessLevel: 'careful' }), allowHook, 'Write', { file_path: '/app/workspace/notes.md', content: 'x' });
    expect(r.order).toEqual(['PermissionRequest', 'execute', 'PostToolUse']);
    expect(r.onPause).not.toHaveBeenCalled();
  });
});

describe('X1 — a PreToolUse hook\'s rewrite is judged on its own (HOOK_PARITY_V1)', () => {
  const toRootWipe: Array<[HookEvent, (i: HookInput) => HookJSONOutput]> = [
    ['PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'rm -rf /' } } })],
  ];

  for (const v2 of [false, true]) {
    it(`a system hook rewriting \`ls\` into \`rm -rf /\` is refused by the security gate (SECURITY_PATTERNS_V2 ${v2 ? 'on' : 'off'})`, async () => {
      process.env.HOOK_PARITY_V1 = 'true';
      if (v2) process.env.SECURITY_PATTERNS_V2 = 'true'; else delete process.env.SECURITY_PATTERNS_V2;
      const r = await run(realGate(), toRootWipe, 'Bash', { command: 'ls' });
      expect(r.of('execute')).toBeUndefined();
      expect(r.result).toMatchObject({ isError: true, text: expect.stringContaining(v2 ? 'Recursive delete of /' : 'Recursive deletion from root') });
      expect(r.pushed).toEqual([expect.objectContaining({ event: 'permission:denied', data: expect.objectContaining({ reasonType: 'security' }) })]);
    });
  }

  it('a rewrite that needs a card shows the card for the ORIGINAL call', async () => {
    process.env.HOOK_PARITY_V1 = 'true';
    const toDelete: Array<[HookEvent, (i: HookInput) => HookJSONOutput]> = [
      ['PreToolUse', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'rm -rf scratch/' } } })],
    ];
    const r = await run(realGate(), toDelete, 'Bash', { command: 'ls' });
    expect(r.of('execute')).toBeUndefined();
    expect(r.onPause.mock.calls[0]![0].toolInput).toEqual({ command: 'ls' });
  });

  it('a rewrite the gate allows runs', async () => {
    process.env.HOOK_PARITY_V1 = 'true';
    const r = await run(realGate(), [['PreToolUse', () => OUT.preToolUseAllowRewrite]], 'Bash', { command: 'ls' });
    expect(r.of('execute')).toEqual({ field_to_modify: 'new value' });
  });

  it('off: today\'s path, the rewrite runs unjudged (byte-identical)', async () => {
    const r = await run(realGate(), toRootWipe, 'Bash', { command: 'ls' });
    expect(r.of('execute')).toEqual({ command: 'rm -rf /' });
  });
});

describe('X1 — context beside the result, a PermissionRequest interrupt, the documented matchers (HOOK_PARITY_V1)', () => {
  const on = () => { process.env.HOOK_PARITY_V1 = 'true'; };
  const said = (event: 'PreToolUse' | 'PostToolUse', additionalContext: string): HookJSONOutput =>
    ({ hookSpecificOutput: { hookEventName: event, additionalContext } }) as HookJSONOutput;

  it('PreToolUse then PostToolUse context ride beside the result the model reads', async () => {
    on();
    const r = await run({ decision: 'allow' }, [
      ['PreToolUse', () => said('PreToolUse', 'Environment: production.')],
      ['PostToolUse', () => said('PostToolUse', 'This file is generated.')],
    ]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: `${TOOL_OUTPUT}\nEnvironment: production.\nThis file is generated.`, isError: false });
  });

  it('a PreToolUse deny\'s context rides beside the refusal the model reads; the card keeps the reason alone', async () => {
    on();
    const r = await run({ decision: 'allow' }, [['PreToolUse', () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No writes', additionalContext: 'Use the staging DB.' },
    })]]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: 'No writes\nUse the staging DB.', isError: true, refused: true });
    expect(r.pushed).toEqual([expect.objectContaining({ event: 'permission:denied', data: expect.objectContaining({ reason: 'No writes' }) })]);
  });

  // Review of #4284, MED-3 (CR4): the context rides beside an error in code, but no test failed when
  // it was reverted. Both error paths, the order pinned: the tool's words, PreToolUse's context,
  // PostToolUseFailure's, then (a sentinel) the stamp at the tail.
  const failSaid = (additionalContext: string): HookJSONOutput =>
    ({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext } }) as HookJSONOutput;
  async function runFailing(fails: 'throws' | 'sentinel') {
    const gateTool = async (): Promise<GateResult> => ({ decision: 'allow' });
    const tool: RawToolOptions = {
      name: 'Bash', description: 't', parameters: { type: 'object' },
      execute: vi.fn(async () => {
        if (fails === 'throws') throw new Error('npm test: 3 failing');
        return toolError('exec_failed', 'npm test: 3 failing');
      }),
    };
    const dispatcher = createNativeHookDispatcher({ gateTool });
    dispatcher.register('PreToolUse', {}, () => said('PreToolUse', 'Environment: production.'));
    dispatcher.register('PostToolUseFailure', {}, () => failSaid('Flaky on CI; rerun once.'));
    return gateAndDispatchTool(tool, toolInput(), 'toolu_01ABC123...', { gateTool }, vi.fn(async () => 'PAUSED_HALT'), undefined, {
      dispatcher, sessionId: 'abc123', pushEvent: () => {}, ...(fails === 'sentinel' && { toolErrorTaxonomy: true }),
    });
  }

  it('a tool that throws: PreToolUse then PostToolUseFailure context ride beside the error', async () => {
    on();
    expect(await runFailing('throws')).toMatchObject({ text: 'npm test: 3 failing\nEnvironment: production.\nFlaky on CI; rerun once.', isError: true });
  });

  it('a tool that returns an error sentinel: the context rides inside, the stamp stays at the tail', async () => {
    on();
    expect(await runFailing('sentinel')).toMatchObject({ text: 'npm test: 3 failing\nEnvironment: production.\nFlaky on CI; rerun once. [error:exec_failed]', isError: true });
  });

  it('off: an error carries no hook context on either path (byte-identical)', async () => {
    expect((await runFailing('throws')).text).toBe('npm test: 3 failing');
    expect((await runFailing('sentinel')).text).toBe('npm test: 3 failing [error:exec_failed]');
  });

  it('off: context reaches nothing, the result is byte-identical', async () => {
    const r = await run({ decision: 'allow' }, [
      ['PreToolUse', () => said('PreToolUse', 'Environment: production.')],
      ['PostToolUse', () => said('PostToolUse', 'This file is generated.')],
    ]);
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: TOOL_OUTPUT, isError: false });
  });

  it('a PermissionRequest deny with interrupt:true refuses the tool like a deny and marks the turn to stop (never a pause), no card', async () => {
    on();
    const r = await run(CARD, [['PermissionRequest', () => ({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Production is frozen', interrupt: true } },
    }) as HookJSONOutput]]);
    // `refused`: the tool never ran, so it bills nothing (toolBillingEvent skips a refusal).
    expect(r.result).toEqual({ toolUseId: 'toolu_01ABC123...', text: 'Production is frozen', isError: true, refused: true, hookStop: 'Production is frozen' });
    expect(toolBillingEvent({ taskId: 't', toolName: 'Bash', toolUseId: 'toolu_01ABC123...' }, r.result)).toBeUndefined();
    expect(r.pushed).toEqual([expect.objectContaining({ event: 'permission:denied', data: expect.objectContaining({ reason: 'Production is frozen' }) })]);
    expect(r.of('execute')).toBeUndefined();
    expect(r.onPause).not.toHaveBeenCalled();
    expect(r.order).toEqual(['PermissionRequest']); // answered, so no permission_prompt Notification
  });

  it('createNativeHookDispatcher matches the documented way only with the flag on (a Notification matcher on notification_type)', async () => {
    const notified = async () => {
      const d = createNativeHookDispatcher({ gateTool: async () => ({ decision: 'allow' }) });
      let ran = false;
      d.register('Notification', { matcher: 'permission_prompt' }, () => { ran = true; return {}; });
      await d.dispatch('Notification', { ...EV.Notification.stdin } as unknown as HookInput, { signal: new AbortController().signal });
      return ran;
    };
    expect(await notified()).toBe(false);
    on();
    expect(await notified()).toBe(true);
  });
});
