import { describe, it, expect, vi } from 'vitest';
import { HookDispatcher } from '../dispatcher.js';
import type {
  HookExecutionEvent,
  HookJSONOutput,
  PreToolUseHookInput,
} from '../contract.js';

// ---------------------------------------------------------------------------
// B4 — HOOK OBSERVABILITY. The dispatcher calls an INJECTED observer around each
// callback: `started` before, `completed` after, `error` on a throwing callback,
// `cancelled` on timeout/abort. The dispatcher stays PURE — it imports no sink,
// no socket, no Date.now(); it only invokes the injected `onHookExecution`.
//
// Default-OFF invariant: with NO observer, the dispatcher makes ZERO observer
// calls and the outcome is byte-identical to today (proven by the existing
// dispatcher.test.ts staying green — here we assert the no-observer no-op).
// ---------------------------------------------------------------------------

const base = { session_id: 's', cwd: '/w', transcript_path: '' };

function preToolInput(tool_name: string, tool_input: unknown = {}): PreToolUseHookInput {
  return { ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'tu_1' };
}

const ctx = { toolUseId: 'tu_1', signal: new AbortController().signal };

describe('HookDispatcher observer — started + completed around a callback', () => {
  it('calls started then completed for a callback that returns', async () => {
    const seen: HookExecutionEvent[] = [];
    const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
    d.register('PreToolUse', {}, async () => ({}));

    await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(seen.map((e) => e.phase)).toEqual(['started', 'completed']);
    // both phases carry the SAME stable hookId (correlation), and the hookEvent.
    expect(seen[0]!.hookId).toBe(seen[1]!.hookId);
    expect(seen[0]!.hookEvent).toBe('PreToolUse');
    expect(seen[1]!.hookEvent).toBe('PreToolUse');
  });

  it('mints a DISTINCT hookId per callback invocation', async () => {
    const seen: HookExecutionEvent[] = [];
    const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
    d.register('PreToolUse', {}, async () => ({}), async () => ({}));

    await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    const started = seen.filter((e) => e.phase === 'started');
    expect(started).toHaveLength(2);
    expect(started[0]!.hookId).not.toBe(started[1]!.hookId);
    // completed events correlate to their own started by hookId.
    const completed = seen.filter((e) => e.phase === 'completed');
    expect(new Set(completed.map((e) => e.hookId))).toEqual(
      new Set(started.map((e) => e.hookId)),
    );
  });

  it('carries the matcher when the group declares one', async () => {
    const seen: HookExecutionEvent[] = [];
    const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
    d.register('PreToolUse', { matcher: '^Bash$' }, async () => ({}));

    await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(seen[0]!.matcher).toBe('^Bash$');
  });
});

describe('HookDispatcher observer — error phase on a throwing callback', () => {
  it('calls started then error (with the message) when the callback throws', async () => {
    const seen: HookExecutionEvent[] = [];
    const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
    d.register('PreToolUse', {}, async () => {
      throw new Error('boom');
    });

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(seen.map((e) => e.phase)).toEqual(['started', 'error']);
    expect(seen[1]!.error).toContain('boom');
    // the dispatch still resolves to a no-decision continue (error-isolation unchanged).
    expect(outcome.decision).toBe('continue');
  });
});

describe('HookDispatcher observer — cancelled phase on timeout / abort', () => {
  it('calls cancelled when a per-group timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const seen: HookExecutionEvent[] = [];
      const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
      d.register('PreToolUse', { timeout: 1 }, () => new Promise<HookJSONOutput>(() => {}));

      const p = d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
      await vi.advanceTimersByTimeAsync(1100);
      await p;

      expect(seen.map((e) => e.phase)).toEqual(['started', 'cancelled']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls cancelled when the signal is already aborted (callback never invoked)', async () => {
    const ac = new AbortController();
    ac.abort();
    const seen: HookExecutionEvent[] = [];
    const d = new HookDispatcher({ onHookExecution: (e) => seen.push(e) });
    d.register('PreToolUse', {}, () => new Promise<HookJSONOutput>(() => {}));

    await d.dispatch('PreToolUse', preToolInput('Bash'), {
      toolUseId: 'tu_1',
      signal: ac.signal,
    });

    // A pre-aborted callback STILL reports started→cancelled so the host can
    // observe that the hook was scheduled but never ran.
    expect(seen.map((e) => e.phase)).toEqual(['started', 'cancelled']);
  });
});

describe('HookDispatcher observer — default OFF is byte-identical', () => {
  it('makes ZERO observer calls when no observer is provided', async () => {
    // Construct with no options → no observer. The only proof we can assert here
    // is that dispatch behaves exactly as before (the rest of dispatcher.test.ts
    // covers the full surface). Concretely: a normal dispatch resolves without
    // throwing and yields the expected outcome.
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
    }
  });

  it('an undefined observer in the options object is also a no-op (no throw)', async () => {
    const d = new HookDispatcher({ onHookExecution: undefined });
    d.register('PreToolUse', {}, async () => ({}));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('continue');
  });
});
