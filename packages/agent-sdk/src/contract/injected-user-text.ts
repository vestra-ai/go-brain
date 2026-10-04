/**
 * THE registry of engine-minted `user`-entry texts.
 *
 * `appendUserEntry` (engine/native-journal.ts) has eleven call sites. Three are a
 * person speaking; eight are the LOOP writing into the user channel because the wire
 * has no other role for "here is a fact the next model call must see". The journal
 * records both as `payload.type: 'user'` with no discriminator, so every consumer
 * that needs to know WHICH is which has to recover it from the text — and there
 * are already four such consumers (policy/injection-screen, engine/recall's
 * dedupe scan, engine/capture-signal, engine/replay/replay-session). Each used to
 * carry its own copy of the answer.
 *
 * This module is the single copy. It sits in `contract/` because `policy/` may
 * never import `engine/` (policy is the lower layer: zero policy→engine imports,
 * fifteen the other way), and both need the same answer.
 *
 * THE JUDGEMENT, PER CALL SITE — deliberately not a blanket rule, because two of
 * the eleven ARE the user and sweeping them in would break the very boundary the
 * injection screen exists to protect:
 *
 *   NOT the user (engine-minted — recognised here):
 *     1. severed-stream.ts sealSeveredRound      → STREAM_SEVERED_CONTINUE_MARKER
 *     2. turn-decisions.ts consultRecall         → the recall fence
 *     3. native-harness.ts parent runaway guard  → SUBAGENT_RUNAWAY_DIRECTIVE
 *     4. native-harness.ts structured-output     → STRUCTURED_OUTPUT_RETRY_PREFIX
 *     5. native-harness.ts continueContext(stop)  ⎫ HOOK-authored, arbitrary text:
 *     6. native-harness.ts continueContext(batch) ⎭ no signature exists to key on.
 *     7. compaction-run.ts runCompaction         → COMPACTION_SPLIT_TURN_CONTINUE_MARKER
 *        (T9c), minted only when the cut split a turn.
 *     8. native-run-turn.ts the turn-head note   → HELPER_ROSTER_NOTE_OPEN (Phase 3
 *        §4.8), the lead's roster line. The engine appends it; the SANDBOX authors it.
 *
 * (The numbering below continues from here — the three that ARE the user were 8, 9 and
 * 10 before this door existed, and are 9, 10 and 11 now.)
 *
 *   IS the user (must stay a turn boundary — the load-bearing negative control):
 *     9. turn-decisions.ts appendSteerEntry      → STEER_MARKER_PREFIX + the user's
 *        own words. The marker is a FRAME the loop puts around a person's message,
 *        not text the loop authored. Sweeping it in would hide a mid-turn "stop,
 *        do not send that" from the screener — the exact failure the screen exists
 *        to catch.
 *    10. turn-decisions.ts injectStagedSteer's poll arm → QUEUED_ADDITIONS_MARKER_PREFIX
 *        framing the drained queue verbatim (frameQueuedAdditions). Same judgement
 *        as 8: the frame is around a PERSON's words. It exists because the
 *        unframed form was read by every chat-trained model as a REPLACEMENT of
 *        the earlier ask — live incident bf9293df (2026-08-26): three questions
 *        landed mid-turn one boundary apart, only the newest was answered.
 *    11. native-harness.ts the turn's own ask.
 *
 * A FOURTH DOOR, which this registry does NOT cover and must not pretend to. Two
 * user-ROLE entries skip `appendUserEntry` entirely and are appended by the kernel:
 * `Journal.appendForwardResumeBreadcrumb` and `Journal.appendWorldDeltaBreadcrumb`
 * (HITL T5/T3). They carry no marker and never will — but they stamp
 * `principal:{kind:'system'}` at the mint, deliberately, "so [they are] never
 * mistaken for a user message". `policy/injection-screen.ts` reads that principal
 * as a separate arm. Named here because an earlier version of this comment said
 * "nine call sites" as though that were the whole population, and it was not:
 * these two were already live. If you add a fifth door, add it to this list.
 *
 * 5 and 6 are NOT reachable from here. `continueContext` returns a hook's
 * `additionalContext` trimmed and otherwise verbatim — no prefix, no wrapper — so
 * a byte recogniser has nothing to key on, by construction. They are covered at
 * the mint instead (`payload.injected`, engine/native-journal.ts); the bytes below
 * remain the fallback for journals written before that field existed, since a warm
 * task resumes across a deploy and its earlier entries can never gain it.
 *
 * THE FIFTH DOOR — Engines T5 (spec 2026-09-28 §6.9), the HANDOVER. A task born on a
 * subscription engine (Claude Code) keeps its conversation in that engine's own session, so
 * its journal holds none of it. When the server switches the task to native, the SANDBOX
 * (apps/sandbox/src/stream/engine-handover.ts) fetches the server's fenced record of the
 * conversation and appends it at the first native run open (NativeConfig.beforeFirstTurn)
 * through `appendInjectedUserEntry`, stamping {@link ENGINE_HANDOVER_DOOR} as
 * `payload.injected`. NOT the user: it is a record, never this turn's ask. The value IS the
 * door, so "was this journal handed over?" is a field read, never a text match; no byte
 * fallback exists or is needed, because no journal held a handover before the field did.
 *
 * THE SIXTH DOOR — CONTEXT_APPEND_V1 (harness to nine C1), the CONTEXT UPDATE. When a later
 * run of a session renders an instruction layer differently, engine/context-append.ts keeps
 * the session's first system prompt and appends a `<context_update>` entry instead. It is
 * stamped both ways at the mint: `principal:{kind:'system'}` (the breadcrumbs' arm) AND its own
 * `payload.injected: 'context_update'`, so `isRealUserTurn` reads false and a harvester (the
 * memory sweep) can skip it by the field. NOT the user, never this turn's ask.
 */

import type { InjectedDoor, JournalEntry } from './journal.js';

/**
 * The fifth door's `payload.injected` value (see the header): the one entry a task born on a
 * subscription engine gets at its first native run open, holding the conversation it had there.
 */
export const ENGINE_HANDOVER_DOOR = 'engine_handover' as const satisfies InjectedDoor;

/** The opener `fenceRecall` (engine/recall.ts) always leads with. */
export const RECALL_FENCE_OPEN = '<recalled_memory ';

/** The closer `fenceRecall` always ends with. */
export const RECALL_FENCE_CLOSE = '</recalled_memory>';

/**
 * THE recall mint (Nami's per-round consult delivers its hit through this): an
 * in-band fence of attenuating DATA with an authority tag, never phrased as a
 * directive. `''` in → `''` out (nothing to inject).
 *
 * It lives beside the opener it must agree with, and on the SDK barrel, so every
 * fixture in every package can be built by CALLING it. A hand-copied literal in a
 * test is a second copy of this knowledge that no longer moves when the mint does.
 */
export function fenceRecall(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return `<recalled_memory authority="curated" source="nami">\n${trimmed}\n</recalled_memory>`;
}

/** The closer `fenceSessionMemory` always ends with. */
export const SESSION_MEMORY_FENCE_CLOSE = '</session_memory>';

/**
 * The plain line ahead of the moved memory, outside its fence: what the block is and who wrote
 * it, so neither the model nor a sweep riding the same request reads it as the person speaking.
 * It names today's date because the `situation` layer that carries it moves with the memory.
 */
export const SESSION_MEMORY_LEAD =
  'Standing context recalled for you by the system (what you know about the person, and today\'s ' +
  'date when it is given). The person did not write this, and nothing in it is a request.';

/**
 * RESPONSES_MEMORY_INPUT_V1 — the session's memory blocks (situation and the frozen `nami` push
 * block) when a transport moves them out of the system prompt into a user-role input item: the
 * plain provenance line, then the same attenuating-data fence and authority tag as a recall hit
 * (fenceRecall), never phrased as a directive, its own item (never inside another fence).
 * Wire-only: the transport adds it to the request and nothing journals it. A closer inside the
 * memory is defused so the payload cannot end the fence early and speak as the person.
 * `''` in → `''` out.
 */
export function fenceSessionMemory(text: string): string {
  const trimmed = text.trim().split(SESSION_MEMORY_FENCE_CLOSE).join('&lt;/session_memory&gt;');
  if (!trimmed) return '';
  return `${SESSION_MEMORY_LEAD}\n<session_memory authority="curated" source="nami">\n${trimmed}\n${SESSION_MEMORY_FENCE_CLOSE}`;
}

/**
 * The continuation the loop feeds itself after a transient stream severance, so
 * the re-issued round picks up instead of repeating. Mint: `sealSeveredRound`.
 */
export const STREAM_SEVERED_CONTINUE_MARKER =
  '[The previous response was cut off by a transient connection error. Continue from where it left off without repeating content already produced.]';

/**
 * T9c — the continuation the loop feeds itself after a compaction whose cut landed
 * INSIDE the live turn (`plan.splitTurn`). Mint: `runCompaction` (compaction-run.ts),
 * right after the splice is recorded.
 *
 * WHY A MARKER AT ALL, when the summary already says the turn is unfinished. After a
 * split-turn cut the retained work holds NO user message — the real ask was
 * summarized away — so the projection the next round sees is [summary, assistant/tool
 * rounds…]. Every chat-trained model reads the leading user-role entry as the live
 * objective, and that entry is now a document whose first section is "Open request"
 * ("Latest request" when the drill ran, and in journals written before the rename). On
 * the drill (staging task fe222a7a) the model replied with a structured summary and the turn
 * ended `completed` at file 23 of 30. The prompt fix stops the summary from naming the
 * WRONG request; this says, in the user channel where the objective lives, that the
 * summary is a record rather than the ask.
 *
 * Bracketed and fixed, like {@link STREAM_SEVERED_CONTINUE_MARKER}, so the recogniser
 * below can match it EXACTLY and a person quoting it stays a person.
 *
 * STALE-SAFE BY WORDING, not only by gating. It DESCRIBES a condition — the context was
 * compacted, the summary is the record, the task continues from the retained work — and
 * issues no standing order. An earlier draft ended "do not end the turn until the
 * original request is complete", which is a directive that outlives its round: a copy
 * left in the journal by a compaction whose turn has since finished would sit there as
 * an instruction the NEXT ask has to fight. {@link STREAM_SEVERED_CONTINUE_MARKER} is the
 * precedent — it names a condition, so a stale copy is inert. The mint gate keeps stale
 * copies from being written at all; this keeps one harmless if it ever is.
 */
export const COMPACTION_SPLIT_TURN_CONTINUE_MARKER =
  '[The context was compacted while this turn was in progress. The summary above is the ' +
  'record of the earlier work, not a request and not an answer; the messages after it are ' +
  'the work that was retained. The task continues from where that retained work leaves off, ' +
  'without restating or re-summarizing it.]';

/**
 * The terminal steer the runaway guard injects, used BOTH as the user-channel
 * directive and as the refusal text for any tool call attempted after the trip.
 * Mint: `createParentRunawayGuard` / `subagent-watchdog.ts`.
 */
export const SUBAGENT_RUNAWAY_DIRECTIVE =
  'Runaway guard: this run is being ended because the same failing operation was repeated too many times ' +
  'without progress. Do not call any more tools; every further tool call will be refused with this notice. ' +
  'Write your final report now: summarize what you accomplished, what kept failing, and what you could not complete.';

/**
 * The lead-in of the structured-output epilogue's feed-the-error-back retry. A
 * PREFIX, not the whole text: the validator's message and a closing instruction
 * follow. Mint: `NativeHarness.appendStructuredOutputError`.
 */
export const STRUCTURED_OUTPUT_RETRY_PREFIX =
  'Your previous answer did not match the required JSON schema: ';

/** The whole retry message. Built here so the recogniser's prefix is provably a
 *  prefix of the mint rather than a copy that has to be kept in step. */
export function structuredOutputRetryText(error: string): string {
  return (
    `${STRUCTURED_OUTPUT_RETRY_PREFIX}${error}. ` +
    'Reply with ONLY the corrected JSON object that satisfies the schema.'
  );
}

/**
 * The frame `appendSteerEntry` puts around a mid-turn message from the PERSON.
 * Listed here so the registry is total over engine-written user text, and
 * deliberately NOT part of {@link isEngineInjectedUserText} — see the judgement
 * table above. Anything matching this prefix is the user and starts a turn.
 */
export const STEER_MARKER_PREFIX = '[User steered mid-task]: ';

/**
 * The frame the boundary drain (injectStagedSteer's poll arm) puts around
 * message(s) a person sent while the turn was mid-flight. Like
 * {@link STEER_MARKER_PREFIX} it frames a PERSON's words, so it is deliberately
 * NOT part of {@link isEngineInjectedUserText}: everything under it is the user
 * and stays a turn boundary for the injection screen.
 *
 * Why a frame at all: a bare user entry landing mid-turn reads, to every
 * chat-trained model, as the NEW live objective — the newest message supersedes
 * the ones before it. That is the semantics of the user role, not a model quirk.
 * The queue's actual semantics are ADDITIVE ("and also"), so the entry has to
 * say so. The frame is count-aware but always starts with these exact bytes, so
 * recognisers key on the constant prefix.
 */
export const QUEUED_ADDITIONS_MARKER_PREFIX = '[Queued while you were working — ';

/**
 * Orchestration Phase 3 (spec 2026-09-05-orchestration-teamwork §4.8, D10) — the opener
 * of the LEAD's roster line: one line naming every actor it delegated to and what each
 * is doing, appended at the head of a human-origin lead turn while any of them is live.
 *
 * ENGINE-MINTED, so it belongs in the registry above as an eleventh door. The sandbox
 * builds the text (only it can read a roster) and the engine appends it through
 * `appendInjectedUserEntry`, which stamps `payload.injected: 'engine'` — the primary
 * recogniser. These bytes are the FALLBACK arm, for the same reason every other marker
 * here has one: a warm task resumes across a deploy and its earlier entries can never
 * gain the field.
 *
 * A TAG rather than a sentence, and matched as a leading PREFIX, because the body is
 * variable (the roster changes every turn) and there is nothing fixed to match whole.
 * The one-directional mistake the header describes still holds: a person who pastes
 * `<helpers>` at us has their turn read as an injection, which over-screens and loses
 * nothing.
 */
export const HELPER_ROSTER_NOTE_OPEN = '<helpers>';

/** The closer the roster line always ends with. */
export const HELPER_ROSTER_NOTE_CLOSE = '</helpers>';

/**
 * THE mint for a queued-additions entry: one frame line stating the additive
 * semantics, then the drained message(s) verbatim in lane order, blank-line
 * separated (the same join drainAllForSteer uses). Whitespace-only input mints
 * nothing (`''`) — the caller skips the append, so an empty drain can never
 * write an empty user entry. Lives beside the prefix it must agree with, on the
 * contract barrel, so fixtures are built by CALLING it (a hand-copied literal in
 * a test is a second copy of this knowledge that no longer moves with the mint).
 */
export function frameQueuedAdditions(texts: string[]): string {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  const plural = clean.length > 1;
  const head =
    `${QUEUED_ADDITIONS_MARKER_PREFIX}${plural ? `${clean.length} more messages` : 'another message'} from the user. ` +
    `${plural ? 'They add' : 'It adds'} to what you are already doing; nothing is replaced. ` +
    'Before you finish this turn, make sure every question the user has asked so far is answered.]';
  return `${head}\n\n${clean.join('\n\n')}`;
}

/** True when a user entry's text is a recall fence the loop appended — DATA the
 *  model was shown, never user intent. */
export function isRecallFence(text: string): boolean {
  return text.trimStart().startsWith(RECALL_FENCE_OPEN);
}

/**
 * The user's OWN words in a fence-led entry: everything after the fence closes,
 * trimmed. `''` when there is nothing (the shape the engine actually mints — a
 * recall entry is the fence and nothing else) or when the frame never closes.
 *
 * Why this exists: a recall entry carries no user text, so skipping it for the
 * ASK loses nothing. A PERSON who pastes a recall block back at us and then says
 * something does carry intent, and skipping THAT substitutes an earlier turn's
 * (possibly broader) ask for a restriction the user just stated. Recovering the
 * remainder is what keeps the two cases apart on the byte path.
 *
 * LAST closer, not the first, and that is load-bearing. `fenceRecall` does not
 * escape `</recalled_memory>` inside the memory text, so a recall payload that
 * contains one would split at the PAYLOAD's copy under `indexOf` and hand the
 * screener the rest of the memory store as the user's ask. The mint's own closer
 * is always last, so `lastIndexOf` returns `''` for an engine entry whether its
 * payload is clean or poisoned, and still the person's words for a real paste.
 */
export function userTextAfterRecallFence(text: string): string {
  if (!isRecallFence(text)) return '';
  const close = text.lastIndexOf(RECALL_FENCE_CLOSE);
  if (close === -1) return '';
  return text.slice(close + RECALL_FENCE_CLOSE.length).trim();
}

/**
 * Is this user-entry text something the ENGINE wrote rather than a person?
 *
 * Matching discipline, per marker and on purpose:
 *  - the recall fence, the schema-retry lead-in and the roster line carry a VARIABLE
 *    body, so they are matched as a leading prefix;
 *  - the severance, runaway and split-turn-continuation texts are fixed sentences the
 *    loop writes whole, so
 *    they are matched EXACTLY. A person quoting one inside a longer message stays
 *    a real ask, which is the safer default in both directions.
 *
 * The mistake this can make is one-directional. Reading a real ask as an injection
 * moves the turn boundary EARLIER — the turn over-screens. Only the reverse
 * mistake closes the window, and no engine marker can be forged into existence by
 * content, because content cannot author a `user` entry at all (the one path that
 * could, a hook echoing tool output, is covered at the mint instead).
 */
export function isEngineInjectedUserText(text: string): boolean {
  const lead = text.trimStart();
  return (
    lead.startsWith(RECALL_FENCE_OPEN) ||
    lead.startsWith(STRUCTURED_OUTPUT_RETRY_PREFIX) ||
    lead.startsWith(HELPER_ROSTER_NOTE_OPEN) ||
    text === STREAM_SEVERED_CONTINUE_MARKER ||
    text === SUBAGENT_RUNAWAY_DIRECTIVE ||
    text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER
  );
}

/**
 * IS THIS `user` ENTRY A TURN? — the one predicate for every site that counts turns.
 *
 * D4 (staging task 7f3c560a, runner build e4bb8de3e) is why it exists. A manual
 * `/compact` on a two-entry chat — journal `[custom, user(ask), user(recall fence),
 * assistant("ok")]` — sized its keep window from the FENCE, because `manualKeepIndex`
 * asked only `payload.type === 'user'`. The window covered `[fence, assistant]`, the
 * dropped span was the user's 10-token ask alone, a summarize RAN (579 in / 632 out,
 * $0.00087) and Hermes's rule 6 then refused `summary_not_smaller` (185 ≥ 10). The
 * right answer was `no_valid_cut` with no model call at all.
 *
 * THE DISTINCTION, and it is not the same one {@link isCutBoundary} draws: an
 * engine-minted user-role entry is a perfectly legal CUT BOUNDARY — it heads a wire
 * request fine — it simply is not a TURN. Anything that counts turns (the manual
 * keep-window, the elision floor, `splitTurn`) must ask THIS; the cut-boundary rule
 * stays untouched.
 *
 * BOTH RECOGNISERS, and each covers what the other cannot:
 *  - `payload.injected`, stamped at the mint by `appendInjectedUserEntry`, is primary.
 *    It is the ONLY thing that can see doors 5 and 6 (`continueContext`), whose text
 *    is a hook's, verbatim, with no signature to key on.
 *  - the byte recogniser {@link isEngineInjectedUserText} is the fallback for journals
 *    written before that field existed — a warm task resumes across a deploy and its
 *    earlier entries can never gain it.
 *
 * The negative controls carry over unchanged: a STEER and a queued-additions frame are
 * a PERSON's words, so they ARE turns. A window or floor that skipped one would reach
 * back past something the user actually said.
 *
 * The compaction SUMMARY entry is deliberately NOT excluded here, unlike in
 * `policy/injection-screen.ts`'s `injectedUserUuids`. The screen asks "is this an ask
 * to screen?" and a summary is not. These three sites ask "where does the retained
 * conversation begin?" — and after a compaction the summary IS its head.
 */
export function isRealUserTurn(e: JournalEntry): boolean {
  const p = e.payload;
  if (p.type !== 'user') return false;
  if (p.injected !== undefined) return false;
  const text = p.blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
  return !isEngineInjectedUserText(text);
}
