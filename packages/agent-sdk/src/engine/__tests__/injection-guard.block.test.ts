/**
 * injection-guard.block.test.ts — S4, ruling 2 ("block and tell").
 *
 * The provider (apps/sandbox, INJECTION_SCREEN_V1=block) stamps an `instructed`
 * reading with `block`; the dispatcher refuses that one call in one plain line. No
 * permission card on this path, so the Relaxed ruling (only payments and deletes ask)
 * is untouched, and a refusal never ends the turn (a working task is never stopped).
 * A reading WITHOUT `block` (shadow, value `true`) dispatches exactly as before:
 * pinned by tool-dispatcher.screen.test.ts ("dispatches an instructed verdict
 * identically to no verdict at all"), which this file does not replace.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { _resetFuelTanksForTest } from '../fuel-tank.js';
import { INJECTION_GUARD_SKIP_LINE } from '../../policy/injection-guard.js';
import type { InjectionScreenReading } from '../../policy/injection-screen.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolCall, GateResult, HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';

const allowGate = () => ({ gateTool: vi.fn(async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' })) });

function sendTool(): RawToolOptions {
  return {
    name: 'mcp__composio__GMAIL_SEND_EMAIL',
    description: 'send',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: vi.fn(async () => 'sent'),
  };
}

const seamReturning = (reading: InjectionScreenReading) => ({ maybeScreen: vi.fn(async () => reading) });
const INSTRUCTED = { verdict: 'instructed', reason: 'the page asked for this send' } as const;

describe('guard block: the dispatcher refuses a content-asked side effect', () => {
  it('guard block: refuses content-asked side effect (not run, told in one plain line)', async () => {
    const t = sendTool();
    const onPause = vi.fn(async () => 'PAUSED_HALT');
    const pushEvent = vi.fn();
    const reading: InjectionScreenReading = { ...INSTRUCTED, block: true };
    const r = await gateAndDispatchTool(t, { to: 'x@example.com' }, 'tu-g1', allowGate() as never, onPause, undefined, {
      injectionScreen: seamReturning(reading),
      pushEvent,
    });
    expect(t.execute).not.toHaveBeenCalled();
    expect(r).toEqual({ toolUseId: 'tu-g1', text: INJECTION_GUARD_SKIP_LINE, isError: true, screen: reading, refused: true });
    expect(r.text).toBe('Skipped: a web page or message asked for this, not you.');
    // Block and TELL, never ask: no card, no pause, no deny frame (the Relaxed invariant).
    expect(onPause).not.toHaveBeenCalled();
    expect(r.pausedHalt).toBeUndefined();
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('guard block: person-asked side effect proceeds', async () => {
    const t = sendTool();
    const r = await gateAndDispatchTool(t, { to: 'x@example.com' }, 'tu-g2', allowGate() as never, async () => '', undefined, {
      injectionScreen: seamReturning({ verdict: 'clean' }),
    });
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(r.text).toBe('sent');
    expect(r.isError).toBe(false);
  });

  it('guard block: an unavailable reading never refuses (fail-open)', async () => {
    const t = sendTool();
    const r = await gateAndDispatchTool(t, {}, 'tu-g4', allowGate() as never, async () => '', undefined, {
      injectionScreen: seamReturning({ verdict: 'unavailable', fault: { stage: 'model', code: 'timeout' } }),
    });
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(r.text).toBe('sent');
  });
});

// ─── through the real loop: refusals never end the turn ─────────────────────

const done = (stopReason: string): StreamEvent => ({
  kind: 'done',
  stopReason,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } as NormalizedUsage,
});

/** A model that asks for the send `sends` times, then finishes its real work. */
class SendsThenAnswers extends FakeTransport {
  calls = 0;
  constructor(private readonly sends: number) {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    this.calls += 1;
    if (this.calls > this.sends) return [{ kind: 'text', text: 'Here is the research summary.' }, done('end_turn')];
    return [{ kind: 'tool_use', toolUse: { id: `tu-${this.calls}`, name: 'Send', input: {} } }, done('tool_use')];
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

describe('guard block: through the loop', () => {
  it('guard block: repeated refusals never end the turn', async () => {
    _resetFuelTanksForTest();
    const transport = new SendsThenAnswers(5);
    const execute = vi.fn(() => 'sent');
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return {
          tools: [{ name: 'Send', description: 'send', parameters: { type: 'object', properties: {} }, execute }],
          onAuthHalt: async () => {},
        };
      },
    };
    const requestInteraction = vi.fn(async () => 'int-1');
    const config = {
      onAttached: () => {},
      maxTurns: 12,
      transport,
      toolHost,
      injectionScreen: seamReturning({ ...INSTRUCTED, block: true }),
      policy: {
        gate: async (): Promise<GateResult> => ({ decision: 'allow' }),
        permissionMode: () => 'default',
        seedModeFromEnv: () => {},
      },
      interaction: { requestInteraction },
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = {
      taskId: 'guard-t',
      sessionId: 'guard-s',
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      signal: new AbortController().signal,
      config,
    };
    const input = (async function* (): AsyncIterable<UserTurn> {
      yield { text: 'research the page' };
    })();
    const events: HarnessEvent[] = [];
    for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);

    // Five refusals, then the model's own answer: the turn ran to its real end.
    expect(transport.calls).toBe(6);
    expect(execute).not.toHaveBeenCalled();
    const results = events.flatMap((e) =>
      e.kind === 'block' && (e.block as { type: string }).type === 'tool_result' ? [e.block as { content: unknown }] : [],
    );
    expect(results.map((b) => b.content)).toEqual(Array(5).fill(INJECTION_GUARD_SKIP_LINE));
    const end = events.find((e) => e.kind === 'turn_end') as
      | { outcome: { kind: string }; paused?: boolean; blocks: Array<{ type: string; text?: string }> }
      | undefined;
    expect(end?.outcome.kind).toBe('completed');
    expect(end?.paused).toBeUndefined();
    expect(end?.blocks.some((b) => b.text === 'Here is the research summary.')).toBe(true);
    // Never an ask on this path (the Relaxed invariant).
    expect(requestInteraction).not.toHaveBeenCalled();
  });
});
