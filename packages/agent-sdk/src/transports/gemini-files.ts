/**
 * Google Files API client — a local video becomes a `files/<id>` reference the
 * Gemini lane can cite, never bytes on the wire of a model call.
 *
 * Everything rides the credential proxy: the start POST, every chunk, and the
 * polls. Google answers the start with an absolute session url on its OWN host,
 * so the origin is rewritten back to `deps.baseUrl` before a single byte moves —
 * otherwise the chunks would need the provider key in the sandbox.
 *
 * The reference is cached per user by CONTENT hash: re-watching the same clip in
 * a later turn costs nothing, and a re-encode gets a new upload by construction.
 */

import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaUrlResolver } from './media-local.js';

/** 32 MiB: a multiple of Google's 256 KiB granularity and under the proxy's 40 MiB body limit. */
export const GEMINI_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
export const GEMINI_FILE_POLL_MS = 2_000;
/** Per-request bounds. Without them a socket that opens and never answers holds
 *  the whole turn: the keep-alive would speak forever over a dead upload. */
export const GEMINI_UPLOAD_START_TIMEOUT_MS = 30_000;
export const GEMINI_UPLOAD_CHUNK_TIMEOUT_MS = 120_000;
export const GEMINI_FILE_POLL_CAP_MS = 120_000;
/** A reference this close to expiry would die mid-turn; re-upload instead. */
export const GEMINI_FILE_STALE_MARGIN_MS = 60 * 60 * 1000;

/** What Google's Files API accepts as a reference: video, audio, or a PDF. */
const SUPPORTED_MEDIA = /^(video|audio)\/[a-z0-9.+-]+$/;

export interface GeminiFileRef {
  name: string;
  uri: string;
  mimeType: string;
  expiresAt: string;
  sizeBytes: number;
}

export interface GeminiFilesDeps {
  /** The proxy lane root, e.g. `${GEMINI_BASE_URL}` — never Google's host directly. */
  baseUrl: string;
  /** `geminiAuthHeaders(process.env)` — bearer to the proxy, or the raw key off-proxy. */
  headers: () => Record<string, string>;
  /** `${workspace}/files/.google-media` — one json per content hash. */
  cacheDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: read `[start, end)` of the file. */
  openChunk?: (path: string, start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>;
  /** Test seam: the per-request deadline (default `AbortSignal.timeout`). */
  timeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * What the request-build pass needs to turn a media marker into a Files API uri:
 * the client's own deps plus the workspace root a `files/<name>` path resolves
 * against. Absent ⇒ the lane cannot send media and degrades to a text placeholder.
 */
export interface GeminiMediaDeps {
  files: GeminiFilesDeps;
  workspaceDir: string;
  /** A journaled url made fetchable at request build (the box door path → a fresh
   *  pass), asked only when the bytes are not on disk. Absent ⇒ fetched as written. */
  resolveUrl?: MediaUrlResolver;
  /** Test seam: the whole-resolution deadline (default GEMINI_MEDIA_RESOLVE_DEADLINE_MS). */
  resolveDeadlineMs?: number;
}

export interface MediaSource {
  path: string;
  mimeType: string;
  /** From a stat of the real file — the upload's length header, so it must be true. */
  sizeBytes: number;
  sha: string;
  displayName: string;
}

export class GeminiFileError extends Error {
  constructor(
    public readonly file: string,
    public readonly reason: string,
  ) {
    super(`Gemini file "${file}": ${reason}`);
    this.name = 'GeminiFileError';
  }
}

/** Wire shape of Google's File resource — v1beta answers camelCase, some paths snake. */
interface WireFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  mime_type?: string;
  state?: string;
  expirationTime?: string;
  expiration_time?: string;
}

/** Keyed by cacheDir + sha: two turns asking for the same clip share one upload. */
const inFlight = new Map<string, Promise<GeminiFileRef>>();

export async function ensureGeminiFileUri(
  src: MediaSource,
  deps: GeminiFilesDeps,
  signal?: AbortSignal,
): Promise<GeminiFileRef> {
  // The mime type becomes the X-Goog-Upload-Header-Content-Type header verbatim, so
  // it is checked HERE — before the network, and before anything is cached under it.
  if (!SUPPORTED_MEDIA.test(src.mimeType) && src.mimeType !== 'application/pdf') {
    throw new GeminiFileError(src.displayName, 'unsupported media type');
  }

  // Registered BEFORE the first await, with the cache read INSIDE the shared promise: two
  // callers arriving in the same tick must not both sail past an empty map while each waits
  // on its own cache read.
  const key = `${deps.cacheDir}:${src.sha}`;
  let shared = inFlight.get(key);
  if (!shared) {
    shared = resolveRef(src, deps).finally(() => inFlight.delete(key));
    // A caller whose signal is ALREADY aborted never awaits `shared` — withAbort
    // rejects before the race is built — so a sole aborted caller would leave this
    // rejection unobserved, which node reports as an unhandled rejection. Observed
    // here with a no-op; every real caller still awaits its own raced copy and sees
    // the failure normally.
    shared.catch(() => {});
    inFlight.set(key, shared);
  }
  // The shared work carries NO caller signal. One session interrupting its turn must not
  // cancel an upload another session is waiting on, so each caller's own await ends on its
  // own abort while the upload runs on for everybody else.
  return signal ? withAbort(shared, signal) : shared;
}

async function resolveRef(src: MediaSource, deps: GeminiFilesDeps): Promise<GeminiFileRef> {
  const cached = await readCache(src.sha, deps);
  if (cached) {
    console.log(`[gemini-files] cache hit ${src.displayName} → ${cached.name}`);
    return cached;
  }
  return uploadAndActivate(src, deps);
}

/** End THIS caller's wait on THIS caller's abort, leaving the shared work running. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  );
}

async function readCache(sha: string, deps: GeminiFilesDeps): Promise<GeminiFileRef | null> {
  try {
    const ref = JSON.parse(
      await readFile(join(deps.cacheDir, `${sha}.json`), 'utf8'),
    ) as GeminiFileRef;
    // SHAPE before expiry. A truncated or hand-edited entry used to pass the date
    // check and hand back `uri: undefined`, which reaches the wire as a media item
    // pointing at nothing — a 400 that names neither the file nor the cache. A
    // malformed entry is a MISS: re-uploading is always the safe answer.
    if (typeof ref?.name !== 'string' || typeof ref?.uri !== 'string' || !ref.uri) return null;
    const now = (deps.now ?? Date.now)();
    if (Date.parse(ref.expiresAt) - now > GEMINI_FILE_STALE_MARGIN_MS) return ref;
  } catch {
    /* a miss reads exactly like an unreadable entry: upload again */
  }
  return null;
}

async function writeCache(sha: string, ref: GeminiFileRef, deps: GeminiFilesDeps): Promise<void> {
  await mkdir(deps.cacheDir, { recursive: true });
  const path = join(deps.cacheDir, `${sha}.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(ref));
  await rename(`${path}.tmp`, path);
}

/** Google returns an absolute session url on its own host; every chunk must ride the same proxy. */
export function rewriteUploadUrl(sessionUrl: string, baseUrl: string): string {
  const u = new URL(sessionUrl);
  return `${baseUrl.replace(/\/$/, '')}${u.pathname}${u.search}`;
}

async function uploadAndActivate(
  src: MediaSource,
  deps: GeminiFilesDeps,
): Promise<GeminiFileRef> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl.replace(/\/$/, '');
  const startedAt = now();

  const bound = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  const started = await withTimeout(
    src,
    'upload start',
    bound(GEMINI_UPLOAD_START_TIMEOUT_MS),
    (signal) =>
      f(`${base}/upload/v1beta/files`, {
        method: 'POST',
        headers: {
          ...deps.headers(),
          'content-type': 'application/json',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(src.sizeBytes),
          'x-goog-upload-header-content-type': src.mimeType,
        },
        body: JSON.stringify({ file: { display_name: src.displayName } }),
        signal,
      }),
  );
  const session = started.headers.get('x-goog-upload-url');
  if (!started.ok || !session) {
    // The STATUS and a fixed phrase, never the body. Google's error bodies quote
    // the request back, and this reason is read twice by things that must not
    // carry it: the model's own context (via the placeholder) and the runner log.
    debugBody(src, 'upload start', started);
    throw new GeminiFileError(src.displayName, `upload start failed (${started.status})`);
  }
  const uploadUrl = rewriteUploadUrl(session, base);

  // A 0-byte file still needs one finalize PUT, so the loop always runs at least once;
  // `end` climbs to sizeBytes, which is what ends it.
  let finalized: WireFile | undefined;
  for (let offset = 0; ; offset += GEMINI_UPLOAD_CHUNK_BYTES) {
    const end = Math.min(offset + GEMINI_UPLOAD_CHUNK_BYTES, src.sizeBytes);
    const last = end >= src.sizeBytes;
    const chunk = await (deps.openChunk ?? readChunk)(src.path, offset, end);
    // The length declared at the start POST came from a stat. Fewer bytes than asked for
    // means the file changed underneath us, and a truncated finalize would succeed and be
    // cached as a good reference.
    if (chunk.byteLength !== end - offset) {
      throw new GeminiFileError(src.displayName, 'file changed during upload');
    }
    const res = await withTimeout(src, 'chunk', bound(GEMINI_UPLOAD_CHUNK_TIMEOUT_MS), (signal) =>
      f(uploadUrl, {
        method: 'PUT',
        headers: {
          ...deps.headers(),
          'content-type': 'application/octet-stream',
          'x-goog-upload-command': last ? 'upload, finalize' : 'upload',
          'x-goog-upload-offset': String(offset),
        },
        body: chunk,
        signal,
      }),
    );
    if (!res.ok) {
      debugBody(src, 'chunk', res);
      throw new GeminiFileError(src.displayName, `chunk failed (${res.status}) at ${offset}`);
    }
    if (last) {
      finalized = ((await res.json()) as { file?: WireFile }).file;
      break;
    }
  }
  // `name` and `uri` are the file's stable identity; the polls only refresh its state
  // and the metadata the finalize response may have left out.
  const name = finalized?.name;
  const uri = finalized?.uri;
  if (!finalized || !name || !uri) {
    throw new GeminiFileError(src.displayName, 'finalize returned no file');
  }
  let file: WireFile = finalized;

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + GEMINI_FILE_POLL_CAP_MS;
  let state = file.state ?? 'PROCESSING';
  while (state === 'PROCESSING' || state === 'STATE_UNSPECIFIED') {
    if (now() > deadline) throw new GeminiFileError(src.displayName, 'processing timed out');
    await sleep(GEMINI_FILE_POLL_MS);
    const res = await f(`${base}/v1beta/${name}`, { headers: deps.headers() });
    if (!res.ok) {
      debugBody(src, 'poll', res);
      throw new GeminiFileError(src.displayName, `poll failed (${res.status})`);
    }
    const got = (await res.json()) as WireFile;
    state = got.state ?? 'PROCESSING';
    file = { ...file, ...got };
  }
  if (state !== 'ACTIVE') throw new GeminiFileError(src.displayName, `state ${state}`);

  const ref: GeminiFileRef = {
    name,
    uri,
    mimeType: file.mimeType ?? file.mime_type ?? src.mimeType,
    // Google's own TTL is 48h; the fallback stays inside it so a missing field can
    // never mint an entry that outlives the file it points at.
    expiresAt:
      file.expirationTime ?? file.expiration_time ?? new Date(now() + 47 * 3600 * 1000).toISOString(),
    sizeBytes: src.sizeBytes,
  };
  await writeCache(src.sha, ref, deps);
  // The name is safe to log; the uri's query and the auth header are not.
  console.log(
    `[gemini-files] uploaded ${src.displayName} ${src.sizeBytes}B in ${now() - startedAt}ms → ${ref.name}`,
  );
  return ref;
}

/**
 * Run one request under its own deadline. A timeout reads as `<stage> timed out`
 * — never as an abort, which the caller treats as an interrupted turn.
 */
async function withTimeout(
  src: MediaSource,
  stage: string,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(signal);
  } catch (err) {
    if (signal.aborted) throw new GeminiFileError(src.displayName, `${stage} timed out`);
    throw err;
  }
}

/**
 * The upstream body, for a human reading the runner log at debug level ONLY.
 * It never becomes a `reason`, so it can reach neither the model's context nor
 * the warn line. Read lazily: a body nobody consumes costs nothing.
 */
function debugBody(src: MediaSource, stage: string, res: Response): void {
  void res
    .text()
    .then((body) =>
      console.debug(
        `[gemini-files] ${src.displayName} ${stage} ${res.status} body:`,
        body.replace(/\s+/g, ' ').slice(0, 300),
      ),
    )
    .catch(() => {});
}

/** Read `[start, end)` off disk — one chunk at a time, never the whole file. */
async function readChunk(path: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  const fh = await open(path, 'r');
  try {
    const buf = new Uint8Array(end - start);
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } finally {
    await fh.close();
  }
}
