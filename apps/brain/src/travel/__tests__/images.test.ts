import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { fetch as undiciFetch } from 'undici';
import { withSchema } from '../../db/test-db.js';
import { createImages, createPinnedAgent, isFetchableImageUrl, isPublicAddress, registerImageRoute, type Lookup } from '../images.js';

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
  it('forgets a picture it stored, and never an outside image or another host\'s URL', async () => {
    const idOf = (url: string): string => url.split('/img/')[1]!.split('.')[0]!;
    const has = async (url: string): Promise<boolean> => ((await db.pool.query('select 1 from go_images where id = $1', [idOf(url)])).rowCount ?? 0) > 0;
    const shot = await images().putBytes(Buffer.from([0xff, 0xd8, 0xff, 0x61]), 'image/jpeg');
    const outside = (await images().rehostUrl('https://example.com/forget-me-not.jpg'))!;
    await images().forget(outside);
    await images().forget(`https://elsewhere.test/img/${idOf(shot)}.jpg`);
    expect([await has(shot), await has(outside)]).toEqual([true, true]);
    await images().forget(shot);
    expect([await has(shot), await has(outside)]).toEqual([false, true]);
  });

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

  // Keshav, 11 Oct: a place card's cover is ixigo's own photo through this cache (its explorer's, plan-cf.ixigo.com).
  // ixigo's images host answers a JPEG as image/jpg, and its CDN picks the format by what is asked (webp for a browser).
  it("keeps a JPEG a host calls image/jpg, and asks every source for webp, jpeg or png only", async () => {
    const asked: Array<string | undefined> = [];
    const agents: Array<string | undefined> = [];
    const fetchStub = vi.fn(async (_url: string, init: { headers?: { accept?: string; 'user-agent'?: string } }) => {
      asked.push(init.headers?.accept);
      agents.push(init.headers?.['user-agent']);
      return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpg' } });
    });
    const app = Fastify();
    registerImageRoute(app, { pool: db.pool, fetch: fetchStub as unknown as typeof fetch, lookup: publicDns });
    const url = await images().rehostUrl('https://plan-cf.ixigo.com/v2/images/agra?refresh=true');
    const res = await app.inject({ method: 'GET', url: new URL(url!).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(asked).toEqual(['image/webp,image/jpeg,image/png']);
    // Wikimedia refuses an image fetch with no descriptive User-Agent (the lead, from the prod brain, 11 Oct).
    expect(agents).toEqual(['GoTravel/1.0 (https://vestra.ai)']);
    const webp = Fastify();
    registerImageRoute(webp, { pool: db.pool, fetch: (async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/webp' } })) as unknown as typeof fetch, lookup: publicDns });
    const shot = await images().rehostUrl('https://plan-cf.ixigo.com/v2/images/goa?refresh=true');
    expect((await webp.inject({ method: 'GET', url: new URL(shot!).pathname })).headers['content-type']).toBe('image/webp');
  });

  // A kept place's photo is Go's own image already: it goes on a card as it is, never a copy that fetches Go from Go.
  it("gives Go's own image back as it is", async () => {
    const own = await images().putBytes(JPEG, 'image/jpeg');
    expect(await images().rehostUrl(own)).toBe(own);
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

  it('re-resolves at the connect and refuses there too: a name that answers public, then private, is never fetched', async () => {
    const answers = [['93.184.216.34'], ['10.0.0.7']];
    const asked: string[] = [];
    const rebinding: Lookup = async (host) => {
      asked.push(host);
      return answers.shift() ?? ['10.0.0.7'];
    };
    const app = Fastify();
    // No fetch stub: the real fetcher, whose connections go through the pinned lookup.
    const route = registerImageRoute(app, { pool: db.pool, lookup: rebinding });
    const url = await images().rehostUrl('https://rebind.example.com/x.png');
    expect((await app.inject({ method: 'GET', url: new URL(url!).pathname })).statusCode).toBe(404);
    // Once for the hop's check and once by the connect itself, which saw the private answer and connected nowhere.
    expect(asked).toEqual(['rebind.example.com', 'rebind.example.com']);
    await route.close();
  });

  it('connects only to the address its lookup checked, and never to a later private answer', async () => {
    const hits = { checked: 0, other: 0 };
    const listen = (host: string, port: number, key: keyof typeof hits): Promise<Server> =>
      new Promise((resolve) => {
        const server = createServer((_req, res) => {
          res.end('ok');
        });
        server.on('connection', () => {
          hits[key] += 1;
        });
        server.listen(port, host, () => resolve(server));
      });
    const checked = await listen('127.0.0.1', 0, 'checked');
    const port = (checked.address() as AddressInfo).port;
    const other = await listen('127.0.0.2', port, 'other');
    const answers = [['127.0.0.1'], ['127.0.0.2']];
    const asked: string[] = [];
    const lookup: Lookup = async (host) => {
      asked.push(host);
      return answers.shift() ?? ['127.0.0.2'];
    };
    // Here 127.0.0.1 stands for a public address and 127.0.0.2 for a private one.
    const allowed = (ip: string) => ip === '127.0.0.1';
    const first = createPinnedAgent(lookup, allowed);
    const res = await undiciFetch(`http://rebind.test:${port}/a.png`, { dispatcher: first });
    expect(await res.text()).toBe('ok');
    expect(asked).toEqual(['rebind.test']);
    expect(hits).toEqual({ checked: 1, other: 0 });
    await first.close();
    // A new connection resolves again; the private answer is refused before any connect.
    const second = createPinnedAgent(lookup, allowed);
    await expect(undiciFetch(`http://rebind.test:${port}/b.png`, { dispatcher: second })).rejects.toThrow();
    expect(hits).toEqual({ checked: 1, other: 0 });
    await second.close();
    await new Promise((r) => checked.close(r));
    await new Promise((r) => other.close(r));
  });
});
