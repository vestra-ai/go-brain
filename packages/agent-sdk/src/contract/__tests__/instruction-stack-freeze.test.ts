/**
 * K4C-4 — codification of the InstructionStack session-freeze contract.
 *
 * The single-system-breakpoint cache design (one `cache_control` over the whole
 * assembled system prefix) silently depends on the two `static:false` layers —
 * 5 `agent_mode` and 7 `nami` — being SESSION-FROZEN (constant for the life of a
 * run). They are excluded from the static-only `hashStaticLayers`/`assertLayerHashes`
 * guard, so a regression that makes them vary per-turn would silently halve the
 * cache hit-rate with no warning.
 *
 * These tests pin that load-bearing invariant as an enforced, observable contract:
 *  - the NEW opt-in `assertSessionFrozenLayerHashes` warns LOUD (one line per
 *    drifted layer) when `agent_mode` or `nami` change after session start;
 *  - identical reassembly → NO warn;
 *  - the EXISTING `assertLayerHashes` default behavior is PRESERVED — it still
 *    ignores 5/7 drift (the Claude `executor.ts` caller must be unaffected).
 *
 * Pure, never-throws — drift is a cache-regression signal, not a hard error.
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_FROZEN_LAYER_IDS,
  hashSessionFrozenLayers,
  assertSessionFrozenLayerHashes,
  hashStaticLayers,
  assertLayerHashes,
} from '../instruction-stack.js';
import type { InstructionLayer } from '../instruction-stack.js';

// A representative native stack: static layers + the four session-frozen dynamic
// layers agent_mode, connected_accounts (multi-account roster), situation (Pulse V1),
// and nami.
function makeStack(
  opts: { agentMode?: string; connectedAccounts?: string; situation?: string; nami?: string } = {},
): InstructionLayer[] {
  return [
    { id: 'soul', text: 'SOUL', static: true },
    { id: 'operational', text: 'OPERATIONAL', static: true },
    { id: 'ability_catalog', text: 'CATALOG', static: true },
    { id: 'agent_mode', text: opts.agentMode ?? 'AGENT_MODE_V1', static: false },
    { id: 'arm_steering', text: 'STEERING', static: true },
    { id: 'connected_accounts', text: opts.connectedAccounts ?? 'ROSTER_V1', static: false },
    { id: 'situation', text: opts.situation ?? 'SITUATION_V1', static: false },
    { id: 'nami', text: opts.nami ?? 'NAMI_V1', static: false },
  ];
}

describe('K4C-4 session-freeze contract', () => {
  describe('SESSION_FROZEN_LAYER_IDS', () => {
    it('names exactly the four session-frozen dynamic layers (agent_mode, connected_accounts, situation, nami)', () => {
      expect([...SESSION_FROZEN_LAYER_IDS].sort()).toEqual([
        'agent_mode',
        'connected_accounts',
        'nami',
        'situation',
      ]);
    });
  });

  describe('hashSessionFrozenLayers', () => {
    it('hashes the static layers AND the session-frozen dynamic layers', () => {
      const hashes = hashSessionFrozenLayers(makeStack());
      // static layers covered (same as hashStaticLayers)
      expect(hashes.soul).toBeDefined();
      expect(hashes.operational).toBeDefined();
      expect(hashes.ability_catalog).toBeDefined();
      expect(hashes.arm_steering).toBeDefined();
      // the four session-frozen dynamic layers ARE covered (the new behavior)
      expect(hashes.agent_mode).toBeDefined();
      expect(hashes.connected_accounts).toBeDefined();
      expect(hashes.situation).toBeDefined();
      expect(hashes.nami).toBeDefined();
    });
  });

  describe('assertSessionFrozenLayerHashes — drift detection', () => {
    it('warns exactly once for a drifted agent_mode (layer 5)', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ agentMode: 'AGENT_MODE_V2_CHANGED' });
      const warnings: string[] = [];
      assertSessionFrozenLayerHashes(baseline, drifted, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('[CACHE_PROMPT_MUTATED]');
      expect(warnings[0]).toContain('layer=agent_mode');
    });

    it('warns exactly once for a drifted nami (layer 7)', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ nami: 'NAMI_V2_CHANGED' });
      const warnings: string[] = [];
      assertSessionFrozenLayerHashes(baseline, drifted, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('layer=nami');
    });

    it('warns exactly once for a drifted connected_accounts (multi-account roster)', () => {
      // PR2 F8: a real mid-session account change DOES move these bytes. The warn
      // is the accepted, true cache-bust signal — pinned here so no one silences it.
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ connectedAccounts: 'ROSTER_V2_CHANGED' });
      const warnings: string[] = [];
      assertSessionFrozenLayerHashes(baseline, drifted, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('[CACHE_PROMPT_MUTATED]');
      expect(warnings[0]).toContain('layer=connected_accounts');
    });

    it('warns exactly once for a drifted situation (Pulse V1)', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ situation: 'SITUATION_V2_CHANGED' });
      const warnings: string[] = [];
      assertSessionFrozenLayerHashes(baseline, drifted, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('layer=situation');
    });

    it('hands each drift to the callback as structured fields beside its line', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ nami: 'NAMI_V2_CHANGED' });
      const drifts: { layer: string; expected: string; actual: string }[] = [];
      assertSessionFrozenLayerHashes(baseline, drifted, (_m, d) => drifts.push(d));
      expect(drifts).toEqual([{ layer: 'nami', expected: baseline.nami, actual: hashSessionFrozenLayers(drifted).nami }]);
    });

    it('does NOT warn when the session-frozen layers are identical', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const same = makeStack();
      const warnings: string[] = [];
      assertSessionFrozenLayerHashes(baseline, same, (m) => warnings.push(m));
      expect(warnings).toHaveLength(0);
    });

    it('never throws on drift (warn-only, like the existing static guard)', () => {
      const baseline = hashSessionFrozenLayers(makeStack());
      const drifted = makeStack({ agentMode: 'X', nami: 'Y' });
      const warnings: string[] = [];
      // Two drifted session-frozen layers → two warns, and NO throw of its own.
      expect(() =>
        assertSessionFrozenLayerHashes(baseline, drifted, (m) => warnings.push(m)),
      ).not.toThrow();
      expect(warnings).toHaveLength(2);
    });
  });

  describe('default static-only guard is PRESERVED (Claude byte-identity)', () => {
    it('hashStaticLayers still EXCLUDES the session-frozen dynamic layers', () => {
      const hashes = hashStaticLayers(makeStack());
      expect(hashes.soul).toBeDefined();
      expect(hashes.agent_mode).toBeUndefined();
      expect(hashes.connected_accounts).toBeUndefined();
      expect(hashes.situation).toBeUndefined();
      expect(hashes.nami).toBeUndefined();
    });

    it('assertLayerHashes still IGNORES agent_mode / nami drift (default behavior)', () => {
      const baseline = hashStaticLayers(makeStack());
      const drifted = makeStack({ agentMode: 'CHANGED', nami: 'CHANGED' });
      const warnings: string[] = [];
      assertLayerHashes(baseline, drifted, (m) => warnings.push(m));
      // 5/7 drift is invisible to the static-only guard — the contract this task
      // codifies is that the NEW guard catches it, NOT the existing one.
      expect(warnings).toHaveLength(0);
    });

    it('assertLayerHashes still warns on a drifted STATIC layer (unchanged)', () => {
      const baseline = hashStaticLayers(makeStack());
      const drifted = makeStack();
      drifted[0] = { id: 'soul', text: 'SOUL_MUTATED', static: true };
      const warnings: string[] = [];
      assertLayerHashes(baseline, drifted, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('layer=soul');
    });
  });
});
