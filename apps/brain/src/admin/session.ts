// The one way in to the operator's pages (the admin page, and the proof board), with ADMIN_TOKEN never in a URL the
// server sees or logs. A person opens /admin#token=<ADMIN_TOKEN>: the browser never sends the part after #. The sign-in
// page reads it, drops it from the address bar, sends it once as a bearer to POST /admin/session, gets an HttpOnly
// cookie back and loads the clean URL. Scripts and the bench send the token as a bearer on every call.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'go_admin';
export const SESSION_PATH = '/admin/session';
/** A stage day: the operator signs in again the next morning. */
export const SESSION_SECONDS = 12 * 60 * 60;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Equal tokens, compared in constant time. */
export function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** What the cookie holds: derived from the token, so the cookie is never the token itself. */
export function sessionValue(token: string): string {
  return createHash('sha256').update(`go-admin-session:${token}`).digest('base64url');
}

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export function bearerOf(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

/** A bearer, or the session cookie. Never ?token=: a token in a URL ends up in logs and in the browser's history. */
export function signedIn(req: FastifyRequest, token: string): boolean {
  if (sameToken(bearerOf(req), token)) return true;
  return sameToken(cookieOf(req, SESSION_COOKIE), sessionValue(token));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionValue(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

/**
 * POST /admin/session: the sign-in page's one call, the token as a bearer swapped for the cookie. The admin page and the
 * board both call this; the first one registers the route, so either works without the other.
 */
export function registerSessionRoute(http: FastifyInstance, token: string, secure: boolean): void {
  if (http.hasRoute({ method: 'POST', url: SESSION_PATH })) return;
  http.post(SESSION_PATH, async (req, reply) => {
    if (!sameToken(bearerOf(req), token)) return reply.code(401).send({ error: { code: 'bad_signature', message: 'Wrong or missing admin token.' } });
    return reply.header('set-cookie', sessionCookie(token, secure)).code(204).send();
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
