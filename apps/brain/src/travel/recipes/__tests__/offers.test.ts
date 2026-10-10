import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOK_DIR, loadBook } from '../../book/book.js';
import { evaluate } from '../../book/expr.js';
import { asOffers, bandsFor, createOffers, NAMES_PER_GROUP, OFFERS_TTL_MS, offersText, pickOffers, type Offer } from '../offers.js';
import { offersNow } from '../offers-now.js';

const { book } = loadBook();
/** ixigo's own metadata call for a place's stays, as its results page makes it (saved for hotels.search_filters). */
const METADATA = JSON.parse(readFileSync(`${BOOK_DIR}samples/hotels.search_filters.json`, 'utf8')) as unknown;
const listed = async (): Promise<Offer[]> => asOffers(await evaluate(book.get('hotels.search')!.offers!.list, METADATA, {}));

describe("a site's own list of what it offers (hotels.search: ixigo's metadata call)", () => {
  it('reads every filter group and the sorts from the call ixigo makes, with their codes, and leaves the nameless price bands out', async () => {
    const list = await listed();
    expect(list).toContainEqual({ kind: 'filter', group: 'Facilities', name: 'Swimming Pool', code: 'FL_HF_29' });
    expect(list).toContainEqual({ kind: 'filter', group: 'Facilities', name: 'Pet-friendly property', code: 'FL_HF_21' });
    expect(list).toContainEqual({ kind: 'filter', group: 'Accommodation Type', name: 'Entire house', code: 'AT_EH' });
    expect(list).toContainEqual({ kind: 'filter', group: 'Star Rating', name: '5', code: 'SR_5' });
    expect(list).toContainEqual({ kind: 'filter', group: 'Payment Mode', name: 'Pay At Hotel', code: 'PT_PAY_AT_HOTEL' });
    expect(list).toContainEqual({ kind: 'sort', group: 'Sort', name: 'Price (Low to High)', code: 'SC_P_LH' });
    expect(list.some((o) => o.code.startsWith('DP_'))).toBe(false);
  });

  it('reads the nameless price bands apart from the list, with their prices, for Go alone', async () => {
    const bands = asOffers(await evaluate(book.get('hotels.search')!.offers!.bands!, METADATA, {}));
    expect(bands.length).toBeGreaterThan(3);
    expect(bands.every((b) => b.kind === 'price' && b.code.startsWith('DP_') && b.min! < b.max!)).toBe(true);
    expect(bands).toContainEqual(expect.objectContaining({ code: 'DP_2000_2500', min: 2000, max: 2500 }));
    // Kept with the list, never in it: the model's text of a kept list has no band.
    const offers = createOffers({ now: () => new Date('2026-10-10T05:00:00Z') });
    offers.keep('hotels.search', '32', 'stays in Goa', await listed(), 't_goa', bands);
    const kept = offers.get('hotels.search', '32')!;
    expect(kept.bands).toEqual(bands);
    expect(kept.offers.some((o) => o.kind === 'price')).toBe(false);
    expect(offersText(kept)).not.toContain('DP_');
  });

  it("matches the names the model gives by the site's own words, whatever their case or punctuation; a name it doesn't list is not the site's", async () => {
    const list = await listed();
    // Asks nobody wrote a rule for: a pet, a whole house, 5 stars, and one ixigo has no filter for.
    const f = pickOffers(list, ['pet friendly property', 'ENTIRE HOUSE', 'Star Rating: 5', 'beachfront'], 'filter');
    expect(f.picked.map((o) => o.code)).toEqual(['FL_HF_21', 'AT_EH', 'SR_5']);
    expect(f.unknown).toEqual(['beachfront']);
    expect(pickOffers(list, ['price (low to high)'], 'sort').picked.map((o) => o.code)).toEqual(['SC_P_LH']);
    // A filter's name is no sort.
    expect(pickOffers(list, ['Swimming Pool'], 'sort')).toEqual({ picked: [], unknown: ['Swimming Pool'] });
  });

  it('keeps a list per recipe and place for 12 hours, and knows the trips whose reads brought one', () => {
    let nowMs = Date.parse('2026-10-09T18:00:00Z');
    const offers = createOffers({ now: () => new Date(nowMs) });
    const pool: Offer = { kind: 'filter', group: 'Facilities', name: 'Swimming Pool', code: 'FL_HF_29' };
    offers.keep('hotels.search', '32', 'stays in Goa', [pool], 't_goa');
    // An empty list is never kept.
    offers.keep('hotels.search', '184', 'stays in Manali', [], 't_goa');
    expect(offers.get('hotels.search', '32')).toMatchObject({ about: 'stays in Goa', offers: [pool] });
    expect(offers.get('hotels.search', '184')).toBeNull();
    expect(offers.forTrip('t_goa').map((l) => l.about)).toEqual(['stays in Goa']);
    expect(offers.forTrip('t_other')).toEqual([]);
    nowMs += OFFERS_TTL_MS;
    expect(offers.get('hotels.search', '32')).toBeNull();
    expect(offers.forTrip('t_goa')).toEqual([]);
  });

  it("reads as headings with their names, a long heading's first ones in the site's order, and the sorts last", () => {
    const chains: Offer[] = Array.from({ length: NAMES_PER_GROUP + 5 }, (_, i) => ({ kind: 'filter', group: 'Hotel Chain', name: `Chain ${i + 1}`, code: `HC_${i + 1}` }));
    const text = offersText({
      recipeId: 'hotels.search', about: 'stays in Goa', at: 0,
      offers: [...chains, { kind: 'filter', group: 'Star Rating', name: '4', code: 'SR_4' }, { kind: 'sort', group: 'Sort', name: 'User Rating (Highest First)', code: 'SC_UR' }],
    });
    expect(text).toBe(`Hotel Chain: ${chains.slice(0, NAMES_PER_GROUP).map((c) => c.name).join(', ')} and 5 more; Star Rating: 4; Sort: User Rating (Highest First)`);
  });

  it("takes only rows that are a kind, a heading, a name and a code, however deep the site's list nests them, its HTML read", () => {
    expect(asOffers([
      [[{ kind: 'filter', group: 'Hotel Chain', name: 'Adamo hotels &amp; resorts', code: 'HC_12' }]],
      { kind: 'filter', group: 'Price', code: 'DP_1600_1800' },
      { kind: 'badge', group: 'x', name: 'y', code: 'Z' },
      { kind: 'filter', group: 'Facilities', name: 'Spa', code: 'not a code!' },
    ])).toEqual([{ kind: 'filter', group: 'Hotel Chain', name: 'Adamo hotels & resorts', code: 'HC_12' }]);
    expect(asOffers(null)).toEqual([]);
  });

  it("puts the trip's lists in its turn's context, for the model to map the ask onto; nothing before a read brought one", async () => {
    const offers = createOffers({ now: () => new Date('2026-10-09T18:00:00Z') });
    const now = offersNow({ offers });
    expect(await now.render('t_goa', [])).toBeNull();
    offers.keep('hotels.search', '32', 'stays in Goa', await listed(), 't_goa');
    const said = await now.render('t_goa', []);
    expect(said).toContain("ixigo's own filters and sorts for stays in Goa, as its page lists them: ");
    expect(said).toContain('Facilities: Internet access');
    expect(said).toContain('Swimming Pool');
    expect(said).toContain('On search_stays, put the ones the ask means in site_filters (and site_sort), by these names, so ixigo filters itself');
    // ixigo lists no villa, only "Entire house" (10 Oct): the nearest name, the group's own word kept to check it by.
    expect(said).toContain("the nearest name for what they said, as a person would pick it on ixigo's page (a kind of stay too: its nearest stay type), keeping their own word in wants too");
    // The list, once known, is how the ask reaches ixigo: must_have only for what no name on it covers (the run sheet's villa, 10 Oct).
    expect(said).toContain('so ixigo filters itself, never must_have for what a name here covers');
    expect(said).toContain('Anything else the group asked for goes in wants, and you pick it from the results');
    expect(await now.render('t_other', [])).toBeNull();
  });
});

// The ixigo atlas (10 Oct): ixigo's price bands (dynamicPrice, "DP_2000_2500") have codes and prices but no names.
describe("ixigo's price bands", () => {
  const band = (min: number, max: number) => ({ kind: 'price', group: 'Price', name: `₹${min} to ₹${max}`, code: `DP_${min}_${max}`, min, max });
  const offers = asOffers([
    [{ kind: 'filter', group: 'Facilities', name: 'Swimming Pool', code: 'FL_HF_29' }],
    [band(2000, 2500), band(2500, 3000), band(3000, 3500), band(3500, 4000), { ...band(5, 1), code: 'DP_BAD' }],
  ]);

  it('keeps them with their prices, and never names them to the model', () => {
    expect(offers.filter((o) => o.kind === 'price').map((o) => [o.code, o.min, o.max])).toEqual([
      ['DP_2000_2500', 2000, 2500], ['DP_2500_3000', 2500, 3000], ['DP_3000_3500', 3000, 3500], ['DP_3500_4000', 3500, 4000],
    ]);
    const said = offersText({ recipeId: 'hotels.search', about: 'stays in Goa', offers, at: 0 });
    expect(said).toContain('Swimming Pool');
    expect(said).not.toContain('₹');
    // Never a name the model can ask for.
    expect(pickOffers(offers, ['₹2000 to ₹2500'], 'filter').picked).toEqual([]);
  });

  it('picks every band at or under a cap a night and a room, and the one band over it', () => {
    expect(bandsFor(offers, 3000).map((o) => o.code)).toEqual(['DP_2000_2500', 'DP_2500_3000', 'DP_3000_3500']);
    expect(bandsFor(offers, 2200).map((o) => o.code)).toEqual(['DP_2000_2500']);
    expect(bandsFor(offers, 9000).map((o) => o.code)).toEqual(['DP_2000_2500', 'DP_2500_3000', 'DP_3000_3500', 'DP_3500_4000']);
    expect(bandsFor(offers.filter((o) => o.kind !== 'price'), 3000)).toEqual([]);
  });
});
