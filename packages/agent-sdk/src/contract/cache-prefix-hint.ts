/**
 * CachePrefixHint — a provider-neutral, run-of-the-mill ADDITIVE engine→transport
 * hint for adaptive prompt-cache placement (K4C-3 D2).
 *
 * The kernel loop never knows a provider's cache mechanics; it only knows a
 * SEMANTIC fact about the projection it is about to send — whether that
 * projection LEADS with a compaction summary (a stable front-of-context prefix
 * that stays fixed until the next compaction). The Anthropic transport consumes
 * this to anchor a `cache_control` breakpoint on that stable prefix instead of
 * the rolling tail-intermediate.
 *
 * MINIMAL + OPTIONAL: a transport that ignores it (or a round with the hint
 * unset) behaves byte-identically to K4C-2. This is types-only (zero runtime).
 */
export interface CachePrefixHint {
  /**
   * The projection's leading message is a compaction summary — a stable prefix
   * worth anchoring once and reusing across subsequent turns.
   */
  summaryLeading: boolean;
}
