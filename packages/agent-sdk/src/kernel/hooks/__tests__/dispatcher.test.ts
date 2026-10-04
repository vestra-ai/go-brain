import { describe, it, expect, vi } from 'vitest';
import { HookDispatcher } from '../dispatcher.js';
import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
} from '../contract.js';

// ---------------------------------------------------------------------------
// Input factories — minimal valid inputs for the events under test.
// `transcript_path` is required by the contract (SDK-compat) but unread by the
// kernel; '' is the placeholder the native loop will pass for journal-backed runs.
// ---------------------------------------------------------------------------

const base = { session_id: 's', cwd: '/w', transcript_path: '' };

function preToolInput(tool_name: string, tool_input: unknown = {}): PreToolUseHookInput {
  return {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 'tu_1',
  };
}

function postToolInput(tool_name: string, tool_response: unknown = 'ok'): PostToolUseHookInput {
  return {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input: {},
    tool_response,
    tool_use_id: 'tu_1',
  };
}

const ctx = { toolUseId: 'tu_1', signal: new AbortController().signal };

// A callback that records it ran and returns whatever output is given.
function spyCb(ran: string[], label: string, out: HookJSONOutput = {}): HookCallback {
  return async () => {
    ran.push(label);
    return out;
  };
}

describe('HookDispatcher — empty-return is FALL THROUGH, NOT allow (the security trap)', () => {
  it('an empty {} return does NOT short-circuit to allow — the chain continues', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, spyCb(ran, 'first', {})); // empty return
    d.register('PreToolUse', {}, spyCb(ran, 'second', {})); // must still run

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    // Both callbacks ran — empty did not stop the chain.
    expect(ran).toEqual(['first', 'second']);
    // And the chain ended with NO permission decision — the loop must NOT read
    // this as "allow"; it falls back to its own default gate.
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBeUndefined();
    }
  });

  it('empty returns across the WHOLE chain yield no permissionDecision (no implicit allow)', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({}));
    d.register('PreToolUse', {}, async () => ({}));

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBeUndefined();
    }
  });
});

describe('HookDispatcher — a RESTRICTIVE PreToolUse permissionDecision short-circuits the chain', () => {
  for (const decision of ['deny', 'ask', 'defer'] as const) {
    it(`'${decision}' short-circuits: later callbacks do NOT run`, async () => {
      const ran: string[] = [];
      const d = new HookDispatcher();
      d.register(
        'PreToolUse',
        {},
        async () => {
          ran.push('decider');
          return {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
          };
        },
      );
      d.register('PreToolUse', {}, spyCb(ran, 'after'));

      const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

      expect(ran).toEqual(['decider']); // 'after' never ran
      expect(outcome.decision).toBe('continue');
      if (outcome.decision === 'continue') {
        expect(outcome.permissionDecision).toBe(decision);
      }
    });
  }

  // §ALLOW IS NOT THE LAST WORD (dispatcher.ts header). The security floor is itself
  // the FIRST PreToolUse hook and allows every plain-safe call; short-circuiting on
  // its `allow` ended the chain on EVERY call, which made per-ability declared hooks
  // (registered after the floor precisely to layer on top of it) unreachable.
  it("'allow' is RECORDED but does NOT short-circuit: later callbacks still run", async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      ran.push('floor');
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    });
    d.register('PreToolUse', {}, spyCb(ran, 'after'));

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(ran).toEqual(['floor', 'after']); // ← 'after' DID run
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('allow'); // no later decision → the allow stands
    }
  });

  it('a later callback turns an earlier allow into a DENY (monotone toward restriction)', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      ran.push('floor');
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    });
    d.register('PreToolUse', {}, async () => {
      ran.push('ability');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'ability hook says no',
        },
      };
    });
    d.register('PreToolUse', {}, spyCb(ran, 'after'));

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    // The deny short-circuits, so the third callback never runs.
    expect(ran).toEqual(['floor', 'ability']);
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
      expect(outcome.permissionDecisionReason).toBe('ability hook says no');
    }
  });

  it('a deny can NEVER be loosened by a later allow (the deny already ended the chain)', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      ran.push('floor-deny');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'security floor',
        },
      };
    });
    d.register('PreToolUse', {}, async () => {
      ran.push('ability-allow');
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    });

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(ran).toEqual(['floor-deny']); // the trusted hook never even ran
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
      expect(outcome.permissionDecisionReason).toBe('security floor');
    }
  });

  it("a reasonless deny after an allow does NOT inherit the allow's reason", async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'floor had no objection',
      },
    }));
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }));

    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);

    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
      expect(outcome.permissionDecisionReason).toBeUndefined();
    }
  });

  it('carries the permissionDecisionReason on the outcome', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked by security',
      },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
      expect(outcome.permissionDecisionReason).toBe('blocked by security');
    } else {
      throw new Error('expected continue');
    }
  });

  // K6-P3-C7 — the optional structured deny classifier folds through with the decision.
  it('carries the permissionDecisionReasonType on the outcome (C7)', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Denied by a permission rule.',
        permissionDecisionReasonType: 'rule',
      },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.permissionDecision).toBe('deny');
    expect(outcome.permissionDecisionReasonType).toBe('rule');
  });

  it('omits permissionDecisionReasonType when the deciding callback set none (additive, C7)', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'plain deny',
      },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.permissionDecisionReasonType).toBeUndefined();
  });

  it('the FIRST decider\'s reasonType wins — a permissionDecision short-circuits the chain (C7)', async () => {
    // The first callback denies with reasonType 'security' → the chain short-circuits
    // (a PreToolUse permissionDecision ends it), so the second callback NEVER runs and
    // cannot clobber the reasonType. This is why the merge is present-only (no clearing).
    const ranSecond = vi.fn();
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'sec',
        permissionDecisionReasonType: 'security',
      },
    }));
    d.register('PreToolUse', {}, async () => {
      ranSecond();
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    });
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.permissionDecision).toBe('deny');
    expect(outcome.permissionDecisionReasonType).toBe('security');
    expect(ranSecond).not.toHaveBeenCalled(); // short-circuited
  });
});

describe('HookDispatcher — matcher regex semantics', () => {
  it('a group with no matcher always matches', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, spyCb(ran, 'nomatch'));
    await d.dispatch('PreToolUse', preToolInput('AnythingAtAll'), ctx);
    expect(ran).toEqual(['nomatch']);
  });

  it('a matcher regex that matches the tool_name runs the group', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', { matcher: '^mcp__browser-control__' }, spyCb(ran, 'browser'));
    await d.dispatch('PreToolUse', preToolInput('mcp__browser-control__click'), ctx);
    expect(ran).toEqual(['browser']);
  });

  it('a matcher regex that does NOT match is skipped', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', { matcher: '^mcp__browser-control__' }, spyCb(ran, 'browser'));
    await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(ran).toEqual([]);
  });

  it('matches PreCompact on `trigger`, not tool_name', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreCompact', { matcher: '^manual$' }, spyCb(ran, 'manualOnly'));
    await d.dispatch(
      'PreCompact',
      { hook_event_name: 'PreCompact', session_id: 's', cwd: '/w', transcript_path: '', trigger: 'auto', custom_instructions: null },
      ctx,
    );
    expect(ran).toEqual([]); // auto != manual
    await d.dispatch(
      'PreCompact',
      { hook_event_name: 'PreCompact', session_id: 's', cwd: '/w', transcript_path: '', trigger: 'manual', custom_instructions: null },
      ctx,
    );
    expect(ran).toEqual(['manualOnly']);
  });

  it('matches Subagent* on `agent_type`', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('SubagentStart', { matcher: 'code-reviewer' }, spyCb(ran, 'reviewer'));
    await d.dispatch(
      'SubagentStart',
      { hook_event_name: 'SubagentStart', session_id: 's', cwd: '/w', transcript_path: '', agent_id: 'a1', agent_type: 'general-purpose' },
      ctx,
    );
    expect(ran).toEqual([]);
    await d.dispatch(
      'SubagentStart',
      { hook_event_name: 'SubagentStart', session_id: 's', cwd: '/w', transcript_path: '', agent_id: 'a2', agent_type: 'code-reviewer' },
      ctx,
    );
    expect(ran).toEqual(['reviewer']);
  });

  it('matches SessionStart on `source` (trigger key)', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('SessionStart', { matcher: '^resume$' }, spyCb(ran, 'resumeOnly'));
    await d.dispatch(
      'SessionStart',
      { hook_event_name: 'SessionStart', session_id: 's', cwd: '/w', transcript_path: '', source: 'startup' },
      ctx,
    );
    expect(ran).toEqual([]);
    await d.dispatch(
      'SessionStart',
      { hook_event_name: 'SessionStart', session_id: 's', cwd: '/w', transcript_path: '', source: 'resume' },
      ctx,
    );
    expect(ran).toEqual(['resumeOnly']);
  });
});

describe('HookDispatcher — registration order', () => {
  it('runs matchers + their callbacks in registration order', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, spyCb(ran, 'a'));
    d.register('PreToolUse', {}, spyCb(ran, 'b1'), spyCb(ran, 'b2'));
    d.register('PreToolUse', {}, spyCb(ran, 'c'));
    await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(ran).toEqual(['a', 'b1', 'b2', 'c']);
  });
});

describe('HookDispatcher — merge across the chain', () => {
  it('merges updatedInput per-key, later callbacks win', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { a: 1, b: 2 } },
    }));
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { b: 99, c: 3 } },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.updatedInput).toEqual({ a: 1, b: 99, c: 3 });
  });

  it('last writer wins for updatedToolOutput (PostToolUse)', async () => {
    const d = new HookDispatcher();
    d.register('PostToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'first' },
    }));
    d.register('PostToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'second' },
    }));
    const outcome = await d.dispatch('PostToolUse', postToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.updatedToolOutput).toBe('second');
  });

  it('concatenates additionalContext from every surviving callback', async () => {
    const d = new HookDispatcher();
    d.register('PostToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'one' },
    }));
    d.register('PostToolUse', {}, async () => ({})); // empty, contributes nothing
    d.register('PostToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'two' },
    }));
    const outcome = await d.dispatch('PostToolUse', postToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('one\ntwo');
  });
});

describe('HookDispatcher — HALT semantics', () => {
  it('continue:false halts and carries the stopReason', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('Stop', {}, async () => {
      ran.push('halter');
      return { continue: false, stopReason: 'budget exhausted' };
    });
    d.register('Stop', {}, spyCb(ran, 'after'));
    const outcome = await d.dispatch(
      'Stop',
      { hook_event_name: 'Stop', session_id: 's', cwd: '/w', transcript_path: '', stop_hook_active: true },
      ctx,
    );
    expect(ran).toEqual(['halter']); // 'after' never ran
    expect(outcome.decision).toBe('halt');
    if (outcome.decision === 'halt') {
      expect(outcome.stopReason).toBe('budget exhausted');
    }
  });

  it("decision:'block' halts and carries the reason as stopReason", async () => {
    const d = new HookDispatcher();
    d.register('PostToolUse', {}, async () => ({ decision: 'block', reason: 'bad output' }));
    const outcome = await d.dispatch('PostToolUse', postToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('halt');
    if (outcome.decision === 'halt') {
      expect(outcome.stopReason).toBe('bad output');
    }
  });

  it("a single-shot halt carries its OWN additionalContext (not just prior survivors')", async () => {
    const d = new HookDispatcher();
    d.register('Stop', {}, async () => ({
      continue: false,
      stopReason: 'done',
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' },
    }));
    const outcome = await d.dispatch(
      'Stop',
      { hook_event_name: 'Stop', session_id: 's', cwd: '/w', transcript_path: '', stop_hook_active: true },
      ctx,
    );
    expect(outcome.decision).toBe('halt');
    if (outcome.decision === 'halt') {
      expect(outcome.stopReason).toBe('done');
      expect(outcome.additionalContext).toBe('x');
    }
  });

  it('a halt carries BOTH prior survivors’ context and the halting callback’s own', async () => {
    const d = new HookDispatcher();
    d.register('PostToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'prior' },
    }));
    d.register('PostToolUse', {}, async () => ({
      decision: 'block',
      reason: 'stop now',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'halting' },
    }));
    const outcome = await d.dispatch('PostToolUse', postToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('halt');
    if (outcome.decision === 'halt') {
      expect(outcome.additionalContext).toBe('prior\nhalting');
    }
  });

  it("HALT takes precedence over a same-output permissionDecision (agent-stop wins over tool-gate)", async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => ({
      continue: false,
      stopReason: 'hard stop',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    // NOT a gated-deny continue — an explicit agent-stop.
    expect(outcome.decision).toBe('halt');
    if (outcome.decision === 'halt') {
      expect(outcome.stopReason).toBe('hard stop');
    }
  });
});

describe('HookDispatcher — timeout + abort', () => {
  it('a per-group timeout fires; the slow hook falls through (no implicit allow/deny)', async () => {
    vi.useFakeTimers();
    try {
      const d = new HookDispatcher();
      // group timeout 1s; hook never resolves.
      d.register('PreToolUse', { timeout: 1 }, () => new Promise<HookJSONOutput>(() => {}));
      const p = d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
      await vi.advanceTimersByTimeAsync(1100);
      const outcome = await p;
      expect(outcome.decision).toBe('continue');
      if (outcome.decision === 'continue') {
        expect(outcome.permissionDecision).toBeUndefined(); // NOT an implicit allow
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('UserPromptSubmit uses the 30s default group timeout', async () => {
    vi.useFakeTimers();
    try {
      const d = new HookDispatcher();
      d.register('UserPromptSubmit', {}, () => new Promise<HookJSONOutput>(() => {}));
      const p = d.dispatch(
        'UserPromptSubmit',
        { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/w', transcript_path: '', prompt: 'hi' },
        ctx,
      );
      // before 30s nothing resolves
      await vi.advanceTimersByTimeAsync(29_000);
      // after 30s the group times out and the dispatch resolves
      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await p;
      expect(outcome.decision).toBe('continue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an already-aborted signal makes the racing hook fall through', async () => {
    const ac = new AbortController();
    ac.abort();
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, () => new Promise<HookJSONOutput>(() => {})); // never resolves
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), {
      toolUseId: 'tu_1',
      signal: ac.signal,
    });
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBeUndefined();
    }
  });
});

describe('HookDispatcher — error isolation', () => {
  it('a throwing callback is caught, does NOT crash dispatch, and falls through', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      ran.push('thrower');
      throw new Error('boom');
    });
    d.register('PreToolUse', {}, spyCb(ran, 'survivor'));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(ran).toEqual(['thrower', 'survivor']); // chain survived
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      // a thrown hook does NOT implicitly allow OR deny
      expect(outcome.permissionDecision).toBeUndefined();
    }
  });

  it('a throwing callback does not consume a later callback decision', async () => {
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      throw new Error('boom');
    });
    d.register('PreToolUse', {}, async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }));
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// PER-EVENT behavioral dispatch + fold coverage.
//
// The mechanism tests above prove the chain RULES (short-circuit, merge, halt,
// timeout) using PreToolUse / PostToolUse / Stop as the carriers. The matcher
// tests prove the dispatch KEY for PreCompact / SubagentStart / SessionStart.
// This block closes the remaining gap: for EVERY one of the 13 dispatcher
// events, assert that dispatching it actually RUNS its registered callback AND
// folds that callback's output per the dispatcher's contract for that event —
// not just that the mechanism works on PreToolUse. Each test is genuine: it
// breaks if the callback stops running or the fold for that event regresses.
// ---------------------------------------------------------------------------

describe('HookDispatcher — per-event dispatch + fold (all 13 events)', () => {
  it('PreToolUse: runs the callback and folds its permission decision', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreToolUse', {}, async () => {
      ran.push('pre');
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    });
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(ran).toEqual(['pre']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.permissionDecision).toBe('allow');
  });

  it('PostToolUse: runs the callback and folds its updatedToolOutput', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PostToolUse', {}, async () => {
      ran.push('post');
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'rewritten' } };
    });
    const outcome = await d.dispatch('PostToolUse', postToolInput('Bash'), ctx);
    expect(ran).toEqual(['post']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.updatedToolOutput).toBe('rewritten');
  });

  it('PostToolUseFailure: runs the callback and folds its additionalContext', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PostToolUseFailure', {}, async () => {
      ran.push('fail');
      return {
        hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'tool blew up' },
      };
    });
    const outcome = await d.dispatch(
      'PostToolUseFailure',
      {
        ...base,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 'tu_1',
        error: 'ECONNREFUSED',
      },
      ctx,
    );
    expect(ran).toEqual(['fail']); // the failure callback actually ran
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('tool blew up');
  });

  it('PostToolBatch: runs the callback and folds its additionalContext', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PostToolBatch', {}, async () => {
      ran.push('batch');
      return {
        hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'two tools ran' },
      };
    });
    const outcome = await d.dispatch(
      'PostToolBatch',
      {
        ...base,
        hook_event_name: 'PostToolBatch',
        tool_calls: [
          { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu_1' },
          { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu_2' },
        ],
      },
      ctx,
    );
    expect(ran).toEqual(['batch']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('two tools ran');
  });

  it('Notification: runs the callback; a halt return SUPPRESSES (the routeNotification contract)', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    // A passthrough notification callback runs and folds its context.
    d.register('Notification', {}, async () => {
      ran.push('notif');
      return {
        hookSpecificOutput: { hookEventName: 'Notification', additionalContext: 'augmented' },
      };
    });
    const passthrough = await d.dispatch(
      'Notification',
      {
        ...base,
        hook_event_name: 'Notification',
        message: 'long task done',
        notification_type: 'idle',
      },
      ctx,
    );
    expect(ran).toEqual(['notif']);
    if (passthrough.decision !== 'continue') throw new Error('expected continue');
    expect(passthrough.additionalContext).toBe('augmented');

    // A Notification callback returning continue:false HALTS — routeNotification
    // reads this as "suppress the notification" (native-hooks.ts).
    const d2 = new HookDispatcher();
    d2.register('Notification', {}, async () => ({ continue: false, stopReason: 'muted' }));
    const suppressed = await d2.dispatch(
      'Notification',
      {
        ...base,
        hook_event_name: 'Notification',
        message: 'noise',
        notification_type: 'idle',
      },
      ctx,
    );
    expect(suppressed.decision).toBe('halt');
  });

  it('Stop: runs the observe-only callback and folds to a no-decision continue', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    // The native + Claude Stop hooks are observe-only: they log and return {}.
    d.register('Stop', {}, spyCb(ran, 'stop'));
    const outcome = await d.dispatch(
      'Stop',
      { ...base, hook_event_name: 'Stop', stop_hook_active: false },
      ctx,
    );
    expect(ran).toEqual(['stop']); // the Stop callback ran
    expect(outcome.decision).toBe('continue'); // observe-only → no halt, no decision
    if (outcome.decision === 'continue') {
      expect(outcome.additionalContext).toBeUndefined();
    }
  });

  it('SubagentStart: runs the callback (matched on agent_type) and folds its context', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('SubagentStart', {}, async () => {
      ran.push('substart');
      return {
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'child spawned' },
      };
    });
    const outcome = await d.dispatch(
      'SubagentStart',
      {
        ...base,
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'code-reviewer',
      },
      ctx,
    );
    expect(ran).toEqual(['substart']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('child spawned');
  });

  it('SubagentStop: runs the callback and folds its context (reads how the child ended)', async () => {
    const ran: string[] = [];
    const seenStatus: string[] = [];
    const d = new HookDispatcher();
    d.register('SubagentStop', {}, async (input) => {
      ran.push('substop');
      if (input.hook_event_name === 'SubagentStop' && input.status) seenStatus.push(input.status);
      return {
        hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: 'child done' },
      };
    });
    const outcome = await d.dispatch(
      'SubagentStop',
      {
        ...base,
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: 'a1',
        agent_type: 'code-reviewer',
        status: 'completed',
        duration_ms: 1234,
      },
      ctx,
    );
    expect(ran).toEqual(['substop']);
    expect(seenStatus).toEqual(['completed']); // the callback saw the kernel-added status
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('child done');
  });

  it('PreCompact: runs the observe-only callback and folds to a no-decision continue', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('PreCompact', {}, spyCb(ran, 'precompact'));
    const outcome = await d.dispatch(
      'PreCompact',
      { ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null },
      ctx,
    );
    expect(ran).toEqual(['precompact']); // the PreCompact callback ran
    expect(outcome.decision).toBe('continue');
  });

  it('PostCompact: runs the callback and folds its additionalContext', async () => {
    const ran: string[] = [];
    const seenSummary: string[] = [];
    const d = new HookDispatcher();
    d.register('PostCompact', {}, async (input) => {
      ran.push('postcompact');
      if (input.hook_event_name === 'PostCompact') seenSummary.push(input.compact_summary);
      return {
        hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: 'compacted' },
      };
    });
    const outcome = await d.dispatch(
      'PostCompact',
      { ...base, hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'kept the gist' },
      ctx,
    );
    expect(ran).toEqual(['postcompact']);
    expect(seenSummary).toEqual(['kept the gist']); // the callback read the event-specific field
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('compacted');
  });

  it('UserPromptSubmit: runs the callback and folds its additionalContext', async () => {
    const ran: string[] = [];
    const seenPrompt: string[] = [];
    const d = new HookDispatcher();
    d.register('UserPromptSubmit', {}, async (input) => {
      ran.push('prompt');
      if (input.hook_event_name === 'UserPromptSubmit') seenPrompt.push(input.prompt);
      return {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'pre-prompt note' },
      };
    });
    const outcome = await d.dispatch(
      'UserPromptSubmit',
      { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      ctx,
    );
    expect(ran).toEqual(['prompt']);
    expect(seenPrompt).toEqual(['do the thing']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('pre-prompt note');
  });

  it('SessionStart: runs the callback (matched on source) and folds its context', async () => {
    const ran: string[] = [];
    const d = new HookDispatcher();
    d.register('SessionStart', {}, async () => {
      ran.push('sessionstart');
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'booting' },
      };
    });
    const outcome = await d.dispatch(
      'SessionStart',
      { ...base, hook_event_name: 'SessionStart', source: 'startup' },
      ctx,
    );
    expect(ran).toEqual(['sessionstart']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('booting');
  });

  it('SessionEnd: runs the callback and folds its context', async () => {
    const ran: string[] = [];
    const seenReason: string[] = [];
    const d = new HookDispatcher();
    d.register('SessionEnd', {}, async (input) => {
      ran.push('sessionend');
      if (input.hook_event_name === 'SessionEnd') seenReason.push(input.reason);
      return {
        hookSpecificOutput: { hookEventName: 'SessionEnd', additionalContext: 'goodbye' },
      };
    });
    const outcome = await d.dispatch(
      'SessionEnd',
      { ...base, hook_event_name: 'SessionEnd', reason: 'logout' },
      ctx,
    );
    expect(ran).toEqual(['sessionend']); // the SessionEnd callback ran
    expect(seenReason).toEqual(['logout']);
    if (outcome.decision !== 'continue') throw new Error('expected continue');
    expect(outcome.additionalContext).toBe('goodbye');
  });

  it('UserPromptSubmit folds + decides within its tighter 30s group window', async () => {
    // A fast callback resolves well within the 30s UserPromptSubmit budget — the
    // event-specific timeout does not prematurely cancel a normal callback.
    vi.useFakeTimers();
    try {
      const d = new HookDispatcher();
      d.register('UserPromptSubmit', {}, async () => ({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'in time' },
      }));
      const p = d.dispatch(
        'UserPromptSubmit',
        { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
        ctx,
      );
      await vi.advanceTimersByTimeAsync(10); // far under 30s
      const outcome = await p;
      if (outcome.decision !== 'continue') throw new Error('expected continue');
      expect(outcome.additionalContext).toBe('in time');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HookDispatcher — no handlers registered', () => {
  it('dispatch with no registered group for the event returns a bare continue', async () => {
    const d = new HookDispatcher();
    const outcome = await d.dispatch('PreToolUse', preToolInput('Bash'), ctx);
    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBeUndefined();
      expect(outcome.updatedInput).toBeUndefined();
    }
  });
});
