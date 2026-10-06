// The passcode gate in front of the try room. The first visit shows one passcode field. The right passcode, compared
// in constant time, gets an HttpOnly, Secure, SameSite=Strict cookie that names the visit, good for 12 hours, signed
// with a key made from TRY_PASSCODE and the random TRY_COOKIE_SALT: without the salt, a cookie that leaks cannot be
// used to test passcode guesses offline. Every page, request and socket checks it. After 5 wrong tries in a minute
// from one address, its wrong tries are held for a moment, and in a flood of wrong tries they are turned away at once;
// the right passcode always gets in. GO_SIGNING_SECRET is not used here: it stays in the Server's socket to Go.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

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

  constructor(private readonly passcode: string, salt: string, private readonly now: () => Date = () => new Date()) {
    // A new passcode or a new salt signs every visitor out.
    this.key = Buffer.from(hkdfSync('sha256', passcode, salt, 'go-try-room visit cookie', 32));
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

/** How the room answers a wrong passcode: at once (401), after a wait (429), or at once in a flood (429). */
export type WrongVerdict = 'wrong' | 'slow' | 'flood';

/**
 * Wrong passcode tries. After 5 in a minute from one address, that address's wrong tries are slowed until the oldest is
 * a minute old. It keeps at most `maxAddresses` addresses and the last 5 tries of each, dropping the address that went
 * wrong longest ago first, in constant time, and prune() clears the stale ones on a timer. Over `perSecond` wrong tries
 * a second across every address (a flood), a wrong try is turned away at once and not remembered. The right passcode
 * never comes here: it always gets in.
 */
export class WrongTries {
  /** In the order each address last went wrong, oldest first. */
  private readonly tries = new Map<string, number[]>();
  private second = 0;
  private inSecond = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly max = WRONG_TRIES_PER_MINUTE,
    private readonly windowMs = 60_000,
    private readonly maxAddresses = 10_000,
    private readonly perSecond = 30,
  ) {}

  /** Counts one wrong try from `address` and says how to answer it. */
  wrong(address: string): WrongVerdict {
    const t = this.now().getTime();
    const second = Math.floor(t / 1000);
    if (second !== this.second) {
      this.second = second;
      this.inSecond = 0;
    }
    this.inSecond += 1;
    if (this.inSecond > this.perSecond) return 'flood';
    const recent = this.recent(address, t);
    const slowed = recent.length >= this.max;
    recent.push(t);
    if (recent.length > this.max) recent.shift();
    this.tries.delete(address); // set again below, so it moves to the newest end
    this.tries.set(address, recent);
    if (this.tries.size > this.maxAddresses) {
      const oldest = this.tries.keys().next().value;
      if (oldest !== undefined) this.tries.delete(oldest);
    }
    return slowed ? 'slow' : 'wrong';
  }

  /** Whether the address's wrong tries are being slowed now. */
  blocked(address: string): boolean {
    return this.recent(address, this.now().getTime()).length >= this.max;
  }

  /** Drops every address with no wrong try in the last minute. */
  prune(): void {
    const since = this.now().getTime() - this.windowMs;
    for (const [address, times] of this.tries) if (!times.some((t) => t > since)) this.tries.delete(address);
  }

  /** How many addresses it holds. */
  get size(): number {
    return this.tries.size;
  }

  private recent(address: string, t: number): number[] {
    return (this.tries.get(address) ?? []).filter((x) => x > t - this.windowMs);
  }
}

/**
 * The visitor's address, for the wrong-try limit, and where it came from. Behind Railway's proxy (trustProxy) it is
 * x-real-ip, which Railway's edge sets to the visitor's address, when that is an IP address; anything else is never used
 * as a key, and the socket's own address is used instead. x-forwarded-for is never used: a visitor can write it.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): { address: string; source: 'x-real-ip' | 'socket' } {
  if (trustProxy) {
    const realIp = req.headers['x-real-ip'];
    const real = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim() ?? '';
    if (isIP(real) !== 0) return { address: real, source: 'x-real-ip' };
  }
  return { address: req.socket.remoteAddress ?? 'unknown', source: 'socket' };
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
