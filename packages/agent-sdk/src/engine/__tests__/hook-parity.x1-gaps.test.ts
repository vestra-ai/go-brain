/**
 * X1 gaps (HOOK_PARITY_V1): the documented answers engine/hook-parity.ts gives where the fixture
 * table listed a gap, each a no-op while the flag is off. The loop-level proofs live in
 * apps/sandbox hook-parity.claude-code-fixtures.test.ts (compaction, SessionStart, SessionEnd),
 * agent-tool.subagent-hooks.test.ts (SubagentStart / SubagentStop) and
 * tool-dispatcher.hook-parity.test.ts (context beside the result, the interrupt, the matchers).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { JournalEntry } from '../../contract/journal.js';
import type { RunContext } from '../run-context.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { Journal } from '../../kernel/index.js';
import type { NativeConfigLike } from '../native-config-like.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type { ProviderHistory } from '../transport.js';
import { HookDispatcher, compactionFailureReason, type HookInput, type HookOutcome } from '../../kernel/index.js';
import {
  blockedCompactionNotice,
  notifyHooks,
  preCompactBlock,
  refuseIfPreCompactBlocked,
  sessionEndReason,
  sessionStartAfterCompaction,
  sessionStartSource,
  subagentStartContext,
  subagentStopContinuation,
  withHookContext,
} from '../hook-parity.js';
import { armCompactionRetry } from '../compaction-refusal.js';
import { subagentStopRail } from '../subagent-stop-rail.js';
import { createNativeHookDispatcher, HOOK_CONTEXT_MAX_CHARS, HOOK_CONTEXT_PREVIEW_CHARS, makeHookContextSpill } from '../native-hooks.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => { delete process.env.HOOK_PARITY_V1; });
const on = () => { process.env.HOOK_PARITY_V1 = 'true'; };
const signal = new AbortController().signal;

const entry = (type: 'user' | 'assistant'): JournalEntry => ({ payload: { type, blocks: [] } }) as unknown as JournalEntry;
const block: HookOutcome = { decision: 'halt', stopReason: 'Keep the history whole', blocked: true };
const stopEverything: HookOutcome = { decision: 'halt', stopReason: 'stop' };
const context: HookOutcome = { decision: 'continue', additionalContext: ' Follow the security guide ' };

function caught(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

describe('X1 — SessionStart / SessionEnd', () => {
  it('source: "resume" once the conversation holds a reply (on); "startup" always off', () => {
    expect(sessionStartSource([entry('user'), entry('assistant')])).toBe('startup');
    on();
    expect(sessionStartSource([])).toBe('startup');
    expect(sessionStartSource([entry('user')])).toBe('startup');
    expect(sessionStartSource([entry('user'), entry('assistant')])).toBe('resume');
  });

  it('after a compaction, SessionStart "compact" fires only on, and hands back its context', async () => {
    const d = new HookDispatcher();
    const sources: string[] = [];
    d.register('SessionStart', {}, (i) => {
      if (i.hook_event_name === 'SessionStart') sources.push(i.source);
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'BRANCH main' } };
    });
    expect(await sessionStartAfterCompaction(d, signal, 's')).toBeUndefined();
    expect(sources).toEqual([]);
    on();
    expect(await sessionStartAfterCompaction(d, signal, 's')).toBe('BRANCH main');
    expect(sources).toEqual(['compact']);
  });

  it('its words are journaled as a hook entry only where a turn resumes (never left behind by a /compact)', async () => {
    on();
    const d = new HookDispatcher();
    d.register('SessionStart', {}, () => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'BRANCH main' } }));
    const appended: Array<{ payload: unknown }> = [];
    const journal = { append: async (e: { payload: unknown }) => { appended.push(e); return e; } } as unknown as Journal;
    const ctx = { taskId: 't', sessionId: 's', config: {} } as unknown as HarnessContext<NativeConfigLike>;
    expect(await sessionStartAfterCompaction(d, signal, 's')).toBe('BRANCH main'); // /compact: fired, not kept
    expect(appended).toEqual([]);
    await sessionStartAfterCompaction(d, signal, 's', { journal, ctx });
    expect(appended.map((e) => e.payload)).toEqual([{ type: 'user', blocks: [{ type: 'text', text: 'BRANCH main' }], injected: 'hook' }]);
  });

  it('SessionEnd reason: the documented "other" on; "input_exhausted" off', () => {
    expect(sessionEndReason()).toBe('input_exhausted');
    on();
    expect(sessionEndReason()).toBe('other');
  });
});

describe('X1 — PreCompact / PostCompact', () => {
  it('on a recovery (the provider already refused the request) a block is logged and the compaction proceeds', () => {
    on();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(caught(() => refuseIfPreCompactBlocked(block, true))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Keep the history whole'));
    warn.mockRestore();
    expect(compactionFailureReason(caught(() => refuseIfPreCompactBlocked(block)))).toBe('hook_blocked');
  });

  it('a block refuses by name with the hook\'s reason; continue:false and context do not (on); never off', () => {
    expect(preCompactBlock(block)).toBeUndefined();
    expect(caught(() => refuseIfPreCompactBlocked(block))).toBeUndefined();
    on();
    expect(preCompactBlock(stopEverything)).toBeUndefined();
    expect(preCompactBlock(context)).toBeUndefined();
    const err = caught(() => refuseIfPreCompactBlocked(block));
    expect(compactionFailureReason(err)).toBe('hook_blocked');
    expect(blockedCompactionNotice(err)).toBe('Keep the history whole');
    expect(blockedCompactionNotice(new Error('summarize failed'))).toBeUndefined();
  });

  it('a hook_blocked refusal arms the retry bound like any refusal: the hook is asked again on its clock, not every round', () => {
    on();
    const rc = { billing: { roundCounter: { value: 5 } } } as unknown as RunContext;
    armCompactionRetry(rc, caught(() => refuseIfPreCompactBlocked(block)));
    expect(rc.compactionRetry).toMatchObject({ failures: 1, notBeforeRound: 7 });
  });
});

describe('X1 — context beside the tool result', () => {
  it('joins after the trailer, trimmed (on); unchanged off', () => {
    expect(withHookContext('trailer', 'ctx')).toBe('trailer');
    on();
    expect(withHookContext(null, '  ctx ')).toBe('ctx');
    expect(withHookContext('trailer', 'ctx')).toBe('trailer\nctx');
    expect(withHookContext('trailer', '   ')).toBe('trailer');
    expect(withHookContext(null, undefined)).toBeNull();
  });
});

describe('X1 — SubagentStart / SubagentStop', () => {
  it('Start\'s context seeds the helper and Stop\'s block or context keeps it going (on); neither off', () => {
    expect(subagentStartContext(context)).toBeUndefined();
    expect(subagentStopContinuation(block)).toBeUndefined();
    expect(subagentStopContinuation(context)).toBeUndefined();
    on();
    expect(subagentStartContext(context)).toBe('Follow the security guide');
    expect(subagentStartContext(block)).toBeUndefined();
    expect(subagentStopContinuation(block)).toBe('Keep the history whole');
    expect(subagentStopContinuation(context)).toBe('Follow the security guide');
    expect(subagentStopContinuation(stopEverything)).toBeUndefined();
  });

  it('the helper loop\'s stop rail: no onStop stops; text back is pushed and journaled into the helper\'s scope', async () => {
    const pushed: string[] = [];
    const transport = { pushUser: (_h: ProviderHistory, text: string) => { pushed.push(text); } };
    const history = [] as unknown as ProviderHistory;
    expect(await subagentStopRail(undefined, transport, history, undefined, () => 'done', () => true)()).toBe(false);
    const asked: string[] = [];
    const appended: Array<{ payload: unknown; agentPath?: unknown }> = [];
    const j = { taskId: 't', workspaceId: 'w', append: async (e: { payload: unknown }) => { appended.push(e); return e; } } as unknown as Journal;
    const path: SubagentPathSegment[] = [{ depth: 1, agentToolUseId: 'tu-agent', agentSlug: 'researcher', agentName: 'Researcher' }];
    const rail = subagentStopRail(async (last) => { asked.push(last); return asked.length === 1 ? 'Run the tests first' : undefined; }, transport, history, { j, path }, () => 'done', () => true);
    expect(await rail()).toBe(true);
    expect(await rail()).toBe(false);
    expect(asked).toEqual(['done', 'done']);
    expect(pushed).toEqual(['Run the tests first']);
    expect(appended).toEqual([expect.objectContaining({ agentPath: path, payload: { type: 'user', blocks: [{ type: 'text', text: 'Run the tests first' }], injected: 'hook' } })]);
  });

  it('the stop rail never asks the hook when the helper could not go on (ceiling, directive, last turn)', async () => {
    let asked = 0;
    const rail = subagentStopRail(async () => { asked += 1; return 'again'; }, { pushUser: () => {} }, [] as unknown as ProviderHistory, undefined, () => 'done', () => false);
    expect(await rail()).toBe(false);
    expect(asked).toBe(0);
  });
});

describe('X1 — Notification', () => {
  it('fires with the documented payload only on, and never without a dispatcher', async () => {
    const d = new HookDispatcher();
    const seen: HookInput[] = [];
    d.register('Notification', {}, (i) => { seen.push(i); return {}; });
    const n = { type: 'elicitation_dialog', message: 'travel is asking you a question', title: 'travel' } as const;
    await notifyHooks(d, signal, 's', n);
    expect(seen).toEqual([]);
    on();
    await notifyHooks(undefined, signal, 's', n);
    await notifyHooks(d, signal, 's', n);
    expect(seen).toEqual([expect.objectContaining({
      hook_event_name: 'Notification', session_id: 's', notification_type: 'elicitation_dialog',
      message: 'travel is asking you a question', title: 'travel',
    })]);
  });
});

describe('X1 — a hook\'s oversized added context is saved to a file (the reference: over 10,000 characters)', () => {
  const big = 'x'.repeat(HOOK_CONTEXT_MAX_CHARS - 1) + 'TAIL-' + 'y'.repeat(500);

  it('keeps text at the limit whole; over it, the first 2,000 characters and the path to the full text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x1-spill-'));
    try {
      const spill = makeHookContextSpill({ workingDir: dir, taskId: 'task-1' });
      const atLimit = 'z'.repeat(HOOK_CONTEXT_MAX_CHARS);
      expect(spill(atLimit)).toBe(atLimit);
      const out = spill(big);
      expect(out.startsWith('x'.repeat(HOOK_CONTEXT_PREVIEW_CHARS) + '\n[hook output cut: ')).toBe(true);
      expect(out).not.toContain('TAIL-');
      const path = /the full text is in (.+)\]$/.exec(out)![1]!;
      expect(path.startsWith(join(dir, '.kernel-offload', 'task-1'))).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no working directory, the preview alone, saying how much was cut', () => {
    expect(makeHookContextSpill({ taskId: 't' })(big)).toBe(`${'x'.repeat(HOOK_CONTEXT_PREVIEW_CHARS)}\n[hook output cut: ${big.length} characters, the first ${HOOK_CONTEXT_PREVIEW_CHARS} shown]`);
  });

  it('createNativeHookDispatcher applies it only with the flag on', async () => {
    const run = async () => {
      const d = createNativeHookDispatcher({ gateTool: async () => ({ decision: 'allow' }) }, undefined, { taskId: 't' });
      d.register('SessionStart', {}, () => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: big } }));
      const out = await d.dispatch('SessionStart', { session_id: 's', cwd: '/', transcript_path: '', hook_event_name: 'SessionStart', source: 'startup' }, { signal });
      return out.additionalContext ?? '';
    };
    expect(await run()).toBe(big);
    on();
    expect((await run()).length).toBeLessThan(HOOK_CONTEXT_PREVIEW_CHARS + 200);
  });
});
