/**
 * splitInstructionStack — the fleet/session tier boundary (CACHE_TIERING_V1).
 *
 * THE invariant: `fleet + session === assembleInstructionStack(layers, harnessId)`
 * for every input — the split may only move cache breakpoints, never change a
 * byte the model reads. Degenerate shapes (claude arm, no fleet layers, fleet
 * not a byte-prefix) fall back to `{ fleet: '', session: full }`.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleInstructionStack,
  splitInstructionStack,
  FLEET_STATIC_LAYER_IDS,
  INSTRUCTION_LAYER_ORDER,
  SESSION_FROZEN_LAYER_IDS,
  type InstructionLayer,
  type InstructionLayerId,
} from '../instruction-stack.js';

const layer = (id: InstructionLayerId, text: string, isStatic = true): InstructionLayer => ({
  id,
  text,
  static: isStatic,
});

/** A full 15-layer stack with distinctive per-layer text. */
function fullStack(): InstructionLayer[] {
  return INSTRUCTION_LAYER_ORDER.map((id) =>
    layer(id, `[${id}] body of ${id}`, !SESSION_FROZEN_LAYER_IDS.includes(id)),
  );
}

describe('splitInstructionStack', () => {
  it('fleet + session === the assembled string (the byte-conservation invariant)', () => {
    const layers = fullStack();
    const full = assembleInstructionStack(layers, 'native');
    const { fleet, session } = splitInstructionStack(layers, 'native');
    expect(fleet + session).toBe(full);
    expect(fleet.length).toBeGreaterThan(0);
    expect(session.length).toBeGreaterThan(0);
  });

  it('fleet is EXACTLY the standalone render of the fleet-prefix layers (cross-user byte-shareable)', () => {
    const layers = fullStack();
    const { fleet } = splitInstructionStack(layers, 'native');
    const fleetOnly = layers.filter((l) => FLEET_STATIC_LAYER_IDS.includes(l.id));
    expect(fleet).toBe(assembleInstructionStack(fleetOnly, 'native'));
    // Same fleet layers + DIFFERENT session layers ⇒ the SAME fleet bytes.
    const otherSession = fullStack().map((l) =>
      FLEET_STATIC_LAYER_IDS.includes(l.id) ? l : { ...l, text: `${l.text} (other user)` },
    );
    expect(splitInstructionStack(otherSession, 'native').fleet).toBe(fleet);
  });

  it('session starts with the blank-line joiner when both parts are non-empty', () => {
    const { session } = splitInstructionStack(fullStack(), 'native');
    expect(session.startsWith('\n\n')).toBe(true);
  });

  it('empty layers are dropped identically on both sides of the boundary (invariant holds)', () => {
    const layers = fullStack().map((l) =>
      l.id === 'activity_narration' || l.id === 'teams' ? { ...l, text: '   ' } : l,
    );
    const { fleet, session } = splitInstructionStack(layers, 'native');
    expect(fleet + session).toBe(assembleInstructionStack(layers, 'native'));
  });

  it('a fleet-only stack yields session === "" (no split worth making downstream)', () => {
    const layers = fullStack().filter((l) => FLEET_STATIC_LAYER_IDS.includes(l.id));
    const { fleet, session } = splitInstructionStack(layers, 'native');
    expect(session).toBe('');
    expect(fleet).toBe(assembleInstructionStack(layers, 'native'));
  });

  it('a stack with NO fleet layers yields fleet === "" and the full render as session', () => {
    const layers = fullStack().filter((l) => !FLEET_STATIC_LAYER_IDS.includes(l.id));
    const { fleet, session } = splitInstructionStack(layers, 'native');
    expect(fleet).toBe('');
    expect(session).toBe(assembleInstructionStack(layers, 'native'));
  });

  it('the claude arm (input-order, grandfathered bytes) NEVER tiers', () => {
    const layers = fullStack();
    const { fleet, session } = splitInstructionStack(layers, 'claude');
    expect(fleet).toBe('');
    expect(session).toBe(assembleInstructionStack(layers, 'claude'));
  });

  it('a fleet layer marked fleetShared:false ends the shared prefix there', () => {
    // `environment` is the 4th fleet layer; marking it keeps the three before it.
    const layers = fullStack().map((l) =>
      l.id === 'environment' ? { ...l, fleetShared: false } : l,
    );
    const { fleet, session } = splitInstructionStack(layers, 'native');
    expect(fleet + session).toBe(assembleInstructionStack(layers, 'native')); // invariant holds
    expect(fleet).toBe(
      assembleInstructionStack(
        layers.filter((l) => ['soul', 'task_progress', 'activity_narration'].includes(l.id)),
        'native',
      ),
    );
    expect(fleet).not.toContain('[environment]'); // the per-user layer stayed out
  });

  it('a user-owned SOUL (layer 1) collapses the tier entirely — same shape as the flag being off', () => {
    const layers = fullStack().map((l) => (l.id === 'soul' ? { ...l, fleetShared: false } : l));
    const full = assembleInstructionStack(layers, 'native');
    const { fleet, session } = splitInstructionStack(layers, 'native');
    // Nothing precedes soul, so there is no deploy-shared prefix to publish:
    // the whole stack rides the session tier and the caller sends ONE block.
    expect(fleet).toBe('');
    expect(session).toBe(full);
  });

  it('fleetShared:true and an absent flag are the same thing (existing callers unchanged)', () => {
    const plain = splitInstructionStack(fullStack(), 'native');
    const marked = splitInstructionStack(
      fullStack().map((l) => ({ ...l, fleetShared: true })),
      'native',
    );
    expect(marked).toEqual(plain);
  });

  it('a user-owned soul still shares NO bytes with a pristine one (the tiers cannot cross-read)', () => {
    const pristine = splitInstructionStack(fullStack(), 'native');
    const owned = splitInstructionStack(
      fullStack().map((l) =>
        l.id === 'soul' ? { ...l, text: '[soul] a soul the user rewrote', fleetShared: false } : l,
      ),
      'native',
    );
    expect(pristine.fleet.length).toBeGreaterThan(0);
    expect(owned.fleet).toBe('');
    // The edited soul's bytes never leak into anything labelled fleet.
    expect(owned.session).toContain('a soul the user rewrote');
    expect(pristine.fleet).not.toContain('a soul the user rewrote');
  });

  it('FLEET_STATIC_LAYER_IDS is a contiguous PREFIX of the canonical order (the property the split rests on)', () => {
    expect(INSTRUCTION_LAYER_ORDER.slice(0, FLEET_STATIC_LAYER_IDS.length)).toEqual([
      ...FLEET_STATIC_LAYER_IDS,
    ]);
    // And it never overlaps the session-frozen tail.
    for (const id of FLEET_STATIC_LAYER_IDS) {
      expect(SESSION_FROZEN_LAYER_IDS).not.toContain(id);
    }
  });
});
