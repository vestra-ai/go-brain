/**
 * severed-recognizer.ts — ONE definition of "the stream was severed", for every lane.
 *
 * The recovery RAIL (seal → journaled continuation marker → bounded re-issue →
 * abort-wins) has always lived at the engine level in severed-stream.ts, and its
 * gate keys on the transport-neutral `network_error` kind. But recognizing a
 * severance necessarily touches per-SDK facts — `@anthropic-ai/sdk` throws
 * `AnthropicError`/`APIConnectionError`, `openai` throws its own classes, and each
 * of our transports throws its own premature-end sentinel. Before this module each
 * dialect answered the question its OWN way, and they had already drifted: the
 * Anthropic arm had no HTTP-status guard, so the two arms disagreed about whether a
 * status-bearing error could be a severance.
 *
 * The split here is policy vs facts. The POLICY — what counts as a severance, and
 * in what order — lives in `isSeveredStream` once. The FACTS — which classes this
 * SDK uses, which sentinel strings this lane throws — are DATA each dialect
 * supplies as a `SeveranceSpec`. Adding a provider means supplying a spec, never
 * re-deciding the policy, and never adding a branch beside the rail.
 *
 * Kept dependency-free (no provider SDKs, no round machinery) so both the engine
 * and the transports can import it without pulling either side's graph in.
 */

/**
 * OUR OWN premature-end sentinels — the throw each transport's `readStream` makes
 * when the SSE ended with no terminal chunk/event.
 *
 * They live HERE, in the engine, rather than beside the transports that throw
 * them, because that placement is what let a lane go dark: each dialect's
 * classifier knew only its own string, so the Gemini lane's sentinel classified
 * `model_error` and its round was terminal — the same hole the OpenAI lanes had.
 * One registry, checked by every lane, means a transport added tomorrow declares
 * its sentinel once and is recovered by construction.
 *
 * Matched by EXACT message: these are plain `Error`s with no discriminating field,
 * so the message IS the structure. Each transport imports its constant from here
 * to throw, so the string exists exactly once.
 */
export const CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE =
  'Chat Completions stream ended without a terminal chunk';
export const OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE =
  'OpenAI Responses stream ended without a terminal event';
export const GEMINI_SEVERED_STREAM_MESSAGE =
  'Gemini stream ended without a terminal chunk';
export const GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE =
  'Gemini Interactions stream ended without a terminal event';

/** Every premature-end sentinel WE throw. Provider-neutral: any lane may see any of them. */
export const STREAM_END_SENTINELS: readonly string[] = [
  CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE,
  OPENAI_RESPONSES_SEVERED_STREAM_MESSAGE,
  GEMINI_SEVERED_STREAM_MESSAGE,
  GEMINI_INTERACTIONS_SEVERED_STREAM_MESSAGE,
];

/** Structured socket/stream disconnect codes (node/undici) that mean the peer died mid-flight. */
const SEVERED_SOCKET_CODES = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET']);

/**
 * Raw socket-level disconnect recognizer — PROVIDER-NEUTRAL, so every dialect
 * shares one implementation of the cause-chain walk (undici wraps the SocketError
 * as `cause`). Structural only: it reads `code`, never a message.
 */
export function isSeveredSocketError(err: unknown): boolean {
  for (
    let e = err as { code?: unknown; cause?: unknown } | null | undefined, depth = 0;
    e != null && depth < 4;
    e = e.cause as { code?: unknown; cause?: unknown } | null | undefined, depth += 1
  ) {
    if (typeof e.code === 'string' && SEVERED_SOCKET_CODES.has(e.code)) return true;
  }
  return false;
}

/** The per-SDK FACTS a dialect supplies. No policy lives here — see isSeveredStream. */
export interface SeveranceSpec {
  /**
   * This SDK's user-abort wrapper. An abort is a clean stop, never a severance,
   * and it must be recognized by CLASS: neither SDK's abort error sets `.name`.
   */
  isAbort(err: unknown): boolean;
  /**
   * This SDK's connection-error wrapper. Recognized by class because its message
   * is not diagnostic (`openai` says only "Connection error."), so no wording net
   * can see it — which is exactly how these reached the terminal catch-all before.
   */
  isConnectionError(err: unknown): boolean;
  /**
   * Premature-end sentinels thrown by the SDK ITSELF (not by us), with the class
   * guard that pins them. Anthropic's `finalMessage` sentinel is the only one:
   * the SDK throws a bare `AnthropicError` whose exact message is the sole signal,
   * so the class must be checked too or a look-alike plain `Error` would match.
   * OUR sentinels are not listed here — they are in STREAM_END_SENTINELS, which
   * every lane checks.
   */
  sdkSentinels?: { messages: readonly string[]; guard: (err: unknown) => boolean };
}

/**
 * Was this round's throw a mid-stream SEVERANCE? The single policy, for every lane.
 *
 * Order is load-bearing:
 *  1. an ABORT is a clean stop and can never be a severance;
 *  2. an error carrying an HTTP `status` is never a severance — a severance happens
 *     BELOW the HTTP layer (the response never completed), so a status means a
 *     stronger, more specific signal exists (429 / 400 context / 413 / 5xx …) and
 *     must win. This guard is what lets a classifier put its severed branch early
 *     without stealing those nets;
 *  3. the SDK's own connection wrapper;
 *  4. a premature-end sentinel — OURS (shared by every lane) or this SDK's own;
 *  5. a raw socket-level disconnect anywhere down the cause chain.
 */
export function isSeveredStream(err: unknown, spec: SeveranceSpec): boolean {
  if (spec.isAbort(err)) return false;
  if (typeof (err as { status?: unknown } | null | undefined)?.status === 'number') return false;
  if (spec.isConnectionError(err)) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string') {
    if (STREAM_END_SENTINELS.includes(message)) return true;
    if (spec.sdkSentinels?.messages.includes(message) && spec.sdkSentinels.guard(err)) return true;
  }
  return isSeveredSocketError(err);
}
