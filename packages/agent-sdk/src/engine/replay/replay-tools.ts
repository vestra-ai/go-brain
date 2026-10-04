/**
 * replay-tools.ts — answers the loop's tool dispatches from the recorded
 * `tool_result` entries. The seam is `RawToolOptions.execute`: gateAndDispatchTool
 * (tool-dispatcher.ts) runs the real gate → execute → scan → output-guard pipeline
 * and hands execute the dispatch id as `ctx.toolCallId` (= the journaled toolUseId),
 * so a wrapped tool can look its recorded result up without touching the dispatcher
 * or the round engine. The dispatcher maps a RETURNED string to `isError:false` and
 * a THROWN error's message to `isError:true` (tool-dispatcher.ts execute catch), so
 * a recorded error result is delivered by throwing its text verbatim — the
 * `[error:<code>]` stamp the taxonomy added at record time rides along unchanged.
 */
import { z } from 'zod';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { RawToolOptions, ToolDispatchResult, ToolExecuteContext } from '../../tools/tool-types.js';
import { splitUntrustedFence } from '../../tools/tool-types.js';

type ToolResultPayload = Extract<JournalPayload, { type: 'tool_result' }>;

/** The loop dispatched a tool_use id the recording has no result for. */
export class ReplayMissingResult extends Error {
  constructor(readonly toolUseId: string) {
    super(`replay: no recorded tool_result for tool_use ${toolUseId}`);
    this.name = 'ReplayMissingResult';
  }
}

export class ReplayTools {
  private readonly results = new Map<string, ToolResultPayload>();
  private readonly names: string[] = [];

  constructor(entries: JournalEntry[]) {
    for (const e of entries) {
      const p = e.payload;
      // Last result per id wins — the projection's keepLastToolResultPerId rule.
      if (p.type === 'tool_result') this.results.set(p.toolUseId, p);
      else if (p.type === 'tool_use' && !this.names.includes(p.name)) this.names.push(p.name);
    }
  }

  /** The journaled result for a tool_use id, as the dispatch result the loop would have seen. */
  resultFor(toolUseId: string): ToolDispatchResult {
    const p = this.results.get(toolUseId);
    if (!p) throw new ReplayMissingResult(toolUseId);
    const texts: string[] = [];
    for (const b of p.blocks) {
      if (b.type !== 'text') {
        throw new Error(`replay: tool_result ${toolUseId} carries a ${b.type} block; only text results replay today`);
      }
      texts.push(b.text);
    }
    return { toolUseId, text: texts.join('\n'), isError: p.isError ?? false };
  }

  /** Same names/descriptions/parameters; execute() answers from the recording. */
  wrap(tools: RawToolOptions[]): RawToolOptions[] {
    return tools.map((t) => ({ ...t, execute: (_args: unknown, ctx: ToolExecuteContext) => this.answer(ctx) }));
  }

  /** One permissive stub per recorded tool name — a keyless replay needs no product tools. */
  stubsFor(): RawToolOptions[] {
    return this.names.map((name) => ({
      name,
      description: `Keyless replay stub for ${name}: returns the recorded result for the dispatching tool_use id.`,
      parameters: z.object({}).passthrough(),
      execute: (_args: unknown, ctx: ToolExecuteContext) => this.answer(ctx),
    }));
  }

  private async answer(ctx: ToolExecuteContext): Promise<string> {
    if (!ctx.toolCallId) throw new ReplayMissingResult('<dispatch carried no toolCallId>');
    const r = this.resultFor(ctx.toolCallId);
    // W4-1: a recorded result of an `untrustedContent`-declaring tool carries the
    // fence the dispatcher minted at record time. Hand back the RAW bytes (exact
    // inverse of the mint) so the dispatcher re-mints the fence on this replay —
    // the round trip a taint fixture pins: a build without the rail journals the
    // raw text (no fence, no `taint` field) and fails equality. Unfenced results
    // pass through unchanged, so every pre-W4 fixture replays byte-identically.
    // S6: a harness trailer after the close marker is dropped too; the tool's own
    // resultTrailer re-appends it, as it did at record time.
    if (r.isError) throw new Error(splitUntrustedFence(r.text).body);
    return splitUntrustedFence(r.text).body;
  }
}
