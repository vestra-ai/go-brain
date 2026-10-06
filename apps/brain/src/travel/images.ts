/**
 * Go's image cache. Every image on a card is a Go URL that never changes what it shows. A screenshot is stored under
 * the hash of its bytes, so the same screen keeps its URL. An outside image (ixigo's, or one a job found) gets a Go
 * URL at once and is fetched on its first view, so a search is never slowed by images.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
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

async function fetchImage(doFetch: typeof fetch, url: string): Promise<{ mime: string; bytes: Buffer } | null> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !(mime in EXT)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

export function registerImageRoute(app: FastifyInstance, d: { pool: pg.Pool; fetch?: typeof fetch }): void {
  const doFetch = d.fetch ?? fetch;
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
      const got = await fetchImage(doFetch, row.source_url);
      if (!got) return reply.code(404).send({ error: 'not_found' });
      await d.pool.query('update go_images set mime = $2, bytes = $3 where id = $1 and bytes is null', [id, got.mime, got.bytes]);
      mime = got.mime;
      bytes = got.bytes;
    }
    if (!bytes || !mime) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', mime).header('cache-control', 'public, max-age=31536000, immutable').send(bytes);
  });
}
