/**
 * WebFetch egress screening (pure) — first half of P0's SSRF defense.
 *
 * `classifyAddress` buckets a resolved IP literal into a reachability class;
 * `assertPublicHost` resolves a URL's hostname and rejects it if ANY resolved
 * address is non-public (loopback / RFC1918 / link-local incl. the cloud
 * metadata endpoint / unique-local / unspecified / CGNAT). On success it
 * returns the first resolved IP as `pinnedIp` so the caller (Task 8) can pin
 * the connection to that exact address and close the DNS-rebind window.
 *
 * Node built-ins only — no new dependency.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import zlib from 'node:zlib';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { Readable, Transform } from 'node:stream';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unique-local'
  | 'unspecified'
  | 'multicast'
  /** IANA special-purpose: documentation, benchmarking, protocol assignments, 240/4. */
  | 'reserved'
  /** Not an IP literal at all. Never public — a screen must not guess. */
  | 'unparseable';

/**
 * Expand an IP literal to canonical bytes — 4 for IPv4, 16 for IPv6 — or null
 * if it is not one. Everything below classifies BYTES, never text.
 *
 * Text matching is what broke this screen: `::ffff:7f00:1` is 127.0.0.1 written
 * in hex, and a `startsWith('::ffff:')` + dotted-quad recursion classified it as
 * PUBLIC, so a resolved address that the OS connects straight to loopback sailed
 * through both the pre-flight and the socket-level re-check. Once an address is
 * bytes, there is one representation and the prefix tests cannot be dodged by
 * spelling.
 */
export function ipToBytes(ip: string): Uint8Array | null {
  const bare = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return v4ToBytes(bare);
  if (net.isIPv6(bare)) return v6ToBytes(bare);
  return null;
}

function v4ToBytes(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function v6ToBytes(input: string): Uint8Array | null {
  // Drop a zone id (fe80::1%en0) — it names an interface, not a different host.
  const pct = input.indexOf('%');
  let s = pct >= 0 ? input.slice(0, pct) : input;

  // A dotted-quad tail (::ffff:127.0.0.1) becomes the two hextets it encodes,
  // so the rest of this function only ever sees hextets.
  if (s.includes('.')) {
    const colon = s.lastIndexOf(':');
    if (colon < 0) return null;
    const quad = v4ToBytes(s.slice(colon + 1));
    if (!quad) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    s = `${s.slice(0, colon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null; // `::` must stand for at least one zero group
    groups = [...head, ...Array<string>(zeros).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const allZero = (b: Uint8Array, from: number, to: number): boolean => {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
};

/**
 * IPv4, by the IANA special-purpose registry. This list is a DENY list, which is
 * safe here only because the registry is finite and stable — every entry below
 * is a real assignment, not a guess.
 */
function classifyV4(b: Uint8Array): AddressClass {
  const [a, c, d] = [b[0], b[1], b[2]];
  if (a === 0) return 'unspecified';                              // 0.0.0.0/8
  if (a === 10) return 'private';                                 // 10.0.0.0/8
  if (a === 127) return 'loopback';                               // 127.0.0.0/8
  if (a === 100 && c >= 64 && c <= 127) return 'private';         // 100.64.0.0/10 CGNAT
  if (a === 169 && c === 254) return 'link-local';                // 169.254.0.0/16 (incl. metadata)
  if (a === 172 && c >= 16 && c <= 31) return 'private';          // 172.16.0.0/12
  if (a === 192 && c === 168) return 'private';                   // 192.168.0.0/16
  if (a === 192 && c === 0 && d === 0) return 'reserved';         // 192.0.0.0/24 protocol assignments
  if (a === 192 && c === 0 && d === 2) return 'reserved';         // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return 'reserved';       // 192.88.99.0/24 6to4 relay anycast
  if (a === 198 && (c === 18 || c === 19)) return 'reserved';     // 198.18.0.0/15 benchmarking
  if (a === 198 && c === 51 && d === 100) return 'reserved';      // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return 'reserved';       // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';                   // 224.0.0.0/4
  if (a >= 240) return 'reserved';                                // 240.0.0.0/4 incl. 255.255.255.255
  return 'public';
}

/**
 * Any IPv6 form that carries an IPv4 address the OS will actually dial. Returns
 * the embedded four bytes so they are classified as the IPv4 they are.
 */
function embeddedV4(b: Uint8Array): Uint8Array | null {
  // ::ffff:a.b.c.d — IPv4-mapped (RFC 4291 §2.5.5.2). This is the one that broke.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16);
  // ::a.b.c.d — IPv4-compatible. Deprecated, still routed by some stacks.
  if (allZero(b, 0, 12)) return b.slice(12, 16);
  // 64:ff9b::/96 well-known and 64:ff9b:1::/48 local-use NAT64 (RFC 6052, RFC 8215).
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (allZero(b, 4, 12)) return b.slice(12, 16);
    if (b[4] === 0x00 && b[5] === 0x01) return b.slice(12, 16);
  }
  // 2002::/16 — 6to4 carries the v4 address in the next four bytes (RFC 3056).
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

/**
 * IPv6, DEFAULT-DENY. Only global unicast (2000::/3) can be public, and the
 * special-purpose blocks inside it are carved back out. This is the inversion
 * that matters: the old code returned `public` for everything it did not
 * recognise, so every unlisted range — and every alternate spelling — was a
 * silent hole. Now an address must EARN `public`.
 */
function classifyV6(b: Uint8Array): AddressClass {
  if (allZero(b, 0, 16)) return 'unspecified';                          // ::/128
  if (allZero(b, 0, 15) && b[15] === 1) return 'loopback';              // ::1/128

  const v4 = embeddedV4(b);
  if (v4) return classifyV4(v4);

  if (b[0] === 0xff) return 'multicast';                                // ff00::/8
  if ((b[0] & 0xff) === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local';   // fe80::/10
  if ((b[0] & 0xfe) === 0xfc) return 'unique-local';                    // fc00::/7

  // Global unicast is the ONLY candidate for public.
  if ((b[0] & 0xe0) !== 0x20) return 'reserved';                        // outside 2000::/3

  if (b[0] === 0x20 && b[1] === 0x01) {
    if ((b[2] & 0xfe) === 0x00) return 'reserved';                      // 2001::/23 IETF (incl. Teredo, ORCHID)
    if (b[2] === 0x0d && b[3] === 0xb8) return 'reserved';              // 2001:db8::/32 documentation
  }
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return 'reserved'; // 3fff::/20 documentation

  return 'public';
}

/**
 * Classify an IP literal into a reachability class. Anything that is not a
 * parseable IP, and any IPv6 address outside global unicast, is non-public —
 * the screen fails closed rather than guessing.
 */
export function classifyAddress(ip: string): AddressClass {
  const bytes = ipToBytes(ip);
  if (!bytes) return 'unparseable';
  return bytes.length === 4 ? classifyV4(bytes) : classifyV6(bytes);
}

/**
 * Resolve `url`'s hostname and confirm every resolved address is public.
 * Rejects non-https schemes up front. Never throws — returns a discriminated
 * result. `pinnedIp` is the first resolved address (all were validated public).
 */
export async function assertPublicHost(
  url: string,
): Promise<{ ok: true; pinnedIp: string } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `only https is allowed (got ${u.protocol})` };

  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'DNS resolution failed' };
  }
  if (addrs.length === 0) return { ok: false, reason: 'no address' };

  for (const { address } of addrs) {
    const cls = classifyAddress(address);
    if (cls !== 'public') return { ok: false, reason: `host resolves to ${cls} address` };
  }
  return { ok: true, pinnedIp: addrs[0].address }; // pin the validated IP for the fetch (Task 8)
}

/**
 * A fetch abandoned because a SCREEN said no — the requested host, or (the case
 * that matters) a REDIRECT HOP that resolved into a private range. Typed, and
 * carrying the verdict's own `reason`, so a caller tells an SSRF refusal from a
 * transport failure with `instanceof` instead of by matching the message: the
 * server's in-house web provider maps it to a `blocked` per-URL error, which is
 * what the reconciler's security alert counts. Transport errors, timeouts, the
 * byte cap and redirect overflow stay plain `Error`s — they are not refusals.
 */
export class WebFetchBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'WebFetchBlockedError';
    this.reason = reason;
  }
}

/**
 * T5 — a fetch that ran out its per-request timeout. Typed like WebFetchBlockedError so a
 * caller tells a timeout apart with `instanceof` (WebFetch codes it `timeout`); the message is
 * the plain words it always was.
 */
export class WebFetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs / 1000}s`);
    this.name = 'WebFetchTimeoutError';
  }
}

const MAX_REDIRECTS = 5;

/**
 * Injectable seam for tests — defaults to the real `node:https.request`. A test
 * can pass a fake to (a) assert zero connections when a host is rejected and
 * (b) capture the pinned `lookup` and prove it yields the validated IP.
 */
type SafeRequestFn = (
  url: string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

/**
 * SSRF-safe text fetch — the second half of P0's defense. Every hop is screened
 * by `assertPublicHost`, and the socket is PINNED to the validated IP via a
 * custom `lookup` so a second DNS resolution cannot rebind the connection to a
 * private/metadata address (TLS SNI + Host stay the hostname). Redirects are
 * walked manually so each target is re-screened at the top of the loop. Enforces
 * a byte cap (destroying the response once exceeded) and a per-request timeout.
 * Throws on a blocked host, redirect overflow, timeout, or transport error —
 * the caller turns that into a model-readable `WebFetch error: …` string.
 */
export async function safeFetchText(
  url: string,
  // `signal` (L1): the calling tool's own; it aborts the request in flight and stops a redirect walk.
  opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
  requestFn: SafeRequestFn = https.request as SafeRequestFn,
): Promise<{ text: string; contentType: string }> {
  let current = url;
  let hops = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    const guard = await assertPublicHost(current);
    if (!guard.ok) throw new WebFetchBlockedError(guard.reason); // every hop, not just the first

    const u = new URL(current);
    const family = net.isIPv6(guard.pinnedIp) ? 6 : 4;
    // Pin to the validated IP. Handle both LookupFunction shapes: net.Socket may
    // call (host, cb) or (host, options, cb), and with autoSelectFamily the
    // `all` variant expects an address array. Never re-resolves DNS.
    const pinnedLookup = (
      _hostname: string,
      optionsOrCb: { all?: boolean } | ((err: Error | null, ...rest: unknown[]) => void),
      maybeCb?: (err: Error | null, ...rest: unknown[]) => void,
    ): void => {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb!;
      const all = typeof optionsOrCb === 'object' && optionsOrCb?.all === true;
      if (all) cb(null, [{ address: guard.pinnedIp, family }]);
      else cb(null, guard.pinnedIp, family);
    };

    const requestOptions: RequestOptions = {
      method: 'GET',
      servername: u.hostname, // TLS SNI stays the hostname
      // Ask compliant servers not to compress: node:https (unlike the OFF path's
      // undici/global fetch) does NOT auto-decompress. Belt to the suspenders below.
      headers: { 'User-Agent': 'Vestra-Agent/1.0 (+https://vestra.ai)', Host: u.host, 'Accept-Encoding': 'identity' },
      timeout: opts.timeoutMs,
      ...(opts.signal !== undefined && { signal: opts.signal }),
      lookup: pinnedLookup as unknown as RequestOptions['lookup'],
    };

    const res = await new Promise<{ status: number; location: string | undefined; contentType: string; body: string }>((resolve, reject) => {
      const req = requestFn(current, requestOptions, (r: IncomingMessage) => {
        const status = r.statusCode ?? 0;
        const location = typeof r.headers.location === 'string' ? r.headers.location : undefined;
        const contentType = typeof r.headers['content-type'] === 'string' ? r.headers['content-type'] : '';
        // Defensive decode: a server/CDN may compress despite Accept-Encoding: identity.
        // For a KNOWN content-encoding, read the DECODED stream; an unknown/absent
        // encoding falls through as raw bytes (never throw on encoding alone).
        const enc = typeof r.headers['content-encoding'] === 'string' ? r.headers['content-encoding'].toLowerCase().trim() : '';
        let decompressor: Transform | undefined;
        if (enc === 'gzip') decompressor = zlib.createGunzip();
        else if (enc === 'deflate') decompressor = zlib.createInflate();
        else if (enc === 'br') decompressor = zlib.createBrotliDecompress();
        let stream: Readable = r;
        if (decompressor) {
          r.on('error', (e: Error) => decompressor!.destroy(e)); // propagate transport errors into the decode stream
          r.pipe(decompressor);
          stream = decompressor;
        }
        let buf = '';
        let bytes = 0;
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve({ status, location, contentType, body: buf }); } };
        stream.on('data', (c: Buffer) => {
          if (settled) return;
          bytes += c.length;
          // Cap the DECODED stream. Unlike the OFF path (which errors "too large"),
          // the ON path silently keeps the head — both clip to MAX_TEXT downstream,
          // so returning the truncated head is acceptable.
          if (bytes > opts.maxBytes) { finish(); r.destroy(); decompressor?.destroy(); return; }
          buf += c.toString('utf8');
        });
        stream.on('end', finish);
        stream.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
      });
      req.on('timeout', () => req.destroy(new WebFetchTimeoutError(opts.timeoutMs)));
      req.on('error', reject);
      req.end();
    });

    if (res.status >= 300 && res.status < 400 && res.location) {
      if (++hops > MAX_REDIRECTS) throw new Error('too many redirects');
      current = new URL(res.location, current).toString(); // re-screened at the loop top
      continue;
    }
    return { text: res.body, contentType: res.contentType };
  }
}
