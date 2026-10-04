/**
 * S4 — the injection guard acts (ruling 2, 2026-09-30: "block and tell").
 *
 * When the screen judges that a side effect was asked for by untrusted content (a
 * page, an email, a tool result) rather than by the person, that one call is refused
 * and the refusal says so in one plain line. There is NO permission card on this path:
 * the Relaxed ruling ("only deletes and payments ask") holds because a refusal is a
 * tool result, never an ask. And the turn is NEVER ended by a refusal (founder law: a
 * working task is never stopped): each content-asked call is refused on its own while
 * the turn carries on with its real work; runaway is bounded by maxTurns and the fuel
 * tank, as for any turn.
 *
 * The provider (apps/sandbox, `INJECTION_SCREEN_V1=block`) decides WHICH readings
 * refuse; it says so by stamping `block: true` on an `instructed` reading. The
 * dispatcher only honours the stamp. A reading without one (shadow, the value `true`)
 * dispatches exactly as before.
 */
import type { InjectionScreenReading } from './injection-screen.js';
import type { ToolDispatchResult } from '../tools/tool-types.js';

/**
 * The one line a refused call answers with. The model reads it as its tool result and
 * the person sees it in the tool's result, so it is written for both: plain, no tool
 * names, no dashes.
 */
export const INJECTION_GUARD_SKIP_LINE = 'Skipped: a web page or message asked for this, not you.';

/**
 * The refusal the dispatcher returns INSTEAD of `execute()` when the reading carries
 * `block`, or `undefined` to run the call as before. `isError` because the step did
 * not happen (the gate-deny precedent); never `pausedHalt`, because nothing waits on
 * the person. Like a gate deny it returns before the PostToolUse hooks.
 */
export function injectionGuardRefusal(
  toolUseId: string,
  screen: InjectionScreenReading | undefined,
): ToolDispatchResult | undefined {
  if (screen?.verdict !== 'instructed' || screen.block !== true) return undefined;
  return { toolUseId, text: INJECTION_GUARD_SKIP_LINE, isError: true, screen, refused: true };
}
