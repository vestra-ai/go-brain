/**
 * @vestra/agent-sdk/query — the public `query()` streaming front door + the
 * built-in HarnessRegistry (ring 5).
 *
 * This is a BATTERIES entry: it imports the engine (NativeHarness) to drive
 * real runs, so it does I/O at run() time. The pure ROOT (`@vestra/agent-sdk`,
 * which `@bash/shared` re-exports) must NOT export `query` — keep it I/O-free at
 * import. Consume the front door from this subpath instead:
 *
 *   import { query } from '@vestra/agent-sdk/query';
 *
 * Spec: docs/superpowers/specs/2026-06-18-vestra-agent-sdk-extraction-design.md
 * §6/§8.5 — "the SDK is consumed via a declarative `query({ harness })` front door".
 */
import type { Harness, HarnessContext, UserTurn } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import { NativeHarness } from '../engine/native-harness.js';

/** The id of a harness the SDK ships built-in (resolvable via {@link HARNESS_REGISTRY}). */
export type BuiltInHarnessId = 'native';

/**
 * The SDK's built-in harness factories. `native` is the SDK's ONE built-in arm.
 * Other harnesses (the product's `ClaudeHarness`/`OpenAIHarness`) arrive as
 * caller-provided instances passed straight to {@link query}. The registry is
 * MECHANISM only — the runtime→harness SELECTOR stays in the product (it owns
 * the gating + the provider arms the SDK does not ship).
 */
export const HARNESS_REGISTRY: Record<BuiltInHarnessId, () => Harness<unknown>> = {
  native: () => new NativeHarness() as Harness<unknown>,
};

/** The declarative shape `query()` consumes. Generic over the harness's own config. */
export interface QueryOptions<TConfig> {
  /**
   * A built-in id (resolved via {@link HARNESS_REGISTRY}) OR a `Harness` instance
   * the caller constructed (e.g. the product's ClaudeHarness / OpenAIHarness).
   */
  harness: BuiltInHarnessId | Harness<TConfig>;
  /** The model id this run drives (threaded into the assembled HarnessContext). */
  model: string;
  /** The user-turn stream feeding the loop. */
  prompt: AsyncIterable<UserTurn>;
  /** The harness's config — `NativeConfig` for the built-in `'native'`. */
  config: TConfig;
  taskId?: string;
  sessionId?: string;
  cwd?: string;
}

/**
 * The value `query()` returns: the harness's `HarnessEvent` stream PLUS an
 * `interrupt()` that aborts the run by tripping the AbortSignal. Iterate it to
 * drive the loop; call `interrupt()` to cancel.
 *
 * P3 — `interrupt()` is UNCONDITIONALLY observable: query() always sets
 * `ctx.signal` (a contract spine field) from the same controller, so a harness
 * that reads `ctx.signal` sees the abort even when its config carries no `signal`
 * slot. Arms that cancel via their own out-of-band handle (a Claude adapter) MAY
 * ignore ctx.signal for stream teardown but MUST NOT contradict it.
 */
export interface QueryHandle extends AsyncIterable<HarnessEvent> {
  interrupt(): void;
}

/**
 * The public front door. Resolve the harness (id → registry, or use the passed
 * instance), wire an AbortController into the config's `signal` slot when the
 * caller left one open, assemble the per-session HarnessContext, and return the
 * harness's event stream behind a QueryHandle whose `interrupt()` aborts it.
 *
 * ADDITIVE: this drives the harness through the SAME `run()` contract the
 * product's query-manager uses — it does NOT replace the orchestration; it is a
 * thin declarative façade over a single conversation.
 */
export function query<TConfig>(opts: QueryOptions<TConfig>): QueryHandle {
  const harness =
    typeof opts.harness === 'string'
      ? (HARNESS_REGISTRY[opts.harness]() as Harness<TConfig>)
      : opts.harness;

  const ac = new AbortController();

  // Inject the abort signal into the config IFF it exposes a `signal` slot and
  // the caller did not already provide one (e.g. NativeConfig.signal). When the
  // config has no signal slot, interrupt() still aborts the controller, but the
  // harness simply never reads it (a no-op for signal-less configs).
  const c = opts.config as TConfig & { signal?: AbortSignal };
  const config: TConfig =
    c && typeof c === 'object' && c.signal === undefined
      ? ({ ...c, signal: ac.signal } as TConfig)
      : opts.config;

  const ctx: HarnessContext<TConfig> = {
    taskId: opts.taskId ?? '',
    sessionId: opts.sessionId ?? '',
    cwd: opts.cwd ?? '',
    model: opts.model,
    // P3 — the contract spine field: always the controller's signal, so
    // interrupt() is observable even for a config with no `signal` slot. The
    // config-slot spread above derives from the SAME controller (one source of truth).
    signal: ac.signal,
    config,
  };

  const stream = harness.run(opts.prompt, ctx);
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    interrupt: () => ac.abort(),
  };
}
