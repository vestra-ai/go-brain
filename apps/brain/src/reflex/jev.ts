/**
 * The Jev client, copied from Bash (apps/server/src/services/jev/jev-client.ts).
 * It never throws, never retries and always returns inside its deadline: a fault is a named
 * value and the caller carries on as if Jev were not there.
 */
import { Agent, fetch as undiciFetch } from 'undici';

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] };
export type JevAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };
export type JevFault = 'no_api_key' | 'killed' | 'daily_cap' | 'timeout' | 'http_error' | 'transport_error' | 'bad_response';
export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; inputTokens: number; serverMs: number | null; totalMs: number }
  | { ok: false; fault: JevFault; status?: number; totalMs: number };

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_KEEP_WARM_MS = 20_000;
/** Parallel calls on HTTP/1.1 each need their own socket, so five stay warm. */
export const JEV_WARM_SOCKETS = 5;

export interface JevRequestInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect?: 'manual';
}
export interface JevResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: { cancel(): Promise<void> } | null;
}
export type JevFetch = (url: string, init: JevRequestInit) => Promise<JevResponse>;

// One shared keep-alive pool. A cold connection costs about a second, nine times the answer.
const pool = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 });
export const poolFetch: JevFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: pool });

export interface JevConfig {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
}
export interface JevAskRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
  deadlineMs: number;
  signal?: AbortSignal;
}
export interface JevClient {
  ask(req: JevAskRequest): Promise<JevResult>;
  startKeepWarm(): void;
  stopKeepWarm(): void;
}

export function createJev(cfg: JevConfig, fetchImpl: JevFetch = poolFetch, clock: () => number = Date.now): JevClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let keepWarmTimer: NodeJS.Timeout | null = null;

  async function oneTouch(): Promise<boolean> {
    try {
      // GET, not HEAD: HEAD opens a fresh socket every time. No key: the touch is unbilled.
      const res = await fetchImpl(`${base}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(JEV_KEEP_WARM_MS) });
      await res.arrayBuffer(); // drain, so the socket goes back to the pool
      return true;
    } catch {
      return false;
    }
  }
  async function touchTheLine(): Promise<void> {
    // Concurrent, or only one socket warms.
    await Promise.all(Array.from({ length: JEV_WARM_SOCKETS }, () => oneTouch()));
  }

  return {
    startKeepWarm() {
      if (keepWarmTimer || !cfg.apiKey) return;
      void touchTheLine();
      keepWarmTimer = setInterval(() => void touchTheLine(), JEV_KEEP_WARM_MS);
      keepWarmTimer.unref();
    },
    stopKeepWarm() {
      if (keepWarmTimer) clearInterval(keepWarmTimer);
      keepWarmTimer = null;
    },
    async ask(req) {
      const started = clock();
      const done = (fault: JevFault, status?: number): JevResult =>
        status === undefined ? { ok: false, fault, totalMs: clock() - started } : { ok: false, fault, status, totalMs: clock() - started };
      if (!cfg.apiKey) return done('no_api_key');
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.deadlineMs);
      const onAbort = (): void => controller.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(`${base}/v1/systemone`, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, state: req.state, questions: req.questions }),
        });
        if (!res.ok) {
          // An undrained error body holds its socket.
          await res.body?.cancel().catch(() => {});
          return done('http_error', res.status);
        }
        let body: { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
        try {
          body = (await res.json()) as typeof body;
        } catch {
          if (timedOut) return done('timeout');
          if (controller.signal.aborted) return done('transport_error');
          return done('bad_response');
        }
        if (!body || !body.answers || typeof body.answers !== 'object') return done('bad_response');
        const h = res.headers.get('x-envoy-upstream-service-time');
        const upstream = h === null || h === '' ? NaN : Number(h); // Number(null) is 0: check emptiness first
        return {
          ok: true,
          answers: body.answers,
          inputTokens: body.usage?.input_tokens ?? 0,
          serverMs: Number.isFinite(upstream) ? upstream : null,
          totalMs: clock() - started,
        };
      } catch {
        return done(timedOut ? 'timeout' : 'transport_error');
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
