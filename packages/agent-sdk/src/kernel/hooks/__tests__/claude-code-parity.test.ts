/**
 * X1 — the dispatcher folds the documented Claude Code hook outputs the way the
 * reference defines them, and the fixture table leaves no event without a verdict.
 * Fixtures: ./fixtures/claude-code-hook-events.ts.
 */
import { describe, it, expect } from 'vitest';
import { HookDispatcher } from '../dispatcher.js';
import type { HookEvent, HookInput, HookJSONOutput, HookOutcome, PermissionRequestHookInput } from '../contract.js';
import {
  CLAUDE_CODE_HOOK_EVENTS as EV,
  CLAUDE_CODE_HOOK_OUTPUTS as OUT,
  CLAUDE_CODE_HOOKS_DOC,
  CLAUDE_CODE_MATCHER_FIELDS,
  DOCUMENTED_NOTIFICATION_TYPES,
  NATIVE_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES_NOT_SOURCED,
  type ClaudeCodeHookEventName,
  type HookEventFixture,
} from './fixtures/claude-code-hook-events.js';

const ctx = { signal: new AbortController().signal };
const permissionRequest = EV.PermissionRequest.stdin as unknown as PermissionRequestHookInput;

async function fold(event: 'PreToolUse' | 'PermissionRequest' | 'Stop', out: HookJSONOutput, after?: () => void): Promise<HookOutcome> {
  const d = new HookDispatcher();
  d.register(event, {}, () => out);
  d.register(event, {}, () => { after?.(); return {}; });
  const input = event === 'PermissionRequest' ? permissionRequest : { ...EV[event].stdin } as never;
  return d.dispatch(event, input, ctx);
}

describe('X1 — the fixture table: every event has a verdict, nothing is skipped silently', () => {
  const TARGET: HookEvent[] = [
    'PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStart',
    'SubagentStop', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'Notification',
  ];

  it('records the doc version it was transcribed from', () => {
    expect(CLAUDE_CODE_HOOKS_DOC).toMatchObject({ url: expect.stringMatching(/^https:\/\/code\.claude\.com\/docs\/en\/hooks/), fetched: '2026-10-02' });
  });

  it('covers exactly the twelve target events, each a kernel HookEvent', () => {
    expect(Object.keys(EV).sort()).toEqual([...TARGET].sort());
    for (const [name, f] of Object.entries(EV)) expect(f.stdin.hook_event_name).toBe(name);
  });

  it.each(Object.keys(EV) as ClaudeCodeHookEventName[])('%s: every uncarried field and every exception carries a reason', (name) => {
    const f: HookEventFixture = EV[name];
    for (const [field, why] of Object.entries(f.notCarried)) {
      expect(field in f.stdin, `${name}.${field} is not a documented field`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
    for (const e of f.exceptions) {
      expect(e.id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  it('no exception is still a gap to close: every one left is a permanent, explained design choice', () => {
    const gaps = Object.values(EV).flatMap((f: HookEventFixture) => f.exceptions.filter((e) => e.nextSlice).map((e) => e.id));
    expect(gaps).toEqual([]);
  });

  it('every documented Notification type is either fired or named with why a cloud box has no source for it', () => {
    expect([...NATIVE_NOTIFICATION_TYPES, ...Object.keys(NOTIFICATION_TYPES_NOT_SOURCED)].sort()).toEqual([...DOCUMENTED_NOTIFICATION_TYPES].sort());
    for (const why of Object.values(NOTIFICATION_TYPES_NOT_SOURCED)) expect(why.length).toBeGreaterThan(20);
  });

  it('exception ids are unique across the table', () => {
    const ids = Object.values(EV).flatMap((f: HookEventFixture) => f.exceptions.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the documented exit-2 table, as transcribed', () => {
    const exit2 = Object.fromEntries(Object.entries(EV).map(([n, f]) => [n, (f as HookEventFixture).exit2]));
    expect(exit2).toEqual({
      PreToolUse: 'blocks', PermissionRequest: 'ignored', PostToolUse: 'feedback', UserPromptSubmit: 'blocks',
      Stop: 'blocks', SubagentStart: 'ignored', SubagentStop: 'blocks', PreCompact: 'blocks', PostCompact: 'ignored',
      SessionStart: 'ignored', SessionEnd: 'ignored', Notification: 'ignored',
    });
  });
});

describe('X1 — documented outputs fold to the documented verdicts', () => {
  it('PreToolUse permissionDecision "deny" blocks and ends the chain', async () => {
    let laterRan = false;
    const o = await fold('PreToolUse', OUT.preToolUseDeny, () => { laterRan = true; });
    expect(o).toEqual({ decision: 'continue', permissionDecision: 'deny', permissionDecisionReason: 'Database writes are not allowed' });
    expect(laterRan).toBe(false);
  });

  it('PermissionRequest behavior "allow" carries its updatedInput and lets the chain continue', async () => {
    let laterRan = false;
    const o = await fold('PermissionRequest', OUT.permissionRequestAllowRewrite, () => { laterRan = true; });
    expect(o).toEqual({ decision: 'continue', permissionDecision: 'allow', updatedInput: { command: 'npm run lint' } });
    expect(laterRan).toBe(true);
  });

  it('PermissionRequest behavior "deny" blocks with its message and never carries updatedInput', async () => {
    let laterRan = false;
    const denyWithRewrite = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on this box', updatedInput: { command: 'x' } } },
    } as unknown as HookJSONOutput;
    const o = await fold('PermissionRequest', denyWithRewrite, () => { laterRan = true; });
    expect(o).toEqual({ decision: 'continue', permissionDecision: 'deny', permissionDecisionReason: 'Not on this box' });
    expect(laterRan).toBe(false);
  });

  it('a later PermissionRequest deny overrides an earlier allow and drops its rewrite', async () => {
    const d = new HookDispatcher();
    d.register('PermissionRequest', {}, () => OUT.permissionRequestAllowRewrite);
    d.register('PermissionRequest', {}, () => OUT.permissionRequestDeny);
    expect(await d.dispatch('PermissionRequest', permissionRequest, ctx)).toEqual({
      decision: 'continue', permissionDecision: 'deny', permissionDecisionReason: 'Not on this box',
    });
  });

  it('a PermissionRequest with no decision object is no answer', async () => {
    expect(await fold('PermissionRequest', { hookSpecificOutput: { hookEventName: 'PermissionRequest' } })).toEqual({ decision: 'continue' });
  });

  it('a PermissionRequest matcher is tested against tool_name', async () => {
    const d = new HookDispatcher();
    d.register('PermissionRequest', { matcher: '^Write$' }, () => OUT.permissionRequestDeny);
    expect(await d.dispatch('PermissionRequest', permissionRequest, ctx)).toEqual({ decision: 'continue' });
    d.register('PermissionRequest', { matcher: '^Bash$' }, () => OUT.permissionRequestDeny);
    expect(await d.dispatch('PermissionRequest', permissionRequest, ctx)).toMatchObject({ permissionDecision: 'deny' });
  });

  it('a top-level decision "block" halts marked as a block, so Stop can keep going on it', async () => {
    expect(await fold('Stop', OUT.topLevelBlock)).toEqual({
      decision: 'halt', stopReason: 'Test suite must pass before proceeding', blocked: true,
    });
  });

  it('continue:false halts unmarked: it stops everything and wins over a block', async () => {
    expect(await fold('Stop', OUT.stopEverything)).toEqual({ decision: 'halt', stopReason: 'Build failed, fix errors before continuing' });
    expect(await fold('Stop', { ...OUT.topLevelBlock, continue: false })).toEqual({
      decision: 'halt', stopReason: 'Test suite must pass before proceeding',
    });
  });
});

/** Run one group with `matcher` on `event` over `input`; did it fire? */
async function fires(event: HookEvent, matcher: string | undefined, input: HookInput, claudeCodeMatchers: boolean): Promise<boolean> {
  const d = new HookDispatcher({ claudeCodeMatchers });
  let ran = false;
  d.register(event, matcher === undefined ? {} : { matcher }, () => { ran = true; return {}; });
  await d.dispatch(event, input, ctx);
  return ran;
}
const stdin = (event: ClaudeCodeHookEventName, extra: Record<string, unknown> = {}) =>
  ({ ...EV[event].stdin, ...extra }) as unknown as HookInput;

describe('X1 — matchers as the reference evaluates them (claudeCodeMatchers, the host sets it under HOOK_PARITY_V1)', () => {
  const tool = (name: string) => stdin('PreToolUse', { tool_name: name });

  it('letters, digits, _, -, spaces, "," and "|" are an exact name or a list of names', async () => {
    expect(await fires('PreToolUse', 'Bash', tool('Bash'), true)).toBe(true);
    expect(await fires('PreToolUse', 'Bash', tool('BashOutput'), true)).toBe(false);
    for (const m of ['Edit|Write', 'Edit, Write', 'Edit,Write']) {
      expect(await fires('PreToolUse', m, tool('Edit'), true)).toBe(true);
      expect(await fires('PreToolUse', m, tool('Write'), true)).toBe(true);
      expect(await fires('PreToolUse', m, tool('NotebookEdit'), true)).toBe(false);
    }
    expect(await fires('PreToolUse', 'mcp__memory__create', tool('mcp__memory__create_entities'), true)).toBe(false);
  });

  it('"*", "" and no matcher match everything; any other character makes an unanchored regex', async () => {
    for (const m of ['*', '', undefined]) expect(await fires('PreToolUse', m, tool('Anything'), true)).toBe(true);
    expect(await fires('PreToolUse', '^Notebook', tool('NotebookEdit'), true)).toBe(true);
    expect(await fires('PreToolUse', 'mcp__memory__.*', tool('mcp__memory__create_entities'), true)).toBe(true);
    expect(await fires('PreToolUse', 'Edit.*', tool('NotebookEdit'), true)).toBe(true);
    expect(await fires('PreToolUse', '(', tool('('), true)).toBe(false); // malformed: non-matching, never throws
  });

  it.each(Object.entries(CLAUDE_CODE_MATCHER_FIELDS) as Array<[ClaudeCodeHookEventName, string | null]>)(
    '%s matches on its documented field (or ignores a matcher it has no support for)',
    async (event, field) => {
      const input = stdin(event);
      if (field === null) {
        expect(await fires(event as HookEvent, 'never-a-value', input, true)).toBe(true);
        return;
      }
      const value = String((EV[event].stdin as Record<string, unknown>)[field]);
      expect(await fires(event as HookEvent, value, input, true)).toBe(true);
      expect(await fires(event as HookEvent, `${value}x`, input, true)).toBe(false);
    },
  );

  it('off (no option): every matcher is a regex and Notification / SessionEnd / PostCompact match on "" (byte-identical)', async () => {
    expect(await fires('PreToolUse', 'Bash', tool('BashOutput'), false)).toBe(true);
    expect(await fires('PreToolUse', '*', tool('Bash'), false)).toBe(false); // an invalid regex, as before
    expect(await fires('Notification', 'permission_prompt', stdin('Notification'), false)).toBe(false);
    expect(await fires('SessionEnd', 'other', stdin('SessionEnd'), false)).toBe(false);
    expect(await fires('UserPromptSubmit', 'anything', stdin('UserPromptSubmit'), false)).toBe(false);
  });
});

describe('X1 — PermissionRequest interrupt and updatedPermissions', () => {
  const deny = (extra: Record<string, unknown>) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on this box', ...extra } },
  }) as unknown as HookJSONOutput;

  it('a deny with interrupt:true carries interrupt; without it, nothing changes', async () => {
    expect(await fold('PermissionRequest', deny({ interrupt: true }))).toEqual({
      decision: 'continue', permissionDecision: 'deny', permissionDecisionReason: 'Not on this box', interrupt: true,
    });
    expect(await fold('PermissionRequest', deny({}))).toEqual({
      decision: 'continue', permissionDecision: 'deny', permissionDecisionReason: 'Not on this box',
    });
  });

  it('PERMISSION_REQUEST_UPDATED_PERMISSIONS_NOT_APPLIED: an allow\'s updatedPermissions is never folded', async () => {
    const allow = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] },
      },
    } as unknown as HookJSONOutput;
    expect(await fold('PermissionRequest', allow)).toEqual({ decision: 'continue', permissionDecision: 'allow' });
  });
});

describe('X1 — the host\'s limit on added context (spillContext)', () => {
  it('is applied to each callback\'s context before the chain\'s are joined, on continue and on halt; absent, text as returned', async () => {
    const said = (additionalContext: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
    const input = { ...EV.SessionStart.stdin } as unknown as HookInput;
    const run = async (spillContext?: (t: string) => string, halt = false) => {
      const d = new HookDispatcher(spillContext ? { spillContext } : undefined);
      d.register('SessionStart', {}, () => said('first'));
      d.register('SessionStart', {}, () => (halt
        ? { decision: 'block', reason: 'stop', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'second' } }
        : said('second')));
      return d.dispatch('SessionStart', input, ctx);
    };
    expect(await run()).toEqual({ decision: 'continue', additionalContext: 'first\nsecond' });
    expect(await run((t) => `<${t.length}>`)).toEqual({ decision: 'continue', additionalContext: '<5>\n<6>' });
    expect(await run((t) => `<${t.length}>`, true)).toMatchObject({ decision: 'halt', additionalContext: '<5>\n<6>' });
  });
});
