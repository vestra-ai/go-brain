/**
 * tool-dispatcher.screen.test.ts — W4-2 (shadow injection screen), dispatcher seam.
 *
 * The dispatcher awaits an injected `execCtx.injectionScreen.maybeScreen(call)`
 * AFTER the gate allows and BEFORE execute() — and ONLY then. SHADOW + FAIL-OPEN
 * by construction: a seam that throws, rejects, or hangs must never stop, delay
 * beyond the belt, or alter the dispatch; a denied/asked/invalid call must never
 * reach the seam; an absent seam leaves the dispatch byte-identical.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import {
  BELT_TIMEOUT_READING,
  INJECTION_SCREEN_BELT_TIMEOUT_MS,
  type InjectionScreenReading,
} from '../../policy/injection-screen.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

function tool(log: string[], name = 'mcp__composio__GMAIL_SEND_EMAIL'): RawToolOptions {
  return {
    name,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => {
      log.push('execute');
      return 'sent';
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('gateAndDispatchTool — injection screen seam', () => {
  it('awaits the seam once, before execute, with the effective call', async () => {
    const log: string[] = [];
    const calls: ToolCall[] = [];
    const seam = {
      maybeScreen: vi.fn(async (call: ToolCall) => {
        log.push('screen');
        calls.push(call);
      }),
    };
    const t = tool(log);
    const r = await gateAndDispatchTool(t, { to: 'a@b.c' }, 'tu-s1', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect(r.text).toBe('sent');
    expect(seam.maybeScreen).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['screen', 'execute']);
    expect(calls[0]).toEqual({
      toolName: 'mcp__composio__GMAIL_SEND_EMAIL',
      toolInput: { to: 'a@b.c' },
      toolCallId: 'tu-s1',
    });
  });

  it('hands the seam the gate-rewritten input (what will actually execute)', async () => {
    const calls: ToolCall[] = [];
    const seam = { maybeScreen: vi.fn(async (call: ToolCall) => void calls.push(call)) };
    const gate = gateOf({ decision: 'allow', updatedInput: { to: 'rewritten@b.c' } });
    await gateAndDispatchTool(tool([]), { to: 'a@b.c' }, 'tu-s2', gate as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect(calls[0]?.toolInput).toEqual({ to: 'rewritten@b.c' });
  });

  it('fail-open: a throwing seam never stops the dispatch', async () => {
    const seam = {
      maybeScreen: vi.fn(() => {
        throw new Error('screener exploded');
      }),
    };
    const r = await gateAndDispatchTool(tool([]), {}, 'tu-s3', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect(r.text).toBe('sent');
    expect(r.isError).toBe(false);
  });

  it('fail-open: a rejecting seam never stops the dispatch', async () => {
    const seam = { maybeScreen: vi.fn(async () => Promise.reject(new Error('down'))) };
    const r = await gateAndDispatchTool(tool([]), {}, 'tu-s4', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect(r.text).toBe('sent');
  });

  it('fail-open: a hung seam is released by the belt timeout', async () => {
    vi.useFakeTimers();
    const seam = { maybeScreen: vi.fn(() => new Promise<void>(() => {})) };
    const p = gateAndDispatchTool(tool([]), {}, 'tu-s5', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
    const r = await p;
    expect(r.text).toBe('sent');
  });

  it('a denied call never reaches the seam', async () => {
    const seam = { maybeScreen: vi.fn(async () => {}) };
    const r = await gateAndDispatchTool(
      tool([]),
      {},
      'tu-s6',
      gateOf({ decision: 'deny', message: 'no' }) as never,
      NOOP_PAUSE,
      undefined,
      { injectionScreen: seam },
    );
    expect(r.isError).toBe(true);
    expect(seam.maybeScreen).not.toHaveBeenCalled();
  });

  it('an asked (paused) call never reaches the seam', async () => {
    const seam = { maybeScreen: vi.fn(async () => {}) };
    const r = await gateAndDispatchTool(
      tool([]),
      {},
      'tu-s7',
      gateOf({ decision: 'needs_human', interactionKind: 'tool_permission' }) as never,
      NOOP_PAUSE,
      undefined,
      { injectionScreen: seam },
    );
    expect(r.pausedHalt).toBe(true);
    expect(seam.maybeScreen).not.toHaveBeenCalled();
  });

  it('a schema-refused call never reaches the seam', async () => {
    const seam = { maybeScreen: vi.fn(async () => {}) };
    const strict: RawToolOptions = {
      name: 'mcp__composio__GMAIL_SEND_EMAIL',
      description: 'test',
      parameters: z.object({ to: z.string() }),
      execute: vi.fn(async () => 'sent'),
    };
    const r = await gateAndDispatchTool(strict, { to: 42 }, 'tu-s8', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect(r.isError).toBe(true);
    expect(seam.maybeScreen).not.toHaveBeenCalled();
    expect(strict.execute).not.toHaveBeenCalled();
  });

  // A cancelled round has nothing to screen: the step will not run, so a verdict
  // about it would bill a screen and raise a banner for a step the user stopped.
  describe('the round abort', () => {
    it('an already-aborted round never reaches the seam, and the tool still dispatches', async () => {
      const log: string[] = [];
      const seam = { maybeScreen: vi.fn(async () => { log.push('screen'); }) };
      const ac = new AbortController();
      ac.abort();
      const t = tool(log);
      const r = await gateAndDispatchTool(t, {}, 'tu-ab1', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
        signal: ac.signal,
      });
      expect(seam.maybeScreen).not.toHaveBeenCalled();
      expect(log).toEqual(['execute']);
      expect(r.text).toBe('sent');
    });

    it('hands the seam the round signal so a provider can abort in flight', async () => {
      const log: string[] = [];
      const seen: (AbortSignal | undefined)[] = [];
      const seam = { maybeScreen: vi.fn(async (_c: ToolCall, sig?: AbortSignal) => { seen.push(sig); }) };
      const ac = new AbortController();
      await gateAndDispatchTool(tool(log), {}, 'tu-ab2', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
        signal: ac.signal,
      });
      expect(seen[0]).toBe(ac.signal);
    });

    it('a mid-flight abort releases the belt without waiting out the timeout', async () => {
      const log: string[] = [];
      const ac = new AbortController();
      // A provider that ignores the signal entirely: the belt must still let go.
      const seam = { maybeScreen: vi.fn(() => new Promise<void>(() => {})) };
      const dispatched = gateAndDispatchTool(tool(log), {}, 'tu-ab3', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
        signal: ac.signal,
      });
      ac.abort();
      const r = await dispatched;
      expect(r.text).toBe('sent');
      expect(log).toEqual(['execute']);
    });
  });

  /**
   * The belt is the LAST place an intended screen can vanish. When it releases a
   * hung seam the tool proceeds with no verdict and, before this hook, no trace:
   * the seam never settled, so nothing anywhere recorded that a screen was wanted
   * and never answered. `onBeltTimeout` is how that becomes countable — it is told
   * ONLY when the timer won, never when the seam answered and never on an abort
   * (a stopped round is not a fault), and it can never affect the dispatch.
   */
  describe('the belt reports itself (counting blind spot)', () => {
    it('tells the seam when the belt timeout released a hung screen', async () => {
      vi.useFakeTimers();
      const belted: ToolCall[] = [];
      const seam = {
        maybeScreen: vi.fn(() => new Promise<void>(() => {})),
        onBeltTimeout: vi.fn((call: ToolCall) => void belted.push(call)),
      };
      const p = gateAndDispatchTool(tool([]), { to: 'a@b.c' }, 'tu-belt1', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
      });
      await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
      const r = await p;
      expect(r.text).toBe('sent');
      expect(seam.onBeltTimeout).toHaveBeenCalledTimes(1);
      expect(belted[0]).toEqual({
        toolName: 'mcp__composio__GMAIL_SEND_EMAIL',
        toolInput: { to: 'a@b.c' },
        toolCallId: 'tu-belt1',
      });
    });

    it('a seam that answers in time is never told the belt fired', async () => {
      const seam = { maybeScreen: vi.fn(async () => {}), onBeltTimeout: vi.fn() };
      await gateAndDispatchTool(tool([]), {}, 'tu-belt2', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
      });
      expect(seam.onBeltTimeout).not.toHaveBeenCalled();
    });

    it('a rejecting seam is not a belt timeout (it settles, so it can account for itself)', async () => {
      const seam = { maybeScreen: vi.fn(async () => Promise.reject(new Error('down'))), onBeltTimeout: vi.fn() };
      await gateAndDispatchTool(tool([]), {}, 'tu-belt3', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
      });
      expect(seam.onBeltTimeout).not.toHaveBeenCalled();
    });

    it('a stopped round is not a belt timeout', async () => {
      const ac = new AbortController();
      const seam = { maybeScreen: vi.fn(() => new Promise<void>(() => {})), onBeltTimeout: vi.fn() };
      const dispatched = gateAndDispatchTool(tool([]), {}, 'tu-belt4', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
        signal: ac.signal,
      });
      ac.abort();
      await dispatched;
      expect(seam.onBeltTimeout).not.toHaveBeenCalled();
    });

    it('a throwing onBeltTimeout never stops the dispatch (the counter cannot break the rail)', async () => {
      vi.useFakeTimers();
      const seam = {
        maybeScreen: vi.fn(() => new Promise<void>(() => {})),
        onBeltTimeout: vi.fn(() => {
          throw new Error('beacon exploded');
        }),
      };
      const p = gateAndDispatchTool(tool([]), {}, 'tu-belt5', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
      });
      await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
      const r = await p;
      expect(r.text).toBe('sent');
      expect(r.isError).toBe(false);
    });

    it('a seam without the hook is dispatched exactly as before', async () => {
      vi.useFakeTimers();
      const seam = { maybeScreen: vi.fn(() => new Promise<void>(() => {})) };
      const p = gateAndDispatchTool(tool([]), {}, 'tu-belt6', allowGate() as never, NOOP_PAUSE, undefined, {
        injectionScreen: seam,
      });
      await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
      expect((await p).text).toBe('sent');
    });
  });

  it('no seam: the dispatch is untouched', async () => {
    const log: string[] = [];
    const r = await gateAndDispatchTool(tool(log), {}, 'tu-s9', allowGate() as never, NOOP_PAUSE);
    expect(r).toEqual({ toolUseId: 'tu-s9', text: 'sent', isError: false });
    expect(log).toEqual(['execute']);
  });
});

/**
 * THE VERDICT CHANNEL — built dark, on purpose.
 *
 * The screen was already awaited inline before every side-effecting call on a
 * tainted turn, and the answer was thrown away: `maybeScreen` returned
 * `Promise<void>`, so the wait was paid and the verdict had nowhere to land. It
 * lands here now. What must NOT have changed is anything a user can feel, so the
 * assertion this suite is built around is a NEGATIVE one: a call carrying an
 * `instructed` verdict dispatches byte-for-byte the same call, in the same
 * order, as one carrying no verdict at all.
 *
 * The channel is not a flag and there is no enforcing branch to switch on. If a
 * later change adds one, `dispatches an instructed verdict identically to no
 * verdict at all` is the test that turns red — verified by mutation, not assumed.
 */
describe('gateAndDispatchTool — the screen verdict reaches the dispatcher', () => {
  const seamReturning = (reading: InjectionScreenReading | undefined) => ({
    maybeScreen: vi.fn(async () => reading),
  });

  const READINGS: [string, InjectionScreenReading][] = [
    ['clean', { verdict: 'clean' }],
    ['instructed', { verdict: 'instructed', reason: 'the page asked for this send' }],
    ['unavailable (model timeout)', { verdict: 'unavailable', fault: { stage: 'model', code: 'timeout' } }],
    ['unavailable (runner transport)', { verdict: 'unavailable', fault: { stage: 'runner', code: 'transport_error' } }],
  ];

  it.each(READINGS)('carries the %s reading out on the result', async (_label, reading) => {
    const r = await gateAndDispatchTool(tool([]), {}, 'tu-v1', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning(reading),
    });
    expect(r.screen).toEqual(reading);
  });

  /**
   * THE ONE THAT MATTERS. `instructed` is the verdict enforcement would act on,
   * so this pins that today it acts on nothing: same text, same isError, same
   * execute call, same arguments, and a result that is key-for-key identical to
   * the unscreened one once the observation is removed.
   */
  it('dispatches an instructed verdict identically to no verdict at all', async () => {
    const instructedLog: string[] = [];
    const t1 = tool(instructedLog);
    const screened = await gateAndDispatchTool(t1, { to: 'a@b.c' }, 'tu-v2', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'instructed', reason: 'the page asked for this send' }),
    });

    const bareLog: string[] = [];
    const t2 = tool(bareLog);
    const bare = await gateAndDispatchTool(t2, { to: 'a@b.c' }, 'tu-v2', allowGate() as never, NOOP_PAUSE, undefined, {});

    expect(t1.execute).toHaveBeenCalledTimes(1);
    expect(t1.execute).toHaveBeenCalledWith({ to: 'a@b.c' }, expect.anything());
    expect(instructedLog).toEqual(['execute']);
    expect(bareLog).toEqual(['execute']);

    // Key-for-key, not field-by-field: an extra key on either side fails this.
    const { screen, ...withoutObservation } = screened;
    expect(screen).toEqual({ verdict: 'instructed', reason: 'the page asked for this send' });
    expect(withoutObservation).toEqual(bare);
    expect(Object.keys(withoutObservation).sort()).toEqual(Object.keys(bare).sort());
  });

  it('dispatches an unavailable verdict identically too (no verdict is not a refusal)', async () => {
    const log: string[] = [];
    const t = tool(log);
    const r = await gateAndDispatchTool(t, {}, 'tu-v3', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'unavailable', fault: { stage: 'model', code: 'timeout' } }),
    });
    expect(log).toEqual(['execute']);
    expect(r.text).toBe('sent');
    expect(r.isError).toBe(false);
  });

  /**
   * `unavailable` and `clean` are the pair the enforcement decision inherits, and
   * before the channel they were indistinguishable downstream because nothing read
   * either. Behaviour does not tell them apart — that is the point of shadow — so
   * the REPRESENTATION has to.
   */
  it('keeps unavailable apart from clean, with the cause intact', async () => {
    const clean = await gateAndDispatchTool(tool([]), {}, 'tu-v4', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'clean' }),
    });
    const dark = await gateAndDispatchTool(tool([]), {}, 'tu-v5', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'unavailable', fault: { stage: 'model', code: 'timeout' } }),
    });
    expect(clean.screen).not.toEqual(dark.screen);
    expect(clean.screen?.verdict).toBe('clean');
    expect(dark.screen?.verdict).toBe('unavailable');
    // The stage split the availability rail counts by survives the crossing.
    expect(dark.screen).toMatchObject({ fault: { stage: 'model', code: 'timeout' } });
    // Both dispatched. The distinction is legible and inert at the same time.
    expect(clean.text).toBe('sent');
    expect(dark.text).toBe('sent');
  });

  /**
   * A seam that answers nothing is a turn with nothing to judge (no third-party
   * content, or a call outside the screened families) — NOT a clean verdict. The
   * result must carry no `screen` key at all, so an unscreened dispatch stays
   * key-for-key identical to a dispatch with no seam attached.
   */
  it.each([
    ['a void-returning seam', { maybeScreen: vi.fn(async () => {}) }],
    ['a throwing seam', { maybeScreen: vi.fn(() => { throw new Error('boom'); }) }],
    ['a rejecting seam', { maybeScreen: vi.fn(async () => Promise.reject(new Error('down'))) }],
  ])('stamps nothing for %s', async (_label, seam) => {
    const r = await gateAndDispatchTool(tool([]), {}, 'tu-v6', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    expect('screen' in r).toBe(false);
    expect(r).toEqual({ toolUseId: 'tu-v6', text: 'sent', isError: false });
  });

  /**
   * The belt released a screen that never settled. A screen WAS wanted (the seam
   * decides that internally, and a hung one cannot tell us either way), so this
   * is `unavailable` with a fault — never `undefined`, which would read as "no
   * screen was needed" and restore the blind spot the channel exists to close.
   */
  it('reads a belted screen as unavailable, not as no screen', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const seam = { maybeScreen: vi.fn(() => new Promise<void>(() => {})) };
    const p = gateAndDispatchTool(tool(log), {}, 'tu-v7', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
    const r = await p;
    expect(r.screen).toEqual(BELT_TIMEOUT_READING);
    expect(r.screen).toMatchObject({ verdict: 'unavailable', fault: { code: 'belt_timeout' } });
    expect(log).toEqual(['execute']);
    expect(r.text).toBe('sent');
  });

  /** A stopped round is a stop, not a fault — the rule the seam's own accounting follows. */
  it('reads a stopped round as no screen at all', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await gateAndDispatchTool(tool([]), {}, 'tu-v8', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'instructed', reason: 'x' }),
      signal: ac.signal,
    });
    expect('screen' in r).toBe(false);
  });

  /**
   * A LATE settle cannot rewrite a decision already taken. The belt released this
   * call and the tool ran; the seam answering afterwards must not retroactively
   * stamp a verdict the dispatch never saw.
   */
  it('ignores a verdict that lands after the belt already released the call', async () => {
    vi.useFakeTimers();
    let settle: ((r: InjectionScreenReading) => void) | undefined;
    const seam = {
      maybeScreen: vi.fn(() => new Promise<InjectionScreenReading>((res) => { settle = res; })),
    };
    const p = gateAndDispatchTool(tool([]), {}, 'tu-v9', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seam,
    });
    await vi.advanceTimersByTimeAsync(INJECTION_SCREEN_BELT_TIMEOUT_MS);
    settle?.({ verdict: 'instructed', reason: 'too late' });
    const r = await p;
    expect(r.screen).toEqual(BELT_TIMEOUT_READING);
  });

  /**
   * The verdict is stamped on the ERROR returns too, not only the success one. A
   * screened call that throws is still a screened call, and an observation that
   * exists on some outcomes and not others is one an enforcement decision would
   * have to special-case.
   */
  it('stamps the reading on a throwing tool as well', async () => {
    const thrower: RawToolOptions = {
      name: 'mcp__composio__GMAIL_SEND_EMAIL',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => { throw new Error('provider 500'); }),
    };
    const r = await gateAndDispatchTool(thrower, {}, 'tu-v10', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'instructed', reason: 'r' }),
    });
    expect(r.isError).toBe(true);
    expect(r.screen).toEqual({ verdict: 'instructed', reason: 'r' });
  });

  /**
   * TIMING. The seam is awaited inline, so the only way the channel could cost a
   * user anything is by making the dispatcher wait longer than it already did.
   * It does not: an answering seam and a void seam release the dispatch on the
   * same tick, and neither arms the belt.
   */
  it('costs no extra wait: an answering seam releases on the same tick as a void one', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const answering = gateAndDispatchTool(tool([]), {}, 'tu-v11', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: seamReturning({ verdict: 'instructed', reason: 'r' }),
    }).then(() => order.push('answering'));
    const bare = gateAndDispatchTool(tool([]), {}, 'tu-v12', allowGate() as never, NOOP_PAUSE, undefined, {
      injectionScreen: { maybeScreen: vi.fn(async () => {}) },
    }).then(() => order.push('void'));
    // No timer advance at all: if the reading added a rung, one of these would hang.
    await Promise.all([answering, bare]);
    expect(order).toEqual(['answering', 'void']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
