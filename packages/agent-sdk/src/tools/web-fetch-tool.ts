/**
 * `WebFetch` native tool for the OpenAI arm — fetch a specific URL and return
 * its readable text. Parity with the Claude SDK's WebFetch.
 *
 * OpenAI's hosted tool set covers web *search* (webSearchTool) but has NO
 * fetch-a-URL primitive, so this is a small custom function tool: GET the URL,
 * strip it to readable text, truncate, and hand it back for the model to reason
 * over. Search finds pages; WebFetch reads a page the user/model already has.
 *
 * Safety + robustness:
 *   - http upgraded to https; only http(s) URLs are fetched
 *   - 15s timeout, 10MB cap, redirects followed by fetch()
 *   - never throws — returns a model-readable error string on any failure
 *
 * Relocated into @vestra/agent-sdk/tools (ring 4b-4). Logger coupling inverted
 * to an optional warn callback; web-tool config injected via getConfig.
 */

import { z } from 'zod';
import type { RawToolOptions, ToolErrorCode, ToolExecuteContext } from './tool-types.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import { resolveProviderChain, fetchWithChain, AllProvidersBillingDead, type WebToolConfig } from './web-providers.js';
import { safeFetchText, WebFetchBlockedError, WebFetchTimeoutError } from './web-fetch-guard.js';
import { webFetchGuardEnabled, webFetchStoreEnabled, toolResultShapeEnabled } from '../policy/feature-flags.js';
import { truncationMarker, softFail } from './result-shape.js';
import * as webContentStore from './web-content-store.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB raw cap
const MAX_TEXT = 30_000; // chars returned to the model
const TIMEOUT_MS = 15_000;

/** Per-fetch store context: present only on the taskId-carrying arms. */
type StoreCtx = { taskId: string; budget?: number };

/** Collapse giant inline base64 data-URIs (token bombs) to a short placeholder. */
export function collapseDataUris(text: string): string {
  return text.replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{256,}/g, (m) => `[data-uri omitted (${m.length} chars)]`);
}

/**
 * Single choke-point for returning fetched text to the model. Flag OFF or no
 * storeCtx (legacy arm): byte-identical legacy head-only clip. Flag ON with a
 * taskId: data-URI collapse then truncate-and-store (head+tail window + Read
 * paging footer); a store failure degrades to the legacy clip — never fails
 * the fetch.
 */
export async function clipWebText(text: string, storeCtx?: StoreCtx): Promise<string> {
  const budget = storeCtx?.budget ?? MAX_TEXT;
  // T5 (TOOL_RESULT_SHAPE_V1): the clip carries the one truncation marker. Off: today's notice.
  const clipNotice = (t: string) => (toolResultShapeEnabled()
    ? `\n${truncationMarker({ omitted: `${t.length - budget} characters`, from: 'end', recovery: 'Fetch a more specific page for the rest.' })}`
    : '\n\n…[truncated]');
  const legacy = (t: string) => (t.length > budget ? t.slice(0, budget) + clipNotice(t) : t);
  if (!webFetchStoreEnabled() || !storeCtx?.taskId) return legacy(text);
  const collapsed = collapseDataUris(text);
  try {
    return await webContentStore.truncateAndStoreWeb(collapsed, storeCtx.taskId, budget);
  } catch {
    return legacy(collapsed);
  }
}

/**
 * Crude but dependency-free HTML → readable text.
 * Exported for the server's in-house web provider (nami-web-provider.ts) — one
 * stripper, not two.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Raw HTTP fetch + HTML→text body — the original `WebFetch` behavior. Shared
 * helper so the legacy arm (`makeRawWebFetchTool`) and the native factory's
 * fallback path return BYTE-IDENTICAL strings. Caller must pass an already
 * normalized/validated https `url` (and a trimmed `prompt`, '' for none). Never
 * throws — returns a model-readable error string on any failure.
 */
export async function rawWebFetch(
  url: string,
  prompt: string,
  warn: (msg: string) => void = () => {},
  storeCtx?: StoreCtx,
  // L1: the calling tool's own signal (a turn's Stop, an early start cancelled) ends the
  // request too, on both paths. Absent: the per-request timeout alone, as before.
  signal?: AbortSignal,
): Promise<string> {
  return (await fetchPage(url, prompt, warn, storeCtx, signal)).text;
}

/** One fetched page: its text, and when the fetch failed, the taxonomy code for it (T5). */
interface FetchedPage {
  text: string;
  failed?: ToolErrorCode;
}

/**
 * T5 — rawWebFetch's body, telling a failure apart from a page by a field rather than by its
 * words, so a single-URL call can answer in the one error shape while a batch section and
 * the exported string surface keep today's bytes. The codes read the response's own status.
 */
async function fetchPage(
  url: string,
  prompt: string,
  warn: (msg: string) => void,
  storeCtx?: StoreCtx,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  // SSRF-safe path: pin the socket to a screened public IP and re-screen every
  // redirect hop (closes the redirect + DNS-rebind bypass in the fetch() path).
  if (webFetchGuardEnabled()) {
    try {
      const { text: raw, contentType } = await safeFetchText(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, ...(signal !== undefined && { signal }) });
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw.trim();
      const clipped = await clipWebText(text, storeCtx);
      const header = `Fetched ${url}` + (prompt ? `\nInstruction: ${prompt}` : '');
      return { text: `${header}\n\n${clipped}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[WebFetch] ${url} failed: ${msg}`);
      // The call's own signal first (a Stop, a cancelled early start: never a timeout), then the
      // guard's own typed errors: a screened-out host is a refusal, a timeout is a timeout; any
      // other transport failure is a plain failure. (This path never sees a status:
      // safeFetchText returns an error page's body as the page.)
      const failed: ToolErrorCode = signal?.aborted === true ? 'aborted'
        : err instanceof WebFetchBlockedError ? 'permission'
        : err instanceof WebFetchTimeoutError ? 'timeout' : 'exec_failed';
      return { text: `WebFetch error: ${msg} for ${url}`, failed };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Vestra-Agent/1.0 (+https://vestra.ai)' },
    });
    if (!res.ok) {
      const failed: ToolErrorCode = res.status === 404 || res.status === 410 ? 'not_found'
        : res.status === 401 || res.status === 403 ? 'permission' : 'exec_failed';
      return { text: `WebFetch error: ${res.status} ${res.statusText} for ${url}`, failed };
    }

    const ctype = res.headers.get('content-type') ?? '';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { text: `WebFetch error: response too large (${Math.round(buf.byteLength / 1e6)}MB) for ${url}`, failed: 'too_large' };
    }
    const raw = new TextDecoder('utf-8').decode(buf);
    const text = /html/i.test(ctype) ? htmlToText(raw) : raw.trim();
    const clipped = await clipWebText(text, storeCtx);
    const header = `Fetched ${url}` + (prompt ? `\nInstruction: ${prompt}` : '');
    return { text: `${header}\n\n${clipped}` };
  } catch (err) {
    const aborted = signal?.aborted === true;
    const timedOut = !aborted && err instanceof Error && err.name === 'AbortError';
    const msg = aborted ? 'aborted'
      : timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : (err instanceof Error ? err.message : String(err));
    warn(`[WebFetch] ${url} failed: ${msg}`);
    return { text: `WebFetch error: ${msg} for ${url}`, failed: aborted ? 'aborted' : timedOut ? 'timeout' : 'exec_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legacy arm's `WebFetch` factory (raw fetch only). Used by `openai-harness.ts`
 * — the sandbox shim re-exports this as the `webFetchToolOptions` const to
 * preserve the existing public surface. The native arm uses `makeWebFetchTool`
 * (provider chain first) instead.
 */
export function makeRawWebFetchTool(warn: (msg: string) => void = () => {}): RawToolOptions {
  return {
    name: 'WebFetch',
    description: TOOL_DESCRIPTIONS.WebFetch,
    strict: true,
    // W3-2: a web read, no workspace writes — concurrency-safe.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    // W4-1: a fetched page is third-party bytes — fenced + tainted at dispatch.
    untrustedContent: true,
    parameters: z.object({
      url: z.string().describe('The URL to fetch content from (http or https).'),
      prompt: z
        .string()
        .nullable()
        .optional()
        .describe('The prompt to run on the fetched content.'),
    }),
    execute: async (args: unknown, ctx?: ToolExecuteContext) => {
      const a = (args ?? {}) as { url?: string; prompt?: string | null };
      let url = typeof a.url === 'string' ? a.url.trim() : '';
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
      // T5: every failure in the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1).
      if (!url) return softFail('invalid_input', 'WebFetch error: no url provided.');
      if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length);
      if (!url.startsWith('https://')) return softFail('invalid_input', `WebFetch error: only http(s) URLs are supported (got: ${url.slice(0, 80)}).`);
      return asToolResult(await fetchPage(url, prompt, warn, undefined, ctx?.signal));
    },
  };
}

/**
 * Native/openai_responses arm's `WebFetch` factory. Drives the provider chain
 * (exa /contents) via web-providers.ts
 * for cleaner, JS-rendered content through the server proxy, then falls back to
 * `rawWebFetch` (local HTTP + HTML→text) on ANY failure (unconfigured proxy,
 * HTTP error, empty result) — a 3-tier chain. `taskId` is captured in the
 * closure for the proxy's per-task billing header; the execute ctx (2nd arg) is
 * ignored, matching `makeWebSearchTool`. Never throws into the loop.
 */
/** Per-URL inline budget: single fetch keeps MAX_TEXT; batches split a 60k pool with an 8k floor. */
export function batchBudget(n: number): number {
  return n <= 1 ? MAX_TEXT : Math.max(8_000, Math.floor(60_000 / n));
}

/** trim + http→https upgrade; null when not http(s). */
function normalizeUrl(raw: string): string | null {
  let url = raw.trim();
  if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length);
  return url.startsWith('https://') ? url : null;
}

export function makeWebFetchTool(
  taskId: string,
  getConfig: () => WebToolConfig,
  warn: (msg: string) => void = () => {},
): RawToolOptions {
  // Schema/description are fixed at factory time (per task start); env is stable
  // for a sandbox process, and flag-OFF must present the exact legacy surface.
  const storeOn = webFetchStoreEnabled();
  const parameters = storeOn
    ? z.object({
        url: z.string().nullable().optional().describe('The URL to fetch content from (http or https).'),
        urls: z.array(z.string()).nullable().optional().describe('Fetch up to 5 URLs in one call (mutually exclusive with url).'),
        prompt: z.string().nullable().optional().describe('The prompt to run on the fetched content.'),
      })
    : z.object({
        url: z.string().describe('The URL to fetch content from (http or https).'),
        prompt: z.string().nullable().optional().describe('The prompt to run on the fetched content.'),
      });
  // T5 (TOOL_RESULT_SHAPE_V1): with the one marker, the paging call sits in the middle of the
  // window, not in a footer. Read at factory time like the schema, so a session's text is stable.
  const pagingNote = toolResultShapeEnabled()
    ? 'page the rest with the Read tool as the marker in the middle says.'
    : 'page the rest with the Read tool as instructed in the footer.';
  const description = storeOn
    ? TOOL_DESCRIPTIONS.WebFetch +
      ` Pass \`urls\` (up to 5) to fetch several pages in one call. Oversized pages return a head+tail window plus a stored-file path - ${pagingNote}`
    : TOOL_DESCRIPTIONS.WebFetch;
  // Per-task billing-dead breaker for the PROVIDER CHAIN only (instance state,
  // never module state — one process runs many sessions). Unlike WebSearch,
  // the tool stays useful after a trip: the raw-fetch tier needs no vendor
  // credits, so post-trip calls skip the paid 402ing proxies and go straight
  // to raw instead of failing.
  let providersBillingDead = false;
  return {
    name: 'WebFetch',
    description,
    strict: true,
    // W3-2: a web read, no workspace writes. The oversized-page store allocates
    // per-call generations tear-free (web-content-store.ts was built for the
    // in-call `urls[]` concurrent batch), and the provider breaker is a monotonic
    // latch — concurrent siblings never produce a wrong result.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    // W4-1: a fetched page is third-party bytes — fenced + tainted at dispatch.
    untrustedContent: true,
    parameters,
    execute: async (args: unknown, ctx?: ToolExecuteContext) => {
      const a = (args ?? {}) as { url?: string | null; urls?: string[] | null; prompt?: string | null };
      const url = typeof a.url === 'string' ? a.url.trim() : '';
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
      const list = storeOn && Array.isArray(a.urls) ? a.urls.map((u) => String(u).trim()).filter(Boolean) : [];
      // T5: every failure of the call in the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1). A batch that
      // fetched some pages worked; its failed sections keep their own words inline.
      if (list.length > 0 && url) return softFail('invalid_input', 'WebFetch error: pass either url or urls, not both.');
      if (list.length > 5) return softFail('invalid_input', 'WebFetch error: at most 5 urls per call.');
      if (!url && list.length === 0) return softFail('invalid_input', 'WebFetch error: no url provided.');

      const targets = list.length > 0 ? list : [url];
      const budget = batchBudget(targets.length);
      const fetchOne = async (rawUrl: string): Promise<FetchedPage> => {
        const u = normalizeUrl(rawUrl);
        if (!u) return { text: `WebFetch error: only http(s) URLs are supported (got: ${rawUrl.slice(0, 80)}).`, failed: 'invalid_input' };
        const cfg = getConfig();
        // Provider chain first (cleaner content); fall back to raw fetch on ANY failure.
        if (!providersBillingDead) {
          try {
            const { content } = await fetchWithChain(resolveProviderChain(cfg.providerOrder), { url: u }, taskId, cfg, warn, ctx?.signal);
            if (content) {
              const clipped = await clipWebText(content, { taskId, budget });
              const header = `Fetched ${u}` + (prompt ? `\nInstruction: ${prompt}` : '');
              return { text: `${header}\n\n${clipped}` };
            }
          } catch (err) {
            if (err instanceof AllProvidersBillingDead) {
              providersBillingDead = true;
              warn(`[WebFetch] breaker tripped for task ${taskId}: providers out of credits (402): ${err.providers.join(', ')}; raw fetch only for the rest of this task`);
            } else {
              warn(`[WebFetch] providers failed, falling back to raw: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
        return fetchPage(u, prompt, warn, { taskId, budget }, ctx?.signal);
      };

      if (targets.length === 1) return asToolResult(await fetchOne(targets[0])); // single-URL output shape unchanged
      const sections = await Promise.all(targets.map(async (t) => `## ${t}\n\n${(await fetchOne(t)).text}`));
      return sections.join('\n\n---\n\n');
    },
  };
}

/** T5 — a single fetch's result: the page, or its failure in the one error shape. */
function asToolResult(page: FetchedPage): ReturnType<typeof softFail> {
  return page.failed === undefined ? page.text : softFail(page.failed, page.text);
}
