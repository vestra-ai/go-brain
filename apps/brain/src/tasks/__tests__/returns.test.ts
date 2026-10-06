import { describe, expect, it } from 'vitest';
import type { ResultOption } from '../../travel/results.js';
import { FOUND_ON_WEB, readReturned, resolvePicks, returnsSchema, type FindOffer } from '../returns.js';

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
    expect(readReturned('answer', { summary: 'Check-in is at 2 pm.' }, 'ignored')).toEqual({ summary: 'Check-in is at 2 pm.', options: [] });
    expect(readReturned('stays', 'not json', 'The job wrote this.')).toEqual({ summary: 'The job wrote this.', options: [] });
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

  it('leaves places, food and activities alone: they are never booked through Go', async () => {
    const food = readReturned('food', { summary: 'Two places.', options: [{ title: 'Gunpowder', highlights: ['Veg friendly'], offer_id: null, total_paise: null, why: 'Great thalis.' }] }, null).options;
    const r = await resolvePicks('t_goa', 'food', food, find);
    expect(r).toEqual({ options: food, checkedAt: null, fromWeb: 0 });
  });
});
