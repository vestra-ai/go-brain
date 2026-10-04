export * from './journal/journal.js';
// P2.0 — entry validation is PURE (contract-only imports), so it is root-safe.
export * from './journal/validate-entry.js';
// P2.3 — step-result memo store is PURE (contract imports + node:crypto, like
// clock.js), so it is root-safe; Task 8's Weave/subagent consult imports it here.
export * from './journal/step-memo.js';
// jsonl-store.js (node:fs) is NOT in the pure root — it is re-exported from the
// @vestra/agent-sdk/engine batteries entry. See engine/index.ts + the ring-E
// node:fs-in-root fix (context/volume-context-port.js moved out for the same reason).
export * from './journal/session-store.js';
export * from './journal/lossless-mirror.js';
// The mirror's row clamp and window (pure): the tidy sweeper's upload sends a journal's owed
// entries in the same windows, clamped the same way, as Journal.flushMirror does.
export { clampForMirror, mirrorWindow, MIRROR_MAX_ENTRY_BYTES } from './journal/mirror-clamp.js';
// The crash-heal's side-effect classifier (pure): the Mac lane's write-ahead asks it which calls
// must reach the mirror before they run (continue anywhere §6.3).
export { mayHaveRunSideEffect } from './journal/side-effect-classifier.js';
export * from './journal/clock.js';
export * from './journal/journal-stats.js';
export * from './journal/token-ledger.js';
export * from './journal/plan.js';
// R3 (TASK_FORK_V1): fork a journal at a turn's end (pure; the writer takes its JsonlStore in).
export * from './journal/fork.js';
export * from './compaction/compactor.js';
export * from './compaction/prune.js';
export * from './compaction/elide.js';
export * from './compaction/trigger.js';
export * from './compaction/overflow.js';
export * from './compaction/file-trail.js';
export * from './compaction/subagent-ceiling.js';
export * from './compaction/prune-screenshots.js';
export * from './compaction/prune-snapshots.js';
export * from './compaction/media-rail.js';
export * from './compaction/archive.js';
export * from './context/context-port.js';
// nami open-taxonomy memory: claim ledger + curator + wedge skill detector. All
// PURE (no node:fs — retrieval-context-port.js, which does I/O, stays in /engine),
// so they are root-safe and the server can import the curator via @bash/kernel.
export * from './context/claims.js';
export * from './context/curator.js';
// The production capture judge (prompt + JSON->RawClaim parse + factory) lifted out
// of apps/server as the single source of truth, so the server and the eval both
// import the byte-identical judge.
export { CAPTURE_EXTRACTION_SYSTEM_PROMPT, parseRawClaims, makeCaptureExtractor } from './context/capture-extractor.js';
// nami brain v2 §3c — the predict-then-residual capture judge, ADDED alongside the
// v1 extractor (the CaptureJudge seam itself flows from `export * from curator.js`).
export {
  CAPTURE_JUDGE_V2_SYSTEM_PROMPT,
  NOT_A_SKILL,
  parseCandidateClaims,
  makeCaptureJudge,
} from './context/capture-extractor.js';
export type { CandidateClaim } from './context/capture-extractor.js';
// Robust LLM-JSON extraction (tolerates leading/trailing prose around the value).
export * from './context/llm-json.js';
export * from './context/skills.js';
// nami Wiki (Vestrapedia): pure synthesis kernel over the claim ledger, behind a
// Haiku WikiSynthesizer seam. Root-safe (no node:fs).
export * from './context/wiki.js';
// …and the derived link graph + lint pass over that index, split out of wiki.js at its
// file-size ratchet. Re-exported here so the package door is unchanged by the split.
export * from './context/wiki-graph.js';
// Vestrapedia v2 editor: the op vocabulary the GLM editor emits (create/rewrite/
// merge/delete) + the deterministic validator the apply layer runs before any
// filesystem write. Pure (no node:fs), root-safe.
export * from './context/wiki-editor-ops.js';
// Vestrapedia v2 editor: deterministic entity resolution cascade (normalized
// exact -> trigram-Jaccard fuzzy, entropy-gated) that every `create` op passes
// through before it can mint a page. No LLM, no node:fs, root-safe.
export * from './context/wiki-entity-resolve.js';
// nami brain v2 capture: the CaptureEpisode (full-fidelity journal-block input to
// the judge; distinct from the legacy skill-log Episode in skills.js) + the §3a
// salience prefilter (encode-on-surprise gate). Both PURE.
export * from './context/episode.js';
export * from './context/salience.js';
// nami brain v2 §3b — convoCorrection: the harness-agnostic repair-marker heuristic
// that ROUTES a free-text user correction to the judge (the salience-prefilter recall
// blind-spot fix). Routes only; extracts nothing. PURE.
export * from './context/convo-correction.js';
// nami brain v2 §G — controlled predicate vocabulary: the cheap, no-embeddings
// dedup-canonicalization layer (semanticKey) consumed by claim merge. PURE; storage
// stays open-vocab (unknown predicates fall back to their normalized self).
export * from './context/predicate-registry.js';
export * from './interaction/strategy.js';
export * from './hooks/contract.js';
export * from './hooks/dispatcher.js';
