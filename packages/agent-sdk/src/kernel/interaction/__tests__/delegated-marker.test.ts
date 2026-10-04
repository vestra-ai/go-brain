/**
 * Phase 2 (background helpers) — the DELEGATED settle marker carries the child's
 * KIND and, for a background helper, the note the model reads instead of a result.
 *
 * Binding property: the teammate marker string is BYTE-IDENTICAL to the pre-Phase-2
 * one (a live journal full of teammate markers must keep parsing on the old shape),
 * and a helper marker is still a `delegated` marker — `isDelegatedResultContent`
 * stays true, so the roster rebuild and the web's parse keep working.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDelegatedResultContent,
  parseDelegatedResultContent,
  isDelegatedResultContent,
} from '../strategy.js';

describe('delegated marker — helper kind + note', () => {
  it('teammate marker is byte-identical to before', () => {
    expect(buildDelegatedResultContent('researcher', 't-1')).toBe(
      '{"status":"delegated","name":"researcher","teammateTaskId":"t-1"}',
    );
  });

  it('helper marker carries kind and note, and still parses as delegated', () => {
    const s = buildDelegatedResultContent('helper-1a2b3c4d', 't-2', {
      kind: 'helper',
      note: 'Helper launched in the background.',
    });
    expect(isDelegatedResultContent(s)).toBe(true);
    expect(parseDelegatedResultContent(s)).toEqual({
      name: 'helper-1a2b3c4d',
      teammateTaskId: 't-2',
      kind: 'helper',
      note: 'Helper launched in the background.',
    });
  });

  // R76 — the description is what TITLES a helper's lane, and the marker is the only
  // spawn record a RELOAD has: without it the card comes back titled by the minted
  // handle instead of the brief the lead wrote.
  it('helper marker carries the description, and it round-trips', () => {
    const s = buildDelegatedResultContent('helper-1a2b3c4d', 't-3', {
      kind: 'helper',
      note: 'Helper launched in the background.',
      description: 'Check the changelog',
    });
    expect(s).toBe(
      '{"status":"delegated","name":"helper-1a2b3c4d","teammateTaskId":"t-3",' +
        '"kind":"helper","note":"Helper launched in the background.","description":"Check the changelog"}',
    );
    expect(parseDelegatedResultContent(s)).toEqual({
      name: 'helper-1a2b3c4d',
      teammateTaskId: 't-3',
      kind: 'helper',
      note: 'Helper launched in the background.',
      description: 'Check the changelog',
    });
  });

  it('a helper marker with no description keeps the key out of the string and the parse', () => {
    const s = buildDelegatedResultContent('helper-1a2b3c4d', 't-4', {
      kind: 'helper',
      note: 'Helper launched in the background.',
    });
    expect(s).not.toContain('description');
    expect(parseDelegatedResultContent(s)).not.toHaveProperty('description');
  });

  it('a teammate marker parses with NO kind and NO note keys', () => {
    const parsed = parseDelegatedResultContent(buildDelegatedResultContent('researcher', 't-1'));
    // toStrictEqual, not toEqual: toEqual IGNORES keys whose value is undefined, so it
    // holds either way and pins nothing. These four see the conditional spreads — turn
    // them into always-present `kind: undefined, note: undefined, description: undefined`
    // and this case goes red.
    expect(parsed).toStrictEqual({ name: 'researcher', teammateTaskId: 't-1' });
    expect(parsed).not.toHaveProperty('kind');
    expect(parsed).not.toHaveProperty('note');
    expect(parsed).not.toHaveProperty('description');
    expect(parsed).not.toHaveProperty('addressable');
  });

  // Phase 3 (spec 2026-09-05 §4.6, D8) — `addressable` says the PERSON can message this
  // helper. Live it rides the spawn event; after a RELOAD this marker is the only record
  // of it, so a lane rebuilt without it comes back filtered out of the composer's @ list.
  it('helper marker carries addressable, and it round-trips', () => {
    const s = buildDelegatedResultContent('check-the-numbers', 't-5', {
      kind: 'helper',
      note: 'Helper launched in the background.',
      description: 'check the numbers',
      addressable: true,
    });
    expect(s).toBe(
      '{"status":"delegated","name":"check-the-numbers","teammateTaskId":"t-5",' +
        '"kind":"helper","note":"Helper launched in the background.",' +
        '"description":"check the numbers","addressable":true}',
    );
    expect(parseDelegatedResultContent(s)).toEqual({
      name: 'check-the-numbers',
      teammateTaskId: 't-5',
      kind: 'helper',
      note: 'Helper launched in the background.',
      description: 'check the numbers',
      addressable: true,
    });
  });

  // Flag OFF: the Phase 2 marker, byte for byte. The web reads the KEY, so a build that
  // wrote `addressable: false` would be a different string that still parses to a helper
  // the picker must refuse — the absent key is the only honest off state.
  it('a helper marker without addressable keeps the key out of the string and the parse', () => {
    const s = buildDelegatedResultContent('helper-1a2b3c4d', 't-6', {
      kind: 'helper',
      note: 'Helper launched in the background.',
      description: 'Check the changelog',
    });
    expect(s).not.toContain('addressable');
    expect(parseDelegatedResultContent(s)).not.toHaveProperty('addressable');
  });

  // A value that is not literally `true` is not an addressable helper. The marker is
  // journal text: a hand-edited or future-build entry must never widen the @ list.
  it('a non-true addressable does not survive the parse', () => {
    const forged =
      '{"status":"delegated","name":"h","teammateTaskId":"t-7","kind":"helper","addressable":"yes"}';
    expect(parseDelegatedResultContent(forged)).not.toHaveProperty('addressable');
  });

  it('a non-string / non-delegated content parses to null', () => {
    expect(parseDelegatedResultContent(undefined)).toBeNull();
    expect(parseDelegatedResultContent('{"status":"deferred"}')).toBeNull();
    expect(parseDelegatedResultContent('not json')).toBeNull();
  });
});
