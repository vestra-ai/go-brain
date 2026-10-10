import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { photosOf, withoutPhotos } from '../photos.js';

// The Server team's 10 Oct B3: labelled photos, every one through Go's image cache.
const images = {
  rehostUrl: async (u: string) => (u.includes('broken') ? null : `https://go.test/img/${u.split('/').pop()!.replace(/\W+/g, '')}.jpg`),
};

describe('photosOf', () => {
  it("re-hosts each photo, in the source's order, with its label as the source gave it, cut to 40", async () => {
    const got = await photosOf(
      [
        'https://cdn.example.com/goa/cover',
        { url: 'https://cdn.example.com/pool', label: '  Swimming   pool ' },
        { url: 'https://cdn.example.com/room', label: 'Deluxe Room with a Private Balcony and a Sea View' },
        { url: 'https://cdn.example.com/blank', label: '   ' },
      ],
      images,
    );
    expect(got).toEqual([
      { url: 'https://go.test/img/cover.jpg' },
      { url: 'https://go.test/img/pool.jpg', label: 'Swimming pool' },
      { url: 'https://go.test/img/room.jpg', label: 'Deluxe Room with a Private Balcony and a' },
      { url: 'https://go.test/img/blank.jpg' },
    ]);
    for (const p of got) expect(C.Photo.safeParse(p).success).toBe(true);
  });

  it('leaves out a photo that will not fetch, one that is not a photo, and the same one twice; twelve at most', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/p${i}`);
    expect(await photosOf(['https://cdn.example.com/broken', { label: 'no url' }, 'https://cdn.example.com/a', 'https://cdn.example.com/a'], images)).toEqual([
      { url: 'https://go.test/img/a.jpg' },
    ]);
    const twelve = await photosOf(many, images);
    expect(twelve).toHaveLength(12);
    expect(twelve[11]).toEqual({ url: 'https://go.test/img/p11.jpg' });
  });

  it("keeps a facts row's photo lists from the model: they are for the App's cards", () => {
    expect(withoutPhotos({ destination: 'Goa', photo: 'https://x/p.jpg', photos: [{ url: 'https://x/a.jpg' }], photo_list: [] })).toEqual({
      destination: 'Goa', photo: 'https://x/p.jpg',
    });
  });
});
