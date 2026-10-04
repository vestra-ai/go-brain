/**
 * capture-signal.ts — P5 Task 3 (Nami in the loop): the in-loop
 * write-on-surprise signal, computed at turn finalization from what the loop
 * already holds — no model call, no I/O, PURE.
 *
 * COMPOSES the kernel salience machinery (the audit's compose-don't-fork
 * ruling): the turn's signals are read into a `SalienceVector`, scored by
 * `prefilterScore`, and gated by `passesPrefilter` — the SAME
 * encode-on-surprise gate the server-side capture path runs, so the two can
 * never drift on what "surprising" means. Correction detection reuses
 * `detectConvoCorrection` over a turn-scoped block window: THIS turn's user
 * entry, preceded by the PRIOR agent work it could be correcting — so a
 * repair marker in an opener ("no thanks, just…") never fires, and a prior
 * turn's correction never re-fires.
 *
 * Signals the loop cannot measure stay `null` (the kernel's UNKNOWN
 * discipline — never a fabricated 0): silentFailure, userRedirected,
 * rewindOnTask, supersedes.
 *
 * When `shouldCapture`, the engine journals ONE `custom` entry
 * (`key:'nami_capture'`, CONTEXT_POLICY:false — durable, survives recycle,
 * never replays into context) and yields a `raw` HarnessEvent named
 * `NAMI_CAPTURE_SIGNAL_EVENT`; the driver's sink forwards it up the socket
 * and the server routes it to the EXISTING capture consumer
 * (triggerShadowCurator + the trigger fabric) — event-driven "encode
 * surprise, not frequency", as a trigger change, not a storage change.
 */
import type { JournalEntry } from '../contract/journal.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import { isRealUserTurn } from '../contract/injected-user-text.js';
import {
  detectConvoCorrection,
  passesPrefilter,
  prefilterScore,
  type JournalBlock,
  type SalienceVector,
} from '../kernel/index.js';

/**
 * ring 4c.9 mirror — byte-identical to `EVENTS.NAMI_CAPTURE_SIGNAL` (@bash/shared
 * events.ts). Inlined so the engine reads no `@bash/*`; a conformance assertion
 * (capture-signal.test.ts + the sandbox suite) proves the values match.
 */
export const NAMI_CAPTURE_SIGNAL_EVENT = 'nami:capture_signal';

/** How many entries BEFORE the turn's user entry feed the correction window. */
const PRIOR_CONTEXT_WINDOW = 20;

/** The turn's surprise assessment — the wire/journal payload shape. */
export interface TurnSurprise {
  /** detectConvoCorrection fired on THIS turn's user text (forcing label). */
  correction: boolean;
  outcomeKind: TurnOutcome['kind'];
  /** A categorical route-to-capture: correction OR a declined/blocked outcome. */
  forcing: boolean;
  /** prefilterScore over the measured vector (forcing labels weigh 0 there). */
  score: number;
  /** The measured vector — shouldCapture gates on it via passesPrefilter. */
  vector: SalienceVector;
}

function textOf(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Map one CONTEXT journal entry to the episode JournalBlock shape (or null). */
function toBlock(e: JournalEntry): JournalBlock | null {
  const p = e.payload;
  switch (p.type) {
    case 'user':
      return { kind: 'user', text: textOf(p.blocks) };
    case 'assistant':
      return { kind: 'assistant', text: textOf(p.blocks) };
    case 'tool_use':
      return { kind: 'tool_use', text: p.name };
    case 'tool_result':
      return { kind: 'tool_result', text: textOf(p.blocks), ...(p.isError ? { isError: true } : {}) };
    default:
      return null;
  }
}

/**
 * Assess THIS turn's surprise off the journal projection + the settled outcome.
 * Pure; never throws. `entries` is the projected context (the same warm
 * `journal.project()` read the loop already does); the turn's span = everything
 * from the LAST user entry onward, with up to PRIOR_CONTEXT_WINDOW earlier
 * agent-action entries feeding the correction detector's preceding-action guard.
 */
export function assessTurnSurprise(
  entries: JournalEntry[],
  outcome: TurnOutcome,
  pausedHalt: boolean,
): TurnSurprise {
  // The turn's user entry = the LAST user entry in the projection (run()
  // appends it at turn start; a mid-turn steer would supersede it — also a
  // user utterance of this turn, so equally valid as the correction target).
  let userIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = entries[i].payload;
    if (p.type === 'user') {
      // Skip EVERY engine-minted user entry (P5 Task 2's cache-honest recall
      // delivery rides user entries, and so do the severance/runaway/T9c markers):
      // they are DATA the model was shown, not user intent — "a remembered fact
      // containing 'no'/'not' must never false-fire the correction detector", and
      // the same holds for anything else the loop wrote.
      //
      // This asked for `isRecallFence` alone, which the T9c continuation marker
      // walked straight past: `detectConvoCorrection` matches "not" in "do not
      // restate it", so every split-turn-compacted turn reported a user correction
      // to Nami's capture pipeline. A STEER stays visible — it is the person
      // speaking, and an equally valid correction target.
      if (!isRealUserTurn(entries[i])) continue;
      userIdx = i;
      break;
    }
  }

  // Correction window: prior agent work (the preceding-action guard) + THIS
  // turn's user entry ONLY — a prior turn's user correction never re-fires.
  let correction = false;
  if (userIdx >= 0) {
    const prior: JournalBlock[] = [];
    for (let i = Math.max(0, userIdx - PRIOR_CONTEXT_WINDOW); i < userIdx; i++) {
      const b = toBlock(entries[i]);
      if (b && b.kind !== 'user') prior.push(b);
    }
    const userBlock = toBlock(entries[userIdx]);
    if (userBlock) correction = detectConvoCorrection([...prior, userBlock]).hit;
  }

  // Tool hard errors in THIS turn's span only (entries after the user entry).
  let toolHardError = 0;
  for (let i = userIdx + 1; i < entries.length; i++) {
    const p = entries[i].payload;
    if (p.type === 'tool_result' && p.isError) toolHardError += 1;
  }

  const failedKinds: TurnOutcome['kind'][] = [
    'model_error', 'model_unavailable', 'auth_error', 'billing_error',
    'image_error', 'request_invalid', 'context_exceeded', 'rate_limited',
  ];
  const declined = outcome.kind === 'refused' || outcome.kind === 'hook_blocked';

  const vector: SalienceVector = {
    toolHardError,
    silentFailure: null,
    turnFailed: failedKinds.includes(outcome.kind) ? 1 : 0,
    userRedirected: null,
    userDeclined: declined ? 1 : 0,
    hitlPauses: pausedHalt ? 1 : 0,
    rewindOnTask: null,
    supersedes: null,
    userAbort: outcome.kind === 'user_aborted' ? 1 : 0,
    convoCorrection: correction ? 1 : 0,
  };

  return {
    correction,
    outcomeKind: outcome.kind,
    forcing: correction || declined,
    score: prefilterScore(vector),
    vector,
  };
}

/** The capture gate — passesPrefilter over the measured vector (theta optional). */
export function shouldCapture(s: TurnSurprise, theta?: number): boolean {
  return passesPrefilter(s.vector, theta);
}
