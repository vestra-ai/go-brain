import * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { makeTurnCtx } from '../../composer/tools.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { OptionsCardT } from '../cards.js';
import { isCountry, placeDetails, suggestedPlaces, type SuggestedPlace } from '../places-card.js';
import type { ResultSet, ResultsStore } from '../results.js';
import { travelTools, type TravelToolDeps } from '../tools.js';

// Keshav, 11 Oct: "where should we go" needs no ixigo. Go picks the places itself and they go up as the place card, the
// group's vote, with real photos; ixigo stays for what gets booked once the place is picked.
const place = (name: string, kind = 'Mountains'): SuggestedPlace => ({
  name, stay_in: name.split(',')[0]!, kind, travel: '12h drive', fit: 'Fits ₹30k each · snow in Dec', why: ['Snow by mid December', 'Cafes and walks | for all'],
  cost_each_rupees: 25_000, nights: 4, things_to_do: ['Solang Valley', 'Old Manali walks', 'Hot springs'],
});
const PLACES = [place('Manali, Himachal Pradesh'), place('Shimla, Himachal Pradesh'), place('Mussoorie, Uttarakhand'), place('Nainital, Uttarakhand'), place('Kasol, Himachal Pradesh')];

describe('places Go picks itself', () => {
  it('are options of kind place: the tagline, its rough cost as an estimate, and its Details from the fit line on', () => {
    const [manali] = suggestedPlaces([PLACES[0]!]);
    expect(manali).toMatchObject({
      kind: 'place', title: 'Manali, Himachal Pradesh', subtitle: 'Mountains · 12h drive', priceMinor: 2_500_000, currency: 'INR', priceNote: 'each, rough',
      facts: { estimate: true, guide: 'Manali' }, place: { name: 'Manali, Himachal Pradesh' },
    });
    const details = placeDetails(manali!);
    expect(C.OptionDetails.safeParse(details).success).toBe(true);
    expect(details).toEqual({
      // The fit line first: the App draws it green on the card. A "|" a reason carried never splits it.
      why: ['Fits ₹30k each · snow in Dec', 'Snow by mid December', 'Cafes and walks / for all'],
      costs: [{ label: 'Getting there and 4 nights', emoji: '🧳', amount_minor: 2_500_000, currency: 'INR' }],
      total_minor: 2_500_000,
      caption: "Go's rough estimate, not a price: about ₹25,000 each",
      activities: ['Solang Valley', 'Old Manali walks', 'Hot springs'],
    });
  });

  it('go up as the place card through suggest_places: every place, its real cover or none, and the first three handed on, no ixigo read', async () => {
    const saved: ResultSet[] = [];
    const covers: string[] = [];
    const handed: unknown[] = [];
    const results = {
      save: async (s: Omit<ResultSet, 'resultsId'>) => {
        const set = { ...s, resultsId: 'r_sug' } as ResultSet;
        saved.push(set);
        return set;
      },
      saveCard: async () => undefined, shownFrom: async () => [], card: async () => null,
    } as unknown as ResultsStore;
    // Manali's photo was kept from ixigo's guide (a Go image already); the others come from Wikipedia, with their file's
    // page for a credit; Kasol has none, and is never looked for twice.
    const deps = {
      results, images: { rehostUrl: async (url: string) => (url.startsWith('https://go.test/img/') ? url : `https://go.test/img/of-${url.split('/').at(-1)}`) },
      now: () => new Date('2026-10-11T18:30:00Z'),
      placePhoto: async (_trip: string, name: string) => {
        covers.push(name);
        const short = name.split(',')[0]!;
        if (short === 'Kasol') return null;
        if (short === 'Manali') return { url: 'https://go.test/img/manali.jpg' };
        return { url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${short}.jpg`, credit: `https://commons.wikimedia.org/wiki/File:${short}.jpg` };
      },
      placeCover: async () => {
        throw new Error('a place Go picked is never looked for again');
      },
      showPlaces: (_trip: string, picks: unknown[]) => handed.push(picks),
    } as unknown as TravelToolDeps;
    const tool = travelTools(deps).find((t) => t.name === 'suggest_places')!;
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_sug', link: {} as never, pack: goaPack(), wake: [], signal: new AbortController().signal });
    const out = await tool.run(tool.input.parse({ title: 'Hill escapes from Delhi in December', line: 'Five hill trips for December, vote on your favourite.', places: PLACES }), ctx);
    expect(out).toMatchObject({ card_id: expect.any(String), shown: 5 });
    expect(saved).toEqual([expect.objectContaining({ tripId: 't_goa', optionKind: 'place', source: 'task', checkedAt: '2026-10-11T18:30:00.000Z' })]);
    // A Wikipedia photo's file page is kept with its place, for its credit.
    expect(saved[0]!.options.map((o) => o.facts['photo_credit'] ?? null)).toEqual([
      null, 'https://commons.wikimedia.org/wiki/File:Shimla.jpg', 'https://commons.wikimedia.org/wiki/File:Mussoorie.jpg', 'https://commons.wikimedia.org/wiki/File:Nainital.jpg', null,
    ]);
    const card = ctx.cards[0] as OptionsCardT;
    expect(card).toMatchObject({ kind: 'options', option_kind: 'place', title: 'Hill escapes from Delhi in December' });
    expect(ctx.lines).toEqual(['Five hill trips for December, vote on your favourite.']);
    expect(card.options.map((o) => [o.title, o.image_url ?? null])).toEqual([
      ['Manali, Himachal Pradesh', 'https://go.test/img/manali.jpg'], ['Shimla, Himachal Pradesh', 'https://go.test/img/of-Shimla.jpg'],
      ['Mussoorie, Uttarakhand', 'https://go.test/img/of-Mussoorie.jpg'], ['Nainital, Uttarakhand', 'https://go.test/img/of-Nainital.jpg'], ['Kasol, Himachal Pradesh', null],
    ]);
    expect(covers).toHaveLength(5);
    // Its price is "each, rough" on the card, never "from": it is Go's estimate, not a least.
    expect(card.options[0]).toMatchObject({ price_minor: 2_500_000, price_note: 'each, rough', subtitle: 'Mountains · 12h drive' });
    expect(card.options[0]).not.toHaveProperty('price_min_minor');
    expect(card.options[0]!.details).toMatchObject({ why: ['Fits ₹30k each · snow in Dec', 'Snow by mid December', 'Cafes and walks / for all'], activities: ['Solang Valley', 'Old Manali walks', 'Hot springs'] });
    // The first three get ixigo's own guide in the background, by its guide's name.
    expect(handed).toEqual([card.options.slice(0, 3).map((o) => ({ cardId: card.card_id, optionId: o.option_id, name: o.title, guide: o.title.split(',')[0] }))]);
  });

  // p1-a, 11 Oct: a country won a vote (Morocco), ixigo couldn't set it as the trip's place, and the trip never moved.
  it('a country alone becomes its town in it, with the town it stays in kept; a city that is its own country stays as it is', () => {
    const [vietnam, coorg, singapore] = suggestedPlaces([
      { ...place('Vietnam', 'Beaches'), stay_in: 'Hanoi' }, { ...place('Coorg, Karnataka', 'Coffee hills'), stay_in: 'Madikeri' }, { ...place('Singapore', 'City'), stay_in: 'Singapore' },
    ]);
    expect(vietnam).toMatchObject({ title: 'Hanoi, Vietnam', place: { name: 'Hanoi, Vietnam' }, facts: { stay_in: 'Hanoi', guide: 'Hanoi' } });
    expect(coorg).toMatchObject({ title: 'Coorg, Karnataka', facts: { stay_in: 'Madikeri', guide: 'Coorg' } });
    expect(singapore).toMatchObject({ title: 'Singapore' });
    expect([isCountry('Vietnam'), isCountry('Morocco'), isCountry('Hoi An, Vietnam'), isCountry('Goa'), isCountry('Singapore'), isCountry('Hong Kong')]).toEqual([true, true, false, false, false, false]);
  });

  it('asks for 5 to 8 places, each with what the card draws, and its line', () => {
    const tool = travelTools({} as TravelToolDeps).find((t) => t.name === 'suggest_places')!;
    expect(tool.input.safeParse({ title: 'x', line: 'y', places: PLACES.slice(0, 4) }).success).toBe(false);
    expect(tool.input.safeParse({ title: 'x', line: 'y', places: [...PLACES, ...PLACES] }).success).toBe(false);
    expect(tool.input.safeParse({ title: 'x', line: 'y', places: PLACES.map((p) => ({ ...p, things_to_do: ['One'] })) }).success).toBe(false);
    expect(tool.description).toContain('never needs ixigo');
    expect(tool.description).toContain('never a country alone');
    expect(tool.input.safeParse({ title: 'x', line: 'y', places: PLACES.map(({ stay_in: _, ...p }) => p) }).success).toBe(false);
    expect(tool.description).toContain('never call it a price');
  });
});
