import { signRequest, verifyRequest } from '@go/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';

/** Go and the vault sign their calls to each other with VAULT_SHARED_SECRET, in the contract's signRequest format. */
export const VAULT_SIGNATURE_HEADER = 'x-vault-signature';

export function signVaultCall(secret: string, method: string, target: string, body: string, now: Date): string {
  return signRequest({ method, target, body }, secret, Math.floor(now.getTime() / 1000));
}

/** Checks the vault's signature over the exact body and accepts each signature once. */
export async function checkVaultCall(
  pool: pg.Pool,
  secret: string,
  req: { method: string; url: string; headers: Record<string, string | string[] | undefined> },
  body: string,
  now: Date,
): Promise<boolean> {
  const sent = req.headers[VAULT_SIGNATURE_HEADER];
  const header = Array.isArray(sent) ? sent[0] : sent;
  if (!verifyRequest({ method: req.method, target: req.url, body }, header, secret, Math.floor(now.getTime() / 1000)).ok) return false;
  const fields = new Map((header ?? '').split(',').map((p) => p.split('=') as [string, string]));
  const r = await pool.query('insert into vault_callback_seen (t, v1, seen_at) values ($1, $2, $3) on conflict do nothing', [
    Number(fields.get('t')),
    fields.get('v1'),
    now,
  ]);
  await pool.query('delete from vault_callback_seen where seen_at < $1', [new Date(now.getTime() - 600_000)]);
  return (r.rowCount ?? 0) > 0;
}

const raw = new WeakMap<FastifyRequest, string>();

export function rawBodyOf(req: FastifyRequest): string {
  return raw.get(req) ?? '';
}

/** Inside one Fastify scope: JSON bodies are parsed as usual and their exact text is kept for the signature check. */
export function keepRawJson(scope: FastifyInstance): void {
  if (scope.hasContentTypeParser('application/json')) scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    raw.set(req, text);
    try {
      done(null, text === '' ? {} : JSON.parse(text));
    } catch {
      done(Object.assign(new Error('The body is not JSON'), { statusCode: 400 }), undefined);
    }
  });
}
