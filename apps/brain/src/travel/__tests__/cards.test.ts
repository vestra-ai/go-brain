import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { arrivalWords, buildFlightsLinkCard, buildOptionsCard, clip, daysLater, formatClock, formatInr, ixigoPage, localClock, plain, subtitleFor } from '../cards.js';
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

  it('adds "See on ixigo" when an option has an ixigo.com page, and only then', () => {
    const onIxigo = picks.map((p, i) => ({ ...p, option: { ...p.option, ...(i === 1 ? { sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI' } : {}) } }));
    const card = buildOptionsCard({ cardId: 'c_ix', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote', 'open']);
    expect(card.actions?.[2]).toEqual({ action_id: 'open', label: 'See on ixigo', style: 'secondary', per_option: true });
    const elsewhere = picks.map((p) => ({ ...p, option: { ...p.option, sourceUrl: 'https://www.airbnb.co.in/rooms/1' } }));
    expect(buildOptionsCard({ cardId: 'c_web', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: elsewhere }).actions?.map((a) => a.action_id)).toEqual(['pick', 'vote']);
  });

  it('with seeAll, its last button opens the whole list on ixigo instead of each option\'s page (stays, three shown)', () => {
    const onIxigo = picks.map((p) => ({ ...p, option: { ...p.option, sourceUrl: 'https://www.ixigo.com/hotels/1/details?hName=x' } }));
    const card = buildOptionsCard({ cardId: 'c_all', title: 'Stays in North Goa', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo, seeAll: true });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote', 'see_all']);
    expect(card.actions?.[2]).toEqual({ action_id: 'see_all', label: 'See all on ixigo', style: 'secondary' });
  });

  it('asks for a budget on a stays card while nobody has a band: "Add my budget" takes "See all on ixigo"\'s place, after the group\'s own buttons', () => {
    const onIxigo = picks.map((p) => ({ ...p, option: { ...p.option, kind: 'stay' as const, sourceUrl: 'https://www.ixigo.com/hotels/1/details?hName=x' } }));
    const three = buildOptionsCard({ cardId: 'c_b3', title: 'Stays in North Goa', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo, seeAll: true, askBudget: true });
    expect(C.OptionsCard.safeParse(three).success).toBe(true);
    expect(three.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote', 'add_budget']);
    expect(three.actions?.[2]).toEqual({ action_id: 'add_budget', label: 'Add my budget', style: 'secondary' });
    // One stay: room for each option's "See on ixigo" after it.
    const one = buildOptionsCard({ cardId: 'c_b1', title: 'Saudades', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo.slice(0, 1), seeAll: true, askBudget: true });
    expect(one.actions?.map((a) => a.action_id)).toEqual(['pick', 'add_budget', 'open']);
    // Once someone has a band, today's buttons.
    expect(buildOptionsCard({ cardId: 'c_b0', title: 'Stays', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo, seeAll: true }).actions?.map((a) => a.action_id))
      .toEqual(['pick', 'vote', 'see_all']);
  });

  it('builds the flights link card as a valid notice with its one button', () => {
    const card = buildFlightsLinkCard({ cardId: 'c_link_1', title: 'Flights, Delhi to Goa', url: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI' });
    expect(C.NoticeCard.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ tone: 'info', fallback_text: 'Flights, Delhi to Goa: see them on ixigo', source: { name: 'ixigo' } });
    expect(card.body).not.toMatch(/no flights/i);
    const set = buildFlightsLinkCard({ cardId: 'c_link_2', title: 'Flights, Delhi to Goa', url: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI', who: 'for 3 from Delhi' });
    expect(set.fallback_text).toBe('Flights, Delhi to Goa, for 3 from Delhi: see them on ixigo');
    expect(set.body).toContain('set for 3 from Delhi');
    expect(set.body).toContain('Book them there.');
  });

  it('opens only https pages on ixigo.com', () => {
    expect(ixigoPage('https://www.ixigo.com/trains/10103?orgn=CSMT')).toBe('https://www.ixigo.com/trains/10103?orgn=CSMT');
    expect(ixigoPage('https://ixigo.com/hotels/1/details')).toBe('https://ixigo.com/hotels/1/details');
    expect(ixigoPage('http://www.ixigo.com/x')).toBeNull();
    expect(ixigoPage('https://ixigo.com.example.net/x')).toBeNull();
    expect(ixigoPage('https://notixigo.com/x')).toBeNull();
    expect(ixigoPage('javascript:alert(1)')).toBeNull();
    expect(ixigoPage(null)).toBeNull();
  });

  it('describes a stay by its area and whole-stay price', () => {
    const stay: ResultOption = { kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, priceNote: 'per night', highlights: [], facts: { nights: 3, area: 'Anjuna' } };
    expect(subtitleFor(stay)).toBe('Anjuna, ₹38,400 for 3 nights');
  });

  it("adds each person's share, worked out in code, when ixigo priced it for a head count: the demo's \"under 8k a head\" for five", () => {
    const villa: ResultOption = {
      kind: 'stay', title: 'Lotus & Orchid Villas', priceMinor: 2394400, totalMinor: 7183200, priceNote: 'per night, per room', highlights: [],
      facts: { nights: 3, rooms: 1, guests: 5, area: 'Candolim' },
    };
    expect(subtitleFor(villa)).toBe('Candolim, ₹71,832 for 3 nights, ₹14,366 each');
    // One person: the share is the total, so it is not said twice.
    expect(subtitleFor({ ...villa, facts: { ...villa.facts, guests: 1 } })).toBe('Candolim, ₹71,832 for 3 nights');
  });
});

describe('when a journey arrives, on its card', () => {
  const journey = (kind: 'flight' | 'train' | 'bus', depart_at: string, arrive_at: string, facts: Record<string, string> = {}, stops?: number): ResultOption => ({
    kind, title: 'x', priceMinor: 100000, currency: 'INR', priceNote: 'per person', highlights: [], facts,
    journey: { mode: kind, origin: { name: 'A' }, destination: { name: 'B' }, depart_at, arrive_at, ...(stops !== undefined ? { stops } : {}) },
  });

  it('says the day it arrives when that is two or more days later: 22634 NZM to TVC runs 27 h 45 m', () => {
    // p4's re-drill: the card said "10:15 pm to 2:00 am next day" for a train that arrives on Sunday 8 Nov.
    expect(subtitleFor(journey('train', '2026-11-06T22:15:00+05:30', '2026-11-08T02:00:00+05:30', { class_code: '3A' }))).toBe('10:15 pm to 2:00 am on Sun 8 Nov, AC 3 Tier');
    expect(daysLater('2026-11-06T22:15:00+05:30', '2026-11-08T02:00:00+05:30')).toBe(2);
    expect(arrivalWords('2026-11-06T05:00:00+05:30', '2026-11-09T05:30:00+05:30')).toBe(' on Mon 9 Nov');
  });

  it('"next day" for the day after, and nothing on the same day, for trains, flights and buses alike', () => {
    // 22656 NZM to MAO, Fri 6 Nov 5:00 am to Sat 7 Nov 10:10 am (ixigo's results for that day).
    expect(subtitleFor(journey('train', '2026-11-06T05:00:00+05:30', '2026-11-07T10:10:00+05:30', { class_code: 'SL' }))).toBe('5:00 am to 10:10 am next day, Sleeper');
    // 6E 5341 DEL to GOI, and 6E 329 + 6E 5106 through Mumbai landing after midnight.
    expect(subtitleFor(journey('flight', '2026-11-06T05:00:00+05:30', '2026-11-06T07:35:00+05:30', {}, 0))).toBe('5:00 am to 7:35 am, non-stop');
    expect(subtitleFor(journey('flight', '2026-11-06T18:30:00+05:30', '2026-11-07T00:40:00+05:30', {}, 1))).toBe('6:30 pm to 12:40 am next day, 1 stop');
    // Naik Tours, Mumbai to Goa overnight.
    expect(subtitleFor(journey('bus', '2026-11-06T15:30:00+05:30', '2026-11-07T06:30:00+05:30', { bus_type: 'NON-AC Sleeper (2 + 1)' }))).toBe('3:30 pm to 6:30 am next day, NON-AC Sleeper (2 + 1)');
  });

  it('counts days where the journey happens, not in UTC', () => {
    // The same 22634, written in UTC: 16:45Z on the 6th is 10:15 pm in India, 20:30Z on the 7th is 2:00 am on the 8th.
    expect(subtitleFor(journey('train', '2026-11-06T16:45:00Z', '2026-11-07T20:30:00Z', { class_code: '3A' }))).toBe('10:15 pm to 2:00 am on Sun 8 Nov, AC 3 Tier');
    // 9:00 pm to 11:30 pm in India the same evening, though the UTC dates differ.
    expect(daysLater('2026-11-06T15:30:00Z', '2026-11-06T18:00:00Z')).toBe(0);
    expect(daysLater('2026-11-06T18:00:00Z', '2026-11-06T19:00:00Z')).toBe(1);
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
    // A number range keeps its meaning as a hyphen; any other dash is still a comma.
    expect(plain('Search North Goa pool villas for 6–9 Nov')).toBe('Search North Goa pool villas for 6-9 Nov');
    expect(plain('6 — 9 Nov, ₹8,000–12,000 a night')).toBe('6-9 Nov, ₹8,000-12,000 a night');
    expect(plain('Villa Sol – Anjuna, 4.7 – near the beach')).toBe('Villa Sol, Anjuna, 4.7, near the beach');
    expect(plain('6–9 Nov')).not.toMatch(/[—–]/);
    expect(clip('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});
