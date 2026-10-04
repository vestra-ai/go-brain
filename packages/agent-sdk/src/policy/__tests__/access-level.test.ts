import { describe, it, expect } from 'vitest';
import {
  ACCESS_LEVELS,
  levelAsks,
  hardFloors,
  clampLevel,
  type AccessLevel,
} from '../access-level.js';
import type { SideEffectFamily } from '../side-effect-classifier.js';

const LEVELS: AccessLevel[] = ['careful', 'balanced', 'relaxed', 'autopilot'];
const FAMILIES: SideEffectFamily[] = [
  'readonly', 'workspace_write', 'external_send',
  'external_mutation', 'dangerous_delete', 'unknown', 'protected_remote', 'payment',
];

// THE spec §1.1 table, encoded as data: does a family ASK at a level? This is the
// COMPOSED verdict (hardFloors OR levelAsks) — the actual behavior the gate produces.
// row order = FAMILIES; col order = careful, balanced, relaxed, autopilot.
const ASK_TABLE: Record<SideEffectFamily, [boolean, boolean, boolean, boolean]> = {
  readonly:          [false, false, false, false],
  workspace_write:   [true,  false, false, false],
  external_send:     [true,  true,  false, false],
  external_mutation: [true,  true,  false, false],
  dangerous_delete:  [true,  true,  true,  false],
  // A call the gate cannot read asks wherever a payment would (2026-09-21).
  unknown:           [true,  true,  true,  true],
  // A force push, a push to main, a merge (git-command-catalog): every level, like a payment.
  protected_remote:  [true,  true,  true,  true],
  payment:           [true,  true,  true,  true],
};

const asks = (family: SideEffectFamily, level: AccessLevel) =>
  hardFloors(family, level) || levelAsks(family, level);

describe('ACCESS_LEVELS', () => {
  it('is the four levels in strictness order (careful < balanced < relaxed < autopilot)', () => {
    expect(ACCESS_LEVELS).toEqual(['careful', 'balanced', 'relaxed', 'autopilot']);
  });
});

describe('the §1.1 ask table — composed hardFloors ∨ levelAsks', () => {
  for (const family of FAMILIES) {
    LEVELS.forEach((level, i) => {
      const expected = ASK_TABLE[family][i];
      it(`${family} @ ${level} → ${expected ? 'ask' : 'run'}`, () => {
        expect(asks(family, level)).toBe(expected);
      });
    });
  }
});

describe('hardFloors — payment always, dangerous_delete below Autopilot', () => {
  it('payment hard-floors at EVERY level', () => {
    for (const level of LEVELS) expect(hardFloors('payment', level)).toBe(true);
  });
  it('dangerous_delete hard-floors except at Autopilot', () => {
    expect(hardFloors('dangerous_delete', 'careful')).toBe(true);
    expect(hardFloors('dangerous_delete', 'balanced')).toBe(true);
    expect(hardFloors('dangerous_delete', 'relaxed')).toBe(true);
    expect(hardFloors('dangerous_delete', 'autopilot')).toBe(false);
  });
  it('no other family hard-floors', () => {
    for (const level of LEVELS) {
      for (const family of ['readonly', 'workspace_write', 'external_send', 'external_mutation'] as SideEffectFamily[]) {
        expect(hardFloors(family, level)).toBe(false);
      }
    }
  });
});

describe('levelAsks and hardFloors never double-gate the same family', () => {
  it('no family is both a hard floor and a level ask at any level', () => {
    for (const family of FAMILIES) {
      for (const level of LEVELS) {
        expect(hardFloors(family, level) && levelAsks(family, level)).toBe(false);
      }
    }
  });
  it('hard-floor families (payment, dangerous_delete) are never produced by levelAsks', () => {
    for (const level of LEVELS) {
      expect(levelAsks('payment', level)).toBe(false);
      expect(levelAsks('dangerous_delete', level)).toBe(false);
    }
  });
});

describe('clampLevel — a child may only tighten (never loosen past the parent)', () => {
  it('a stricter request wins (child tightens)', () => {
    expect(clampLevel('careful', 'autopilot')).toBe('careful');
    expect(clampLevel('balanced', 'relaxed')).toBe('balanced');
  });
  it('a looser request is clamped back to the parent', () => {
    expect(clampLevel('autopilot', 'careful')).toBe('careful');
    expect(clampLevel('relaxed', 'balanced')).toBe('balanced');
    expect(clampLevel('autopilot', 'relaxed')).toBe('relaxed');
  });
  it('an equal request is unchanged', () => {
    for (const level of LEVELS) expect(clampLevel(level, level)).toBe(level);
  });
  it('an undefined request inherits the parent', () => {
    for (const level of LEVELS) expect(clampLevel(undefined, level)).toBe(level);
  });
  it('the result is never looser than the parent (property over all pairs)', () => {
    const rank = (l: AccessLevel) => ACCESS_LEVELS.indexOf(l);
    for (const child of LEVELS) {
      for (const parent of LEVELS) {
        expect(rank(clampLevel(child, parent))).toBeLessThanOrEqual(rank(parent));
      }
    }
  });
});
