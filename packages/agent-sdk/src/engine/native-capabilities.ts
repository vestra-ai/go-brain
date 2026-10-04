import { defaultCapabilities, type HarnessCapabilities } from '../contract/capabilities.js';

/**
 * The native Anthropic arm calls the raw Messages API. It returns token usage
 * but NOT dollar cost → reportsCostUsd:false, and the arm derives USD and
 * surfaces cumulative billing on every turn_end (the LEAK-1 event seam).
 */
export const NATIVE_CAPABILITIES: Readonly<HarnessCapabilities> = Object.freeze(
  defaultCapabilities({
    thinking: true,
    // honest as of K4-T8: cache_control on system prefix + tools tail + rolling
    // conversation breakpoint + ~15-block intermediates (anthropic-transport.callModel)
    promptCaching: true,
    inlineToolArgRewrite: true,   // we control the tool loop → can honor updatedInput
    resumeSurvivesRestart: true,  // journal-backed history rehydrates on cold start
    nativeSubagents: true,        // K5 batch-2: the `Agent` tool spawns nested native subagent runs
    reportsCostUsd: false,
    surfacesTerminalReason: true, // K6 P4: derives + surfaces its own user-facing terminal reason (no native SDK footer)
    steerMidTurn: true,           // P3 STEER V2: wires BOTH halves — actor.roundAbort + cfg.drainSteerText
    rewind: true,                 // P2.4: owns its journal → Journal.rewindTo + applyRewind pivot the projection (no product entry point invokes it yet)
    usesWarmQueryPool: false,     // K1 v0: construct per-turn (warm pool is a later optimization)
    maxContextTokens: 200_000, // conservative fallback; NativeHarness.iterateTurn resolves the authoritative per-model value at runtime via resolveMaxContextTokens(ctx.model) from @bash/kernel (K4-T0).
  }),
);
