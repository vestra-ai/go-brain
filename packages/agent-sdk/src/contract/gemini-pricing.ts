/**
 * gemini-pricing.ts — the Gemini family rate card.
 *
 * PURE (model id → rates), with no provider SDK and no transport import, exactly
 * like its sibling `openai-pricing.ts`. It lives in the contract — not beside the
 * transports — so a rate lookup can be imported from the PURE ROOT
 * (`@vestra/agent-sdk`) instead of `@vestra/agent-sdk/transports`.
 *
 * That placement is load-bearing, not tidiness. `credit.service.ts` derives its
 * `model:*_per_mtok` DEFAULTS at MODULE LOAD, and the transports barrel is
 * wholesale-mocked by server tests (`vi.mock('@vestra/agent-sdk/transports')`
 * returning only the four transport classes). Reaching the resolver through that
 * barrel made every such test throw at import — before a single case ran — for
 * any module transitively importing the credit service (51 of them). The same
 * hazard is documented at `credit.service.ts` for `resolveCapabilities`: a
 * module-load-time lookup must never travel through a mockable provider surface.
 *
 * `transports/gemini-transport.ts` re-exports these names, so the barrel's public
 * surface is unchanged and every existing importer keeps working.
 */

/** A Gemini rate-card row: per-million-token USD rates plus provenance. Mirrors
 *  openai-pricing.ts's TokenPrice so the pricing-coverage tripwire can assert an
 *  explicit, provenance-carrying row exists for every seeded gemini id. */
export interface GeminiTokenPrice {
  /** USD per 1M input tokens (uncached). */
  inPerM: number;
  /** USD per 1M cached-read input tokens (Google context-cache read rate). */
  cachedPerM: number;
  /** USD per 1M output tokens (includes billed thoughts — see BILL-10). */
  outPerM: number;
  verifiedAt: string;
  sources: string[];
}

export interface GeminiRateResolution {
  price: GeminiTokenPrice;
  /** The GEMINI_RATES family token that matched, or null when the fallback stood in. */
  matched: string | null;
  /** True ONLY when no family token matched and the conservative pro-tier stand-in was used. */
  isFallback: boolean;
}

// PROVISIONAL — the rates below are a conservative seed for the Gemini 2.5/3 family,
// NOT confirmed against Google's published price sheet. The `sources` string says so
// out loud so the pricing-coverage tripwire sees a real (non-absent) provenanced row
// while still signalling "confirm before GA" (audit BILL-04). Gemini is not yet a
// pickable provider (model-capabilities marks both gemini rows available:false).
const GEMINI_PROVISIONAL: Pick<GeminiTokenPrice, 'verifiedAt' | 'sources'> = {
  verifiedAt: '2026-07-10',
  sources: ['provisional — confirm against Google price sheet before GA'],
};

/**
 * Per-million-token USD rates for the Gemini family, ordered MOST-SPECIFIC-FIRST
 * (3.8-flash before flash-lite before flash) so the resolver returns the first family
 * token that is a substring of the id. `cachedPerM` = Google's context-cache read rate
 * (~0.25× input for the 2.5 family). PROVISIONAL (see GEMINI_PROVISIONAL).
 */
const GEMINI_RATES: ReadonlyArray<{ match: string } & GeminiTokenPrice> = [
  // Gemini 3.8 Flash — VERIFIED 2026-09-03 against the price page (paid tier, ≤ the
  // standard context): $0.75 in / $0.075 cached / $3.75 out through 2026-12-31.
  // Google has announced $1.50 / $0.15 / $7.50 from 2027-01-01 — a one-row follow-up
  // when it lands. Thinking tokens bill at the output rate (folded in by the
  // Interactions usage normalizer). Precedes the provisional 'flash' family token.
  {
    match: '3.8-flash',
    inPerM: 0.75,
    cachedPerM: 0.075,
    outPerM: 3.75,
    verifiedAt: '2026-09-03',
    sources: [
      'https://ai.google.dev/gemini-api/docs/pricing (Gemini 3.8 Flash, paid tier)',
      'rises to $1.50 / $0.15 / $7.50 per 1M on 2027-01-01 (announced on the same page)',
    ],
  },
  { match: 'flash-lite', inPerM: 0.1, cachedPerM: 0.025, outPerM: 0.4, ...GEMINI_PROVISIONAL },
  { match: 'flash', inPerM: 0.3, cachedPerM: 0.075, outPerM: 2.5, ...GEMINI_PROVISIONAL },
  { match: 'pro', inPerM: 1.25, cachedPerM: 0.3125, outPerM: 10, ...GEMINI_PROVISIONAL },
];

/**
 * Classify a gemini model id to its rate row. Fails to the conservative pro tier
 * (never $0) when no family token matches, flagging `isFallback` so the pricing-
 * coverage tripwire can assert every SEEDED gemini id resolves to an explicit row.
 */
export function resolveGeminiRate(model: string): GeminiRateResolution {
  const lower = model.toLowerCase();
  for (const { match, ...price } of GEMINI_RATES) {
    if (lower.includes(match)) return { price, matched: match, isFallback: false };
  }
  const { match: _pro, ...price } = GEMINI_RATES.find((r) => r.match === 'pro')!;
  return { price, matched: null, isFallback: true };
}
