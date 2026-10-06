// The one way in to the operator's pages (the admin page, and the proof board), with ADMIN_TOKEN never in a URL Go
// sees or logs. A person opens /admin#token=<ADMIN_TOKEN>: the browser never sends the part after #. The sign-in
// page reads it, drops it from the address bar, sends it once as a bearer to POST /admin/session, gets an HttpOnly
// cookie back and loads the clean URL. Scripts and the bench send the token as a bearer on every call.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SESSION_PATH = '/admin/session';
export const SIGN_OUT_PATH = '/admin/sign-out';
/** A stage day: the operator signs in again the next morning. Go checks it, not only the browser. */
export const SESSION_SECONDS = 12 * 60 * 60;

/** Headers for every page a person signs in to: never cached, never framed, never indexed, no referrer. */
export const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
} as const;

export interface SessionOptions {
  token: string;
  /** Go is served over https: the cookie is __Host- and Secure. */
  secure: boolean;
  now: () => Date;
}

/** Over https the cookie is __Host-: only this host can set it, on Path=/, Secure, so nothing else can plant one. */
export const cookieName = (secure: boolean): string => (secure ? '__Host-go_admin' : 'go_admin');

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Equal tokens, compared in constant time. */
export function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** What the cookie holds: when it was issued, signed with the token. Never the token itself. */
export function sessionValue(token: string, issuedAt: Date): string {
  const at = Math.floor(issuedAt.getTime() / 1000);
  return `${at}.${createHmac('sha256', token).update(`go-admin-session:${at}`).digest('base64url')}`;
}

function freshSession(value: string, o: SessionOptions): boolean {
  const at = Number(value.split('.')[0]);
  if (!Number.isInteger(at)) return false;
  const age = o.now().getTime() / 1000 - at;
  return age >= -60 && age <= SESSION_SECONDS && sameToken(value, sessionValue(o.token, new Date(at * 1000)));
}

/** Every value sent under exactly this name: a browser sends one per path, and one may have been planted. */
function cookiesNamed(req: FastifyRequest, name: string): string[] {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return [];
  return header.split(';').flatMap((part) => {
    const at = part.indexOf('=');
    return at > 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
  });
}

export function bearerOf(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

/** The request came from Go's own pages: the browser says so, or its Origin is this host. */
function sameSite(req: FastifyRequest): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === req.host;
  } catch {
    return false;
  }
}

/**
 * A bearer, or a session cookie under 12 hours old. A cookie on anything but a read must also come from Go's own pages,
 * so another site cannot make a signed-in browser press a button. Never ?token=: a token in a URL ends up in logs and
 * in the browser's history.
 */
export function signedIn(req: FastifyRequest, o: SessionOptions): boolean {
  if (sameToken(bearerOf(req), o.token)) return true;
  if (!cookiesNamed(req, cookieName(o.secure)).some((v) => freshSession(v, o))) return false;
  return req.method === 'GET' || req.method === 'HEAD' || sameSite(req);
}

export function sessionCookie(o: SessionOptions): string {
  return `${cookieName(o.secure)}=${sessionValue(o.token, o.now())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${o.secure ? '; Secure' : ''}`;
}

const signedOutCookie = (secure: boolean): string => `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/**
 * POST /admin/session (the sign-in page's one call: the token as a bearer, swapped for the cookie) and POST
 * /admin/sign-out. The admin page and the board both call this; the first one registers the routes, so either works
 * without the other.
 */
export function registerSessionRoute(http: FastifyInstance, o: SessionOptions): void {
  if (http.hasRoute({ method: 'POST', url: SESSION_PATH })) return;
  http.post(SESSION_PATH, async (req, reply) => {
    if (!sameToken(bearerOf(req), o.token)) return reply.code(401).send({ error: { code: 'bad_signature', message: 'Wrong or missing admin token.' } });
    return reply.header('set-cookie', sessionCookie(o)).code(204).send();
  });
  // Signing out needs no sign-in: it only clears this browser's cookie, then goes back to the page it came from.
  http.post<{ Querystring: { next?: string } }>(SIGN_OUT_PATH, async (req, reply) => {
    const next = req.query.next === '/board' ? '/board' : '/admin';
    return reply.header('set-cookie', signedOutCookie(o.secure)).code(303).header('location', next).send();
  });
}

/** The page a person sees before signing in, at `path` (/admin or /board). Its script only sends the token in a header. */
export function signInPage(title: string, path: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${title}: sign in</title>
<style>body{margin:0;background:#FFFFFF;color:#0A0A0A;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:560px;margin:0 auto;padding:48px 24px}p{color:#5F5F5F}code{background:#F7F6F3;padding:2px 6px;border-radius:6px}</style></head>
<body><main><h1>${title}</h1><p id="say">Open this page with the admin token after a #, like <code>${path}#token=...</code>.</p></main>
<script>
(function () {
  var m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!m) return;
  var say = document.getElementById('say');
  history.replaceState(null, '', location.pathname + location.search);
  say.textContent = 'Signing in...';
  fetch('${SESSION_PATH}', { method: 'POST', credentials: 'same-origin', headers: { authorization: 'Bearer ' + decodeURIComponent(m[1]) } })
    .then(function (r) {
      if (r.ok) location.reload();
      else say.textContent = 'That token was refused.';
    })
    .catch(function () { say.textContent = 'Go did not answer. Try again in a moment.'; });
})();
</script></body></html>`;
}
