import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { arrivalWords, buildFlightsLinkCard, buildOptionsCard, clip, daysLater, formatClock, formatInr, ixigoPage, localClock, plain, stayLine, stayPayWords, subtitleFor } from '../cards.js';
import type { ResultOption } from '../results.js';

const flight = (title: string, dep: string, arr: string, price: number): ResultOption => ({
  offerId: `fake:${title}`, kind: 'flight', title, priceMinor: price, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop', '2 h 35 m'], facts: {},
  journey: { mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa (Dabolim)', code: 'GOI' }, depart_at: `2026-11-06T${dep}:00+05:30`, arrive_at: `2026-11-06T${arr}:00+05:30`, carrier_name: 'IndiGo', stops: 0 },
});
const picks = [flight('IndiGo 6E 2134', '18:10', '20:45', 592000), flight('Air India AI 2981', '19:45', '22:20', 598000), flight('IndiGo 6E 6721', '21:20', '23:55', 564000)]
  .map((option, i) => ({ optionId: `opt_${i + 1}`, option, imageUrl: null }));

describe('the options card', () => {
  it('is a valid contract card with checked prices, subtitles and its pick (a ticket is never put to a vote)', () => {
    const card = buildOptionsCard({ cardId: 'c_flights_1', title: 'Friday flights, Delhi to Goa', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card.options[0]).toMatchObject({ option_id: 'opt_1', title: 'IndiGo 6E 2134', subtitle: '6:10 pm to 8:45 pm, non-stop', price_minor: 592000, currency: 'INR', price_note: 'per person' });
    expect(card.fallback_text).toBe('3 flights: Friday flights, Delhi to Goa, from ₹5,640 per person');
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick']);
    expect(card.actions?.[0]).toMatchObject({ per_option: true });
    // A shared thing is the group's vote (rev 5 R5): no buttons of its own, Vote on each option from the card's vote.
    const stays = buildOptionsCard({ cardId: 'c_stays', title: 'Stays', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: picks.map((p) => ({ ...p, option: { ...p.option, kind: 'stay' as const } })) });
    expect(stays.actions).toEqual([]);
  });

  it('a shared thing\'s card names its vote, and has "See more" when its search has more', () => {
    const stays = picks.map((p) => ({ ...p, option: { ...p.option, kind: 'stay' as const } }));
    const card = buildOptionsCard({ cardId: 'c_v', title: 'Stays', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: stays, decisionId: 'd_12', more: true });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ decision_id: 'd_12', actions: [C.MORE_OPTIONS] });
    // A ticket's card never: it is each traveller's own pick.
    const flights = buildOptionsCard({ cardId: 'c_f', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks, more: true });
    expect(flights.actions?.map((a) => a.action_id)).toEqual(['pick']);
  });

  it('offers no vote for a single option, and never shows an em dash', () => {
    const one = buildOptionsCard({ cardId: 'c_1', title: 'Villa Sol — the one', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: [{ optionId: 'opt_s', imageUrl: 'https://go.test/img/u1.jpg', option: { kind: 'stay', title: 'Villa Sol – Anjuna', highlights: ['Pool — private'], facts: {} } }] });
    expect(one.actions).toEqual([]);
    expect(one.decision_id).toBeUndefined();
    expect(JSON.stringify(one)).not.toMatch(/[—–]/);
    expect(one.options[0]!.image_url).toBe('https://go.test/img/u1.jpg');
  });

  it("puts an option's own ixigo.com page inside it (rev 5 R5: View on ixigo in its details), never as a button, and no other site's", () => {
    const onIxigo = picks.map((p, i) => ({ ...p, option: { ...p.option, ...(i === 1 ? { sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI' } : {}) } }));
    const card = buildOptionsCard({ cardId: 'c_ix', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo });
    expect(C.OptionsCard.safeParse(card).success).toBe(true);
    expect(card.options.map((o) => o.url ?? null)).toEqual([null, 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI', null]);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick']);
    const elsewhere = picks.map((p) => ({ ...p, option: { ...p.option, sourceUrl: 'https://www.airbnb.co.in/rooms/1' } }));
    expect(buildOptionsCard({ cardId: 'c_web', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: elsewhere }).options.every((o) => o.url === undefined)).toBe(true);
  });

  it('never asks for a budget on a stays card (rev 4: one group budget, nobody gives a private one)', () => {
    const onIxigo = picks.map((p) => ({ ...p, option: { ...p.option, kind: 'stay' as const, sourceUrl: 'https://www.ixigo.com/hotels/1/details?hName=x' } }));
    const three = buildOptionsCard({ cardId: 'c_b3', title: 'Stays in North Goa', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo, decisionId: 'd_1', more: true });
    expect(three.actions?.map((a) => a.action_id)).toEqual(['more_options']);
    const one = buildOptionsCard({ cardId: 'c_b1', title: 'Saudades', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: onIxigo.slice(0, 1) });
    expect(one.actions).toEqual([]);
    expect(JSON.stringify([three, one])).not.toMatch(/add_budget|my budget/i);
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

  // p0's golden run, 10 Oct: stays that stayed on Cloudflare's check, with no earlier read, go as ixigo's own page.
  it("puts ixigo's own stays page on a card, set as asked, when Go can't read it", () => {
    const card = buildFlightsLinkCard({ cardId: 'c_link_s', title: 'Stays in North Goa', url: 'https://www.ixigo.com/hotels/search/result?locationId=32', kind: 'stays' });
    expect(card.body).toBe("Go can't read ixigo's stays from its computer right now, so here they are on ixigo, with what you asked for already set. Book them there.");
    expect(card.actions?.map((a) => [a.action_id, a.label])).toEqual([['see_on_ixigo', 'See stays on ixigo']]);
  });

  it("describes a stay by its area and its night's price, the card's price being the whole stay", () => {
    const stay: ResultOption = { kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, priceNote: 'per night', highlights: [], facts: { nights: 3, area: 'Anjuna' } };
    expect(subtitleFor(stay)).toBe('Anjuna, ₹12,800 per night');
  });

  // The Server team, 10 Oct (§6c): a card said ₹11,800 (a night) while the vote built from it said ₹35,400 (the stay).
  it("prices a stay on its card by the whole stay, saying for how long, and its night in the subtitle; other kinds as before", () => {
    const sol: ResultOption = {
      kind: 'stay', title: 'Villa Sol', priceMinor: 1_180_000, totalMinor: 3_540_000, currency: 'INR', priceNote: 'per night', highlights: [], facts: { nights: 3, area: 'Anjuna' },
    };
    const card = (option: ResultOption) => buildOptionsCard({ cardId: 'c_whole', title: 'Stays', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: [{ optionId: 'opt_w', option, imageUrl: null }] }).options[0]!;
    expect(card(sol)).toMatchObject({ price_minor: 3_540_000, currency: 'INR', price_note: 'for 3 nights', subtitle: 'Anjuna, ₹11,800 per night' });
    // Two rooms, ixigo's own coupon: the note says the rooms, the subtitle the night as ixigo priced it.
    const two: ResultOption = { ...sol, priceMinor: 900_000, totalMinor: 5_400_000, priceNote: 'per night, per room, IXIFIRST applied', facts: { nights: 3, rooms: 2, area: 'Candolim' } };
    expect(card(two)).toMatchObject({ price_minor: 5_400_000, price_note: 'for 3 nights, 2 rooms', subtitle: 'Candolim, ₹9,000 per night, per room, IXIFIRST applied' });
    expect(card({ ...sol, facts: { area: 'Anjuna' } })).toMatchObject({ price_minor: 3_540_000, price_note: 'for the whole stay' });
    // No whole-stay total: no price at all, never the night's; the night still shows in the subtitle.
    const nightOnly = card({ kind: 'stay', title: 'Villa Sol', priceMinor: 1_180_000, currency: 'INR', priceNote: 'per night', highlights: [], facts: { nights: 3, area: 'Anjuna' } });
    expect(nightOnly).not.toHaveProperty('price_minor');
    expect(nightOnly).not.toHaveProperty('price_note');
    expect(nightOnly.subtitle).toBe('Anjuna, ₹11,800 per night');
    // A flight keeps its own price and note.
    expect(buildOptionsCard({ cardId: 'c_f2', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: [picks[0]!] }).fallback_text).toBe('1 flight: Flights, from ₹5,920 per person');
    expect(buildOptionsCard({ cardId: 'c_f', title: 'Flights', optionKind: 'flight', checkedAt: '2026-10-07T12:00:00.000Z', picks: [picks[0]!] }).options[0]).toMatchObject({ price_minor: 592000, price_note: 'per person' });
  });

  // The lead, 10 Oct: the pay card's "Paid ₹38,400 … ₹12,800 per night" read as if ₹38,400 were a night's.
  it('says a stay for its vote and payment as the whole stay first, the night in brackets', () => {
    const villa: ResultOption = {
      kind: 'stay', title: 'Lotus Villas', priceMinor: 1_197_200, totalMinor: 7_183_200, currency: 'INR', priceNote: 'per night, per room', highlights: [],
      facts: { nights: 3, rooms: 2, guests: 5, area: 'Candolim' },
    };
    expect(stayLine(villa)).toBe('Candolim, ₹71,832 for 3 nights, 2 rooms (₹11,972 a room a night), about ₹14,400 each');
    expect(stayLine({ ...villa, priceMinor: 1_280_000, totalMinor: 3_840_000, facts: { nights: 3, area: 'Anjuna' } })).toBe('Anjuna, ₹38,400 for 3 nights (₹12,800 a night)');
    // No whole stay: what its card says.
    expect(stayLine({ kind: 'stay', title: 'Casa Lua', priceMinor: 1_500_000, priceNote: 'per night', highlights: [], facts: { area: 'Assagao' } })).toBe('Assagao, ₹15,000 per night');
  });

  // The lead, 10 Oct: "Paid ₹38,400 … ₹38,400 for 3 nights" said the amount twice. The pay card says the amount; its words
  // say what it covers and the night.
  it('names a stay for its payment by what it covers and its night, never the amount the pay card already says', () => {
    const villa: ResultOption = {
      kind: 'stay', title: 'Lotus Villas', priceMinor: 1_197_200, totalMinor: 7_183_200, currency: 'INR', priceNote: 'per night, per room', highlights: [],
      facts: { nights: 3, rooms: 2, guests: 5, area: 'Candolim' },
    };
    expect(stayPayWords(villa)).toBe('Candolim: 3 nights, 2 rooms (₹11,972 a room a night)');
    expect(stayPayWords({ ...villa, priceMinor: 1_280_000, totalMinor: 3_840_000, facts: { nights: 3, area: 'Anjuna' } })).toBe('Anjuna: 3 nights (₹12,800 a night)');
    expect(stayPayWords({ ...villa, facts: { area: 'Assagao' } })).toBe('Assagao: ₹11,972 a night');
    expect(stayPayWords({ kind: 'stay', title: 'Somewhere', highlights: [], facts: {} })).toBeNull();
  });

  // The exam, 10 Oct (#5): a stays card for five said "from ₹621 per night, per room, IXIFIRST applied".
  it("says a stays card's from as its cheapest whole stay and each person's share, never a night's", () => {
    const stay = (title: string, night: number, rooms: number): ResultOption => ({
      kind: 'stay', title, priceMinor: night, totalMinor: night * 3 * rooms, currency: 'INR', priceNote: 'per night, per room, IXIFIRST applied', highlights: [],
      facts: { nights: 3, rooms, guests: 5, area: 'Arambol' },
    });
    const cheap = [stay('Dorm by the Sea', 50_000, 5), stay('Sea Breeze Rooms', 62_100, 3), stay('Arambol Huts', 250_000, 1)].map((option, i) => ({ optionId: `opt_c${i + 1}`, option, imageUrl: null }));
    const card = buildOptionsCard({ cardId: 'c_cheap', title: 'Cheap sleeps near the beach', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: cheap });
    // The cheapest night (₹500 a room, five rooms: ₹7,500) is not the cheapest stay: three rooms at ₹621 are (₹5,589).
    expect(card.fallback_text).toBe('3 stays: Cheap sleeps near the beach, from ₹5,589 for 3 nights, 3 rooms, about ₹1,100 each');
    expect(card.options[1]).toMatchObject({
      price_minor: 558_900, price_note: 'for 3 nights, 3 rooms', subtitle: 'Arambol, ₹621 per night, per room, IXIFIRST applied, about ₹1,100 each',
    });
    // No stay with a total (a job's web finds): the night's, as it was.
    const nightOnly = { kind: 'stay' as const, title: 'Casa Lua', priceMinor: 150_000, currency: 'INR', priceNote: 'per night', highlights: [], facts: {} };
    expect(buildOptionsCard({ cardId: 'c_n', title: 'Web finds', optionKind: 'stay', checkedAt: '2026-10-07T12:00:00.000Z', picks: [{ optionId: 'opt_n', option: nightOnly, imageUrl: null }] }).fallback_text)
      .toBe('1 stay: Web finds, from ₹1,500 per night');
  });

  it("adds each person's share, worked out in code, when ixigo priced it for a head count: the demo's \"under 8k a head\" for five", () => {
    const villa: ResultOption = {
      kind: 'stay', title: 'Lotus & Orchid Villas', priceMinor: 2394400, totalMinor: 7183200, priceNote: 'per night, per room', highlights: [],
      facts: { nights: 3, rooms: 1, guests: 5, area: 'Candolim' },
    };
    expect(subtitleFor(villa)).toBe('Candolim, ₹23,944 per night, per room, about ₹14,400 each');
    expect(subtitleFor({ ...villa, totalMinor: 3_840_000 })).toBe('Candolim, ₹23,944 per night, per room, about ₹7,700 each');
    // One person: the share is the whole price, already on the card, so it is not said.
    expect(subtitleFor({ ...villa, facts: { ...villa.facts, guests: 1 } })).toBe('Candolim, ₹23,944 per night, per room');
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
    // Naik Tours, Mumbai to Goa overnight: a bus's arrival is its first stop in the city it goes to, never every drop's
    // (the exam's re-run, 10 Oct: "reach Goa between 6 and 7:20 am, all dropping at Mapusa").
    expect(subtitleFor(journey('bus', '2026-11-06T15:30:00+05:30', '2026-11-07T06:30:00+05:30', { bus_type: 'NON-AC Sleeper (2 + 1)' }))).toBe('3:30 pm, first stop in B 6:30 am next day, NON-AC Sleeper (2 + 1)');
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
