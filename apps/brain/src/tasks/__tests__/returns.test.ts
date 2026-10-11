import { describe, expect, it } from 'vitest';
import type { ResultOption } from '../../travel/results.js';
import { FOUND_ON_WEB, readReturned, resolvePicks, returnsSchema, type FindBySource, type FindOffer } from '../returns.js';

describe('return shapes', () => {
  it('asks for options with a summary, every pick with its offer_id and whole price, or for an answer', () => {
    expect(returnsSchema('stays')).toMatchObject({
      type: 'object',
      required: ['summary', 'options'],
      properties: { options: { items: { required: ['title', 'offer_id', 'total_paise', 'highlights', 'why'], properties: { offer_id: { type: ['string', 'null'] }, total_paise: { type: ['integer', 'null'] } } } } },
    });
    expect(returnsSchema('answer')).toMatchObject({ type: 'object', required: ['summary'] });
  });

  it('reads options back leniently: trims, keeps Go offer ids, whole prices and https images, drops what has no title', () => {
    const r = readReturned('stays', {
      summary: 'Three villas with a pool — all near the beach.',
      options: [
        { title: 'Villa Sol', area: 'Anjuna', price_minor: 1280000, price_note: 'per night', total_paise: 3840000, highlights: ['Private pool', '8 min to the beach', 'x'.repeat(60)], rating: 4.7, image_url: 'https://picsum.photos/x', offer_id: 'fake:st-villa-sol-anjuna-20261106-20261109-5', why: 'Pool and the beach close by.' },
        { title: 'Casa Azul', price_minor: 1460000.5, total_paise: -1, image_url: 'http://insecure.example/x.jpg', offer_id: 'booking.com:123', rating: 9, highlights: [], why: 'Big' },
        { area: 'nowhere' },
      ],
    }, null);
    expect(r.summary).toBe('Three villas with a pool, all near the beach.');
    expect(r.options).toHaveLength(2);
    expect(r.options[0]).toMatchObject({ kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, currency: 'INR', priceNote: 'per night', offerId: 'fake:st-villa-sol-anjuna-20261106-20261109-5', imageUrl: 'https://picsum.photos/x', rating: 4.7, facts: { area: 'Anjuna' }, why: 'Pool and the beach close by.' });
    expect(r.options[0]!.highlights[2]!.length).toBeLessThanOrEqual(40);
    expect(r.options[1]).not.toHaveProperty('priceMinor');
    expect(r.options[1]).not.toHaveProperty('totalMinor');
    expect(r.options[1]).not.toHaveProperty('currency');
    expect(r.options[1]).not.toHaveProperty('imageUrl');
    expect(r.options[1]).not.toHaveProperty('offerId');
    expect(r.options[1]).not.toHaveProperty('rating');
  });

  it('reads an answer as its summary, and falls back to the text when the data is not the shape', () => {
    expect(readReturned('answer', { summary: 'Check-in is at 2 pm.' }, 'ignored')).toEqual({ summary: 'Check-in is at 2 pm.', options: [], fromText: false });
    expect(readReturned('stays', 'not json', 'The job wrote this.')).toEqual({ summary: 'The job wrote this.', options: [], fromText: false });
  });

  // The rehearsal drill: the run that ended first had no output_schema, so its answer came as JSON in the text.
  const IN_TEXT = {
    summary: 'Checked all four villas the stay search returned; none has a confirmed pet policy.',
    options: [
      { title: 'Villa Sol', offer_id: 'fake:st-villa-sol-anjuna-20261106-20261109-5', total_paise: 3840000, price_note: 'Whole villa, 3 nights, 5 guests', area: 'Anjuna', rating: 4.7, highlights: ['Private pool'], why_it_fits: 'Within budget.' },
      { title: 'The Palms Villa', offer_id: 'fake:st-the-palms-vagator-20261106-20261109-5', total_paise: 3660000, area: 'Vagator', highlights: ['Private pool'] },
    ],
  };

  it('with no data, reads an answer the job wrote as JSON in its text, plain or in one fenced block, and says so', () => {
    for (const text of [JSON.stringify(IN_TEXT, null, 2), `\`\`\`json\n${JSON.stringify(IN_TEXT)}\n\`\`\``]) {
      const r = readReturned('stays', null, text);
      expect(r.fromText).toBe(true);
      expect(r.summary).toBe(IN_TEXT.summary);
      expect(r.options.map((o) => [o.title, o.offerId, o.totalMinor])).toEqual([
        ['Villa Sol', 'fake:st-villa-sol-anjuna-20261106-20261109-5', 3840000],
        ['The Palms Villa', 'fake:st-the-palms-vagator-20261106-20261109-5', 3660000],
      ]);
    }
    // Options alone: no summary, rather than the raw JSON as one.
    expect(readReturned('stays', null, JSON.stringify({ options: IN_TEXT.options }))).toMatchObject({ summary: null, fromText: true });
  });

  it('keeps the data first, and words, JSON of another shape or broken JSON in the text as words', () => {
    expect(readReturned('stays', { summary: 'From the data.', options: [] }, JSON.stringify(IN_TEXT))).toMatchObject({ summary: 'From the data.', options: [], fromText: false });
    for (const text of ['Found three villas, all near the beach.', '{"villas": 3}', '{"summary": "cut off', '[1, 2]']) {
      expect(readReturned('stays', null, text), text).toEqual({ summary: text, options: [], fromText: false });
    }
  });
});

describe("a job's picks against Go's own searches", () => {
  const SOL_ID = 'fake:st-villa-sol-anjuna-20261106-20261109-5';
  const saved: ResultOption = {
    offerId: SOL_ID, kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, currency: 'INR', priceNote: 'per night',
    imageUrl: 'https://picsum.photos/seed/go-villa-sol-anjuna/800/600', rating: 4.7, highlights: ['Private pool', 'Sleeps 6'], facts: { nights: 3, area: 'Anjuna' },
  };
  const finds: string[] = [];
  const find: FindOffer = async (tripId, offerId) => {
    finds.push(`${tripId}:${offerId}`);
    return offerId === SOL_ID ? { option: saved, checkedAt: '2026-10-07T11:58:00.000Z' } : null;
  };
  const picks = readReturned('stays', {
    summary: 'Three villas.',
    options: [
      { title: 'Villa Sol, Anjuna', price_minor: 1000000, price_note: 'per night', total_paise: 3000000, highlights: ['8 min to the beach'], offer_id: SOL_ID, why: 'Pool and the beach close by.' },
      { title: 'Casa Lua', area: 'Assagao', price_minor: 1500000, price_note: 'per night', total_paise: 4500000, highlights: ['Garden'], offer_id: null, source_url: 'https://villas.example/casa-lua', why: 'Quiet, with a big garden.' },
      { title: 'Villa Fake', price_minor: 900000, total_paise: 2700000, highlights: [], offer_id: 'fake:st-made-up-20261106-20261109-5', why: 'Cheap.' },
    ],
  }, null).options;

  it("turns an offer id Go's search showed this trip into that offer, with Go's checked prices and the whole-stay total", async () => {
    const r = await resolvePicks('t_goa', 'stay', picks, find);
    expect(r.options[0]).toEqual({ ...saved, highlights: ['8 min to the beach'], why: 'Pool and the beach close by.' });
    expect(r.checkedAt).toBe('2026-10-07T11:58:00.000Z');
    expect(finds).toContain(`t_goa:${SOL_ID}`);
  });

  it('marks a pick with no offer id, or one Go never showed, as found on the web, with no offer', async () => {
    const r = await resolvePicks('t_goa', 'stay', picks, find);
    expect(r.fromWeb).toBe(2);
    for (const web of [r.options[1]!, r.options[2]!]) {
      expect(web).not.toHaveProperty('offerId');
      expect(web.highlights[0]).toBe(FOUND_ON_WEB);
      expect(web.facts.found_on_web).toBe(true);
    }
    expect(r.options[1]).toMatchObject({ title: 'Casa Lua', priceMinor: 1500000, totalMinor: 4500000, sourceUrl: 'https://villas.example/casa-lua' });
  });

  // The lead, 11 Oct: options read off ixigo.com come back with offer_id null, so a job's pick of one was "Found on the web"
  // and never booked. Its ixigo page finds the option Go's own search read there.
  it("turns a pick read off ixigo.com into the option Go's search read on that page; only another site's is found on the web", async () => {
    const page = 'https://www.ixigo.com/hotels/4395492/details?checkinDate=06112026&checkoutDate=09112026&adultCount=5';
    const onIxigo: ResultOption = {
      kind: 'stay', title: 'High Five Hotels Phase 2', priceMinor: 945000, totalMinor: 2835000, currency: 'INR', priceNote: 'per night', sourceUrl: page, highlights: ['Pool'], facts: { area: 'Anjuna' },
    };
    const asked: string[] = [];
    const bySource: FindBySource = async (tripId, kind, url, title) => {
      asked.push(`${tripId}:${kind}:${title}`);
      return url === page ? { option: onIxigo, checkedAt: '2026-10-11T07:00:00.000Z' } : null;
    };
    const read = readReturned('stays', {
      summary: 'Three stays.',
      options: [
        { title: 'High Five Hotels', price_minor: 900000, total_paise: 2700000, highlights: ['Near the beach'], offer_id: null, source_url: page, why: 'Pool and close to the beach.' },
        { title: 'Ganga Homestay', price_minor: 400000, total_paise: 800000, highlights: ['Garden'], offer_id: null, source_url: 'https://www.ixigo.com/hotels/999/details?x=1', why: 'Cheap and calm.' },
        { title: 'Casa Lua', price_minor: 1500000, total_paise: 4500000, highlights: ['Garden'], offer_id: null, source_url: 'https://villas.example/casa-lua', why: 'Quiet.' },
      ],
    }, null).options;
    const r = await resolvePicks('t_goa', 'stay', read, find, bySource);
    expect(asked).toEqual(['t_goa:stay:High Five Hotels', 't_goa:stay:Ganga Homestay']);
    expect(r.options[0]).toEqual({ ...onIxigo, highlights: ['Near the beach'], why: 'Pool and close to the beach.' });
    expect(r.checkedAt).toBe('2026-10-11T07:00:00.000Z');
    // An ixigo page Go's search never read stays the job's own pick, ixigo's still: never "Found on the web".
    expect(r.options[1]).toMatchObject({ title: 'Ganga Homestay', sourceUrl: 'https://www.ixigo.com/hotels/999/details?x=1', highlights: ['Garden'] });
    expect(r.options[1]).not.toHaveProperty('offerId');
    expect(r.options[1]!.facts).not.toHaveProperty('found_on_web');
    expect(r.options[2]!.highlights[0]).toBe(FOUND_ON_WEB);
    expect(r.fromWeb).toBe(1);
  });

  it('leaves places, food and activities alone: they are never booked through Go', async () => {
    const food = readReturned('food', { summary: 'Two places.', options: [{ title: 'Gunpowder', highlights: ['Veg friendly'], offer_id: null, total_paise: null, why: 'Great thalis.' }] }, null).options;
    const r = await resolvePicks('t_goa', 'food', food, find);
    expect(r).toEqual({ options: food, checkedAt: null, fromWeb: 0 });
  });
});
