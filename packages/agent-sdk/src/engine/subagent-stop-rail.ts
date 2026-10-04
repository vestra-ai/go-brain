/**
 * X1 (HOOK_PARITY_V1) — a SubagentStop hook keeps a helper running.
 *
 * The Claude Code hooks reference: "Returning decision: "block" with a reason keeps the
 * subagent running and delivers reason to the subagent as its next instruction." So the
 * helper's loop asks its `onStop` (the Agent tool's, which fires SubagentStop on the parent's
 * dispatcher) each time the model answers without calling a tool: text back is pushed as the
 * helper's next user message, journaled into the helper's scope (a resumed helper replays it,
 * as the main loop's Stop re-feed is replayed), and the loop goes on, a turn out of the same
 * `maxTurns`. How many times is the caller's to cap (the Agent tool: MAX_STOP_CONTINUE).
 *
 * The hook is asked only when the helper genuinely could go on (`canContinue`): never on the
 * forced last round after its context ceiling emptied its tools, after the runaway or wrap-up
 * directive, or with no turn left (a continuation there would buy a refused round and label a
 * finished answer as a turn-cap partial).
 *
 * No `onStop` (every other caller, and the flag off): the rail answers false and the helper
 * stops where it always did, byte-identical. Lives beside subagent-runner.ts, which sits at its
 * size ratchet. Per run: the closure is the only state.
 */
import type { Journal } from '../kernel/index.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { SubagentPathSegment } from '../contract/subagent-path.js';
import type { ProviderHistory, Transport } from './transport.js';
import { baseFromTaskId } from './journal-entry-base.js';

/** What the helper's loop calls when the model stops: true when the helper was told to go on. */
export function subagentStopRail(
  onStop: ((lastText: string) => Promise<string | undefined>) | undefined,
  transport: Pick<Transport, 'pushUser'>,
  history: ProviderHistory,
  scoped: { j: Journal; path: SubagentPathSegment[] } | undefined,
  lastText: () => string,
  canContinue: () => boolean,
): () => Promise<boolean> {
  return async () => {
    if (onStop === undefined || !canContinue()) return false;
    const next = await onStop(lastText());
    if (next === undefined) return false;
    transport.pushUser(history, next);
    if (scoped) {
      // Scope-tagged and marked with its door (`hook`), like the main loop's Stop re-feed entry.
      await scoped.j.append({
        ...baseFromTaskId(scoped.j.taskId, scoped.j.workspaceId, scoped.path),
        payload: { type: 'user', blocks: [{ type: 'text', text: next } as ContentBlock], injected: 'hook' },
      });
    }
    return true;
  };
}
