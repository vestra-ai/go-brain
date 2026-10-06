/**
 * Go's image cache. Every image on a card is a Go URL that never changes what it shows. A screenshot is stored under
 * the hash of its bytes, so the same screen keeps its URL. An outside image (ixigo's, or one a job found) gets a Go
 * URL at once and is fetched on its first view, so a search is never slowed by images. Every hop of that fetch must be
 * https on a public name that resolves only to public addresses, so a URL a job found cannot reach Go's own network.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

/** A host's addresses, as DNS answers them. Tests pass their own. */
export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv6');

/** False for private, loopback, link-local, carrier NAT, multicast and unspecified addresses (IPv4-mapped IPv6 too). */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  const v = isIP(ip);
  if (v === 4) return !NOT_PUBLIC.check(ip, 'ipv4');
  if (v === 6) return !NOT_PUBLIC.check(ip, 'ipv6');
  return false;
}

async function resolvesPublic(lookup: Lookup, host: string): Promise<boolean> {
  const addresses = await lookup(host);
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface Images {
  putBytes(bytes: Uint8Array, mime: ImageMime): Promise<string>;
  /** Null when the URL is not an https image on a public name. */
  rehostUrl(sourceUrl: string): Promise<string | null>;
}

export function isFetchableImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IP literals are refused: an image comes from a named host.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
  return true;
}

export function createImages(d: { pool: pg.Pool; publicUrl: string }): Images {
  const base = d.publicUrl.replace(/\/+$/, '');
  return {
    async putBytes(bytes, mime) {
      const id = `i${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
      await d.pool.query('insert into go_images (id, mime, bytes) values ($1, $2, $3) on conflict (id) do nothing', [id, mime, Buffer.from(bytes)]);
      return `${base}/img/${id}.${EXT[mime]}`;
    },
    async rehostUrl(sourceUrl) {
      if (!isFetchableImageUrl(sourceUrl)) return null;
      const id = `u${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32)}`;
      await d.pool.query('insert into go_images (id, source_url) values ($1, $2) on conflict (id) do nothing', [id, sourceUrl]);
      return `${base}/img/${id}.jpg`;
    },
  };
}

async function fetchImage(doFetch: typeof fetch, lookup: Lookup, first: string): Promise<{ mime: string; bytes: Buffer } | null> {
  let url = first;
  try {
    // Redirects are followed by hand, so every hop is checked before it is fetched.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isFetchableImageUrl(url) || !(await resolvesPublic(lookup, new URL(url).hostname))) return null;
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!next) return null;
        url = new URL(next, url).toString();
        continue;
      }
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!res.ok || !(mime in EXT)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
      return { mime, bytes };
    }
    return null;
  } catch {
    return null;
  }
}

export function registerImageRoute(app: FastifyInstance, d: { pool: pg.Pool; fetch?: typeof fetch; lookup?: Lookup }): void {
  const doFetch = d.fetch ?? fetch;
  const lookup = d.lookup ?? systemLookup;
  app.get<{ Params: { file: string } }>('/img/:file', async (req, reply) => {
    const id = req.params.file.replace(/\.[a-z]+$/, '');
    if (!/^[iu][0-9a-f]{32}$/.test(id)) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await d.pool.query<{ mime: string | null; bytes: Buffer | null; source_url: string | null }>(
      'select mime, bytes, source_url from go_images where id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    let mime = row.mime;
    let bytes = row.bytes;
    if (!bytes && row.source_url) {
      const got = await fetchImage(doFetch, lookup, row.source_url);
      if (!got) return reply.code(404).send({ error: 'not_found' });
      await d.pool.query('update go_images set mime = $2, bytes = $3 where id = $1 and bytes is null', [id, got.mime, got.bytes]);
      mime = got.mime;
      bytes = got.bytes;
    }
    if (!bytes || !mime) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', mime).header('cache-control', 'public, max-age=31536000, immutable').send(bytes);
  });
}
