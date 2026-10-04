import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGeminiInteractionsBody } from '../gemini-inline.js';
import type { GeminiFilesDeps } from '../gemini-files.js';
import { _resetMediaBytesCacheForTest } from '../media-bytes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_INLINE_GEMINI_V1;
  _resetMediaBytesCacheForTest();
});

const URL_IMG = 'https://cdn.test/u1/chart%20q3.png?sig=abc';
const body = () => ({
  model: 'm', store: false, stream: true, generation_config: { max_output_tokens: 1 },
  input: [
    { type: 'user_input', content: [{ type: 'image', data: '', mime_type: 'image/png', vestraImageUrl: URL_IMG }, { type: 'text', text: 'see' }] },
    { type: 'function_call', id: 'fc', name: 'Shot', arguments: {} },
    { type: 'function_result', call_id: 'fc', result: [{ type: 'image', data: 'AAAA', mime_type: 'image/png', vestraImageUrl: URL_IMG }] },
  ],
});

describe('materializeGeminiInteractionsBody — MEDIA_INLINE_GEMINI_V1 on the steps shape', () => {
  it('flag OFF: the INTERNAL marker is stripped everywhere and nothing else changes', async () => {
    const out = (await materializeGeminiInteractionsBody(body())) as { input: Array<Record<string, unknown>> };
    expect(JSON.stringify(out)).not.toContain('vestraImageUrl');
    expect(out.input[0].content).toEqual([{ type: 'image', data: '', mime_type: 'image/png' }, { type: 'text', text: 'see' }]);
    expect(out.input[2].result).toEqual([{ type: 'image', data: 'AAAA', mime_type: 'image/png' }]);
  });

  it('flag ON: a url-only image is edge-fetched and inlined; a fetch failure becomes a text placeholder naming the file', async () => {
    process.env.MEDIA_INLINE_GEMINI_V1 = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([3, 4]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const ok = (await materializeGeminiInteractionsBody(body())) as { input: Array<{ content?: unknown[]; result?: unknown[] }> };
    expect(ok.input[0].content?.[0]).toEqual({ type: 'image', data: Buffer.from([3, 4]).toString('base64'), mime_type: 'image/png' });
    expect(ok.input[2].result).toEqual([{ type: 'image', data: 'AAAA', mime_type: 'image/png' }]); // data present → no fetch, marker stripped

    _resetMediaBytesCacheForTest();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const failed = (await materializeGeminiInteractionsBody(body())) as { input: Array<{ content?: unknown[] }> };
    expect(failed.input[0].content?.[0]).toEqual({ type: 'text', text: '[image unavailable: chart q3.png — re-read it from files/ if needed]' });
  });

  it('a body with no marked image is returned as-is (same reference)', async () => {
    const b = { input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }] };
    expect(await materializeGeminiInteractionsBody(b)).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO_UNDERSTANDING_V1 §7 — the media marker becomes a Files API uri HERE, at
// request build. The journal never holds a uri, and the marker never reaches the
// wire in ANY state (resolved, failed, or no deps at all).
// ─────────────────────────────────────────────────────────────────────────────

const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';

interface RecordedCall { method: string; url: string; headers: Record<string, string> }

/** A Files API upstream that answers start → finalize(ACTIVE) and records every call. */
function filesUpstream(cacheDir: string, onStart?: () => void) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (method === 'POST') {
      onStart?.();
      return new Response(null, {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=S' },
      });
    }
    return new Response(
      JSON.stringify({ file: { name: 'files/abc123', uri: FILE_URI, mimeType: 'video/mp4', state: 'ACTIVE', expirationTime: '2099-01-01T00:00:00.000Z' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const files: GeminiFilesDeps = {
    baseUrl: 'https://proxy.test/api/proxy/google',
    headers: () => ({ authorization: 'Bearer tok' }),
    cacheDir,
    fetch: fetchImpl,
    openChunk: async (_p: string, start: number, end: number) => new Uint8Array(end - start),
  };
  return { files, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('materializeGeminiInteractionsBody — media markers → Files API references', () => {
  let workspaceDir = '';
  let cacheDir = '';
  /** The REAL byte length on disk — never what the block claims. */
  const CLIP_BYTES = 1234;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'gemini-media-ws-'));
    cacheDir = await mkdtemp(join(tmpdir(), 'gemini-media-cache-'));
    await mkdir(join(workspaceDir, 'files'), { recursive: true });
    await writeFile(join(workspaceDir, 'files', 'clip.mp4'), Buffer.alloc(CLIP_BYTES, 7));
  });
  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** sizeBytes 0 = UNKNOWN — the pass must stat, never trust it. */
  const marker = (over: Record<string, unknown> = {}) => ({
    path: 'files/clip.mp4', mimeType: 'video/mp4', sizeBytes: 0, displayName: 'clip.mp4', ...over,
  });
  const mediaBody = (over: Record<string, unknown> = {}) => ({
    model: 'm', store: false, stream: true, generation_config: { max_output_tokens: 1 },
    input: [
      { type: 'user_input', content: [
        { type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: marker(), ...over },
        { type: 'text', text: 'watch' },
      ] },
    ],
  });

  it('a marked video item resolves to {type:"video", mime_type, uri} via ensureGeminiFileUri and the marker is stripped', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(mediaBody(), { files: up.files, workspaceDir })) as {
      input: Array<{ content?: unknown[] }>;
    };
    expect(out.input[0].content).toEqual([
      { type: 'video', mime_type: 'video/mp4', uri: FILE_URI },
      { type: 'text', text: 'watch' },
    ]);
    expect(JSON.stringify(out)).not.toContain('vestraMediaRef');
  });

  it('the upload length comes from a STAT of the real file, never from the block’s sizeBytes hint', async () => {
    const up = filesUpstream(cacheDir);
    await materializeGeminiInteractionsBody(mediaBody(), { files: up.files, workspaceDir });
    expect(up.posts()[0].headers['x-goog-upload-header-content-length']).toBe(String(CLIP_BYTES));
  });

  it('the sha comes from the marker when present, else from the file’s own bytes', async () => {
    const up = filesUpstream(cacheDir);
    await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ sha: 'marker-sha' }) }),
      { files: up.files, workspaceDir },
    );
    expect(existsSync(join(cacheDir, 'marker-sha.json'))).toBe(true);

    const fresh = await mkdtemp(join(tmpdir(), 'gemini-media-cache2-'));
    const up2 = filesUpstream(fresh);
    await materializeGeminiInteractionsBody(mediaBody(), { files: up2.files, workspaceDir });
    const computed = createHash('sha256').update(Buffer.alloc(CLIP_BYTES, 7)).digest('hex');
    expect(existsSync(join(fresh, `${computed}.json`))).toBe(true);
    await rm(fresh, { recursive: true, force: true });
  });

  it('two items with the same sha resolve with ONE client call', async () => {
    const up = filesUpstream(cacheDir);
    const body = {
      model: 'm', store: false, stream: true, generation_config: { max_output_tokens: 1 },
      input: [
        { type: 'user_input', content: [{ type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: marker({ sha: 's1' }) }] },
        { type: 'user_input', content: [{ type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: marker({ sha: 's1' }) }] },
      ],
    };
    const out = (await materializeGeminiInteractionsBody(body, { files: up.files, workspaceDir })) as {
      input: Array<{ content: unknown[] }>;
    };
    expect(up.posts()).toHaveLength(1);
    expect(out.input[0].content[0]).toEqual({ type: 'video', mime_type: 'video/mp4', uri: FILE_URI });
    expect(out.input[1].content[0]).toEqual({ type: 'video', mime_type: 'video/mp4', uri: FILE_URI });
  });

  it('resolution and processing survive the substitution', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ resolution: 'low', processing: { start_offset: '12s', end_offset: '40s' } }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content: unknown[] }> };
    expect(out.input[0].content[0]).toEqual({
      type: 'video', mime_type: 'video/mp4', uri: FILE_URI,
      resolution: 'low', processing: { start_offset: '12s', end_offset: '40s' },
    });
  });

  it('resolution failure → a text placeholder naming the file and its path, never an empty item', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ mimeType: 'application/zip' }) }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content: unknown[] }> };
    expect(out.input[0].content[0]).toEqual({
      type: 'text',
      text: '[video unavailable: clip.mp4 — unsupported media type; it is at files/clip.mp4]',
    });
    expect(up.posts()).toHaveLength(0);
  });

  // STRICT (a `watch` call): the request is nothing but this file, so a
  // placeholder would buy a confident "I have no video" at full price.
  it('a STRICT item RETHROWS instead of placeholdering, carrying the short reason as a field', async () => {
    const up = filesUpstream(cacheDir);
    await expect(
      materializeGeminiInteractionsBody(
        mediaBody({ vestraMediaRef: marker({ strict: true, path: 'files/gone.mp4', displayName: 'gone.mp4' }) }),
        { files: up.files, workspaceDir },
      ),
    ).rejects.toMatchObject({ reason: 'file not found on disk' });
  });

  it('a STRICT item that RESOLVES is byte-identical to a non-strict one — the marker never reaches the wire', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ strict: true }) }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content?: unknown[] }> };
    expect(out.input[0].content).toEqual([
      { type: 'video', mime_type: 'video/mp4', uri: FILE_URI },
      { type: 'text', text: 'watch' },
    ]);
    expect(JSON.stringify(out)).not.toContain('strict');
  });

  it('a missing file with no url → the same placeholder shape (the reason names the miss)', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ path: 'files/gone.mp4', displayName: 'gone.mp4' }) }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content: Array<{ type: string; text?: string }> }> };
    // A SHORT reason from a typed field, and the workspace-relative path named ONCE
    // — never the raw Error.message, which repeats the name and leaks /var/folders/…
    expect(out.input[0].content[0]).toEqual({
      type: 'text',
      text: '[video unavailable: gone.mp4 — file not found on disk; it is at files/gone.mp4]',
    });
    expect(out.input[0].content[0].text).not.toContain(workspaceDir);
  });

  it('a failed download names its status — the reason is read from a field, never parsed out of a message', async () => {
    // The bytes are missing locally, so the ref's url is fetched: global fetch here,
    // not the Files client's own (which rides deps.fetch and is untouched).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ path: 'files/away.mp4', displayName: 'away.mp4', url: 'https://cdn/away.mp4' }) }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content: Array<{ text?: string }> }> };
    expect(out.input[0].content[0].text).toBe(
      '[video unavailable: away.mp4 — download failed (404); it is at files/away.mp4]',
    );
  });

  it('a journaled box door path is resolved through mediaDeps.resolveUrl at request build, then uploaded', async () => {
    const DOOR = '/api/box/files/22222222-2222-4222-8222-222222222222';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(String(url)); return new Response(Buffer.alloc(4, 1)); }));
    const up = filesUpstream(cacheDir);
    const resolveUrl = vi.fn(async (url: string) => (url === DOOR ? 'https://p/fresh-pass.mp4' : null));
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ path: 'files/talk.mp4', displayName: 'talk.mp4', url: DOOR }) }),
      { files: up.files, workspaceDir, resolveUrl },
    )) as { input: Array<{ content: unknown[] }> };
    expect(resolveUrl).toHaveBeenCalledWith(DOOR, expect.any(AbortSignal));
    expect(fetched).toEqual(['https://p/fresh-pass.mp4']);
    expect(out.input[0].content[0]).toEqual({ type: 'video', mime_type: 'video/mp4', uri: FILE_URI });
  });

  it('a door path the gate will not serve becomes a placeholder that says the file could not be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must not be reached'); }));
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ path: 'files/gone.mp4', displayName: 'gone.mp4', url: '/api/box/files/22222222-2222-4222-8222-222222222222' }) }),
      { files: up.files, workspaceDir, resolveUrl: async () => null },
    )) as { input: Array<{ content: Array<{ text?: string }> }> };
    expect(out.input[0].content[0].text).toBe(
      '[video unavailable: gone.mp4 — file could not be read; it is at files/gone.mp4]',
    );
  });

  it('a marker with NO path is stripped like any other and becomes the placeholder — the marker never reaches the wire', async () => {
    const up = filesUpstream(cacheDir);
    const body = {
      input: [
        { type: 'user_input', content: [
          { type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: { mimeType: 'video/mp4', sizeBytes: 0, displayName: 'clip.mp4' } },
          { type: 'text', text: 'watch' },
        ] },
      ],
    };
    const out = (await materializeGeminiInteractionsBody(body, { files: up.files, workspaceDir })) as {
      input: Array<{ content: unknown[] }>;
    };
    expect(out.input[0].content).toEqual([
      { type: 'text', text: '[video unavailable: clip.mp4 — no file path]' },
      { type: 'text', text: 'watch' },
    ]);
    expect(JSON.stringify(out)).not.toContain('vestraMediaRef');
    expect(up.posts()).toHaveLength(0);
  });

  it('an abort mid-resolution fails the build promptly while the shared upload runs on for its peers', async () => {
    const controller = new AbortController();
    // Abort the moment the upload session opens — mid-resolution, not before it.
    const up = filesUpstream(cacheDir, () => controller.abort());
    await expect(
      materializeGeminiInteractionsBody(
        mediaBody({ vestraMediaRef: marker({ sha: 'sha-aborted' }) }),
        { files: up.files, workspaceDir },
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
    // An interrupt is not a per-file failure: the build FAILS rather than sending a
    // placeholder. The upload itself is shared, so it finishes and caches for the
    // next turn — this session simply stopped waiting on it.
    await new Promise((r) => setTimeout(r, 20));
    expect(up.posts()).toHaveLength(1);
    expect(existsSync(join(cacheDir, 'sha-aborted.json'))).toBe(true);
  });

  it('no mediaDeps (flag off / legacy construction) → the marker is stripped and the item becomes the placeholder text, never an empty item', async () => {
    const out = (await materializeGeminiInteractionsBody(mediaBody())) as { input: Array<{ content: unknown[] }> };
    expect(out.input[0].content).toEqual([
      { type: 'text', text: '[video unavailable: clip.mp4 — native media input is off; it is at files/clip.mp4]' },
      { type: 'text', text: 'watch' },
    ]);
    expect(JSON.stringify(out)).not.toContain('vestraMediaRef');
  });

  it('a marked media item inside a function_result resolves the same way', async () => {
    const up = filesUpstream(cacheDir);
    const body = {
      input: [
        { type: 'function_call', id: 'fc', name: 'Watch', arguments: {} },
        { type: 'function_result', call_id: 'fc', result: [{ type: 'video', mime_type: 'video/mp4', uri: '', vestraMediaRef: marker() }] },
      ],
    };
    const out = (await materializeGeminiInteractionsBody(body, { files: up.files, workspaceDir })) as {
      input: Array<{ result?: unknown[] }>;
    };
    expect(out.input[1].result).toEqual([{ type: 'video', mime_type: 'video/mp4', uri: FILE_URI }]);
  });

  // I2 — each in-flight upload holds a 32 MiB chunk in memory on its way through
  // the SINGLE ai-proxy replica every sandbox shares, and the number of clips on a
  // turn is chosen by whoever sent the message.
  it('never runs more than two uploads at once, however many clips the turn carries', async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const files: GeminiFilesDeps = {
      baseUrl: 'https://proxy.test/g',
      headers: () => ({}),
      cacheDir,
      fetch: (async (_input: string | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Hold every start open until the last worker has had its turn, so the
          // peak is the real concurrency and not a scheduling artefact.
          if (peak >= 2) release();
          await gate;
          inFlight -= 1;
          return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=S' } });
        }
        return new Response(
          JSON.stringify({ file: { name: 'files/a', uri: FILE_URI, mimeType: 'video/mp4', state: 'ACTIVE', expirationTime: '2099-01-01T00:00:00.000Z' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
      openChunk: async (_p: string, a: number, b: number) => new Uint8Array(b - a),
    };
    for (const n of [1, 2, 3, 4, 5]) await writeFile(join(workspaceDir, 'files', `c${n}.mp4`), `clip ${n}`);
    const body = {
      input: [{ type: 'user_input', content: [1, 2, 3, 4, 5].map((n) => ({
        type: 'video', mime_type: 'video/mp4', uri: '',
        vestraMediaRef: { path: `files/c${n}.mp4`, mimeType: 'video/mp4', sizeBytes: 0, displayName: `c${n}.mp4`, sha: `sha-${n}` },
      })) }],
    };
    const out = (await materializeGeminiInteractionsBody(body, { files, workspaceDir })) as {
      input: Array<{ content: Array<{ uri?: string }> }>;
    };
    expect(peak).toBe(2);
    expect(out.input[0].content.every((c) => c.uri === FILE_URI)).toBe(true);
  });

  // I1 — per-request bounds stop a dead socket; this stops the other shape, where
  // every request answers slowly and the resolution simply never ends.
  it('the whole resolution has a deadline; on expiry the item is a placeholder, not a hang', async () => {
    const files: GeminiFilesDeps = {
      baseUrl: 'https://proxy.test/g',
      headers: () => ({}),
      cacheDir,
      fetch: (async () => {
        // Answers, eventually — but not before the resolution's own deadline.
        await new Promise((r) => { const t = setTimeout(r, 5_000); t.unref?.(); });
        return new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://g/upload/v1beta/files?upload_id=S' } });
      }) as unknown as typeof fetch,
      openChunk: async (_p: string, a: number, b: number) => new Uint8Array(b - a),
    };
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ sha: 'sha-deadline' }) }),
      { files, workspaceDir, resolveDeadlineMs: 20 },
    )) as { input: Array<{ content: Array<{ text?: string }> }> };
    expect(out.input[0].content[0].text).toBe(
      '[video unavailable: clip.mp4 — upload timed out; it is at files/clip.mp4]',
    );
  }, 10_000);

  // M1 — the path rides off a journalled block, so it is user-shaped input.
  it('a path that escapes the workspace never reaches the disk, and says so', async () => {
    const up = filesUpstream(cacheDir);
    const out = (await materializeGeminiInteractionsBody(
      mediaBody({ vestraMediaRef: marker({ path: '../../etc/passwd', displayName: 'passwd' }) }),
      { files: up.files, workspaceDir },
    )) as { input: Array<{ content: Array<{ text?: string }> }> };
    expect(out.input[0].content[0].text).toBe(
      '[video unavailable: passwd — path outside the workspace; it is at ../../etc/passwd]',
    );
    expect(up.posts()).toHaveLength(0);
  });

  // Triage #12 — the model gets the short reason; whoever is debugging needs more
  // than "unavailable", so the error object itself rides as a second argument.
  it('the warn line carries the error object beside the short reason', async () => {
    const warns: unknown[][] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args); });
    try {
      const up = filesUpstream(cacheDir);
      await materializeGeminiInteractionsBody(
        mediaBody({ vestraMediaRef: marker({ path: 'files/gone.mp4', displayName: 'gone.mp4' }) }),
        { files: up.files, workspaceDir },
      );
    } finally {
      spy.mockRestore();
    }
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toBe('[gemini-media] gone.mp4 unavailable: file not found on disk');
    expect(warns[0][1]).toBeInstanceOf(Error);
  });

  it('a body with no marked item is returned as-is even WITH mediaDeps (same reference)', async () => {
    const up = filesUpstream(cacheDir);
    const b = { input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }] };
    expect(await materializeGeminiInteractionsBody(b, { files: up.files, workspaceDir })).toBe(b);
    expect(up.calls).toHaveLength(0);
  });
});
