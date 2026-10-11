import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import type { EngineAnswer } from '../book/engine.js';
import { placeDetails, placeOnClose, placeOptions, retitled, showPlaces } from '../places-card.js';
import type { ResultsStore } from '../results.js';

// The Server team's rev 5 (R2): "where should we go" as a card of places, from ixigo's trip explorer (plan.explore).
const AGRA = {
  place: 'Agra, Uttar Pradesh, India', getting_there: 'Prices starting from ₹170', stay_a_night: 'about ₹2,000', trip_estimate: 'about ₹9,000 for 3 nights',
  estimate_minor: 900_000, estimate_nights: 3, getting_there_minor: 17_000, weather: '15 to 24 C', good_for: ['family', 'friends'],
  weather_tags: ['Warmer'], kind: ['historical sites', 'architecture'], guide: 'agra', tag: 'Weekend getaway',
};

describe('the places a trip could go, as a card', () => {
  it("makes each place the explorer read an option: ixigo's estimate a person for the trip, why, getting there", () => {
    const [agra, bare] = placeOptions([AGRA, { place: 'Neemrana, Rajasthan, India' }, { tag: 'no place' }]);
    expect(agra).toEqual({
      kind: 'place', title: 'Agra, Uttar Pradesh, India', subtitle: 'Historical sites · getting there from ₹170',
      priceMinor: 900_000, currency: 'INR', priceNote: 'a person, 3 nights',
      highlights: ['Weekend getaway', 'Historical sites', 'Architecture'],
      facts: { getting_there_minor: 17_000, nights: 3, stay_a_night: 'about ₹2,000', weather: '15 to 24 C', guide: 'agra', tag: 'Weekend getaway', kinds: 'historical sites, architecture', good_for: 'family, friends' },
      place: { name: 'Agra, Uttar Pradesh, India' },
    });
    expect(bare).toEqual({ kind: 'place', title: 'Neemrana, Rajasthan, India', highlights: [], facts: {}, place: { name: 'Neemrana, Rajasthan, India' } });
    expect(placeDetails(agra!)).toEqual({
      why: ['Historical sites, architecture', 'Good for family, friends', 'Weekend getaway'],
      costs: [
        { label: 'Stay, a night', emoji: '🏡', amount_minor: 200_000, currency: 'INR' },
        { label: 'Getting there, from', emoji: '🎫', amount_minor: 17_000, currency: 'INR' },
      ],
      total_minor: 900_000,
      caption: "ixigo's estimate for 3 nights: about ₹9,000 each",
    });
    expect(placeDetails(bare!)).toBeNull();
  });

  // Keshav, 11 Oct, with Saket's App: a place comes as the App's place card, each piece in the field the App draws it
  // from. The price badge, the tagline (its kind and getting there; ixigo's explorer gives no travel time, so none), the
  // green fit line (the group's budget and the month), why, the rough cost each, and its photo. Nothing ixigo didn't say.
  it("fills the App's place card from ixigo's explorer: tagline, fit line, why, rough cost each, photo", () => {
    const row = {
      ...AGRA, kind: ['historical sites', 'food drink'], weather_tags: ['Warmer', 'No Rain'],
      photo_list: ['https://plan-cf.ixigo.com/v2/images/agra?refresh=true'],
    };
    const [agra] = placeOptions([row], { origin: 'Delhi', month: '2026-12-12', budgetMinor: 1_000_000 });
    expect(agra).toMatchObject({
      subtitle: 'Historical sites · getting there from ₹170',
      imageUrl: 'https://plan-cf.ixigo.com/v2/images/agra?refresh=true',
      facts: { fit: 'Fits the ₹10,000 budget · Dry, 15 to 24 C in Dec', origin: 'Delhi', kinds: 'historical sites, food and drink' },
    });
    const details = placeDetails(agra!);
    expect(C.OptionDetails.safeParse(details).success).toBe(true);
    expect(details).toEqual({
      why: ['Fits the ₹10,000 budget · Dry, 15 to 24 C in Dec', 'Historical sites, food and drink', 'Good for family, friends', 'Weekend getaway'],
      costs: [
        { label: 'Stay, a night', emoji: '🏡', amount_minor: 200_000, currency: 'INR' },
        { label: 'Getting there, from', emoji: '🎫', amount_minor: 17_000, currency: 'INR' },
      ],
      total_minor: 900_000,
      caption: "ixigo's estimate for 3 nights from Delhi: about ₹9,000 each",
    });
    // Over the budget, the fit line says only the month; with no budget and no month, there is none.
    expect(placeOptions([row], { month: '2026-12-12', budgetMinor: 500_000 })[0]!.facts['fit']).toBe('Dry, 15 to 24 C in Dec');
    expect(placeOptions([row])[0]!.facts).not.toHaveProperty('fit');
    // A photo that isn't https is left out.
    expect(placeOptions([{ ...row, photo_list: ['http://plan-cf.ixigo.com/v2/images/agra'] }])[0]).not.toHaveProperty('imageUrl');
  });

  it("gives a place card's first places their own place, photos, best time and places to visit, then replaces the card", async () => {
    const option = {
      option_id: 'opt_c_1', title: 'Agra, Uttar Pradesh, India', image_url: 'https://go.test/img/explorer-agra.jpg',
      details: { why: ['Historical sites'], costs: [{ label: 'Getting there, from', emoji: '🎫', amount_minor: 17_000, currency: 'INR' }] },
    };
    const saved: Array<Record<string, unknown>> = [];
    const results = {
      card: async () => ({ card: { options: [option] } }),
      setOptionFields: async (_t: string, _c: string, _o: string, fields: Record<string, unknown>) => {
        saved.push(fields);
        return { card_id: 'c_places', kind: 'options', options: [{ ...option, ...fields }] };
      },
    } as unknown as Pick<ResultsStore, 'card' | 'setOptionFields'>;
    const photos = Array.from({ length: 8 }, (_, i) => ({ url: `https://go.test/img/agra${i}.jpg`, label: i === 0 ? 'Agra' : `Spot ${i}` }));
    const place = { name: 'Agra', place_id: 'ixigo:123', lat: 27.17, lng: 78.04, photo_url: 'https://go.test/img/agra0.jpg', photos };
    const guide: EngineAnswer = {
      as: 'facts', title: 'Agra', page: 'https://www.ixigo.com/plan/agra', checkedAt: '2026-10-11T02:00:00.000Z', ms: 400,
      rows: [{ best_time: 'October to March', places_to_visit: ['Taj Mahal (4.8, Monument): white marble', 'Agra Fort: red sandstone', 'Taj Mahal (4.8, Monument): again'] }],
    };
    const sent: Array<Record<string, unknown>> = [];
    const read: Array<Record<string, unknown>> = [];
    await showPlaces({
      placeFor: async () => ({ place, kind: 'city', within: [] }),
      engine: { answer: async (_id: string, given: Record<string, unknown>, o: Record<string, unknown>) => { read.push({ given, o }); return guide; } } as never,
      results, link: { request: async (_m: string, p: Record<string, unknown>) => { sent.push(p); return {}; } } as never,
    }, 't_goa', [{ cardId: 'c_places', optionId: 'opt_c_1', name: 'Agra, Uttar Pradesh, India' }]);
    expect(read).toEqual([{ given: { place: 'Agra, Uttar Pradesh, India' }, o: { tripId: 't_goa', background: true } }]);
    // The place's own hero replaces the explorer's photo; its best time is one more reason (the App's rich Details draws no
    // facts), and its places to visit are the things the crew can do.
    expect(saved).toEqual([{
      place, photos, image_url: 'https://go.test/img/agra0.jpg',
      details: {
        why: ['Historical sites', 'Best time to go: October to March'],
        costs: [{ label: 'Getting there, from', emoji: '🎫', amount_minor: 17_000, currency: 'INR' }],
        activities: ['Taj Mahal', 'Agra Fort'],
      },
    }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ trip_id: 't_goa', card: { card_id: 'c_places' } });
  });

  it("follows a place a vote picked: the trip's destination, and its title when it named the old place, never the group's own", async () => {
    expect(retitled('Manali trip', 'Manali', 'Goa, India')).toBe('Goa trip');
    expect(retitled('Manali with the gang', 'Manali, Himachal Pradesh', 'Ladakh')).toBe('Ladakh with the gang');
    expect(retitled("Rahul's 30th", 'Goa', 'Manali')).toBeNull();
    expect(retitled('', null, 'Goa, India')).toBe('Goa trip');
    expect(retitled('Goa trip', 'Goa', 'Goa, India')).toBeNull();
    const changes: Array<Record<string, unknown>> = [];
    const decision = { decision_id: 'd_where', kind: 'choice', result_index: 1, options: [{ label: 'Goa', option_ref: 'opt_goa' }, { label: 'Agra', option_ref: 'opt_agra' }] };
    const pack = { trip: { trip_id: 't_goa', title: 'Goa trip', destination: { name: 'Goa' }, decisions: [decision] } };
    const wake = [{ id: 'w', tripId: 't_goa', kind: 'trip_change', ref: 'd_where', dueAt: new Date(), payload: { type: 'decision.closed', decisionId: 'd_where' } }];
    const offers: Record<string, { kind: string; title: string }> = { opt_agra: { kind: 'place', title: 'Agra, Uttar Pradesh, India' }, opt_villa: { kind: 'stay', title: 'Villa Sol' } };
    const rider = placeOnClose({
      results: { offer: async (id: string) => offers[id] ?? null } as never,
      save: async (_pack, change, requestId) => { changes.push({ ...change, request: requestId() }); return { ok: true, changed: ['destination', 'title'] }; },
    });
    expect(await rider({ tripId: 't_goa', turnId: 'turn_1', wake: wake as never, pack: pack as never })).toBeNull();
    expect(changes).toEqual([{ destination: 'Agra, Uttar Pradesh, India', title: 'Agra trip', request: expect.stringMatching(/^go_trip/) }]);
    // A stay's vote is the rooms card's, never the trip's place.
    const stayVote = { trip: { ...pack.trip, decisions: [{ ...decision, options: [{ label: 'Villa Sol', option_ref: 'opt_villa' }], result_index: 0 }] } };
    await rider({ tripId: 't_goa', turnId: 'turn_2', wake: wake as never, pack: stayVote as never });
    expect(changes).toHaveLength(1);
  });
});
