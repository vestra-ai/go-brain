import type { FastifyInstance, FastifyRequest } from 'fastify';

const raw = new WeakMap<FastifyRequest, string>();

/** The exact body bytes, for checking a signature. Empty for a request without a body. */
export function rawBody(req: FastifyRequest): string {
  return raw.get(req) ?? '';
}

/** JSON bodies are parsed as usual, and their exact text is kept for signature checks. */
export function keepRawJson(app: FastifyInstance): void {
  if (app.hasContentTypeParser('application/json')) app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    raw.set(req, text);
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = Object.assign(new Error('The body is not JSON'), { statusCode: 400 });
      done(err, undefined);
    }
  });
}

/** Stripe's card form needs js.stripe.com; nothing else outside the vault is allowed, and nobody may frame it. */
export const PAGE_CSP = [
  "default-src 'none'",
  // Stripe's security guide: Stripe.js may start its frames on *.js.stripe.com.
  "script-src 'self' https://js.stripe.com https://*.js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.stripe.com",
  "connect-src 'self' https://api.stripe.com",
  'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export function sessionCookie(name: string, value: string, path: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}
