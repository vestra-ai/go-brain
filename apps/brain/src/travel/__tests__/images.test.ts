import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { withSchema } from '../../db/test-db.js';
import { createImages, isFetchableImageUrl, registerImageRoute } from '../images.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
const images = () => createImages({ pool: db.pool, publicUrl: 'https://go.test/' });

describe("Go's image cache", () => {
  it('stores bytes under their hash, so the same screen gives the same URL', async () => {
    const a = await images().putBytes(JPEG, 'image/jpeg');
    expect(a).toMatch(/^https:\/\/go\.test\/img\/i[0-9a-f]{32}\.jpg$/);
    expect(await images().putBytes(JPEG, 'image/jpeg')).toBe(a);
    expect(await images().putBytes(PNG, 'image/png')).toMatch(/\.png$/);
  });

  it('serves stored bytes with an immutable cache header, and 404 for an unknown or malformed id', async () => {
    const app = Fastify();
    registerImageRoute(app, { pool: db.pool });
    const url = await images().putBytes(JPEG, 'image/jpeg');
    const res = await app.inject({ method: 'GET', url: new URL(url).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/img/i${'0'.repeat(32)}.jpg` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/img/nothing-here.jpg' })).statusCode).toBe(404);
  });

  it('re-hosts an outside https image lazily: a Go URL at once, fetched on first view, then kept', async () => {
    const fetchStub = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
    const app = Fastify();
    registerImageRoute(app, { pool: db.pool, fetch: fetchStub as unknown as typeof fetch });
    const url = await images().rehostUrl('https://picsum.photos/seed/go-villa-sol/800/600');
    expect(url).toMatch(/^https:\/\/go\.test\/img\/u[0-9a-f]{32}\.jpg$/);
    expect(fetchStub).not.toHaveBeenCalled();
    const path = new URL(url!).pathname;
    const first = await app.inject({ method: 'GET', url: path });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    await app.inject({ method: 'GET', url: path });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('never fetches what is not an https image on a public name', async () => {
    expect(isFetchableImageUrl('http://picsum.photos/x')).toBe(false);
    expect(isFetchableImageUrl('https://127.0.0.1/x.jpg')).toBe(false);
    expect(isFetchableImageUrl('https://localhost/x.jpg')).toBe(false);
    expect(isFetchableImageUrl('https://[::1]/x.jpg')).toBe(false);
    expect(isFetchableImageUrl('https://picsum.photos/x')).toBe(true);
    expect(await images().rehostUrl('ftp://example.com/x.jpg')).toBeNull();
    const app = Fastify();
    registerImageRoute(app, { pool: db.pool, fetch: (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch });
    const url = await images().rehostUrl('https://example.com/not-an-image');
    expect((await app.inject({ method: 'GET', url: new URL(url!).pathname })).statusCode).toBe(404);
  });
});
