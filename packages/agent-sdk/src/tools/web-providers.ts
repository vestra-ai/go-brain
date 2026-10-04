/**
 * Provider-swappable web tooling — wraps the per-provider client (exa-client)
 * as a uniform WebProvider object, resolves an ordered chain from a
 * WEB_PROVIDER_ORDER-style string (default exa), and runs the chain with
 * fallback on HARD FAILURE ONLY. Exa is the only provider: Parallel was retired
 * 2026-09-25 (founder ruling), so a single Exa 402 is billing-dead at once.
 *
 * Locked decision: a THROWN error (hard failure / timeout / unconfigured)
 * advances to the next provider; a successful return with empty `results` is
 * NOT a fallback — empty is a successful return and short-circuits the chain.
 * When every provider throws "unconfigured", we throw AllProvidersUnconfigured
 * so the tool can show "temporarily unavailable". When every REACHABLE provider
 * refuses with HTTP 402 (classified by status via WebProvider.httpStatus, never
 * by message text), we throw AllProvidersBillingDead so the tool layer can trip
 * its per-task breaker instead of letting the model retry a dead account forever.
 */
import type { CanonicalSearch, CanonicalFetch } from './web-types.js';
import { exaSearch, exaExtract, ExaUnconfigured, ExaHttpError } from './exa-client.js';

export interface WebToolConfig {
  serverUrl?: string | undefined;
  apiToken?: string | undefined;
  providerOrder?: string | undefined;
  exaSearchType?: string | undefined;
}
type SearchArgs = { query: string; allowed_domains?: string[] | null; blocked_domains?: string[] | null };
export interface WebProvider {
  name: string;
  search(args: SearchArgs, taskId: string, cfg: WebToolConfig, signal?: AbortSignal): Promise<CanonicalSearch>;
  fetch(args: { url: string }, taskId: string, cfg: WebToolConfig, signal?: AbortSignal): Promise<CanonicalFetch>;
  isUnconfigured(err: unknown): boolean;
  /** HTTP status from this provider's typed transport error; undefined for non-HTTP errors. */
  httpStatus(err: unknown): number | undefined;
}
export class AllProvidersUnconfigured extends Error {
  constructor() { super('No web provider is configured.'); }
}
/**
 * PROVIDER_BILLING_DEAD: every reachable provider refused the call with HTTP
 * 402 (vendor account out of credits). Classified by STATUS, never by message
 * text. Retrying is pointless until the account is refilled — the tool layer
 * trips its per-task breaker on this error.
 */
export class AllProvidersBillingDead extends Error {
  constructor(public providers: string[]) {
    super(`Web providers out of credits (HTTP 402): ${providers.join(', ')}`);
    this.name = 'AllProvidersBillingDead';
  }
}
const BILLING_DEAD_STATUS = 402;

const exaProvider: WebProvider = {
  name: 'exa',
  search: (a, t, c, s) => exaSearch(a, t, { serverUrl: c.serverUrl, apiToken: c.apiToken, searchType: c.exaSearchType }, s),
  fetch: (a, t, c, s) => exaExtract(a, t, { serverUrl: c.serverUrl, apiToken: c.apiToken, searchType: c.exaSearchType }, s),
  isUnconfigured: (e) => e instanceof ExaUnconfigured,
  httpStatus: (e) => (e instanceof ExaHttpError ? e.status : undefined),
};
// A WEB_PROVIDER_ORDER that still names 'parallel' resolves to exa: unknown names are ignored.
const KNOWN: Record<string, WebProvider> = { exa: exaProvider };
const DEFAULT_ORDER = ['exa'];

export function resolveProviderChain(order?: string): WebProvider[] {
  const names = (order ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  const chain: WebProvider[] = [];
  for (const n of names) { if (KNOWN[n] && !seen.has(n)) { seen.add(n); chain.push(KNOWN[n]); } }
  if (chain.length) return chain;
  return DEFAULT_ORDER.map((n) => KNOWN[n]);
}

async function runChain<T>(
  chain: WebProvider[], warn: (m: string) => void, label: string,
  call: (p: WebProvider) => Promise<T>,
): Promise<T> {
  let lastErr: unknown; let unconfigured = 0; const billingDead: string[] = [];
  for (const p of chain) {
    try { return await call(p); }
    catch (err) {
      lastErr = err;
      if (p.isUnconfigured(err)) { unconfigured++; continue; }
      if (p.httpStatus(err) === BILLING_DEAD_STATUS) billingDead.push(p.name);
      warn(`[${label}] provider ${p.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (unconfigured === chain.length) throw new AllProvidersUnconfigured();
  // Every reachable provider said 402 → billing-dead, a class of failure retries
  // can never fix. A mix with any OTHER hard failure keeps the plain rethrow.
  if (billingDead.length > 0 && billingDead.length + unconfigured === chain.length) throw new AllProvidersBillingDead(billingDead);
  throw lastErr;
}

/** `signal`: the calling tool's own (a turn's Stop, an early start cancelled); absent, as before. */
export function searchWithChain(chain: WebProvider[], args: SearchArgs, taskId: string, cfg: WebToolConfig, warn: (m: string) => void, signal?: AbortSignal): Promise<CanonicalSearch> {
  return runChain(chain, warn, 'WebSearch', (p) => p.search(args, taskId, cfg, signal));
}
export function fetchWithChain(chain: WebProvider[], args: { url: string }, taskId: string, cfg: WebToolConfig, warn: (m: string) => void, signal?: AbortSignal): Promise<CanonicalFetch> {
  return runChain(chain, warn, 'WebFetch', (p) => p.fetch(args, taskId, cfg, signal));
}
