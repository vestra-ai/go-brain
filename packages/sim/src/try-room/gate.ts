// The passcode gate in front of the try room. The first visit shows one passcode field. The right passcode, compared
// in constant time, gets an HttpOnly, Secure, SameSite=Strict cookie that names the visit, signed with a key made from
// TRY_PASSCODE and good for 12 hours. Every page, request and socket checks it. Wrong tries are held to 5 a minute
// for each address. GO_SIGNING_SECRET is not used here: it stays in the Server's socket to Go.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_SECONDS = 12 * 60 * 60;
/** __Host-: only this host can set it, on Path=/, Secure, so nothing else can plant one. */
export const COOKIE_NAME = '__Host-go_try';
export const WRONG_TRIES_PER_MINUTE = 5;

/** The admin page's headers (apps/brain/src/admin/session.ts): never cached, never framed, never indexed, no referrer. */
export const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * The Content-Security-Policy: nothing runs but the page's own script (by its nonce; a page without one runs no script),
 * nothing connects but the live socket back to this host, and nobody can frame it. Inline styles are allowed: the room
 * draws avatars and vote bars with them.
 */
export function contentSecurityPolicy(nonce: string | null, host: string | undefined): string {
  const live = host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? ` wss://${host} ws://${host}` : '';
  return [
    "default-src 'none'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src https: data:',
    `connect-src 'self'${live}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Every value sent under exactly this cookie name: a browser may send more than one. */
function cookiesNamed(header: string | undefined, name: string): string[] {
  if (typeof header !== 'string') return [];
  return header.split(';').flatMap((part) => {
    const at = part.indexOf('=');
    return at > 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
  });
}

export class Gate {
  private readonly key: Buffer;

  constructor(private readonly passcode: string, private readonly now: () => Date = () => new Date()) {
    // The cookie key is made from the passcode, so a new passcode signs every visitor out.
    this.key = Buffer.from(hkdfSync('sha256', passcode, 'go-try-room', 'visit cookie', 32));
  }

  /** The passcode, compared in constant time. */
  matches(given: string): boolean {
    return timingSafeEqual(digest(given), digest(this.passcode));
  }

  /** A new visit: its id, and the Set-Cookie header that carries it. */
  newVisit(): { visit: string; setCookie: string } {
    const visit = randomBytes(12).toString('base64url');
    const at = Math.floor(this.now().getTime() / 1000);
    const value = `${visit}.${at}.${this.mac(visit, at)}`;
    return { visit, setCookie: `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}` };
  }

  /** The visit a request belongs to, and when its cookie runs out (ms): a cookie this gate signed less than 12 hours ago. Null for anything else. */
  visit(req: IncomingMessage): { id: string; endsAt: number } | null {
    for (const value of cookiesNamed(req.headers.cookie, COOKIE_NAME)) {
      const [visit, atText, mac, ...rest] = value.split('.');
      if (!visit || !atText || !mac || rest.length > 0) continue;
      const at = Number(atText);
      if (!Number.isInteger(at)) continue;
      const age = this.now().getTime() / 1000 - at;
      if (age < -60 || age > SESSION_SECONDS) continue;
      const want = Buffer.from(this.mac(visit, at));
      const got = Buffer.from(mac);
      if (got.length === want.length && timingSafeEqual(got, want)) return { id: visit, endsAt: (at + SESSION_SECONDS) * 1000 };
    }
    return null;
  }

  private mac(visit: string, at: number): string {
    return createHmac('sha256', this.key).update(`go-try-visit:${visit}:${at}`).digest('base64url');
  }
}

/** Wrong passcode tries for each address: after 5 in a minute, every try waits until the oldest is a minute old. */
export class WrongTries {
  private readonly tries = new Map<string, number[]>();

  constructor(private readonly now: () => Date = () => new Date(), private readonly max = WRONG_TRIES_PER_MINUTE, private readonly windowMs = 60_000) {}

  blocked(address: string): boolean {
    return this.recent(address).length >= this.max;
  }

  wrong(address: string): void {
    const recent = this.recent(address);
    recent.push(this.now().getTime());
    this.tries.set(address, recent);
    if (this.tries.size > 10_000) for (const a of [...this.tries.keys()]) this.recent(a); // drops addresses with nothing recent
  }

  private recent(address: string): number[] {
    const since = this.now().getTime() - this.windowMs;
    const recent = (this.tries.get(address) ?? []).filter((t) => t > since);
    if (recent.length > 0) this.tries.set(address, recent);
    else this.tries.delete(address);
    return recent;
  }
}

/**
 * The visitor's address. Behind Railway's proxy (trustProxy) it is the last address in x-forwarded-for, the one the
 * proxy added; anything before it came from the visitor and could be made up.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const list = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
    const last = list[list.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page before the room: one passcode field. It runs no script. */
export function passcodePage(say?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Try Go</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #e9ecf1; color: #0f172a; font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 400px; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px 24px; }
.go { width: 48px; height: 48px; border-radius: 50%; background: #38bdf8; color: #fff; display: grid; place-items: center; font-weight: 700; margin-bottom: 12px; }
h1 { font-size: 22px; margin: 0 0 6px; }
p { color: #475569; margin: 0 0 18px; }
label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
input { width: 100%; font: inherit; font-size: 16px; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 10px 12px; }
button { width: 100%; margin-top: 12px; font: inherit; min-height: 44px; border: 0; border-radius: 12px; background: #0f172a; color: #fff; cursor: pointer; }
.say { color: #b45309; margin: 14px 0 0; }
</style>
</head>
<body>
<main>
<div class="go">Go</div>
<h1>Try Go</h1>
<p>Go is an AI member of a group trip chat. Enter the passcode you were given to open a room where five friends plan a long weekend in Goa.</p>
<form method="post" action="/enter">
<label for="passcode">Passcode</label>
<input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open the room</button>
</form>
${say ? `<p class="say" role="alert">${esc(say)}</p>` : ''}
</main>
</body>
</html>`;
}
