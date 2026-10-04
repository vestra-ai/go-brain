import { describe, it, expect } from 'vitest';
import { FakeTransport, type Transport } from '../transport.js';
import { resolveChildTransport, runChildWithFallback } from '../child-transport-registry.js';

/**
 * Task 10 — per-child transport/model routing + single-shot fallback.
 *
 * `resolveChildTransport` is the engine-pure resolver: PARENT pair verbatim when a
 * child carries no override, a provider-specific pair when it does. The concrete
 * transport is built by an INJECTED factory (the product's `selectNativeTransport`)
 * because the engine never imports a provider transport.
 *
 * `runChildWithFallback` is the engine-pure single-shot fallback: run once on the
 * primary model, retry ONCE on the fallback model on the first throw (mirroring the
 * parent loop's `cfg.retry.fallbackModel`). When primary === fallback (a no-override
 * child) there is nothing to fall back to — one attempt, byte-identical to Task 9.
 */
const anthropicT: Transport = new FakeTransport([]);
const fireworksT: Transport = new FakeTransport([]);

describe('resolveChildTransport', () => {
  it('routes a child to its requested model/provider, else inherits the parent', () => {
    const parent = { transport: anthropicT, model: 'claude-opus-4-8' };
    // The injected factory maps a resolved model id → its provider transport.
    const makeTransport = (model: string): Transport => (model === 'glm-5.2' ? fireworksT : anthropicT);

    // No override → the parent pair, VERBATIM.
    expect(resolveChildTransport({}, parent, makeTransport)).toEqual(parent);
    expect(resolveChildTransport({}, parent)).toBe(parent);

    // Override → a provider-specific pair (routed model + routed transport).
    const routed = resolveChildTransport({ model: 'glm-5.2', provider: 'fireworks' }, parent, makeTransport);
    expect(routed.model).toBe('glm-5.2');
    expect(routed.transport).toBe(fireworksT);
  });

  it('keeps the parent transport but stamps the resolved model when no factory is wired', () => {
    const parent = { transport: anthropicT, model: 'claude-opus-4-8' };
    const routed = resolveChildTransport({ model: 'glm-5.2' }, parent);
    expect(routed.model).toBe('glm-5.2');
    expect(routed.transport).toBe(anthropicT);
  });
});

describe('runChildWithFallback', () => {
  it('falls back to the parent model when the child run throws once', async () => {
    let calls = 0;
    const run = async (model: string): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('flaky-model unavailable');
      return model;
    };
    const res = await runChildWithFallback({ run, primaryModel: 'flaky-model', fallbackModel: 'parent-model' });
    expect(res.usedFallback).toBe(true);
    expect(res.value).toBe('parent-model'); // the retry ran on the fallback model
    expect(calls).toBe(2);
  });

  it('does not retry when the run succeeds first time', async () => {
    let calls = 0;
    const run = async (model: string): Promise<string> => {
      calls += 1;
      return model;
    };
    const res = await runChildWithFallback({ run, primaryModel: 'routed', fallbackModel: 'parent' });
    expect(res.usedFallback).toBe(false);
    expect(res.value).toBe('routed');
    expect(calls).toBe(1);
  });

  it('does not retry a no-override child (primary === fallback) — rethrows the throw', async () => {
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      throw new Error('boom');
    };
    await expect(runChildWithFallback({ run, primaryModel: 'm', fallbackModel: 'm' })).rejects.toThrow('boom');
    expect(calls).toBe(1); // single attempt — nothing distinct to fall back to
  });

  it('suppresses the retry when shouldRetry returns false (e.g. a user abort)', async () => {
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      throw new Error('aborted');
    };
    await expect(
      runChildWithFallback({ run, primaryModel: 'routed', fallbackModel: 'parent', shouldRetry: () => false }),
    ).rejects.toThrow('aborted');
    expect(calls).toBe(1);
  });
});
