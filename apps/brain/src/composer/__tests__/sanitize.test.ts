import { describe, expect, it } from 'vitest';
import { clip, sanitize, sanitizeDeep, stripMessageRefs } from '../sanitize.js';

describe('sanitize', () => {
  it('turns em and en dashes into commas, and number ranges into hyphens', () => {
    expect(sanitize('Villa Sol — great pick')).toBe('Villa Sol, great pick');
    expect(sanitize('Villa Sol—great pick')).toBe('Villa Sol, great pick');
    expect(sanitize('Flights 6–9 pm')).toBe('Flights 6-9 pm');
    expect(sanitize('— hi')).toBe('hi');
    expect(sanitize('ok —.')).toBe('ok.');
  });

  it('never names the model or who made it', () => {
    expect(sanitize("Sure — I'm Claude, made by Anthropic.")).toBe("Sure, I'm Go, made by the Go team.");
    expect(sanitize('Running on Sonnet 5.5 today')).toBe('Running on Go today');
  });

  it('leaves plain text alone', () => {
    const t = 'Flights from Delhi after 6 pm on Friday: three options, from ₹5,400.';
    expect(sanitize(t)).toBe(t);
  });

  it('cleans every text field of a card, never an id, a link or a time', () => {
    const card = {
      kind: 'notice', card_id: 'c_—1', fallback_text: 'Heads up — check-in is at 2', tone: 'info',
      title: 'Check-in — 2 pm', body: 'Villa Sol — early check-in is possible',
      source: { name: 'Villa Sol', url: 'https://example.com/a—b' }, checked_at: '2026-10-05T10:00:00Z',
    };
    const out = sanitizeDeep(card);
    expect(out.fallback_text).toBe('Heads up, check-in is at 2');
    expect(out.title).toBe('Check-in, 2 pm');
    expect(out.body).toBe('Villa Sol, early check-in is possible');
    expect(out.card_id).toBe('c_—1');
    expect(out.source.url).toBe('https://example.com/a—b');
  });

  it("takes Go's message numbers out of its words, and says which it cited, in order", () => {
    expect(stripMessageRefs("Priya, I've got you down for 13-16 (#21, #34).")).toEqual({ text: "Priya, I've got you down for 13-16.", refs: [21, 34] });
    expect(stripMessageRefs('Meher is vegetarian. Meher said so in #6.')).toEqual({ text: 'Meher is vegetarian. Meher said so.', refs: [6] });
    expect(stripMessageRefs('Priya and Arjun both said 13-16 #21, #34.')).toEqual({ text: 'Priya and Arjun both said 13-16.', refs: [21, 34] });
    expect(stripMessageRefs('Arjun can leave after 6 (see #9 and #3), so the 7 pm flight works.')).toEqual({
      text: 'Arjun can leave after 6, so the 7 pm flight works.', refs: [9, 3],
    });
  });

  it('keeps every "#" that is not a message number, and leaves text with no numbers exactly as it was', () => {
    for (const t of [
      'Your flight leaves from Gate #4.',
      'Villa Sol is House #12, Calangute.',
      'Flat #3B is free.',
      'The map is at https://example.com/page#21 for now.',
      'Room #12, #14 are both free.',
      'IndiGo 6E 2134 leaves at 7:10 pm.',
      'Flights from Delhi after 6 pm on Friday:  three options , from ₹5,400.',
    ]) {
      expect(stripMessageRefs(t)).toEqual({ text: t, refs: [] });
    }
  });

  it('clips long text to the limit', () => {
    const t = clip('x'.repeat(2_100), 2_000);
    expect(t).toHaveLength(2_000);
    expect(t.endsWith('...')).toBe(true);
    expect(clip('short', 2_000)).toBe('short');
  });
});
