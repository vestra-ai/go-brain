import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { withSchema } from '../../db/test-db.js';
import { createImages, isFetchableImageUrl, isPublicAddress, registerImageRoute, type Lookup } from '../images.js';

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
/** Every name resolves to a public address unless a test says otherwise; no test reaches real DNS. */
const publicDns: Lookup = async () => ['93.184.216.34'];

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
    registerImageRoute(app, { pool: db.pool, fetch: fetchStub as unknown as typeof fetch, lookup: publicDns });
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
    registerImageRoute(app, { pool: db.pool, fetch: (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch, lookup: publicDns });
    const url = await images().rehostUrl('https://example.com/not-an-image');
    expect((await app.inject({ method: 'GET', url: new URL(url!).pathname })).statusCode).toBe(404);
  });

  it('checks every redirect hop, and never fetches a name that resolves to a private, loopback or link-local address', async () => {
    const dns: Lookup = async (host) => (host === 'inside.example.net' ? ['10.0.0.5'] : host === 'loop.example.net' ? ['127.0.0.1', '93.184.216.34'] : ['93.184.216.34']);
    const hops: string[] = [];
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      hops.push(url);
      if (url === 'https://cdn.example.com/a.png') return new Response(null, { status: 302, headers: { location: 'https://img.example.org/b.png' } });
      if (url === 'https://cdn.example.com/to-metadata.png') return new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/latest/meta-data' } });
      if (url === 'https://cdn.example.com/to-inside.png') return new Response(null, { status: 302, headers: { location: 'https://inside.example.net/x.png' } });
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const app = Fastify();
    registerImageRoute(app, { pool: db.pool, fetch: fetchStub as unknown as typeof fetch, lookup: dns });
    const view = async (source: string) => app.inject({ method: 'GET', url: new URL((await images().rehostUrl(source))!).pathname });
    expect((await view('https://cdn.example.com/a.png')).statusCode).toBe(200);
    expect(hops).toEqual(['https://cdn.example.com/a.png', 'https://img.example.org/b.png']);
    hops.length = 0;
    expect((await view('https://cdn.example.com/to-metadata.png')).statusCode).toBe(404);
    expect((await view('https://cdn.example.com/to-inside.png')).statusCode).toBe(404);
    expect(hops).toEqual(['https://cdn.example.com/to-metadata.png', 'https://cdn.example.com/to-inside.png']);
    expect((await view('https://loop.example.net/c.png')).statusCode).toBe(404);
    expect(hops).not.toContain('https://loop.example.net/c.png');
  });

  it('tells public addresses from private, loopback, link-local and mapped ones', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});
