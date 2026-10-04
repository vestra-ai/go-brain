import { describe, it, expect } from 'vitest';
import { resolveRoutedSpawn, RoutingFloorViolationError, UnknownSpawnModelError } from '../routed-spawn.js';
import type { Transport } from '../../engine/transport.js';

const parentTransport = { api: 'anthropic_messages' } as unknown as Transport;
const parent = { transport: parentTransport, model: 'claude-sonnet-5' };

describe('resolveRoutedSpawn — AC-R5 per-node routing + floor', () => {
  it('no override → the parent pair verbatim (byte-identical to no routing)', () => {
    expect(resolveRoutedSpawn({}, parent)).toBe(parent);
  });

  it('an override at/above the floor routes to that model via the injected transport factory', () => {
    const routedTransport = { api: 'gemini' } as unknown as Transport;
    const makeTransport = () => routedTransport;
    const result = resolveRoutedSpawn({ model: 'gpt-5.5', provider: 'openai' }, parent, makeTransport);
    expect(result.model).toBe('gpt-5.5');
    expect(result.transport).toBe(routedTransport);
  });

  it('an override requesting a Haiku model is REJECTED — throws, never silently downgrades', () => {
    expect(() => resolveRoutedSpawn({ model: 'claude-haiku-4-5' }, parent)).toThrow(RoutingFloorViolationError);
  });

  it('the rejection happens BEFORE any transport is built (no side effect on a rejected spawn)', () => {
    let built = false;
    const makeTransport = () => {
      built = true;
      return parentTransport;
    };
    expect(() => resolveRoutedSpawn({ model: 'claude-haiku-4-5-20251001' }, parent, makeTransport)).toThrow(
      RoutingFloorViolationError,
    );
    expect(built).toBe(false);
  });

  it('the error carries the requested model', () => {
    try {
      resolveRoutedSpawn({ model: 'claude-haiku-4-5' }, parent);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingFloorViolationError);
      expect((err as RoutingFloorViolationError).requestedModel).toBe('claude-haiku-4-5');
    }
  });

  it('a provider-only override (no model) still routes on the parent model, never floor-rejected', () => {
    const result = resolveRoutedSpawn({ provider: 'fireworks' }, parent, (m) => ({ api: m }) as unknown as Transport);
    expect(result.model).toBe('claude-sonnet-5'); // falls back to parent model, which is above the floor
  });

  describe('the INHERITED path is floor-checked too (coordinator must-fix)', () => {
    const haikuParent = { transport: parentTransport, model: 'claude-haiku-4-5' };

    it('a session whose OWN model is Haiku is REJECTED even with NO per-spawn override', () => {
      // A "Lite" session (AGENT_MODE_MODELS.light = claude-haiku-4-5) spawning a
      // type with no model pin and no per-spawn override must NOT silently
      // inherit Haiku — that is exactly the case the floor exists to catch.
      expect(() => resolveRoutedSpawn({}, haikuParent)).toThrow(RoutingFloorViolationError);
    });

    it('the rejection on the inherited path also happens BEFORE any transport is built', () => {
      let built = false;
      const makeTransport = () => {
        built = true;
        return parentTransport;
      };
      expect(() => resolveRoutedSpawn({}, haikuParent, makeTransport)).toThrow(RoutingFloorViolationError);
      expect(built).toBe(false);
    });

    it('the error on the inherited path names the PARENT model (what would have actually run)', () => {
      try {
        resolveRoutedSpawn({}, haikuParent);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as RoutingFloorViolationError).requestedModel).toBe('claude-haiku-4-5');
      }
    });

    it('a provider-only override on a Haiku parent is STILL rejected (resolved model is still Haiku)', () => {
      expect(() => resolveRoutedSpawn({ provider: 'fireworks' }, haikuParent)).toThrow(RoutingFloorViolationError);
    });

    it('an explicit non-Haiku override on a Haiku parent routes normally (the override wins, no false-positive)', () => {
      const result = resolveRoutedSpawn({ model: 'gpt-5.5', provider: 'openai' }, haikuParent, (m) => ({ api: m }) as unknown as Transport);
      expect(result.model).toBe('gpt-5.5');
    });
  });
});

describe('resolveRoutedSpawn — an override runs as a KNOWN canonical id, or is refused', () => {
  it('an id the registry does not know is REJECTED before any transport is built', () => {
    let built = false;
    const makeTransport = () => {
      built = true;
      return parentTransport;
    };
    for (const m of ['o3', 'gpt-5', 'gpt-4.1', 'not-a-model']) {
      expect(() => resolveRoutedSpawn({ model: m }, parent, makeTransport), m).toThrow(UnknownSpawnModelError);
    }
    expect(built).toBe(false);
  });

  it('the refusal names the model as requested', () => {
    try {
      resolveRoutedSpawn({ model: 'o3' }, parent);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as UnknownSpawnModelError).requestedModel).toBe('o3');
    }
  });

  it('an alias or a dated snapshot runs as its canonical id — built and priced at its real row', () => {
    const built: string[] = [];
    const makeTransport = (m: string) => {
      built.push(m);
      return parentTransport;
    };
    expect(resolveRoutedSpawn({ model: 'gpt-5.6' }, parent, makeTransport).model).toBe('gpt-5.6-sol');
    expect(resolveRoutedSpawn({ model: 'claude-opus-4-8-20260101' }, parent, makeTransport).model).toBe('claude-opus-4-8');
    expect(built).toEqual(['gpt-5.6-sol', 'claude-opus-4-8']);
  });
});
