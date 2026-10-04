/**
 * Provider-neutral model-capability registry.
 *
 * THE SINGLE SOURCE OF TRUTH for per-model wire limits (context window, max
 * output tokens), thinking mode, and context-awareness. Importable from the
 * sandbox harness, the kernel, and the web model-selector because it lives in
 * @bash/shared with zero provider-SDK dependencies.
 *
 * PURITY CONTRACT:
 *   - Pure data + one pure resolver. No I/O, no clock, no provider SDK.
 *   - Never throws. Unknown ids resolve to a conservative fallback so a future
 *     model selector can never break on an id we have not hardcoded yet.
 *
 * SCOPE: capabilities ONLY. Pricing is intentionally NOT modeled here — billing
 * is owned by apps/sandbox/src/harness/native-pricing.ts and must stay the only
 * pricing source of truth. `premiumInputThreshold` is metadata (the provider's
 * documented input-token re-pricing boundary), not a rate; `preferredMaxInputTokens`
 * is a compaction hint and carries no pricing meaning at all. Never conflate the
 * two: a 1M-window model can carry the second without the first (Anthropic bills
 * the full window at standard rate).
 *
 * MATCHING IDIOM mirrors the established family-match style in
 * apps/sandbox/src/harness/native-pricing.ts (rateFor) and
 * packages/kernel/src/journal/token-ledger.ts (resolveMaxContextTokens):
 * lowercase the id, then match a family token. Here the seed table is ordered
 * most-specific-first so dated/aliased ids (claude-haiku-4-5-20251001) and
 * sub-variants (gpt-5.4-mini before gpt-5.4) resolve correctly.
 */

/**
 * How the request must carry the thinking/reasoning config. Each member maps to
 * a DISTINCT wire shape (Anthropic docs verified 2026-06) — getting it wrong is a
 * hard 400, not a soft mislabel:
 *   - 'enabled'    manual budget: request carries thinking:{type:'enabled', budget_tokens:N}
 *   - 'adaptive'   request carries thinking:{type:'adaptive'} (model decides depth; effort tunes it)
 *   - 'always_on'  thinking is always on; send NO thinking config (thinking:{disabled} is rejected)
 *   - 'reasoning'  OpenAI: request carries reasoning:{effort, summary}
 *   - 'none'       no thinking
 */
export type ThinkingMode = 'enabled' | 'adaptive' | 'always_on' | 'reasoning' | 'none';

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'fireworks' | 'meta' | 'xai' | 'deepseek';

/**
 * The wire dialect a model's requests speak — selects the transport implementation.
 * OPTIONAL on a model row: when ABSENT, the transport is derived from `provider`
 * (anthropic → Anthropic Messages, openai → OpenAI Responses, google →
 * Gemini Interactions). Set it ONLY to override that default — chiefly to route an
 * OpenAI-compatible provider (DeepSeek, Kimi, MiniMax, Groq, …) through the
 * 'openai_chat_completions' breadth transport instead of the Responses default.
 */
export type WireApi =
  | 'anthropic_messages'
  | 'openai_responses'
  | 'openai_chat_completions'
  | 'gemini'
  | 'gemini_interactions';

/**
 * Provider-neutral prompt-cache policy. A CAPABILITY (what caching the
 * model/provider supports), NOT pricing — keep rates out (pricing stays in
 * native-pricing.ts). The Anthropic transport reads `lookbackBlocks` /
 * `intermediateBlocks` from here to place `cache_control` breakpoints; OpenAI
 * prefix caching is automatic, so its policy zeroes the breakpoint fields.
 */
export interface CachePolicy {
  /**
   * Min tokens a span must reach to be worth a cache_control breakpoint
   * (Anthropic: 1024 most models, 2048 Haiku-class; OpenAI automatic prefix: 1024).
   * Seeded now; CONSUMED by K4C-3's token-aware placement (unread in this task).
   */
  minCacheableTokens: number;
  /** Default cache TTL hint. Anthropic ephemeral 5m baseline; absent for OpenAI (automatic). */
  ttl?: '5m' | '1h';
  /** Max cache_control breakpoints per request. Anthropic 4; OpenAI 0 (automatic prefix — we place none). */
  breakpointBudget: number;
  /** Breakpoint lookback window in content blocks (Anthropic 20; OpenAI 0). */
  lookbackBlocks: number;
  /** Intermediate-breakpoint spacing within a long turn (Anthropic 15; OpenAI 0). */
  intermediateBlocks: number;
  /** GPT-5.6+: read only at lookup boundaries, one the developer block's end (openai-cache-boundaries.ts). */
  readsAtBoundaries?: true;
}

/**
 * The cache policy every Anthropic NON-Haiku family carries (and the inferred-
 * anthropic fallback). Defined once so the seed rows + fallback can never drift
 * apart. Haiku-class differs only in `minCacheableTokens` (see HAIKU_CACHE_POLICY).
 */
const ANTHROPIC_CACHE_POLICY: CachePolicy = {
  minCacheableTokens: 1024,
  ttl: '5m',
  breakpointBudget: 4,
  lookbackBlocks: 20,
  intermediateBlocks: 15,
};
/** Anthropic Haiku-class minimum cacheable prompt length is higher (2048). */
const HAIKU_CACHE_POLICY: CachePolicy = { ...ANTHROPIC_CACHE_POLICY, minCacheableTokens: 2048 };
/**
 * OpenAI prefix caching is AUTOMATIC — we place no explicit breakpoints, so the
 * breakpoint fields are 0 and there is no TTL hint to send.
 */
const OPENAI_CACHE_POLICY: CachePolicy = { minCacheableTokens: 1024, breakpointBudget: 0, lookbackBlocks: 0, intermediateBlocks: 0 };
/** The GPT-5.6+ builds probed 2026-10-04 (openai-cache-boundaries.ts): RESPONSES_MEMORY_INPUT_V1 reads this. */
const OPENAI_BOUNDARY_CACHE_POLICY: CachePolicy = { ...OPENAI_CACHE_POLICY, readsAtBoundaries: true };

export interface ModelCapabilities {
  /** The resolved canonical/known id (or the input id for unknown models). */
  id: string;
  provider: ModelProvider;
  /**
   * Explicit wire dialect override. ABSENT on every seed row today (the dialect is
   * derived from `provider` at transport-selection time); present only to opt a
   * model into a non-default dialect — e.g. 'openai_chat_completions' for an
   * OpenAI-compatible provider. Optional + absent-by-default ⇒ existing rows and
   * their exact-shape tests are byte-identical.
   */
  api?: WireApi;
  /** Real wire token limit for the context window. */
  contextWindow: number;
  /** Per-response output-token cap the model supports. */
  maxOutputTokens: number;
  thinking: {
    mode: ThinkingMode;
    /**
     * Default effort to send (output_config.effort for anthropic, reasoning.effort
     * for openai). PRESENT iff the model supports the effort param; ABSENT means
     * do not send effort.
     */
    effort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
    /**
     * Highest effort this model's API accepts on the wire (openai lanes).
     * ABSENT means 'high' — the safe pre-max vocabulary. 'max' only on models
     * verified to honor it (echoed back, not just accepted): the GPT-5.6
     * family — Sol documented at launch (07-09), Luna + Terra live-probed
     * 2026-08-06. resolveOpenAIReasoning clamps every requested effort to this
     * ceiling, so an env override can never send a tier the model rejects.
     */
    effortCeiling?: 'high' | 'max';
  } & import('./reasoning-replay.js').ReasoningReplayCapability & import('./per-message-effort.js').PerMessageEffortCapability;
  /** Model receives token-budget signals and persists context-awareness to end. */
  contextAware: boolean;
  /**
   * The provider's documented input-token re-pricing boundary (metadata only —
   * not a rate; rates live in openai-pricing.ts, which reads this for the
   * whole-request swap and whose row says whether the boundary itself is premium —
   * xAI "reaches", OpenAI "more than"). Live only where the pricing row declares
   * premium rates (grok, and since 2026-09-29 the GPT-6 / GPT-5.6 rows; gpt-5.5
   * carries the tier with no premium row, so the swap is inert there). ABSENT where
   * the provider bills one rate across the whole window (Anthropic, verified 2026-08-20).
   */
  premiumInputThreshold?: number;
  /**
   * The input-token count past which we PREFER to compact (context hygiene, prefill
   * latency, rejection headroom, subagent bounding). NOT a pricing boundary — see
   * kernel/compaction/trigger.ts. ABSENT means no preferred ceiling: the window
   * ceiling alone bounds the session.
   */
  preferredMaxInputTokens?: number;
  /**
   * Provider-neutral prompt-cache policy (a capability, not pricing). REQUIRED so
   * every resolveCapabilities result carries a policy — the Anthropic transport
   * reads lookback/intermediate from it (K4C-2) and K4C-3's token-aware placement
   * reads minCacheableTokens with no null-checks.
   */
  cache: CachePolicy;
  /**
   * Whether the model may actually be selected and dispatched. OPTIONAL and
   * defaults to AVAILABLE when ABSENT — so every existing seed row stays
   * byte-identical (no `available` key). Set to `false` only on a model the
   * account cannot run (not entitled, or retired by its provider), so the picker
   * excludes it and the server submit-gate rejects it instead of substituting.
   * Today: deepseek-v4-pro and glm-5.2, both 404 on Fireworks since 2026-10-04.
   * Provider-VALUE gating — never branches on runtime/harness.
   */
  available?: boolean;
  /** User-facing reason a model is unavailable. Present iff `available === false`. */
  unavailableReason?: string;
  /**
   * Phase 4 (§1.7 AC-R4) — the tokenizer family this model's provider counts
   * tokens with. METADATA ONLY (no encoder/decoder shipped here — token counts
   * still come from provider `usage` on turn_end, per K4-T0's estimateTokens
   * heuristic-rationale). Lets a future token-estimate/offload seam pick a
   * closer heuristic per family instead of one blend for every provider.
   * REQUIRED so every resolveCapabilities result carries one (mirrors `cache`).
   */
  tokenizerId: 'anthropic-claude' | 'o200k_base' | 'gemini';
  /**
   * Whether the model accepts inline image content parts (vision input). OPTIONAL
   * and absent-means-CAPABLE (mirrors `available?`) so every multimodal seed row
   * stays byte-identical (no key). Set to `false` ONLY on text-only models — today
   * the Fireworks OSS lane (GLM / DeepSeek), which hard-400s ("does not support
   * image inputs") on an image_url part. Gate through `modelSupportsImageInput`,
   * never the raw field, so absent reads as capable everywhere.
   */
  supportsImageInput?: boolean;
  /** Video, audio and PDF input via the Interactions Files API (spec 2026-09-04). Absent ⇒ false. */
  supportsVideoInput?: boolean;
  /**
   * The SAME weights served on a sibling lane the engine may run a round on when
   * THIS lane answers "model not found" after its retries. Meta's contributor door
   * flapped on 2026-09-05 (~40% of requests 404'd `model_not_found`, the model
   * itself fine on every request that got through; the standard door never missed).
   * Read ONLY by startStreamWithRetry, ONLY on `model_unavailable`: the round is
   * billed at THIS row's price (the person picked it; we absorb the lane
   * difference), the usage row records the served model, and the round says so in
   * one live line. Never a silent substitution, never the pricier direction.
   */
  unavailableSibling?: string;
  /**
   * Whether this model's API accepts Anthropic tool search — the
   * `tool_search_tool_regex_20251119` server tool plus `defer_loading: true` on
   * the tools it discovers (TOOL_DEFER_V1).
   *
   * POLARITY IS DELIBERATELY THE OPPOSITE of `available?` / `supportsImageInput?`:
   * ABSENT means NOT capable. Those two describe a floor every model clears until
   * proven otherwise; this describes a feature only some models have, and sending
   * `defer_loading` to a model that lacks it is a hard 400 on EVERY turn. Absent-
   * means-capable would make every unknown id and every non-Anthropic row silently
   * eligible. Read through `modelSupportsToolSearch`, never the raw field.
   *
   * Seeded per-model, never inferred from a version/family comparison — the set is
   * not a clean cutoff (Haiku 4.5 and Sonnet 4.5 are capable; some newer ids are
   * not). Anthropic's published compatibility table is the default source, and a
   * direct live probe OUTRANKS it: `claude-sonnet-5` was absent from that table
   * while the newer Opus 5 was listed, which turned out to be doc lag rather than a
   * real gap (probed 2026-08-12 — HTTP 200, clean `end_turn`, with `defer_loading`
   * plus `tool_search_tool_regex_20251119`).
   *
   * The asymmetry that decides ties: a wrong `true` is a hard 400 on EVERY turn for
   * that model, a wrong `false` costs only the saving. So absent-from-the-table
   * stays OFF until someone probes it — add the field on a 200, not on a hunch.
   */
  supportsToolSearch?: boolean;
  /** C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1) — tokens one tool result may cost before it is spilled and cut to
   *  head and tail. ABSENT (every row today) ⇒ 10,000; read via engine/context-offload.ts. */
  toolOutputTokenBudget?: number;
}

/**
 * A seed row: the canonical capability record plus the family token used to
 * match dated/aliased ids. `match` is checked as a substring of the lowercased
 * input id. Rows are ordered MOST-SPECIFIC-FIRST (see SEED below).
 */
interface SeedEntry {
  /** Lowercase substring that identifies this model family in an input id. */
  match: string;
  caps: ModelCapabilities;
}

/**
 * Authoritative seed data (verified against Anthropic + OpenAI docs, 2026-06).
 *
 * ORDER IS LOAD-BEARING: the resolver returns the FIRST row whose `match` is a
 * substring of the lowercased input id, so more-specific families must precede
 * the families they are a superstring of. In particular `gpt-5.4-mini` MUST come
 * before `gpt-5.4`, otherwise a mini id would match the gpt-5.4 row first.
 */
/**
 * GPT-5.6 Sol capabilities — hoisted because TWO seed rows share it: the
 * canonical 'gpt-5.6-sol' row and the bare 'gpt-5.6' alias row (OpenAI routes
 * the bare id to Sol). One object ⇒ the alias can never drift from the family.
 * The 'gpt-6.1-sol' and 'gpt-6-sol' rows spread it with their own ids (same page-verified shape).
 */
const GPT_56_SOL_CAPS: ModelCapabilities = {
  id: 'gpt-5.6-sol',
  provider: 'openai',
  tokenizerId: 'o200k_base',
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  // Sol also ships a new 'max' effort (2026-07-09 launch) — default stays 'high'
  // (mirrors gpt-5.5's max-tier default); opt in via OPENAI_REASONING_EFFORT.
  // effortCeiling 'max' makes that opt-in actually reachable — the resolver's
  // old unconditional xhigh→high clamp silently defeated it.
  thinking: { mode: 'reasoning', effort: 'high', effortCeiling: 'max' },
  contextAware: false,
  premiumInputThreshold: 272_000,
  preferredMaxInputTokens: 272_000,
  cache: OPENAI_CACHE_POLICY,
};

const SEED: readonly SeedEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // Opus 5.5 (2026-09-22) — supersedes Opus 5 as the offered Opus, at $4/$20 (its
  // own 'opus55' rate row in native-pricing). opus-5-5 BEFORE opus-5: the resolver
  // takes the first substring match and 'claude-opus-5-5'.includes('opus-5') is
  // TRUE, so below the 5 row every 5.5 id would resolve as Opus 5 (the Fable 5.1
  // stem hazard again; model-capabilities.opus-5-5.test.ts pins the order).
  {
    match: 'opus-5-5',
    caps: {
      id: 'claude-opus-5-5',
      provider: 'anthropic',
      // Live-probed capable 2026-09-22 on the staging key: HTTP 200, clean end_turn,
      // with tool_search_tool_regex_20251119 plus a defer_loading tool.
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking:{disabled} and budget_tokens 400 at EVERY effort (the
      // Fable rows' rule, unlike Opus 5). effort 'medium' is the API default and a
      // deliberate step down from Opus 5's 'high': Opus 5.5 at medium beats Opus 5
      // at high on Anthropic's coding and knowledge-work evals and thinks MORE per
      // level, so carrying 'high' over would cost more for no measured gain.
      thinking: { mode: 'always_on', effort: 'medium', perMessageEffort: true },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  // Opus 5 (released 2026-07-24) — supersedes Opus 4.8 as the offered Opus. Same
  // lane/caps ($5/$25 via the 'opus' family rate, versions ignored). Opus 4.8's row
  // stays below so historical tasks still resolve + bill.
  {
    match: 'opus-5',
    caps: {
      id: 'claude-opus-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // adaptive: thinking:{type:'adaptive'} + effort; manual enabled → 400
      thinking: { mode: 'adaptive', effort: 'high', perMessageEffort: true },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'opus-4-8',
    caps: {
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // adaptive: thinking:{type:'adaptive'} + effort; manual enabled → 400
      thinking: { mode: 'adaptive', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  // Sonnet 5.5 (2026-09-28) — the offered Sonnet since Sonnet 5 retired 2026-09-29,
  // same $2/$10 on the sonnet5 rate row. sonnet-5-5 BEFORE sonnet-5: 'claude-sonnet-5-5'
  // .includes('sonnet-5') is TRUE, so below the 5 row every 5.5 id would resolve as
  // Sonnet 5 (the opus-5-5 stem hazard; model-capabilities.sonnet-5-5.test.ts pins it).
  {
    match: 'sonnet-5-5',
    caps: {
      id: 'claude-sonnet-5-5',
      provider: 'anthropic',
      // Listed in Anthropic's tool-search compatibility table (checked 2026-09-29).
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking:{disabled} and budget_tokens 400 (its floor is between_tools,
      // which we never send), so the adaptive + display:'summarized' shape rides every
      // turn and carries the notes it writes between tool calls. effort 'medium', not
      // the API's 'high': the levels are recalibrated, and Anthropic starts agentic
      // tool use at medium.
      thinking: { mode: 'always_on', effort: 'medium', perMessageEffort: true },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      // Its minimum cacheable prompt is 512 tokens (Sonnet 5: 1,024).
      cache: { ...ANTHROPIC_CACHE_POLICY, minCacheableTokens: 512 },
    },
  },
  // Sonnet 5 — RETIRED 2026-09-29 for Sonnet 5.5 (row kept so old tasks resolve).
  // Launched 2026-06-30. 1M context, 128k max output. Adaptive thinking like the rest of
  // the 4.6+ family. effort kept at 'medium' to preserve the default-model cost/
  // latency profile of the workhorse slot it replaces (Anthropic ships Sonnet 5
  // at API-default 'high' — bump here if a deeper default is wanted).
  // 'sonnet-5' is disjoint from 'sonnet-4-5'/'sonnet-4-6' (substring-safe).
  {
    match: 'sonnet-5',
    caps: {
      id: 'claude-sonnet-5',
      provider: 'anthropic',
      // Absent from Anthropic's published tool-search table; live-probed capable
      // 2026-08-12 (see the field's doc comment). The probe is the authority.
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // adaptive: thinking:{type:'adaptive'} + effort; manual enabled → 400
      thinking: { mode: 'adaptive', effort: 'medium' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  // Sonnet 4.6 — SUPERSEDED by Sonnet 5 in the picker/defaults, but the seed row
  // STAYS so a task that already ran on claude-sonnet-4-6 still resolves its real
  // caps (1M / 64k / adaptive) on resume instead of degrading to the 8k-output
  // unknown-id fallback. Not selectable (absent from the web catalog).
  {
    match: 'sonnet-4-6',
    caps: {
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      // adaptive: thinking:{type:'adaptive'} + effort; manual enabled deprecated
      thinking: { mode: 'adaptive', effort: 'medium' },
      contextAware: true,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'haiku-4-5',
    caps: {
      id: 'claude-haiku-4-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      // enabled: thinking:{type:'enabled', budget_tokens:N}; NOT in effort-support list → no effort
      thinking: { mode: 'enabled' },
      contextAware: true,
      cache: HAIKU_CACHE_POLICY,
    },
  },
  // fable-5-1 before fable-5: SEED is scanned with `lower.includes(entry.match)`,
  // and 'claude-fable-5-1'.includes('fable-5') is TRUE — the 5 row would swallow
  // every 5.1 id and misreport it as claude-fable-5. Same stem hazard the
  // mythos-preview/mythos-5 pair below guards against.
  {
    match: 'fable-5-1',
    caps: {
      id: 'claude-fable-5-1',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking always on, send NO thinking config (thinking:{disabled} → 400); effort tunes it
      thinking: { mode: 'always_on', effort: 'high', perMessageEffort: true },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'fable-5',
    caps: {
      id: 'claude-fable-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking always on, send NO thinking config (thinking:{disabled} → 400); effort tunes it
      thinking: { mode: 'always_on', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
      // Fable 5 is GA on our account (30-day-retention org; verified live). No
      // `available` flag → treated as available, like every other seed row. The
      // available:false GATE mechanism stays in resolveCapabilities for future use.
    },
  },
  // mythos-preview before mythos-5: both share the 'mythos' stem, and a
  // preview id must not collide with the dated 5 line.
  {
    match: 'mythos-preview',
    caps: {
      id: 'claude-mythos-preview',
      provider: 'anthropic',
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking always on, send NO thinking config (thinking:{disabled} → 400); effort tunes it
      thinking: { mode: 'always_on', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'mythos-5',
    caps: {
      id: 'claude-mythos-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // always_on: thinking always on, send NO thinking config (thinking:{disabled} → 400); effort tunes it
      thinking: { mode: 'always_on', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'opus-4-7',
    caps: {
      id: 'claude-opus-4-7',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // adaptive: thinking:{type:'adaptive'} + effort; manual enabled → 400
      thinking: { mode: 'adaptive', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'opus-4-6',
    caps: {
      id: 'claude-opus-4-6',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // adaptive: thinking:{type:'adaptive'} + effort; budget_tokens deprecated
      thinking: { mode: 'adaptive', effort: 'high' },
      contextAware: false,
      preferredMaxInputTokens: 200_000,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'sonnet-4-5',
    caps: {
      id: 'claude-sonnet-4-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      // enabled: thinking:{type:'enabled', budget_tokens:N}; NOT in effort-support list → no effort
      thinking: { mode: 'enabled' },
      contextAware: true,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  {
    match: 'opus-4-5',
    caps: {
      id: 'claude-opus-4-5',
      provider: 'anthropic',
      supportsToolSearch: true,
      tokenizerId: 'anthropic-claude',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      // enabled: thinking:{type:'enabled', budget_tokens:N}; DOES support effort alongside
      thinking: { mode: 'enabled', effort: 'high' },
      contextAware: false,
      cache: ANTHROPIC_CACHE_POLICY,
    },
  },
  // ── Fireworks (open models) ────────────────────────────────────────────────
  // DeepSeek V4 (Pro + Flash) ride the OpenAI Chat Completions breadth transport
  // via the 'fireworks' provider lane (its own FIREWORKS_API_KEY proxy, separate
  // from OpenAI so concurrent GPT + open-model sessions in one process never
  // collide). Canonical ids are short ('deepseek-v4-pro'); the long Fireworks wire
  // slug (accounts/fireworks/models/deepseek-v4-pro) is applied at the callModel
  // wire boundary by the Fireworks id-rewrite seam. Facts verified vs official
  // Fireworks docs (docs.fireworks.ai/serverless/pricing, app.fireworks.ai,
  // 2026-06-30): ~1M context, reasoning via reasoning_content / reasoning_effort.
  // maxOutputTokens 131,072 (app.fireworks displayed value) — re-verify by live
  // probe; third-party listings claim higher for Flash.
  {
    // REVERSAL 2026-08-17 (founder ruling, Google OAuth verification): Pro returned to the
    // Fireworks lane once Fireworks published the 0813 GA build. Google's Limited Use policy bars
    // sending Google user data to DeepSeek's API (their ToS reserve training rights), so the
    // direct 'deepseek' lane is REMOVED: defaultChatClientFor throws on it.
    // RETIRED BY FIREWORKS (live probe 2026-10-04, staging key): the 0813 build answers 404
    // "Model not found" while /v1/models still lists it. Unavailable, never deleted: old tasks
    // resolve and bill, a pinned task gets the gate's refusal. Successor: the founder's call.
    match: 'deepseek-v4-pro',
    caps: {
      id: 'deepseek-v4-pro',
      provider: 'fireworks',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high', replaysReasoning: true },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
      supportsImageInput: false, // Fireworks OSS lane is text-only
      available: false, unavailableReason: 'DeepSeek V4 Pro was retired by its provider. Pick another model to continue.',
    },
  },
  // DeepSeek V4.1 Flash — every Nami background seat (founder 2026-09-14). Live-probed on our
  // Fireworks account 2026-09-14: slug `deepseek-v4p1-flash`, 1,048,576 context, tools, reasoning in
  // `reasoning_content`, reasoning_effort 'none'/'high'. Max output carried from V4 Flash; image input
  // unprobed, so text-only like its siblings. The id cannot includes-match the V4 Flash row.
  {
    match: 'deepseek-v4.1-flash',
    caps: {
      id: 'deepseek-v4.1-flash',
      provider: 'fireworks',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high', replaysReasoning: true },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
      supportsImageInput: false, // Fireworks OSS lane is text-only
    },
  },
  {
    match: 'deepseek-v4-flash',
    caps: {
      id: 'deepseek-v4-flash',
      provider: 'fireworks',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high', replaysReasoning: true },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
      supportsImageInput: false, // Fireworks OSS lane is text-only
    },
  },
  // ── GLM (open model on Fireworks) ──────────────────────────────────────────
  // GLM 5.2 rides the OpenAI Chat Completions breadth transport (api override below)
  // on the SHARED 'fireworks' provider lane (same as DeepSeek): its own
  // FIREWORKS_API_KEY proxy, separate from OpenAI so concurrent GPT + open-model
  // sessions in one process never collide. The canonical id stays short ('glm-5.2');
  // the long Fireworks wire slug (accounts/fireworks/models/glm-5p2) is applied at
  // the callModel wire boundary by the Fireworks id-rewrite seam. Reasoning rides
  // OpenAI's `reasoning_effort` (not a Z.ai knob). 1M context, 131,072 max output (Fireworks docs, 2026-06-30).
  // RETIRED BY FIREWORKS (live probe 2026-10-04): glm-5p2 answers 404 like V4 Pro above.
  {
    match: 'glm-5.2',
    caps: {
      id: 'glm-5.2',
      provider: 'fireworks',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high', replaysReasoning: true },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
      supportsImageInput: false, // Fireworks OSS lane is text-only
      available: false, unavailableReason: 'GLM 5.2 was retired by its provider. Pick another model to continue.',
    },
  },
  // ── Meta (direct lane) ──────────────────────────────────────────────────────
  // Muse Spark 1.3 CONTRIBUTOR tier — THE offered Muse (founder 2026-09-03: "muse
  // spark 1.3 … thats the latest and lets use that in contributor mode"). Meta's
  // contributor tier is its own model id: heavily discounted ($0.10 / $0.002 /
  // $0.20 per MTok) in exchange for permission to train on prompts + completions
  // (dev.meta.ai/docs/pricing-rate-limits, verified 2026-09-03). Same wire, same
  // lane, same 1,048,576 context as 1.1; max output carried over from 1.1's
  // verified 131,072 (Meta's 1.3 model card lists no separate figure — confirm on
  // the first live turn). MUST precede the 1.1 row (most-specific-first).
  {
    match: 'muse-spark-1.3-contributor',
    caps: {
      id: 'muse-spark-1.3-contributor',
      provider: 'meta',
      tokenizerId: 'o200k_base',
      api: 'openai_responses',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
      // Same weights on Meta's Standard door (see the field doc). Standard never
      // trains on the data, so a sibling round is strictly MORE private.
      unavailableSibling: 'muse-spark-1.3',
    },
  },
  // Muse Spark 1.3 STANDARD — never offered on the picker (the contributor tier is
  // the product; Standard is 12.5×/21× the price). Seeded 2026-09-05 ONLY as the
  // contributor row's `unavailableSibling`: identical weights, Meta trains on
  // nothing. MUST follow the contributor row — 'muse-spark-1.3' is a substring of
  // 'muse-spark-1.3-contributor' (the resolver takes the first match).
  {
    match: 'muse-spark-1.3',
    caps: {
      id: 'muse-spark-1.3',
      provider: 'meta',
      tokenizerId: 'o200k_base',
      api: 'openai_responses',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // Muse Spark 1.1 — SUPERSEDED on the picker by 1.3-contributor (2026-09-03); the
  // row stays so historical tasks resolve + re-price at 1.1's Standard rates.
  // Muse Spark 1.1 (Meta Superintelligence Labs, Meta Model API — their FIRST paid
  // API, launched 2026-07-09). Rides the OpenAI RESPONSES wire — NOT Chat
  // Completions: Meta's cross-turn reasoning continuity uses the Responses
  // `reasoning.encrypted_content` include (their docs warn the chat-completions
  // path "loses the thread in multi-step loops"), which our Responses transport
  // already implements (stateless store:false + encrypted replay). Facts verified
  // vs dev.meta.ai + ai.meta.com 2026-07-15: 1,048,576 context / 131,072 max
  // output; multimodal INPUT (text+image wired here; PDF/video out of scope).
  // UNDARKED 2026-09-03 (founder: "showing gemini and meta now"; keys are
  // provisioned directly on Railway — placeholders declared, real values his).
  {
    match: 'muse-spark-1.1',
    caps: {
      id: 'muse-spark-1.1',
      provider: 'meta',
      tokenizerId: 'o200k_base',
      api: 'openai_responses',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // ── xAI (direct lane) ───────────────────────────────────────────────────────
  // Grok 4.5 — OpenAI-Chat-Completions-compatible at api.x.ai. Facts verified vs
  // docs.x.ai 2026-07-15: 500K context; vision input; premium WHOLE-REQUEST
  // repricing once the prompt reaches 200K ("billed at the higher rate for all
  // tokens in the request") — threshold recorded here, rates in openai-pricing.
  // maxOutputTokens is UNPUBLISHED — seeded conservatively at 32,768; confirm at
  // the key-flip live probe (smoke-live-transports --arm xai) and bump. The
  // 'grok-4.5-latest' alias substring-matches this row. reasoning_effort
  // acceptance is unconfirmed (Grok-4 rejected it) — probe at flip.
  // UNDARKED 2026-07-15. RETIRED 2026-09-29 (with 4.6) for 4.7; the row stays for history.
  {
    match: 'grok-4.5',
    caps: {
      id: 'grok-4.5',
      provider: 'xai',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 500_000,
      maxOutputTokens: 32_768,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      premiumInputThreshold: 200_000,
      preferredMaxInputTokens: 200_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // Grok 4.6 (released 2026-08-12) — same lane, same shape as 4.5. Facts verified
  // vs the OpenRouter endpoints oracle 2026-08-13: 500K context; vision input;
  // same ≥200K whole-request premium repricing; reasoning_effort listed as
  // supported. maxOutputTokens is UNPUBLISHED — seeded conservatively at 32,768
  // like 4.5; confirm via smoke-live-transports --arm xai once the xAI team has
  // credits again (lane is 403-dead on credit exhaustion as of 2026-08-13). The
  // 'grok-4.6-latest' alias substring-matches this row.
  {
    match: 'grok-4.6',
    caps: {
      id: 'grok-4.6',
      provider: 'xai',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 500_000,
      maxOutputTokens: 32_768,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      premiumInputThreshold: 200_000,
      preferredMaxInputTokens: 200_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // Grok 4.7 — same lane, shape and price as 4.6 (docs.x.ai 2026-09-29: 500K context,
  // text + image in, reasoning always on, low…xhigh, default high). It always returns
  // encrypted reasoning, but only on the Responses API: Chat Completions has no field
  // for it, so this lane never sees or replays it. maxOutputTokens UNPUBLISHED: 32,768
  // like 4.5/4.6. The 'grok-4.7-latest' alias substring-matches this row.
  {
    match: 'grok-4.7',
    caps: {
      id: 'grok-4.7',
      provider: 'xai',
      tokenizerId: 'o200k_base',
      api: 'openai_chat_completions',
      contextWindow: 500_000,
      maxOutputTokens: 32_768,
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      premiumInputThreshold: 200_000,
      preferredMaxInputTokens: 200_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // GPT-6 Astra — OpenAI's flagship above the 5.6 family. Seeded 2026-09-05 on
  // the founder's call; verified the same day against the per-model page
  // (developers.openai.com/api/docs/models/gpt-6-astra: 1.05M context, 128K
  // output, text + image input, reasoning low…max, Apr-30-2026 cutoff, >272K
  // premium-input threshold) and live-probed through the staging lane (a
  // Responses call answered on our key — entitlement is real, so no gate).
  // No video input: the watch tool covers it. 'gpt-6-astra' shares no substring
  // with any 'gpt-5.x' match, so its place among the OpenAI rows is free.
  {
    match: 'gpt-6-astra',
    caps: {
      id: 'gpt-6-astra',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      // Founder 2026-09-05: Sol's default ('high'); the top tier is reachable
      // via OPENAI_REASONING_EFFORT but never the default at $50/M output.
      thinking: { mode: 'reasoning', effort: 'high', effortCeiling: 'max' },
      contextAware: false,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
      cache: OPENAI_BOUNDARY_CACHE_POLICY,
    },
  },
  // GPT-6 Sol / Luna (2026-09-23) — succeed 5.6 Sol / Luna in every offer and
  // default (GPT-6 Sol also takes retired Terra's place). Page-verified the same
  // day: 1.05M context, 128K output, >272K premium threshold, text + image input;
  // both live-probed on the staging key (Responses 200). Each keeps its 5.6
  // sibling's effort + ceiling: no GPT-6 eval exists yet, so the swap changes the
  // model and not the effort. GPT-6.1 Sol (2026-09-29, page-verified and probed
  // 2026-09-30, same limits) replaces GPT-6 Sol at effort 'medium' (founder 2026-10-01,
  // OpenAI's own default; ceiling stays 'max'). No match here is a substring of another ('gpt-6.1-sol' vs
  // 'gpt-6-sol', 'gpt-6-astra', any 'gpt-5.x'); there is no bare 'gpt-6' alias row.
  { match: 'gpt-6.1-sol', caps: { ...GPT_56_SOL_CAPS, id: 'gpt-6.1-sol', cache: OPENAI_BOUNDARY_CACHE_POLICY, thinking: { ...GPT_56_SOL_CAPS.thinking, effort: 'medium' } } },
  { match: 'gpt-6-sol', caps: { ...GPT_56_SOL_CAPS, id: 'gpt-6-sol' } },
  {
    match: 'gpt-6-luna',
    caps: {
      id: 'gpt-6-luna',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      // 5.6 Luna's founder call (2026-08-06): max effort on the agent lane.
      thinking: { mode: 'reasoning', effort: 'max', effortCeiling: 'max' },
      contextAware: false,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
      cache: OPENAI_BOUNDARY_CACHE_POLICY,
    },
  },
  // GPT-5.6 family, SUPERSEDED 2026-09-23 (rows kept for historical tasks)
  // (Sol / Terra / Luna, GA 2026-07-09 — verified against the
  // per-model pages on developers.openai.com same day). All three: 1.05M context,
  // 128K output, >272K premium-input threshold, Feb-16-2026 cutoff. The three
  // VARIANT rows MUST precede the bare 'gpt-5.6' alias row ('gpt-5.6' is a
  // substring of all three).
  { match: 'gpt-5.6-sol', caps: GPT_56_SOL_CAPS },
  {
    match: 'gpt-5.6-terra',
    caps: {
      id: 'gpt-5.6-terra',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      // 'max' honored (live probe echoed effort=max, 2026-08-06); default medium.
      thinking: { mode: 'reasoning', effort: 'medium', effortCeiling: 'max' },
      contextAware: false,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  {
    match: 'gpt-5.6-luna',
    caps: {
      id: 'gpt-5.6-luna',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      // Founder call 2026-08-06: Luna runs at MAX effort on the agent lane
      // (supersedes the medium default from the cheap-lane era; the composer
      // router's own effort lives in apps/server composer/openai-stream.ts).
      // 'max' honored by the API — live probe echoed effort=max back.
      thinking: { mode: 'reasoning', effort: 'max', effortCeiling: 'max' },
      contextAware: false,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // Bare 'gpt-5.6' — OpenAI's documented alias for Sol. Resolves to the shared
  // Sol caps (canonical id 'gpt-5.6-sol') so pricing + capabilities land on the
  // real family instead of the inferred-openai fallback.
  {
    match: 'gpt-5.6',
    caps: GPT_56_SOL_CAPS,
  },
  // Superseded GPT-5.4/5.5 rows stay for historical-task resume (the sonnet-4-6
  // precedent) — delisted from the picker catalog, still resolvable here.
  // gpt-5.4-mini MUST precede gpt-5.4 (specificity: 'gpt-5.4' is a substring of
  // 'gpt-5.4-mini').
  {
    match: 'gpt-5.4-mini',
    caps: {
      id: 'gpt-5.4-mini',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 400_000, // TODO verify — mini context window unconfirmed in docs
      maxOutputTokens: 128_000,
      thinking: { mode: 'reasoning', effort: 'medium' },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  {
    match: 'gpt-5.5',
    caps: {
      id: 'gpt-5.5',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      // PR5 item 4: default reasoning effort bumped medium → high (low-risk quality
      // win; resolveOpenAIReasoning still honors an env OPENAI_REASONING_EFFORT
      // override, and the xhigh→high OpenAI clamp is unchanged).
      thinking: { mode: 'reasoning', effort: 'high' },
      contextAware: false,
      premiumInputThreshold: 272_000,
      preferredMaxInputTokens: 272_000,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  {
    match: 'gpt-5.4',
    caps: {
      id: 'gpt-5.4',
      provider: 'openai',
      tokenizerId: 'o200k_base',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      thinking: { mode: 'reasoning', effort: 'medium' },
      contextAware: false,
      cache: OPENAI_CACHE_POLICY,
    },
  },
  // ── Gemini (Interactions API) ───────────────────────────────────────────────
  // Gemini 3.8 Flash — the gemini_interactions dialect (spec 2026-09-03). Facts
  // verified 2026-09-03 vs ai.google.dev + the DeepMind model card: 1,048,576
  // context / 65,536 max output; text+image input wired (audio/video out of
  // scope); thinking on by default (medium). Automatic prefix caching, no
  // breakpoints (OPENAI_CACHE_POLICY). DARK until GEMINI_API_KEY is provisioned
  // (undarked 2026-09-03). The former 'gemini-3-pro' / 'gemini-3-flash' rows
  // (dialect 'gemini', generateContent) named ids Google never shipped under
  // those names and were never probed; retired here, so the legacy dialect has
  // no seeded rows.
  {
    match: 'gemini-3.8-flash',
    caps: {
      id: 'gemini-3.8-flash',
      provider: 'google',
      tokenizerId: 'gemini',
      api: 'gemini_interactions',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      thinking: { mode: 'reasoning', effort: 'medium' },
      contextAware: false,
      supportsVideoInput: true,
      cache: OPENAI_CACHE_POLICY,
    },
  },
];

/**
 * Every canonical model id the registry knows, DEDUPED and in SEED order. Derived
 * from SEED at module load, so a newly-seeded model automatically appears here —
 * the pricing-coverage tripwire (contract/__tests__/pricing-coverage.test.ts)
 * enumerates this to prove every seeded model resolves to an explicit rate, so a
 * rate can never drift silently behind the model list. The bare 'gpt-5.6' alias
 * shares Sol's canonical id, so it collapses into a single entry here.
 */
export const KNOWN_MODEL_IDS: readonly string[] = [...new Set(SEED.map((e) => e.caps.id))];

/**
 * Infer the provider from an id prefix (most-specific prefixes first):
 *   - starts with `gemini` → google
 *   - starts with `claude` → anthropic
 *   - starts with `gpt` or `o` (o-series reasoning models) → openai
 *   - otherwise → anthropic (the default arm)
 */
function inferProvider(lowerId: string): ModelProvider {
  if (lowerId.startsWith('gemini')) return 'google';
  if (lowerId.startsWith('glm') || lowerId.startsWith('accounts/fireworks'))
    return 'fireworks'; // GLM rides the Fireworks lane
  if (lowerId.startsWith('deepseek'))
    return 'fireworks'; // DeepSeek family rides Fireworks US hosting (the direct lane was removed 2026-08-17, Google Limited Use)
  if (lowerId.startsWith('muse')) return 'meta'; // Muse family — Meta Model API direct lane
  if (lowerId.startsWith('grok')) return 'xai'; // Grok family — xAI direct lane
  if (lowerId.startsWith('claude')) return 'anthropic';
  if (lowerId.startsWith('gpt') || lowerId.startsWith('o')) return 'openai';
  return 'anthropic';
}

/**
 * Resolve the capabilities for a model id.
 *
 * Lowercases the input, then returns the first seed row whose family token is a
 * substring of it (seed ordered most-specific-first so dated/aliased ids and
 * sub-variants like gpt-5.4-mini resolve to the correct family). Unknown ids
 * return a conservative fallback (200k context, 8192 out, no thinking) carrying
 * the lowercased input id and an inferred provider, so callers never break on an
 * id we have not hardcoded yet.
 */
export function resolveCapabilities(modelId: string): ModelCapabilities {
  const lower = (modelId ?? '').toLowerCase();

  for (const entry of SEED) {
    if (lower.includes(entry.match)) {
      // Return a fresh object (incl. nested thinking + cache) so callers cannot
      // mutate the shared seed record.
      return {
        ...entry.caps,
        thinking: { ...entry.caps.thinking },
        cache: { ...entry.caps.cache },
      };
    }
  }

  // Unknown id → conservative fallback. The cache policy keys off the inferred
  // provider so a future provider/model id never lands without a policy (cache is
  // a required field). Cloned so callers cannot mutate the shared seed policy.
  // `available` stays ABSENT here → an unknown id is treated as available (we only
  // ever fail-closed on a model we have explicitly marked unavailable).
  const provider = inferProvider(lower);
  return {
    id: lower,
    provider,
    tokenizerId: tokenizerIdFor(provider),
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    thinking: { mode: 'none' },
    contextAware: false,
    cache: {
      ...(provider === 'openai' || provider === 'google' || provider === 'fireworks' ||
      provider === 'meta' || provider === 'xai'
        ? OPENAI_CACHE_POLICY
        : ANTHROPIC_CACHE_POLICY),
    },
    // Fail-closed on the text-only OSS lane: an unknown fireworks-inferred id
    // (a future GLM/DeepSeek variant) is text-only until seeded otherwise; every
    // other provider defaults to vision-capable (field ABSENT, read as capable).
    ...(provider === 'fireworks' || provider === 'deepseek' ? { supportsImageInput: false } : {}),
  };
}

/** The tokenizer family for a provider that has no seed row (the unknown-id fallback). */
function tokenizerIdFor(provider: ModelProvider): ModelCapabilities['tokenizerId'] {
  if (provider === 'google') return 'gemini';
  if (provider === 'openai' || provider === 'fireworks' || provider === 'meta' || provider === 'xai')
    return 'o200k_base';
  return 'anthropic-claude';
}

/**
 * True unless the model is explicitly marked unavailable (`available === false`).
 * ABSENT `available` (every seed row today, plus unknown-id fallbacks) means
 * AVAILABLE — so the gate is fail-closed only for ids we have deliberately
 * disabled. Pure, never throws. Provider-VALUE based; no runtime/harness branch.
 */
export function isModelAvailable(modelId: string): boolean {
  return resolveCapabilities(modelId).available !== false;
}

/**
 * True unless the model is explicitly marked text-only (`supportsImageInput === false`).
 * ABSENT `supportsImageInput` (every multimodal row + non-fireworks unknown ids)
 * means CAPABLE — so only the Fireworks OSS lane (GLM / DeepSeek) fails-closed.
 * The single predicate the server submit-gate and the transport image-strip both
 * call. Pure, never throws. Provider-VALUE based; no runtime/harness branch.
 */
export function modelSupportsImageInput(modelId: string): boolean {
  return resolveCapabilities(modelId).supportsImageInput !== false;
}

/** True only when the registry says so — the default is blind (no surprise uploads). */
export function modelSupportsVideoInput(modelId: string): boolean {
  return resolveCapabilities(modelId).supportsVideoInput === true;
}

/**
 * True ONLY for models whose seed row explicitly carries `supportsToolSearch`.
 * Note the inverted polarity vs `modelSupportsImageInput` above: this fails
 * CLOSED, because `defer_loading` on a model that does not accept it is a hard
 * 400 on every turn, and an unknown id resolves to a fallback row that carries
 * no such claim. Pure, never throws. Provider-VALUE based; no runtime/harness
 * branch. This is the ONLY eligibility source — never hand-list model ids at a
 * call site.
 */
export function modelSupportsToolSearch(modelId: string): boolean {
  return resolveCapabilities(modelId).supportsToolSearch === true;
}
