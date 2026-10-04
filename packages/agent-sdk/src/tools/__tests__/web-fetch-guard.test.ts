import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { classifyAddress, ipToBytes, assertPublicHost, safeFetchText } from '../web-fetch-guard.js';

afterEach(() => vi.restoreAllMocks());

describe('classifyAddress', () => {
  it('classifies non-public ranges', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('172.16.0.9')).toBe('private');
    expect(classifyAddress('192.168.1.5')).toBe('private');
    expect(classifyAddress('169.254.169.254')).toBe('link-local'); // covers the metadata endpoint
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('fd00::1')).toBe('unique-local');
  });
  it('classifies a real public address as public', () => { expect(classifyAddress('93.184.216.34')).toBe('public'); });

  it('covers the remaining non-public ranges precisely', () => {
    expect(classifyAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyAddress('::')).toBe('unspecified');
    expect(classifyAddress('172.15.0.1')).toBe('public');   // just below the /12
    expect(classifyAddress('172.32.0.1')).toBe('public');   // just above the /12
    expect(classifyAddress('100.64.0.1')).toBe('private');  // CGNAT 100.64.0.0/10
    expect(classifyAddress('100.128.0.1')).toBe('public');  // just above CGNAT
    expect(classifyAddress('fe80::1')).toBe('link-local');
    expect(classifyAddress('febf::1')).toBe('link-local');  // top of fe80::/10 — missed by a prefix check
    expect(classifyAddress('fcff::1')).toBe('unique-local'); // fc00::/7
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local'); // IPv4-mapped, dotted form
  });

  // ── the gap this rewrite closes ──────────────────────────────────────────
  /**
   * `::ffff:7f00:1` IS 127.0.0.1 — the same IPv4-mapped address written with the
   * last four bytes as hextets instead of a dotted quad. The old classifier
   * stripped the `::ffff:` prefix as TEXT and recursed; what was left was not
   * dotted-quad, so it fell through to the IPv6 branch, matched neither
   * fe80::/10 nor fc00::/7, and came back `public`. Both the pre-flight and the
   * socket-level re-check used that same classifier, so the belt and the braces
   * had the identical hole and a connection to loopback went through.
   */
  it('classifies hexadecimal IPv4-mapped IPv6 by the address the OS actually dials', () => {
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback');       // 127.0.0.1
    expect(classifyAddress('::ffff:a00:1')).toBe('private');         // 10.0.0.1
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('link-local');  // 169.254.169.254 metadata
    expect(classifyAddress('::ffff:c0a8:1')).toBe('private');        // 192.168.0.1
    expect(classifyAddress('::ffff:6440:1')).toBe('private');        // 100.64.0.1 CGNAT
    // Same address, every spelling anyone would try — one answer.
    for (const spelling of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001',
                            '0:0:0:0:0:ffff:7f00:1', '[::ffff:7f00:1]']) {
      expect(classifyAddress(spelling)).toBe('loopback');
    }
  });

  it('classifies the other IPv6 forms that carry an IPv4 address', () => {
    expect(classifyAddress('::7f00:1')).toBe('loopback');            // IPv4-compatible (deprecated)
    expect(classifyAddress('64:ff9b::7f00:1')).toBe('loopback');     // NAT64 well-known prefix
    expect(classifyAddress('64:ff9b::a9fe:a9fe')).toBe('link-local');// NAT64 → metadata
    expect(classifyAddress('64:ff9b:1::7f00:1')).toBe('loopback');   // NAT64 local-use
    expect(classifyAddress('2002:7f00:1::')).toBe('loopback');       // 6to4 → 127.0.0.1
    expect(classifyAddress('2002:a9fe:a9fe::')).toBe('link-local');  // 6to4 → metadata
  });

  /**
   * DEFAULT-DENY is the actual fix. The old rule was "anything not recognised is
   * public", so every unlisted range was a silent hole that only a future
   * reviewer could find. Now only global unicast (2000::/3) can be public and
   * the special-purpose blocks inside it are carved back out.
   */
  it('refuses every IPv6 range outside global unicast', () => {
    expect(classifyAddress('ff02::1')).toBe('multicast');            // all-nodes multicast
    expect(classifyAddress('ff00::')).toBe('multicast');
    expect(classifyAddress('100::1')).toBe('reserved');              // 100::/64 discard-only
    expect(classifyAddress('4000::1')).toBe('reserved');             // unassigned
    expect(classifyAddress('5f00::1')).toBe('reserved');             // SRv6 SIDs (RFC 9602)
    expect(classifyAddress('2001:db8::1')).toBe('reserved');         // documentation
    expect(classifyAddress('2001::1')).toBe('reserved');             // Teredo, inside 2001::/23
    expect(classifyAddress('3fff::1')).toBe('reserved');             // documentation (RFC 9637)
    // fec0::/10 site-local: deprecated, but it named an INTERNAL network and the
    // old default-allow rule called it public. It is not.
    expect(classifyAddress('fec0::1')).toBe('reserved');
  });

  it('still lets real public IPv6 through', () => {
    expect(classifyAddress('2001:4860:4860::8888')).toBe('public');  // Google DNS
    expect(classifyAddress('2606:4700:4700::1111')).toBe('public');  // Cloudflare DNS
    expect(classifyAddress('2620:fe::fe')).toBe('public');           // Quad9
    expect(classifyAddress('2000::1')).toBe('public');               // bottom of 2000::/3
    expect(classifyAddress('3ffe::1')).toBe('public');               // inside 2000::/3
  });

  it('covers the IPv4 special-purpose ranges an SSRF screen must not miss', () => {
    expect(classifyAddress('192.0.0.1')).toBe('reserved');           // protocol assignments
    expect(classifyAddress('192.0.2.1')).toBe('reserved');           // TEST-NET-1
    expect(classifyAddress('192.88.99.1')).toBe('reserved');         // 6to4 relay anycast
    expect(classifyAddress('198.18.0.1')).toBe('reserved');          // benchmarking
    expect(classifyAddress('198.19.255.255')).toBe('reserved');      // top of the /15
    expect(classifyAddress('198.51.100.1')).toBe('reserved');        // TEST-NET-2
    expect(classifyAddress('203.0.113.1')).toBe('reserved');         // TEST-NET-3
    expect(classifyAddress('224.0.0.1')).toBe('multicast');
    expect(classifyAddress('239.255.255.255')).toBe('multicast');    // top of 224/4
    expect(classifyAddress('240.0.0.1')).toBe('reserved');
    expect(classifyAddress('255.255.255.255')).toBe('reserved');     // broadcast
    expect(classifyAddress('198.20.0.1')).toBe('public');            // just above benchmarking
    expect(classifyAddress('223.255.255.255')).toBe('public');       // just below multicast
  });

  it('refuses anything that is not an IP literal, rather than guessing public', () => {
    for (const junk of ['', 'example.com', 'localhost', 'not-an-ip', '999.1.1.1',
                        '1.2.3', '1.2.3.4.5', '::gggg', ':::1', '12345']) {
      expect(classifyAddress(junk)).toBe('unparseable');
    }
  });
});

describe('ipToBytes', () => {
  it('expands every spelling of one address to the same canonical bytes', () => {
    const hex = (b: Uint8Array | null) => b && Buffer.from(b).toString('hex');
    expect(hex(ipToBytes('127.0.0.1'))).toBe('7f000001');
    for (const s of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001']) {
      expect(hex(ipToBytes(s))).toBe('00000000000000000000ffff7f000001');
    }
    expect(hex(ipToBytes('::1'))).toBe('00000000000000000000000000000001');
    expect(hex(ipToBytes('fe80::1%en0'))).toBe('fe800000000000000000000000000001'); // zone id dropped
  });
  it('returns null for anything that is not an IP', () => {
    for (const junk of ['example.com', '', '1.2.3', '::gggg', '1:2:3:4:5:6:7:8:9']) {
      expect(ipToBytes(junk)).toBeNull();
    }
  });
});

describe('assertPublicHost', () => {
  it('rejects a non-https scheme', async () => {
    expect(await assertPublicHost('ftp://example.com')).toMatchObject({ ok: false });
  });
  it('rejects when the hostname resolves into a blocked range', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    expect(await assertPublicHost('https://metadata.example')).toMatchObject({ ok: false });
  });
  it('accepts a public host and returns the pinned IP', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    expect(await assertPublicHost('https://example.com')).toEqual({ ok: true, pinnedIp: '93.184.216.34' });
  });
});

// A minimal fake of node:https.request. `capture` receives the (url, options)
// the SUT passed — so a test can grab the pinned `lookup` and prove pinning.
type FakeSpec = { status: number; headers?: Record<string, string>; chunks?: string[] };
function fakeRequestFn(spec: FakeSpec, capture?: (url: string, options: Record<string, unknown>) => void) {
  return (url: string, options: Record<string, unknown>, cb: (res: unknown) => void) => {
    capture?.(url, options);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      res.statusCode = spec.status;
      res.headers = spec.headers ?? {};
      res.destroy = () => {};
      cb(res);
      queueMicrotask(() => {
        for (const ch of spec.chunks ?? []) res.emit('data', Buffer.from(ch, 'utf8'));
        res.emit('end');
      });
    };
    return req;
  };
}

describe('safeFetchText — SSRF-safe fetch', () => {
  it('rejects before connecting when the host resolves to a private address', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    const requestFn = vi.fn();
    await expect(
      safeFetchText('https://internal.example', { maxBytes: 1000, timeoutMs: 1000 }, requestFn as never),
    ).rejects.toThrow(/private/);
    expect(requestFn).not.toHaveBeenCalled(); // no connection was ever attempted
  });

  it('pins the socket to the validated IP so a DNS rebind cannot redirect the connection', async () => {
    vi.spyOn(dns.promises, 'lookup')
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never) // validation → public
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never); // rebind → metadata
    let capturedLookup: ((h: string, o: unknown, cb: (e: unknown, a: unknown, f: unknown) => void) => void) | undefined;
    const requestFn = fakeRequestFn(
      { status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['OK'] },
      (_url, options) => { capturedLookup = options.lookup as typeof capturedLookup; },
    );
    const result = await safeFetchText('https://rebind.example', { maxBytes: 1000, timeoutMs: 1000 }, requestFn as never);
    expect(result).toEqual({ text: 'OK', contentType: 'text/plain' });
    // The pinned lookup must yield the FIRST (validated, public) IP — never
    // re-resolving to the rebind/metadata address DNS now hands out.
    const pinned = await new Promise<{ err: unknown; addr: unknown; fam: unknown }>((res) =>
      capturedLookup!('rebind.example', {}, (err, addr, fam) => res({ err, addr, fam })),
    );
    expect(pinned).toEqual({ err: null, addr: '93.184.216.34', fam: 4 });
  });

  it('re-screens every redirect hop — a 302 to a private host is blocked, not followed', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) =>
      host === 'start.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.7', family: 4 }]) as never);
    const requestFn = vi.fn(fakeRequestFn({ status: 302, headers: { location: 'https://evil.example/x' } }));
    await expect(
      safeFetchText('https://start.example', { maxBytes: 1000, timeoutMs: 1000 }, requestFn as never),
    ).rejects.toThrow(/private/);
    expect(requestFn).toHaveBeenCalledTimes(1); // only hop 0 dialed; the private redirect target was never fetched
  });

  it('caps the body at maxBytes and returns the truncated content', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const requestFn = fakeRequestFn({ status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['a'.repeat(600), 'b'.repeat(600)] });
    const result = await safeFetchText('https://big.example', { maxBytes: 1000, timeoutMs: 1000 }, requestFn as never);
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text).toBe('a'.repeat(600)); // second chunk crosses the cap → dropped
  });

  it('decompresses a gzip response body (node:https, unlike the OFF path, does not auto-decompress)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const body = 'hello from a server that gzips regardless of Accept-Encoding '.repeat(4);
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
    // Emit the compressed bytes with content-encoding: gzip through a real
    // Readable so the SUT can pipe it into node:zlib. Without decoding, the raw
    // gzip bytes .toString('utf8') would be garbage.
    const requestFn = (_url: string, _options: Record<string, unknown>, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => {
        const res = Readable.from([gz], { objectMode: false }) as Readable & { statusCode: number; headers: Record<string, string> };
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/plain', 'content-encoding': 'gzip' };
        cb(res);
      };
      return req;
    };
    const result = await safeFetchText('https://gz.example', { maxBytes: 100_000, timeoutMs: 1000 }, requestFn as never);
    expect(result.contentType).toBe('text/plain');
    expect(result.text).toBe(body);
  });
});
