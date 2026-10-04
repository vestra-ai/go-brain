import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureGeminiFileUri,
  rewriteUploadUrl,
  GeminiFileError,
  GEMINI_UPLOAD_CHUNK_BYTES,
  GEMINI_FILE_POLL_MS,
  GEMINI_FILE_POLL_CAP_MS,
  GEMINI_FILE_STALE_MARGIN_MS,
  GEMINI_UPLOAD_START_TIMEOUT_MS,
  GEMINI_UPLOAD_CHUNK_TIMEOUT_MS,
  type GeminiFileRef,
  type GeminiFilesDeps,
  type MediaSource,
} from '../gemini-files.js';

const BASE = 'https://proxy.test/api/proxy/google';
const AUTH_TOKEN = 'Bearer tok-SECRET-never-log-me';
const GOOGLE_SESSION =
  'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=SESSION-abc&upload_protocol=resumable';
const PROXIED_SESSION =
  'https://proxy.test/api/proxy/google/upload/v1beta/files?upload_id=SESSION-abc&upload_protocol=resumable';
const FILE_NAME = 'files/abc123';
const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
const EXPIRES = '2026-09-06T12:00:00.000Z';
const T0 = Date.parse('2026-09-04T12:00:00.000Z');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyLen: number;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fake = (async (input: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    const body = init?.body;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      ...(typeof body === 'string' ? { bodyText: body } : {}),
      bodyLen:
        typeof body === 'string'
          ? Buffer.byteLength(body)
          : body instanceof Uint8Array
            ? body.byteLength
            : 0,
    };
    calls.push(call);
    return await respond(call);
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

/** The happy upstream: start → chunks → finalize → poll. */
function upstream(opts: { finalState?: string; pollStates?: string[] } = {}) {
  const finalState = opts.finalState ?? 'ACTIVE';
  const pollStates = opts.pollStates ?? ['ACTIVE'];
  let polled = 0;
  return (call: Call): Response => {
    if (call.method === 'POST') {
      return new Response(null, { status: 200, headers: { 'x-goog-upload-url': GOOGLE_SESSION } });
    }
    if (call.method === 'PUT') {
      if (!(call.headers['x-goog-upload-command'] ?? '').includes('finalize')) {
        return new Response('', { status: 200 });
      }
      return json({
        file: {
          name: FILE_NAME,
          uri: FILE_URI,
          mimeType: 'video/mp4',
          state: finalState,
          expirationTime: EXPIRES,
        },
      });
    }
    const state = pollStates[Math.min(polled++, pollStates.length - 1)]!;
    return json({
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      state,
      expirationTime: EXPIRES,
    });
  };
}

let cacheDir = '';
let nowMs = T0;
let slept: number[] = [];
let chunkRanges: Array<[number, number]> = [];
let logs: string[] = [];

function source(over: Partial<MediaSource> = {}): MediaSource {
  return {
    path: '/w/files/clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 8,
    sha: 'sha-of-clip',
    displayName: 'clip.mp4',
    ...over,
  };
}

function deps(fetchImpl: typeof fetch, over: Partial<GeminiFilesDeps> = {}): GeminiFilesDeps {
  return {
    baseUrl: BASE,
    headers: () => ({ authorization: AUTH_TOKEN }),
    cacheDir,
    fetch: fetchImpl,
    now: () => nowMs,
    sleep: async (ms: number) => {
      slept.push(ms);
      nowMs += ms;
    },
    openChunk: async (_path: string, start: number, end: number) => {
      chunkRanges.push([start, end]);
      return new Uint8Array(end - start);
    },
    ...over,
  };
}

async function seedCache(sha: string, ref: GeminiFileRef): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, `${sha}.json`), JSON.stringify(ref));
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'gemini-files-'));
  nowMs = T0;
  slept = [];
  chunkRanges = [];
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cacheDir, { recursive: true, force: true });
});

describe('rewriteUploadUrl', () => {
  it('keeps the path and query and swaps only the origin, so every chunk rides the proxy', () => {
    expect(rewriteUploadUrl(GOOGLE_SESSION, BASE)).toBe(PROXIED_SESSION);
    expect(rewriteUploadUrl(GOOGLE_SESSION, `${BASE}/`)).toBe(PROXIED_SESSION);
  });
});

describe('ensureGeminiFileUri', () => {
  it('returns a fresh cache entry with ZERO fetches', async () => {
    const ref: GeminiFileRef = {
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      expiresAt: new Date(nowMs + 47 * 3600 * 1000).toISOString(),
      sizeBytes: 8,
    };
    await seedCache('sha-of-clip', ref);
    const { fetch: f, calls } = makeFetch(upstream());
    expect(await ensureGeminiFileUri(source(), deps(f))).toEqual(ref);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toContain('[gemini-files] cache hit');
  });

  it('re-uploads an entry AT the 1h stale margin and keeps one a millisecond past it', async () => {
    // The margin is strict: an entry that expires in exactly an hour is not fresh enough
    // to survive a long turn, so it is re-uploaded rather than handed to the model.
    await seedCache('sha-stale', {
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      expiresAt: new Date(nowMs + GEMINI_FILE_STALE_MARGIN_MS).toISOString(),
      sizeBytes: 8,
    });
    const stale = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sha: 'sha-stale' }), deps(stale.fetch));
    expect(stale.calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    await seedCache('sha-fresh', {
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      expiresAt: new Date(nowMs + GEMINI_FILE_STALE_MARGIN_MS + 1).toISOString(),
      sizeBytes: 8,
    });
    const fresh = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sha: 'sha-fresh' }), deps(fresh.fetch));
    expect(fresh.calls).toHaveLength(0);
  });

  it('starts the resumable session with the four X-Goog-Upload headers and the display name', async () => {
    const { fetch: f, calls } = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sizeBytes: 73400320 }), deps(f));
    const start = calls[0]!;
    expect(start.url).toBe(`${BASE}/upload/v1beta/files`);
    expect(start.method).toBe('POST');
    expect(start.headers['x-goog-upload-protocol']).toBe('resumable');
    expect(start.headers['x-goog-upload-command']).toBe('start');
    expect(start.headers['x-goog-upload-header-content-length']).toBe('73400320');
    expect(start.headers['x-goog-upload-header-content-type']).toBe('video/mp4');
    expect(start.headers['content-type']).toBe('application/json');
    expect(start.headers.authorization).toBe(AUTH_TOKEN);
    expect(JSON.parse(start.bodyText!)).toEqual({ file: { display_name: 'clip.mp4' } });
    // Google hands back a session url on ITS host; every chunk must ride the proxy instead.
    expect(calls[1]!.url).toBe(PROXIED_SESSION);
  });

  it('cuts a 70 MiB file into 32 MiB chunks at exact offsets and finalizes on the last', async () => {
    const size = 70 * 1024 * 1024;
    const { fetch: f, calls } = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sizeBytes: size }), deps(f));

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.headers['x-goog-upload-offset'])).toEqual([
      '0',
      String(GEMINI_UPLOAD_CHUNK_BYTES),
      String(2 * GEMINI_UPLOAD_CHUNK_BYTES),
    ]);
    expect(puts.map((c) => c.headers['x-goog-upload-command'])).toEqual([
      'upload',
      'upload',
      'upload, finalize',
    ]);
    expect(puts.map((c) => c.headers['content-type'])).toEqual([
      'application/octet-stream',
      'application/octet-stream',
      'application/octet-stream',
    ]);
    expect(puts.map((c) => c.bodyLen)).toEqual([
      GEMINI_UPLOAD_CHUNK_BYTES,
      GEMINI_UPLOAD_CHUNK_BYTES,
      6 * 1024 * 1024,
    ]);
    // Every byte exactly once: the read ranges tile [0, size) with no gap and no overlap.
    expect(chunkRanges).toEqual([
      [0, GEMINI_UPLOAD_CHUNK_BYTES],
      [GEMINI_UPLOAD_CHUNK_BYTES, 2 * GEMINI_UPLOAD_CHUNK_BYTES],
      [2 * GEMINI_UPLOAD_CHUNK_BYTES, size],
    ]);
    expect(puts.reduce((n, c) => n + c.bodyLen, 0)).toBe(size);
  });

  it('sends a file that is an exact multiple of the chunk size without a trailing empty PUT', async () => {
    const size = 2 * GEMINI_UPLOAD_CHUNK_BYTES;
    const { fetch: f, calls } = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sizeBytes: size }), deps(f));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]!.headers['x-goog-upload-command']).toBe('upload, finalize');
    expect(puts[1]!.bodyLen).toBe(GEMINI_UPLOAD_CHUNK_BYTES);
  });

  it('finalizes a 0-byte file in exactly one PUT', async () => {
    const { fetch: f, calls } = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sizeBytes: 0 }), deps(f));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.headers['x-goog-upload-command']).toBe('upload, finalize');
    expect(puts[0]!.headers['x-goog-upload-offset']).toBe('0');
    expect(chunkRanges).toEqual([[0, 0]]);
  });

  it('polls every 2s until ACTIVE, then writes the cache entry', async () => {
    const { fetch: f, calls } = makeFetch(
      upstream({ finalState: 'PROCESSING', pollStates: ['PROCESSING', 'ACTIVE'] }),
    );
    const ref = await ensureGeminiFileUri(source(), deps(f));

    const polls = calls.filter((c) => c.method === 'GET');
    expect(polls.map((c) => c.url)).toEqual([`${BASE}/v1beta/${FILE_NAME}`, `${BASE}/v1beta/${FILE_NAME}`]);
    expect(polls[0]!.headers.authorization).toBe(AUTH_TOKEN);
    expect(slept).toEqual([GEMINI_FILE_POLL_MS, GEMINI_FILE_POLL_MS]);
    expect(ref).toEqual({
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      expiresAt: EXPIRES,
      sizeBytes: 8,
    });
    expect(JSON.parse(await readFile(join(cacheDir, 'sha-of-clip.json'), 'utf8'))).toEqual(ref);
  });

  it('reads snake_case file fields too', async () => {
    const { fetch: f } = makeFetch((call) => {
      if (call.method === 'POST')
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': GOOGLE_SESSION } });
      return json({
        file: {
          name: FILE_NAME,
          uri: FILE_URI,
          mime_type: 'video/quicktime',
          state: 'ACTIVE',
          expiration_time: EXPIRES,
        },
      });
    });
    const ref = await ensureGeminiFileUri(source(), deps(f));
    expect(ref.mimeType).toBe('video/quicktime');
    expect(ref.expiresAt).toBe(EXPIRES);
  });

  it('throws GeminiFileError naming the file on FAILED, and caches nothing', async () => {
    const { fetch: f } = makeFetch(upstream({ finalState: 'PROCESSING', pollStates: ['FAILED'] }));
    await expect(ensureGeminiFileUri(source(), deps(f))).rejects.toThrow(
      new GeminiFileError('clip.mp4', 'state FAILED'),
    );
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(false);
  });

  it('gives up at the 120s poll cap and caches nothing', async () => {
    const { fetch: f, calls } = makeFetch(
      upstream({ finalState: 'PROCESSING', pollStates: ['PROCESSING'] }),
    );
    const err = await ensureGeminiFileUri(source(), deps(f)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiFileError);
    expect((err as GeminiFileError).reason).toBe('processing timed out');
    expect((err as GeminiFileError).file).toBe('clip.mp4');
    // One poll per interval up to the cap, plus the one whose clock crosses it.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(
      GEMINI_FILE_POLL_CAP_MS / GEMINI_FILE_POLL_MS + 1,
    );
    expect(nowMs - T0).toBe(GEMINI_FILE_POLL_CAP_MS + GEMINI_FILE_POLL_MS);
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(false);
  });

  it('throws GeminiFileError when the start POST fails', async () => {
    const { fetch: f } = makeFetch(() => new Response('quota exceeded', { status: 429 }));
    await expect(ensureGeminiFileUri(source(), deps(f))).rejects.toThrow(GeminiFileError);
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(false);
  });

  it('throws GeminiFileError naming the offset when a chunk fails', async () => {
    const { fetch: f } = makeFetch((call) =>
      call.method === 'POST'
        ? new Response(null, { status: 200, headers: { 'x-goog-upload-url': GOOGLE_SESSION } })
        : new Response('bad offset', { status: 400 }),
    );
    // The reason names the STATUS and the offset — never the upstream body (I5).
    await expect(ensureGeminiFileUri(source(), deps(f))).rejects.toThrow(/chunk failed \(400\) at 0/);
  });

  it('an already-aborted signal throws for THAT caller while a peer still gets the file', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch: f, calls } = makeFetch(upstream());
    const d = deps(f);
    const cancelled = ensureGeminiFileUri(source(), d, controller.signal);
    const peer = ensureGeminiFileUri(source(), d);
    await expect(cancelled).rejects.toThrow(/abort/i);
    await expect(peer).resolves.toMatchObject({ name: FILE_NAME });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('one caller cancelling mid-upload does not kill the upload its peers share', async () => {
    const gate = deferred();
    const controller = new AbortController();
    const { fetch: f, calls } = makeFetch(async (call) => {
      if (call.method === 'POST') {
        await gate.promise;
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': GOOGLE_SESSION } });
      }
      return upstream()(call);
    });
    const d = deps(f);
    const cancelled = ensureGeminiFileUri(source(), d, controller.signal);
    const peer = ensureGeminiFileUri(source(), d);
    const cancelledSettled = expect(cancelled).rejects.toThrow(/abort/i);

    controller.abort();
    gate.resolve();

    await cancelledSettled;
    // Session A walked away; session B's video still arrives, off ONE upload.
    await expect(peer).resolves.toEqual({
      name: FILE_NAME,
      uri: FILE_URI,
      mimeType: 'video/mp4',
      expiresAt: EXPIRES,
      sizeBytes: 8,
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(true);
  });

  it('refuses a file that shrank under the upload instead of finalizing it truncated', async () => {
    const { fetch: f, calls } = makeFetch(upstream());
    const err = await ensureGeminiFileUri(
      source({ sizeBytes: 1024 }),
      deps(f, { openChunk: async () => new Uint8Array(512) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiFileError);
    expect((err as GeminiFileError).reason).toBe('file changed during upload');
    expect((err as GeminiFileError).file).toBe('clip.mp4');
    // Nothing was announced as uploaded, and nothing was cached as a good reference.
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(false);
  });

  it('refuses a LATER chunk that short-reads, after earlier chunks already went out', async () => {
    const size = 70 * 1024 * 1024;
    const { fetch: f, calls } = makeFetch(upstream());
    await expect(
      ensureGeminiFileUri(
        source({ sizeBytes: size }),
        deps(f, {
          openChunk: async (_p: string, start: number, end: number) =>
            new Uint8Array(start === 2 * GEMINI_UPLOAD_CHUNK_BYTES ? 1 : end - start),
        }),
      ),
    ).rejects.toThrow(/file changed during upload/);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.some((c) => (c.headers['x-goog-upload-command'] ?? '').includes('finalize'))).toBe(
      false,
    );
    expect(existsSync(join(cacheDir, 'sha-of-clip.json'))).toBe(false);
  });

  it('rejects a mime type outside video/*, audio/* and application/pdf before any fetch', async () => {
    const { fetch: f, calls } = makeFetch(upstream());
    for (const mimeType of ['image/png', 'text/plain', 'application/zip', 'video/mp4; codecs=avc1']) {
      const err = await ensureGeminiFileUri(source({ mimeType }), deps(f)).catch(
        (e: unknown) => e,
      );
      expect(err, mimeType).toBeInstanceOf(GeminiFileError);
      expect((err as GeminiFileError).reason, mimeType).toBe('unsupported media type');
      expect((err as GeminiFileError).file, mimeType).toBe('clip.mp4');
    }
    expect(calls).toHaveLength(0);

    const accepted = ['video/mp4', 'audio/mpeg', 'application/pdf', 'video/x-matroska'];
    for (const [i, mimeType] of accepted.entries()) {
      await expect(
        ensureGeminiFileUri(source({ mimeType, sha: `sha-ok-${i}` }), deps(f)),
      ).resolves.toBeTruthy();
    }
  });

  it('shares ONE upload between two concurrent callers that both miss the cache', async () => {
    // The first call is held open, so the second genuinely arrives mid-upload rather than
    // after it — the sharing is not an artefact of how two cache-miss reads happen to settle.
    const gate = deferred();
    const { fetch: f, calls } = makeFetch(async (call) => {
      if (call.method === 'POST') {
        await gate.promise;
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': GOOGLE_SESSION } });
      }
      return upstream()(call);
    });
    const d = deps(f);
    const a = ensureGeminiFileUri(source(), d);
    const b = ensureGeminiFileUri(source(), d);
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  // A sole caller that has ALREADY aborted never awaits the shared work, so the
  // shared promise's rejection would surface as an unhandled rejection and, under
  // node's default, take the runner down. Observed at the mint site instead; every
  // caller still sees its own rejection.
  it('an already-aborted SOLE caller leaves no unhandled rejection when the shared upload fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      controller.abort();
      const { fetch: f } = makeFetch(() => new Response('upstream down', { status: 500 }));
      await expect(
        ensureGeminiFileUri(source({ sha: 'sha-lonely-abort' }), deps(f), controller.signal),
      ).rejects.toThrow(/abort/i);
      // Let the shared upload settle, then let node decide about its rejection.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  // I1 — a socket that opens and never answers used to hold the whole turn: the
  // keep-alive would talk over a dead upload until the model call itself gave up.
  /**
   * A socket that OPENS and never answers, with the request's own deadline under
   * the test's control. The fake rejects on abort exactly as real fetch does —
   * a fake that ignored the signal would prove the deadline was wired when it was
   * not.
   */
  function hangsOn(method: 'POST' | 'PUT') {
    const asked: number[] = [];
    let latest: AbortController | undefined;
    const timeoutSignal = (ms: number): AbortSignal => {
      asked.push(ms);
      latest = new AbortController();
      return latest.signal;
    };
    const happy = upstream();
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== method) {
        return happy({ url: String(input), method: init?.method ?? 'GET', headers: {}, bodyLen: 0 });
      }
      const signal = init!.signal!;
      queueMicrotask(() => latest?.abort()); // the deadline expires
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;
    return { asked, fetch: fetchImpl, timeoutSignal };
  }

  it('bounds the start POST at 30s and every chunk PUT at 120s; a chunk that never answers reads as a timeout', async () => {
    const h = hangsOn('PUT');
    const err = await ensureGeminiFileUri(
      source({ sha: 'sha-chunk-timeout' }),
      deps(h.fetch, { timeoutSignal: h.timeoutSignal }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GeminiFileError);
    expect((err as GeminiFileError).reason).toBe('chunk timed out');
    expect(h.asked).toEqual([GEMINI_UPLOAD_START_TIMEOUT_MS, GEMINI_UPLOAD_CHUNK_TIMEOUT_MS]);
    expect(GEMINI_UPLOAD_START_TIMEOUT_MS).toBe(30_000);
    expect(GEMINI_UPLOAD_CHUNK_TIMEOUT_MS).toBe(120_000);
    // A timed-out upload is never cached as a good reference.
    expect(existsSync(join(cacheDir, 'sha-chunk-timeout.json'))).toBe(false);
  });

  it('a start POST that never answers times out too, and names its own stage', async () => {
    const h = hangsOn('POST');
    const err = await ensureGeminiFileUri(
      source({ sha: 'sha-start-timeout' }),
      deps(h.fetch, { timeoutSignal: h.timeoutSignal }),
    ).catch((e: unknown) => e);
    expect((err as GeminiFileError).reason).toBe('upload start timed out');
    expect(h.asked).toEqual([GEMINI_UPLOAD_START_TIMEOUT_MS]);
  });

  // I3 — a truncated or hand-edited entry used to pass the date check and hand back
  // `uri: undefined`, which reaches the wire as a media item pointing at nothing.
  it('a fresh-dated cache entry with no uri is a MISS, and the file uploads again', async () => {
    await seedCache('sha-bad-entry', { name: FILE_NAME, expiresAt: EXPIRES, mimeType: 'video/mp4', sizeBytes: 8 } as unknown as GeminiFileRef);
    const { fetch: f, calls } = makeFetch(upstream());
    const ref = await ensureGeminiFileUri(source({ sha: 'sha-bad-entry' }), deps(f));
    expect(ref.uri).toBe(FILE_URI);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('an entry with an empty uri, or no name, is a miss too', async () => {
    await seedCache('sha-empty-uri', { name: FILE_NAME, uri: '', mimeType: 'video/mp4', expiresAt: EXPIRES, sizeBytes: 8 });
    const a = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sha: 'sha-empty-uri' }), deps(a.fetch));
    expect(a.calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    await seedCache('sha-no-name', { uri: FILE_URI, mimeType: 'video/mp4', expiresAt: EXPIRES, sizeBytes: 8 } as unknown as GeminiFileRef);
    const b = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sha: 'sha-no-name' }), deps(b.fetch));
    expect(b.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  // I5 — the reason is read twice by things that must not carry an upstream body:
  // the MODEL's own context (through the placeholder) and the runner log.
  it('a failure reason carries the status and a fixed phrase — never a byte of the upstream body', async () => {
    const body = 'quota exceeded for project SECRET-MARKER-abc123, request id 7f';
    for (const [sha, stage, respond] of [
      ['sha-start-body', 'upload start failed (503)', (c: Call) => (c.method === 'POST' ? new Response(body, { status: 503 }) : upstream()(c))],
      ['sha-chunk-body', 'chunk failed (502) at 0', (c: Call) => (c.method === 'PUT' ? new Response(body, { status: 502 }) : upstream()(c))],
    ] as const) {
      const { fetch: f } = makeFetch(respond);
      const err = await ensureGeminiFileUri(source({ sha }), deps(f)).catch((e: unknown) => e);
      expect((err as GeminiFileError).reason).toBe(stage);
      expect((err as GeminiFileError).reason).not.toContain('SECRET-MARKER');
      expect((err as GeminiFileError).message).not.toContain('SECRET-MARKER');
    }
  });

  it('a poll failure names its status only', async () => {
    let polled = false;
    const { fetch: f } = makeFetch((call) => {
      if (call.method === 'GET') {
        polled = true;
        return new Response('SECRET-MARKER body', { status: 429 });
      }
      return upstream({ finalState: 'PROCESSING' })(call);
    });
    const err = await ensureGeminiFileUri(source({ sha: 'sha-poll-body' }), deps(f)).catch((e: unknown) => e);
    expect(polled).toBe(true);
    expect((err as GeminiFileError).reason).toBe('poll failed (429)');
  });

  it('logs the upload without ever printing the credential', async () => {
    const { fetch: f } = makeFetch(upstream());
    await ensureGeminiFileUri(source({ sizeBytes: 1234 }), deps(f));
    const line = logs.find((l) => l.includes('uploaded'))!;
    expect(line).toContain('[gemini-files] uploaded clip.mp4');
    expect(line).toContain('1234B');
    expect(line).toContain(FILE_NAME);
    expect(logs.join('\n')).not.toContain('tok-SECRET-never-log-me');
  });
});
