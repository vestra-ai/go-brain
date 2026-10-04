import { describe, it, expect } from 'vitest';
import { query } from '../index.js';
import type {
  Harness,
  HarnessContext,
  UserTurn,
  ToolCall,
  GateResult,
  ResumeHandle,
  HumanAnswer,
} from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { HarnessCapabilities } from '../../contract/capabilities.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';

// ─────────────────────────────────────────────────────────────────────────────
// P3 Task 1 — `signal` is a REQUIRED field on HarnessContext (the contract spine),
// wired unconditionally by query() so interrupt() can never silently no-op — even
// for a config that carries NO `signal` slot of its own.
// ─────────────────────────────────────────────────────────────────────────────

const completed: TurnOutcome = {
  kind: 'completed',
  summary: '',
  costUsd: 0,
  numTurns: 1,
  durationMs: 0,
  modelUsage: {},
  raw: { subtype: 'fake', errors: [] },
} as TurnOutcome;

/**
 * A minimal arm that records the ctx it received, then blocks until the run's
 * `ctx.signal` aborts before finalizing. This proves ctx.signal is the LIVE handle
 * interrupt() trips: a signal-less config still receives an observable ctx.signal.
 */
class SignalRecordingArm implements Harness<Record<string, never>> {
  readonly id = 'native' as const;
  readonly capabilities = { reportsCostUsd: false } as unknown as HarnessCapabilities;
  seenCtx: HarnessContext<Record<string, never>> | null = null;

  async *run(
    _input: AsyncIterable<UserTurn>,
    ctx: HarnessContext<Record<string, never>>,
  ): AsyncIterable<HarnessEvent> {
    this.seenCtx = ctx;
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield {
      kind: 'turn_end',
      outcome: completed,
      blocks: [],
      stopReason: 'end_turn',
      billing: { cumulativeCostUsd: 0, modelUsage: {} },
    };
  }

  async gateTool(_c: ToolCall): Promise<GateResult> {
    return { decision: 'allow' };
  }
  pause(_c: ToolCall): ResumeHandle {
    return { serializable: false, payload: null };
  }
  resume(_h: ResumeHandle, _a: HumanAnswer): void {}
  classifyTermination(_raw: unknown): TurnOutcome {
    return completed;
  }
}

async function* oneTurn(): AsyncIterable<UserTurn> {
  yield { text: 'go' };
}

describe('query() — signal is a spine field on HarnessContext (P3)', () => {
  it('interrupt() aborts ctx.signal even for a config with NO signal slot', async () => {
    const arm = new SignalRecordingArm();
    const h = query<Record<string, never>>({
      harness: arm,
      config: {}, // no signal slot
      prompt: oneTurn(),
      taskId: 't',
      sessionId: 't',
      cwd: '/',
      model: 'm',
    });
    const consumer = (async () => {
      for await (const _ of h) {
        /* drain */
      }
    })();
    h.interrupt();
    await consumer;
    expect(arm.seenCtx!.signal.aborted).toBe(true); // TODAY: ctx has no signal at all
  });
});
