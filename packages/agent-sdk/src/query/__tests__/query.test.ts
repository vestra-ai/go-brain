import { describe, it, expect } from 'vitest';
import { query, HARNESS_REGISTRY } from '../index.js';
import { NativeHarness } from '../../engine/native-harness.js';
import { FakeTransport, type StreamEvent } from '../../engine/transport.js';
import type { NativeConfig } from '../../engine/native-config.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';
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
// Helpers — SDK-only. NOTHING from apps/sandbox.
// ─────────────────────────────────────────────────────────────────────────────

/** A single scripted assistant turn that ends with `end_turn`. */
function scriptedEndTurn(text = 'hello'): StreamEvent[] {
  return [
    { kind: 'text', text },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** A minimal NativeConfig built from ONLY SDK pieces. The engine fills the port
 *  defaults (AllowAllPolicyPort / EmptyToolHost / …) when they are absent. */
function minimalNativeConfig(overrides: Partial<NativeConfig> = {}): NativeConfig {
  return {
    onAttached: () => {},
    maxTurns: 5,
    runtimeConfig: makeRuntimeConfig({ systemPrompt: '' }),
    transport: new FakeTransport(scriptedEndTurn()),
    ...overrides,
  };
}

/** A single-turn user prompt stream. */
async function* oneTurn(text: string): AsyncIterable<UserTurn> {
  yield { text };
}

async function collect(handle: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of handle) out.push(ev);
  return out;
}

const turnEnds = (events: HarnessEvent[]) =>
  events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');

/**
 * A tiny conformant FakeHarness — yields a scripted event then a terminal
 * turn_end, and RECORDS the HarnessContext it received so the test can assert
 * query() assembled it correctly. Used for the instance + interrupt paths.
 */
class FakeHarness implements Harness<{ tag: string; signal?: AbortSignal }> {
  readonly id = 'native' as const;
  readonly capabilities: HarnessCapabilities = {
    reportsCostUsd: false,
  } as unknown as HarnessCapabilities;

  lastCtx: HarnessContext<{ tag: string; signal?: AbortSignal }> | null = null;
  sawAbortedAtRun: boolean | null = null;

  async *run(
    _input: AsyncIterable<UserTurn>,
    ctx: HarnessContext<{ tag: string; signal?: AbortSignal }>,
  ): AsyncIterable<HarnessEvent> {
    this.lastCtx = ctx;
    this.sawAbortedAtRun = ctx.config.signal?.aborted ?? null;
    yield { kind: 'block', block: { type: 'text', text: 'from-fake' } as never };
    yield {
      kind: 'turn_end',
      outcome: { kind: 'completed', summary: '', costUsd: 0, numTurns: 1, durationMs: 0, modelUsage: {}, raw: { subtype: 'fake', errors: [] } } as TurnOutcome,
      blocks: [],
      stopReason: 'end_turn',
      billing: { cumulativeCostUsd: 0, modelUsage: {} },
    };
  }

  async gateTool(_call: ToolCall): Promise<GateResult> {
    return { decision: 'allow' };
  }
  pause(_call: ToolCall): ResumeHandle {
    return { serializable: false, payload: null };
  }
  resume(_handle: ResumeHandle, _answer: HumanAnswer): void {}
  classifyTermination(_raw: unknown): TurnOutcome {
    return { kind: 'completed', summary: '', costUsd: 0, numTurns: 1, durationMs: 0, modelUsage: {}, raw: { subtype: 'fake', errors: [] } } as TurnOutcome;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) the registry built-in
// ─────────────────────────────────────────────────────────────────────────────

describe('HARNESS_REGISTRY', () => {
  it('native() returns a NativeHarness instance', () => {
    const h = HARNESS_REGISTRY.native();
    expect(h).toBeInstanceOf(NativeHarness);
    expect(h.id).toBe('native');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) query({ harness: 'native' }) drives the REAL NativeHarness via SDK pieces
// ─────────────────────────────────────────────────────────────────────────────

describe('query({ harness: "native" }) — drives the real engine', () => {
  it('resolves the built-in via the registry and yields a terminal turn_end', async () => {
    const handle = query<NativeConfig>({
      harness: 'native',
      model: 'claude-sonnet-4-6',
      prompt: oneTurn('hi'),
      config: minimalNativeConfig(),
      taskId: 't1',
      sessionId: 's1',
      cwd: '/tmp',
    });

    const events = await collect(handle);
    const ends = turnEnds(events);
    expect(ends).toHaveLength(1);
    // FakeTransport classifies an end_turn as a completed outcome.
    expect(ends[0].outcome.kind).toBe('completed');
  });

  it('exposes interrupt() on the handle', () => {
    const handle = query<NativeConfig>({
      harness: 'native',
      model: 'claude-sonnet-4-6',
      prompt: oneTurn('hi'),
      config: minimalNativeConfig(),
    });
    expect(typeof handle.interrupt).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) query({ harness: <instance> }) uses the instance + the assembled context
// ─────────────────────────────────────────────────────────────────────────────

describe('query({ harness: <instance> }) — uses the passed instance', () => {
  it('drives the instance and hands it the assembled HarnessContext', async () => {
    const fake = new FakeHarness();
    const handle = query<{ tag: string; signal?: AbortSignal }>({
      harness: fake,
      model: 'gpt-5.4',
      prompt: oneTurn('go'),
      config: { tag: 'cfg-marker' },
      taskId: 'task-7',
      sessionId: 'sess-7',
      cwd: '/work',
    });

    const events = await collect(handle);
    // The instance's scripted events flowed through.
    expect(events.some((e) => e.kind === 'block')).toBe(true);
    expect(turnEnds(events)).toHaveLength(1);

    // The assembled context reached run() with the right fields.
    expect(fake.lastCtx).not.toBeNull();
    expect(fake.lastCtx!.taskId).toBe('task-7');
    expect(fake.lastCtx!.sessionId).toBe('sess-7');
    expect(fake.lastCtx!.cwd).toBe('/work');
    expect(fake.lastCtx!.model).toBe('gpt-5.4');
    expect(fake.lastCtx!.config.tag).toBe('cfg-marker');
  });

  it('defaults taskId/sessionId/cwd to "" when omitted', async () => {
    const fake = new FakeHarness();
    const handle = query<{ tag: string; signal?: AbortSignal }>({
      harness: fake,
      model: 'm',
      prompt: oneTurn('go'),
      config: { tag: 't' },
    });
    await collect(handle);
    expect(fake.lastCtx!.taskId).toBe('');
    expect(fake.lastCtx!.sessionId).toBe('');
    expect(fake.lastCtx!.cwd).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) interrupt() aborts via the injected signal
// ─────────────────────────────────────────────────────────────────────────────

describe('interrupt() — aborts the run via the injected AbortSignal', () => {
  it('injects ac.signal into a config that left signal unset, and interrupt() aborts it', async () => {
    const fake = new FakeHarness();
    const handle = query<{ tag: string; signal?: AbortSignal }>({
      harness: fake,
      model: 'm',
      prompt: oneTurn('go'),
      config: { tag: 't' }, // no signal → query() injects one
    });

    // interrupt() before iterating; the FakeHarness records signal.aborted at run().
    handle.interrupt();
    await collect(handle);

    expect(fake.lastCtx!.config.signal).toBeDefined();
    expect(fake.sawAbortedAtRun).toBe(true);
  });

  it('does NOT overwrite a caller-provided signal', async () => {
    const fake = new FakeHarness();
    const callerAc = new AbortController();
    const handle = query<{ tag: string; signal?: AbortSignal }>({
      harness: fake,
      model: 'm',
      prompt: oneTurn('go'),
      config: { tag: 't', signal: callerAc.signal },
    });
    // interrupt() trips query()'s OWN controller, which is NOT the caller's signal.
    handle.interrupt();
    await collect(handle);
    // The caller's signal is the one the harness saw, and it was not aborted by interrupt().
    expect(fake.lastCtx!.config.signal).toBe(callerAc.signal);
    expect(fake.sawAbortedAtRun).toBe(false);
  });
});
