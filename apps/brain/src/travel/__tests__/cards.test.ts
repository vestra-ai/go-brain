import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { buildOptionsCard, clip, formatClock, formatInr, localClock, plain, subtitleFor } from '../cards.js';
import type { ResultOption } from '../results.js';

const flight = (title: string, dep: string, arr: string, price: number): ResultOption => ({
  offerId: `fake:${title}`, kind: 'flight', title, priceMinor: price, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop', '2 h 35 m'], facts: {},
  journey: { mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa (Dabolim)', code: 'GOI' }, depart_at: `2026-11-06T${dep}:00+05:30`, arrive_at: `2026-11-06T${arr}:00+05:30`, carrier_name: 'IndiGo', stops: 0 },
});
const picks = [flight('IndiGo 6E 2134', '18:10', '20:45', 592000), flight('Air India AI 2981', '19:45', '22:20', 598000), flight('IndiGo 6E 6721', '21:20', '23:55', 564000)]
  .map((option, i) => ({ optionId: `opt_${i + 1}`, option, imageUrl: null }));

describe('the options card', () => {
  it('is a valid contract card with checked prices, subtitles and both buttons', () => {
    const card = buildOptionsCard({ cardId: 'c_flights_1', title: 'Friday flights, Delhi to Goa', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card.options[0]).toMatchObject({ option_id: 'opt_1', title: 'IndiGo 6E 2134', subtitle: '6:10 pm to 8:45 pm, non-stop', price_minor: 592000, currency: 'INR', price_note: 'per person' });
    expect(card.fallback_text).toBe('3 flights: Friday flights, Delhi to Goa, from ₹5,640 per person');
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote']);
    expect(card.actions?.[0]).toMatchObject({ per_option: true });
  });

  it('offers no vote for a single option, and never shows an em dash', () => {
    const one = buildOptionsCard({ cardId: 'c_1', title: 'Villa Sol — the one', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: [{ optionId: 'opt_s', imageUrl: 'https://go.test/img/u1.jpg', option: { kind: 'stay', title: 'Villa Sol – Anjuna', highlights: ['Pool — private'], facts: {} } }] });
    expect(one.actions?.map((a) => a.action_id)).toEqual(['pick']);
    expect(JSON.stringify(one)).not.toMatch(/[—–]/);
    expect(one.options[0]!.image_url).toBe('https://go.test/img/u1.jpg');
  });

  it('describes a stay by its area and whole-stay price', () => {
    const stay: ResultOption = { kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, priceNote: 'per night', highlights: [], facts: { nights: 3, area: 'Anjuna' } };
    expect(subtitleFor(stay)).toBe('Anjuna, ₹38,400 for 3 nights');
  });
});

describe('words and numbers on cards', () => {
  it('formats rupees the Indian way, from paise', () => {
    expect(formatInr(592000)).toBe('₹5,920');
    expect(formatInr(5420000)).toBe('₹54,200');
    expect(formatInr(12345678)).toBe('₹1,23,456.78');
  });

  it('reads local clocks and says them like a person', () => {
    expect(localClock('2026-11-06T18:10:00+05:30')).toBe('18:10');
    expect(localClock('2026-11-06T12:40:00Z')).toBe('18:10');
    expect(formatClock('18:10')).toBe('6:10 pm');
    expect(formatClock('00:30')).toBe('12:30 am');
    expect(formatClock('12:00')).toBe('12:00 pm');
  });

  it('removes dashes and trims to a length', () => {
    expect(plain('Three that leave after 6 — all non-stop')).toBe('Three that leave after 6, all non-stop');
    expect(clip('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});
