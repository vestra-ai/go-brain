/**
 * Thin Exa client — calls the server credential proxy (/api/proxy/exa) so
 * EXA_API_KEY never enters the sandbox. Credential-free: config injected by the
 * caller. Maps Exa /search + /contents responses to the canonical shapes.
 */
import type { CanonicalSearch, CanonicalFetch } from './web-types.js';
import { webFetchStoreEnabled } from '../policy/feature-flags.js';

export interface ExaProxyConfig {
  serverUrl?: string | undefined;
  apiToken?: string | undefined;
  searchType?: string | undefined;
}
export class ExaUnconfigured extends Error {
  constructor() { super('Exa proxy not configured (VESTRA_SERVER_URL / VESTRA_API_TOKEN absent)'); }
}
export class ExaHttpError extends Error {
  constructor(public status: number, body: string) { super(`Exa ${status}: ${body.slice(0, 200)}`); }
}

interface ExaSearchResp { results?: Array<{ url: string; title?: string; publishedDate?: string; highlights?: string[] }> }
interface ExaContentsResp { results?: Array<{ url: string; title?: string; text?: string; highlights?: string[] }>; statuses?: Array<{ id: string; status?: string; error?: { tag?: string } }> }

const TIMEOUT_MS = 20_000;
const MAX_TEXT = 30_000;
// Flag-ON: request enough text that truncate-and-store preserves the whole
// page (stored-file cap is 2MB downstream); flag-OFF requests stay byte-identical.
const STORE_MAX_TEXT = 500_000;

function proxyBase(cfg: ExaProxyConfig): { base: string; token: string } {
  const base = cfg.serverUrl; const token = cfg.apiToken;
  if (!base || !token) throw new ExaUnconfigured();
  return { base, token };
}
async function postProxy(path: string, body: unknown, taskId: string, cfg: ExaProxyConfig, signal?: AbortSignal): Promise<unknown> {
  const { base, token } = proxyBase(cfg);
  // The call's own signal (a turn's Stop, an early start cancelled) ends the request too;
  // absent, the timeout alone, as before.
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${base}/api/proxy/exa${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-vestra-task-id': taskId },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new ExaHttpError(res.status, await res.text().catch(() => ''));
  const text = await res.text();
  try { return JSON.parse(text) as unknown; }
  catch { throw new ExaHttpError(res.status, `non-JSON body: ${text.slice(0, 200)}`); }
}

export async function exaSearch(
  args: { query: string; allowed_domains?: string[] | null; blocked_domains?: string[] | null },
  taskId: string, cfg: ExaProxyConfig, signal?: AbortSignal,
): Promise<CanonicalSearch> {
  const body: Record<string, unknown> = {
    query: args.query,
    type: cfg.searchType ?? 'auto',
    numResults: 8,
    contents: { highlights: { maxCharacters: 400 } },
  };
  if (args.allowed_domains?.length) body.includeDomains = args.allowed_domains;
  if (args.blocked_domains?.length) body.excludeDomains = args.blocked_domains;
  const resp = (await postProxy('/search', body, taskId, cfg, signal)) as ExaSearchResp;
  const results = (resp.results ?? []).map((r) => ({
    content: [{ title: r.title ?? r.url, url: r.url }],
    excerpts: r.highlights ?? [],
    publish_date: r.publishedDate ?? null,
  }));
  return { query: args.query, durationSeconds: null, results };
}

export async function exaExtract(args: { url: string }, taskId: string, cfg: ExaProxyConfig, signal?: AbortSignal): Promise<CanonicalFetch> {
  const resp = (await postProxy('/contents', { urls: [args.url], text: { maxCharacters: webFetchStoreEnabled() ? STORE_MAX_TEXT : MAX_TEXT } }, taskId, cfg, signal)) as ExaContentsResp;
  const r = resp.results?.[0];
  const content = r?.text?.trim() || (r?.highlights ?? []).join('\n\n');
  // A 2xx with no usable content (e.g. Exa couldn't crawl the URL → statuses:[error])
  // is a SUCCESS-with-empty-content, NOT a hard failure. Return empty so the provider
  // chain short-circuits and the tool drops to the free raw-fetch tier — instead of
  // throwing, which would fall through to the next provider and double-charge for one
  // logical fetch. Real transport failures (non-2xx, non-JSON) still throw in postProxy.
  if (!r || !content) return { url: r?.url ?? args.url, content: '' };
  return { url: r.url, content };
}
