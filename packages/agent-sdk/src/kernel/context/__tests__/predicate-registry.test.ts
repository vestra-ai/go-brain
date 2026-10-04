import { describe, it, expect } from 'vitest';
import {
  PREDICATE_VOCAB_VERSION,
  PREDICATE_ALIASES,
  canonicalPredicate,
  canonicalEntity,
  semanticKey,
} from '../predicate-registry.js';

describe('predicate-registry', () => {
  it('canonicalizes reworded predicates to one key', () => {
    expect(canonicalPredicate('works at')).toBe('employed_by');
    expect(canonicalPredicate('employed by')).toBe('employed_by');
  });

  it('falls back to normalized self for unknown predicates (open vocab preserved)', () => {
    expect(canonicalPredicate('Reconciles Invoices For')).toBe('reconciles invoices for');
  });

  it('canonicalizes entity surface variants', () => {
    expect(canonicalEntity('the user')).toBe('user');
    expect(canonicalEntity('project Atlas')).toBe('atlas');
  });

  it('semanticKey is stable across rewording', () => {
    expect(semanticKey('the user', 'works at')).toBe(semanticKey('user', 'employed by'));
  });

  // --- additional coverage of the spec ---

  it('exposes a versioned, curated alias map', () => {
    expect(PREDICATE_VOCAB_VERSION).toBe(1);
    expect(PREDICATE_ALIASES['employer is']).toBe('employed_by');
    // the over-folding 'is a'/'is an'/'is' cluster was removed (M3): no alias entry.
    expect(PREDICATE_ALIASES['is a']).toBeUndefined();
    expect(PREDICATE_ALIASES['likes']).toBe('prefers');
  });

  it('canonicalizes the remaining seeded clusters', () => {
    expect(canonicalPredicate('deadline is')).toBe('has_deadline');
    expect(canonicalPredicate('has deadline')).toBe('has_deadline');
    expect(canonicalPredicate('due')).toBe('has_deadline');
    expect(canonicalPredicate('prefers')).toBe('prefers');
    expect(canonicalPredicate('likes')).toBe('prefers');
  });

  it('does NOT fold type/identity predicates: coexisting type-facts stay distinct (M3)', () => {
    // 'is a'/'is an'/'is' no longer collapse onto one key — each falls back to its
    // normalized self, so distinct TYPE facts about one subject cannot false-merge.
    expect(canonicalPredicate('is a')).toBe('is a');
    expect(canonicalPredicate('is an')).toBe('is an');
    expect(canonicalPredicate('is')).toBe('is');
    // two type-facts about one subject -> DIFFERENT semanticKeys (neither supersedes
    // the other): e.g. {Dr. Lee | is a | cardiologist} + {Dr. Lee | is an | oncologist}.
    expect(semanticKey('Dr. Lee', 'is a')).not.toBe(semanticKey('Dr. Lee', 'is an'));
  });

  it('normalizes case, whitespace, and trailing punctuation before aliasing', () => {
    expect(canonicalPredicate('  Works   At. ')).toBe('employed_by');
    expect(canonicalPredicate('Likes!')).toBe('prefers');
  });

  it('is idempotent: canonicalizing a canonical predicate is a no-op', () => {
    expect(canonicalPredicate('employed_by')).toBe('employed_by');
    expect(canonicalPredicate('has_deadline')).toBe('has_deadline');
  });

  it('strips leading article/project markers and possessive on entities', () => {
    expect(canonicalEntity('A Deadline')).toBe('deadline');
    expect(canonicalEntity("Keshav's")).toBe('keshav');
    expect(canonicalEntity('  The   User  ')).toBe('user');
  });

  it('leaves an unknown bare entity normalized but otherwise intact', () => {
    expect(canonicalEntity('Atlas')).toBe('atlas');
    // a leading "a" without a following word boundary is NOT a stripped article
    expect(canonicalEntity('Acme')).toBe('acme');
  });

  it('falls back to normalized self for Object.prototype keys (prototype-pollution guard)', () => {
    // 'constructor' is a plausible predicate in coding-assistant episodes
    expect(canonicalPredicate('constructor')).toBe('constructor');
    // '__proto__' must not return [object Object]
    expect(canonicalPredicate('__proto__')).toBe('__proto__');
    // 'hasOwnProperty' normalizes to lowercase, never returns the built-in fn
    expect(canonicalPredicate('hasOwnProperty')).toBe('hasownproperty');
  });
});
