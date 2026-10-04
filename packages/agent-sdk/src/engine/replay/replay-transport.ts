/**
 * replay-transport.ts — a Transport that answers the kernel loop's model calls from
 * a RECORDED journal. No provider client is ever constructed: `callModel` hands out
 * the next recorded round (or a recorded fault) and `readStream` replays it as the
 * normalized events a live transport would yield — so the real loop (runOneRound's
 * retry belt, stream fold, journal appends, tool batch) runs unmodified.
 *
 * WIRE DIALECT — chosen from the RECORDING's own `api`, never assumed. A recording
 * must replay through the dialect that authored it: the reconstruction check compares
 * the wire against `historyFromJournal`, so projecting a gpt recording through the
 * Anthropic dialect would compare the wrong two things and pass no matter what the
 * OpenAI projection does. `openai_responses` recordings therefore project through
 * `journalToOpenAIResponsesInput` (and push the Responses input shapes); every other
 * recording keeps the Anthropic dialect exactly as before — byte-identical.
 *
 * This is the one place the engine imports `transports/` (the Anthropic dialect's pure
 * functions live in `engine/native-messages.ts`, the Responses ones in
 * `transports/openai-responses-messages.ts`). It is deliberate: the alternative — a
 * dialect injected by each caller — is a seam someone forgets, which is exactly the
 * defect this switch closes. The import is one-way (`transports/` never imports
 * `replay/`), so it adds no cycle.
 *
 * Classification and pricing still delegate to the Anthropic helpers for every
 * recording: a replayed error frame classifies exactly as production would, and cost
 * is stripped as volatile before a fixture is compared.
 *
 * `api`/`provider` are stamped from the recording so the replayed assistant entries
 * carry the lane that authored them; the journal's blocks are provider-neutral, so a
 * Flash or Luna recording replays through this dialect with an identical journal.
 */
import { APIError } from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ContentBlock, ImageBlock, MediaBlock } from '../../contract/blocks.js';
import type { AnthropicReplayBlock, JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { ModelUsageSummary, TurnOutcome } from '../../contract/turn-outcome.js';
import type { RawToolOptions, ToolDispatchResult } from '../../tools/tool-types.js';
import type {
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
  ProviderTool,
  StreamEvent,
  Transport,
} from '../transport.js';
import { journalToAnthropicMessages, blocksToAnthropic, toolResultContent } from '../native-messages.js';
import {
  journalToOpenAIResponsesInput,
  blocksToOpenAIResponsesContent,
  toolResultOutput,
} from '../../transports/openai-responses-messages.js';
import { classifyAnthropicError, classifyAnthropicTermination } from '../native-termination.js';
import { chargeableAnthropicUsage, computeAnthropicCostUsd, buildModelUsage, denormalizeAnthropicUsage } from '../native-pricing.js';
import type { PlacedFault, ReplayFault } from './fixture.js';
import { groupRounds, journalToStreamEvents, type RecordedRound } from './journal-to-stream-events.js';

/** The loop asked for a round the recording does not have (more model calls than recorded). */
export class ReplayExhausted extends Error {
  constructor(readonly calls: number, readonly recorded: number) {
    super(`replay exhausted: model call #${calls} but the recording has ${recorded} round(s)`);
    this.name = 'ReplayExhausted';
  }
}

type ReplayStream = { kind: 'fault'; fault: ReplayFault } | { kind: 'round'; round: RecordedRound };

/** The SDK's closed set of error `type`s — a fixture names one of them (checked by the SDK's own typing at the throw site). */
type ApiErrorType = NonNullable<APIError['type']>;

/**
 * Byte-for-byte what @anthropic-ai/sdk core/streaming.js builds for an SSE
 * `event: error` frame: `new APIError(undefined, body, undefined, headers, type)` —
 * NO status, the body ENVELOPE in `.error`, the typed field in `.type`.
 */
function inStreamError(fault: ReplayFault): APIError {
  const body = { type: 'error', error: { type: fault.error.type, message: fault.error.message ?? fault.error.type } };
  return new APIError(undefined, body, undefined, new Headers(), fault.error.type as ApiErrorType);
}

export class ReplayTransport implements Transport {
  readonly api: string;
  readonly provider: string;
  /** Model calls made so far, faults included. */
  calls = 0;
  /** Recorded faults thrown so far. */
  faultsThrown = 0;

  private readonly rounds: RecordedRound[];
  /** True when the recording's `api` is `openai_responses` — see WIRE DIALECT above. */
  private readonly responses: boolean;
  private cursor = 0;
  private faultIdx = 0;
  private last: RecordedRound | undefined;
  /**
   * The served round's captured reasoning, awaiting its §4.3a echo on the next
   * `pushAssistant` — mirroring `OpenAIResponsesTransport.pendingReasoning`. Drained by
   * that push so it can never leak into a later turn. Without this the rail's
   * `pushAssistant` emitted one item where the real transport emits two, and the
   * in-memory push paths (empty-recovery seat, severed-stream seal, steer) replayed a
   * SHORTER wire than production builds — the exact discrepancy the rail exists to catch.
   */
  private pendingReasoning: Array<{ callId: string | null; id: string; encryptedContent: string; issuer?: string }> = [];

  constructor(entries: JournalEntry[], opts: { directives?: PlacedFault[] } = {}) {
    this.rounds = groupRounds(entries, opts.directives ?? []);
    const first = entries.find((e) => e.payload.type === 'assistant')?.payload as
      | Extract<JournalPayload, { type: 'assistant' }>
      | undefined;
    this.api = first?.api ?? 'anthropic_messages';
    this.provider = first?.provider ?? 'anthropic';
    this.responses = this.api === 'openai_responses';
  }

  /** Recorded rounds not yet served. */
  get remaining(): number {
    return this.rounds.length - this.cursor;
  }

  emptyHistory(): ProviderHistory {
    return [] as Anthropic.MessageParam[];
  }

  historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    return this.responses
      ? journalToOpenAIResponsesInput(entries)
      : journalToAnthropicMessages(entries);
  }

  pushAssistant(h: ProviderHistory, blocks: ContentBlock[]): void {
    if (this.responses) {
      // Mirrors OpenAIResponsesTransport.pushAssistant: §4.3a HEAD reasoning first, then
      // text blocks → ONE assistant message (omitted entirely when empty — a tool-only
      // turn pushes no message, the PR11 shape), then each tool_use → its own reasoning
      // echo + a function_call. Thinking has no Responses input form (reasoning rides
      // `capturedReasoning` → the journal), so it is dropped here.
      const out = h as OpenAI.Responses.ResponseInputItem[];
      const carry = this.pendingReasoning;
      this.pendingReasoning = [];
      const echo = (r: { id: string; encryptedContent: string; issuer?: string }): void => {
        out.push({
          type: 'reasoning', id: r.id, summary: [], encrypted_content: r.encryptedContent,
          ...(r.issuer ? { _issuer: r.issuer } : {}),
        } as OpenAI.Responses.ResponseReasoningItem);
      };
      for (const r of carry) if (r.callId === null) echo(r);
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) out.push({ role: 'assistant', content: text });
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          for (const r of carry) if (r.callId === b.toolUseId) echo(r);
          out.push({
            type: 'function_call',
            call_id: b.toolUseId,
            name: b.toolName,
            arguments: b.toolInput === undefined ? '{}' : JSON.stringify(b.toolInput),
          });
        }
      }
      return;
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking' && b.signature) {
        content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
      } else if (b.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: b.toolUseId,
          name: b.toolName,
          input: (b.toolInput ?? {}) as Record<string, unknown>,
        });
      }
    }
    if (content.length) (h as Anthropic.MessageParam[]).push({ role: 'assistant', content });
  }

  pushToolResult(h: ProviderHistory, r: ToolDispatchResult): void {
    if (this.responses) {
      // Same helper the Responses journal projection uses, so the two cannot drift.
      (h as OpenAI.Responses.ResponseInputItem[]).push({
        type: 'function_call_output',
        call_id: r.toolUseId,
        output: toolResultOutput(r.blocks ?? [], r.text),
      });
      return;
    }
    (h as Anthropic.MessageParam[]).push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: toolResultContent(r.blocks ?? [], r.text),
          is_error: r.isError,
        },
      ],
    });
  }

  pushUser(h: ProviderHistory, text: string, images?: ImageBlock[], _media?: MediaBlock[]): void {
    if (this.responses) {
      const out = h as OpenAI.Responses.ResponseInputItem[];
      out.push({
        role: 'user',
        content: images?.length
          ? blocksToOpenAIResponsesContent([...images, ...(text ? [{ type: 'text' as const, text }] : [])])
          : text,
      });
      return;
    }
    if (images?.length) {
      const content: Anthropic.ContentBlockParam[] = [
        ...blocksToAnthropic(images),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ];
      (h as Anthropic.MessageParam[]).push({ role: 'user', content });
      return;
    }
    (h as Anthropic.MessageParam[]).push({ role: 'user', content: text });
  }

  buildTools(raw: RawToolOptions[]): ProviderTool[] {
    return raw as ProviderTool[];
  }

  callModel(_p: Parameters<Transport['callModel']>[0]): ProviderStream {
    this.calls += 1;
    const round = this.rounds[this.cursor];
    if (!round) throw new ReplayExhausted(this.calls, this.rounds.length);
    if (this.faultIdx < round.faults.length) {
      // A recorded fault: the cursor stays — the re-issued call gets the real round.
      const fault = round.faults[this.faultIdx++];
      return { kind: 'fault', fault } satisfies ReplayStream;
    }
    this.cursor += 1;
    this.faultIdx = 0;
    this.last = round;
    this.pendingReasoning = this.responses ? this.reasoningOf(round) : [];
    return { kind: 'round', round } satisfies ReplayStream;
  }

  async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const s = stream as ReplayStream;
    if (s.kind === 'fault') {
      // Thrown on the FIRST read — the pre-commit point startStreamWithRetry classifies
      // and re-issues from (no event was yielded, so nothing was emitted or billed).
      this.faultsThrown += 1;
      throw inStreamError(s.fault);
    }
    for (const ev of journalToStreamEvents(s.round)) yield ev;
  }

  /**
   * §4.3a / PR4 P2 — the recording's encrypted reasoning for the round just served,
   * split the way a live Responses stream hands it over: `callId:null` for the HEAD
   * items the recording kept on the assistant entry, and the owning `call_id` for the
   * items that rode each tool_use. settleRoundOutput re-splits on exactly that key, so
   * a replayed round journals the reasoning back onto the same entries it came off.
   * Empty for every non-Responses recording → those replays are byte-identical.
   */
  capturedReasoning(): Array<{ callId: string | null; id: string; encryptedContent: string; issuer?: string }> {
    if (!this.responses || !this.last) return [];
    return this.reasoningOf(this.last);
  }

  /** The reasoning a served round captured: head items (no call) then per-tool_use items. */
  private reasoningOf(round: RecordedRound): Array<{ callId: string | null; id: string; encryptedContent: string; issuer?: string }> {
    return [
      ...(round.assistant.payload.reasoning ?? []).map((r) => ({ callId: null, ...r })),
      ...round.toolUses.flatMap((tu) =>
        (tu.payload.reasoning ?? []).map((r) => ({ callId: tu.payload.toolUseId, ...r })),
      ),
    ];
  }

  /** The recording's verbatim-replay channel for the round just served (PR2 parity). */
  capturedOrderedBlocks(): AnthropicReplayBlock[] | undefined {
    return this.last?.assistant.payload.anthropicBlocks;
  }

  computeCostUsd(usage: NormalizedUsage, model: string): number {
    // The live transport's own projection (5m/1h split included), so a replayed round
    // prices exactly as the recorded one did.
    return computeAnthropicCostUsd(chargeableAnthropicUsage(denormalizeAnthropicUsage(usage)), model);
  }

  buildModelUsage(usage: NormalizedUsage, model: string): ModelUsageSummary {
    return buildModelUsage(chargeableAnthropicUsage(denormalizeAnthropicUsage(usage)), model);
  }

  classifyError(err: unknown): TurnOutcome {
    return classifyAnthropicError(err);
  }

  classifyTermination(a: {
    stopReason: string | null;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    modelUsage: ModelUsageSummary;
    summaryText: string;
  }): TurnOutcome {
    return classifyAnthropicTermination(a);
  }

  defaultModel(): string {
    return 'claude-sonnet-5-5';
  }
}
