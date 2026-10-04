/**
 * replay-interactions.ts — the HITL PAUSE PLANE of a keyless replay.
 *
 * A recording's `interaction` entries are what make a paused turn a paused turn:
 * `suspendPending` drops a tool_use bound to a `resolved:false` interaction from the
 * projection, and the resume materializes its `tool_result` in place. Without them a
 * recording of a paused turn replays as a turn that never paused — which is why the
 * rail could not see the only divergence class this system has ever recorded.
 *
 * This module reads that plane back out of the recording:
 *
 *  - the PAUSE side becomes a deterministic {@link InteractionPort}: when the loop
 *    gates `AskUserQuestion` (or any interactive tool) to `ask`, `onPause` asks the
 *    port for an interaction id and the port answers with the id the RECORDING used,
 *    so the replayed `interaction` entry equals the recorded one;
 *  - the RESUME side becomes a `getResolution` callback for
 *    `Journal.reconcileInteractions` — the recorded `resolved:true` entry's own
 *    outcome, so the materialized `tool_result` is the one the human actually gave.
 *
 * Pure bookkeeping over the entry list; no clock, no I/O.
 */
import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { PermissionMode } from '../../contract/permission.js';
import type { InteractionPort } from '../../ports/interaction-port.js';
import type { PolicyPort } from '../../ports/policy-port.js';

type InteractionPayload = Extract<JournalPayload, { type: 'interaction' }>;

/** One recorded pause: the tool it bound to, the id it was minted under, its kind. */
interface RecordedPause {
  interactionId: string;
  toolUseId: string;
  kind: InteractionKind;
}

function pauseOf(p: InteractionPayload): RecordedPause | null {
  if (p.resolved !== false) return null;
  const d = p.data as { toolUseId?: unknown; kind?: unknown } | undefined;
  if (typeof d?.toolUseId !== 'string') return null;
  return {
    interactionId: p.interactionId,
    toolUseId: d.toolUseId,
    kind: (typeof d.kind === 'string' ? d.kind : 'ask_question') as InteractionKind,
  };
}

function outcomeOf(p: InteractionPayload): InteractionOutcome | null {
  if (p.resolved !== true) return null;
  const o = (p.data as { outcome?: unknown } | undefined)?.outcome;
  return o !== undefined && o !== null ? (o as InteractionOutcome) : null;
}

/**
 * Does this recording carry a HITL pause the rail must re-enact? Used to keep the
 * arm OPT-IN BY DATA: a recording with no `interaction` entry drives exactly the
 * path it drove before this module existed.
 */
export function recordingHasPause(entries: JournalEntry[]): boolean {
  return entries.some((e) => e.payload.type === 'interaction' && pauseOf(e.payload) !== null);
}

export class ReplayInteractions {
  /** toolUseId → the pause the recording minted for it. */
  private readonly byToolUse = new Map<string, RecordedPause>();
  /** interactionId → the outcome the recording resolved it with. */
  private readonly outcomes = new Map<string, InteractionOutcome>();
  /** Interaction ids this replay actually paused on, in pause order. */
  readonly paused: string[] = [];

  constructor(entries: JournalEntry[]) {
    for (const e of entries) {
      if (e.payload.type !== 'interaction') continue;
      const pause = pauseOf(e.payload);
      if (pause) {
        this.byToolUse.set(pause.toolUseId, pause);
        continue;
      }
      const outcome = outcomeOf(e.payload);
      if (outcome) this.outcomes.set(e.payload.interactionId, outcome);
    }
  }

  /**
   * The gate, replayed from the recording rather than re-derived. The product's gate
   * ladder (mode → security → capability → classifier) needs product rule DATA a
   * keyless replay does not have; but WHICH calls paused is recorded, so the rail
   * answers `needs_human` for exactly the tool_uses the recording bound a pending
   * interaction to, and allows everything else. Same discipline as ReplayTools (answer
   * from the recording; never re-run the real tool) and ReplayTransport.
   */
  policy(): PolicyPort {
    return {
      gate: async (call: ToolCall): Promise<GateResult> => {
        const pause = this.byToolUse.get(call.toolCallId);
        return pause ? { decision: 'needs_human', interactionKind: pause.kind } : { decision: 'allow' };
      },
      permissionMode: (): PermissionMode => 'default',
      seedModeFromEnv: (): void => {},
    };
  }

  /**
   * The port the harness pauses through. It mints the RECORDED id for a recorded
   * pause so the replayed journal matches; an UNRECORDED pause (the loop gated a
   * tool the recording never paused on) is a real replay divergence, so it throws
   * rather than inventing an id that would silently pass.
   */
  port(): InteractionPort {
    return {
      requestInteraction: async (a: { call: ToolCall; kind: InteractionKind }): Promise<string> => {
        const pause = this.byToolUse.get(a.call.toolCallId);
        if (!pause) {
          throw new Error(
            `replay: the loop paused on tool_use ${a.call.toolCallId} (${a.call.toolName}, ${a.kind}) ` +
              'but the recording has no interaction bound to it',
          );
        }
        this.paused.push(pause.interactionId);
        return pause.interactionId;
      },
      requestComposioAuth: async (): Promise<string> => {
        throw new Error('replay: composio auth is not part of the replay pause plane');
      },
    };
  }

  /**
   * The `Journal.reconcileInteractions` resolver: the recorded human answer for an
   * interaction, or null (still pending) when the recording never resolved it —
   * which is what a recording of a turn the user walked away from looks like.
   */
  resolver(): (interactionId: string) => Promise<InteractionOutcome | null> {
    return async (interactionId: string) => this.outcomes.get(interactionId) ?? null;
  }

  /** Is there a recorded answer for this interaction? */
  hasResolution(interactionId: string): boolean {
    return this.outcomes.has(interactionId);
  }
}
