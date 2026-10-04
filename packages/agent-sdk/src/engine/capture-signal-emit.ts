/**
 * capture-signal-emit.ts — the write-on-surprise capture signal at turn finalization.
 *
 * Assess the turn's surprise off the warm journal projection (capture-signal.ts: pure,
 * no model call); on a capture-worthy turn journal one durable `nami_capture` marker +
 * yield one raw NAMI_CAPTURE_SIGNAL for the server's capture consumer. Fired BEFORE the
 * terminal turn_end (so a tearing-down driver still forwards it); dark + journal-gated;
 * never-throw. Pinned by: capture-signal.test.ts, native-harness.capture-signal.test.ts.
 *
 * Lifted verbatim out of NativeHarness.run (native-harness.ts only ratchets down), the
 * way billing-tripwire.ts owns its own emit one line above the call site.
 */
import type { HarnessEvent } from '../contract/events.js';
import type { HarnessContext } from '../contract/harness.js';
import type { NativeConfig } from './native-config.js';
import type { TurnIterationResult } from './turn-iteration-result.js';
import { assessTurnSurprise, shouldCapture, NAMI_CAPTURE_SIGNAL_EVENT } from './capture-signal.js';
import { appendCaptureSignalEntry } from './native-journal.js';

export async function* emitCaptureSignal(
  cfg: Pick<NativeConfig, 'captureSignal' | 'journal'>,
  ctx: HarnessContext<NativeConfig>,
  turnResult: Pick<TurnIterationResult, 'outcome' | 'pausedHalt'>,
): AsyncIterable<HarnessEvent> {
  if (cfg.captureSignal !== true || !cfg.journal) return;
  try {
    const projected = (await cfg.journal.project()).messages;
    const surprise = assessTurnSurprise(projected, turnResult.outcome, turnResult.pausedHalt === true);
    if (shouldCapture(surprise)) {
      const payload = {
        correction: surprise.correction,
        outcomeKind: surprise.outcomeKind,
        forcing: surprise.forcing,
        score: surprise.score,
      };
      await appendCaptureSignalEntry(cfg.journal, ctx, payload);
      yield {
        kind: 'raw',
        engine: 'native',
        event: NAMI_CAPTURE_SIGNAL_EVENT,
        data: { taskId: ctx.taskId, surprise: payload },
      };
    }
  } catch (captureErr) {
    console.warn('[NativeHarness] capture-signal assessment failed — skipping', captureErr);
  }
}
