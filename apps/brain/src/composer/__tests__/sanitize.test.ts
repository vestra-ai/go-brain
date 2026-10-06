import { describe, expect, it } from 'vitest';
import { clip, sanitize, sanitizeDeep } from '../sanitize.js';

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

  it('clips long text to the limit', () => {
    const t = clip('x'.repeat(2_100), 2_000);
    expect(t).toHaveLength(2_000);
    expect(t.endsWith('...')).toBe(true);
    expect(clip('short', 2_000)).toBe('short');
  });
});
