/**
 * native-journal.ts — First-class journal integration for the native Anthropic arm.
 *
 * Provides append helpers (appendUserEntry, appendAssistantEntry, appendToolUseEntry,
 * appendToolResultEntry) and a message loader (loadMessages) that converts the
 * journal's projected context into Anthropic MessageParam[].
 *
 * When `cfg.journal` is present, the harness uses these to persist every turn's
 * user/assistant/tool_use/tool_result entries durably (first-class K0 entries).
 * When `cfg.journal` is absent, run() falls back to the in-memory path — existing
 * Task 8 tests that pass no journal are unaffected.
 *
 * All helpers are safe to call with `journal = undefined` (no-op gracefully).
 *
 * ring 4c — RELOCATED into the SDK engine. The tenant boundary (`workspaceId` /
 * `principal.userId`) is no longer read inline from `process.env.USER_ID`; the SDK
 * reads NO environment. It arrives via `ctx.config.runtimeConfig.userId` (the
 * injected RuntimeConfig port) for the ctx-family helpers, and as an explicit
 * `userId` argument for the three taskId-only helpers (which carry no ctx). The
 * recorded values are byte-identical for real inputs (`runtimeConfig.userId` is
 * populated with the exact value `process.env.USER_ID` had).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import { isContextEntry, type AnthropicReplayBlock, type GeminiReplayStep, type InjectedDoor, type JournalEntry, type NewEntry } from '../contract/journal.js';
import type { SealedChannels } from './replay-channels.js';
import type { InstructionSnapshot } from '../contract/instruction-stack.js';
import type { InteractionKind, InteractionOutcome } from '../contract/interaction.js';
import type { SubagentId, SubagentPathSegment } from '../contract/subagent-path.js';
import { subagentIdFromPath } from '../contract/subagent-path.js';
import type { HarnessId } from '../contract/ids.js';
import type { OutputFormat } from '../contract/output-format.js';
import type { HarnessContext, MessageOrigin } from '../contract/harness.js';
import type { TodoStatus } from '../contract/blocks.js';
import {
  type Journal,
  type PlanTodo,
  buildDeferredResultContent,
  buildPendingInteractionData,
  buildResolvedInteractionData,
  projectPlan,
  projectScope,
} from '../kernel/index.js';
import type { NativeConfigLike } from './native-config-like.js';
import type { NativeConfig } from './native-config.js';
import { treeStats, resetTreeStats, type TreeStats } from './subagent-pool.js';
import { base, baseFromTaskId } from './journal-entry-base.js';

// The CONTEXT_POLICY:false observability appends moved to telemetry-entries.ts
// (apps/reconciler file-size ratchet — this file only goes down). Re-exported so
// every existing import path keeps working; telemetry-entries owes nothing back.
export { appendToolBatchShapeEntry, appendElisionShapeEntry } from './telemetry-entries.js';
import { journalToAnthropicMessages } from './native-messages.js';

// ── Append helpers ────────────────────────────────────────────────────────────

/**
 * Append a user message entry. No-op when journal is absent.
 *
 * `images` (uploaded with the turn) are journaled as first-class ImageBlocks so a
 * later projection replays them to the model as image content blocks. They LEAD
 * (Anthropic recommends image-before-text for "what's in this image"), then the
 * text — but the text block is only appended when non-empty, so a caption-less
 * upload doesn't journal an empty text block. The text-only path (no images) keeps
 * the prior shape verbatim (a single text block, even when empty) → byte-identical
 * for every existing caller.
 *
 * `media` (VIDEO_UNDERSTANDING_V1 — an attached video / audio / PDF) is journaled
 * the same way, between the images and the text: a POINTER block (path, signed
 * url, hash), never bytes and never a provider-side file uri. Only the Gemini
 * projection reads it; every other dialect ignores it. Absent/empty → the entry is
 * exactly today's.
 */
export async function appendUserEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  text: string,
  images?: ImageBlock[],
  media?: MediaBlock[],
): Promise<void> {
  return appendUserPayload(j, ctx, text, images, media, undefined);
}

/**
 * Append a user entry the LOOP minted rather than a person — a severance
 * continuation, a recall fence, the runaway directive, a schema retry, or a
 * hook's `additionalContext`. Identical to {@link appendUserEntry} but stamps
 * `payload.injected`, so a consumer that must not mistake engine text for the
 * user's intent reads a FIELD instead of guessing from bytes.
 *
 * A separate function rather than a parameter on purpose: the choice between the
 * two is a judgement about WHO IS SPEAKING, and it should be legible at the call
 * site. `contract/injected-user-text.ts` carries that judgement for all nine.
 */
export async function appendInjectedUserEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  text: string,
  injected: InjectedDoor,
): Promise<void> {
  return appendUserPayload(j, ctx, text, undefined, undefined, injected);
}

async function appendUserPayload(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  text: string,
  images: ImageBlock[] | undefined,
  media: MediaBlock[] | undefined,
  injected: InjectedDoor | undefined,
): Promise<void> {
  if (!j) return;
  const blocks: ContentBlock[] = images?.length || media?.length
    ? [...(images ?? []), ...(media ?? []), ...(text ? [{ type: 'text', text } as ContentBlock] : [])]
    : [{ type: 'text', text } as ContentBlock];
  await j.append({
    ...base(ctx),
    principal: { kind: 'user', userId: ctx.config.runtimeConfig?.userId ?? '' },
    payload: {
      type: 'user',
      blocks,
      ...(injected !== undefined ? { injected } : {}),
    },
  });
}

/**
 * Append an assistant response entry. No-op when journal is absent.
 *
 * `api`/`provider` are stamped from the active Transport (K2): the journal records
 * WHICH wire dialect authored the turn so a cross-model handoff can rehydrate it
 * correctly. Defaults to the native Anthropic pair for back-compat with callers
 * that predate the transport seam (tests).
 *
 * PR4 P2 — `reasoning` (OpenAI/Sakana-scoped) carries the HEAD/orphan encrypted
 * reasoning items that preceded NO function_call (so they cannot ride a tool_use
 * entry). Persisted on the assistant entry so a journal re-projection
 * (journalToOpenAIResponsesInput) echoes them BEFORE the assistant message on
 * reload. Omitted (undefined → field absent) for Anthropic + non-reasoning OpenAI
 * turns → the payload is byte-identical there, and journalToAnthropicMessages never
 * reads it.
 */
export async function appendAssistantEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  blocks: ContentBlock[],
  model: string,
  api: string = 'anthropic_messages',
  provider: string = 'anthropic',
  reasoning?: Array<{ id: string; encryptedContent: string }>,
  anthropicBlocks?: AnthropicReplayBlock[],
  geminiSteps?: GeminiReplayStep[],
  channels: Omit<SealedChannels, 'geminiSteps'> = {}, // replay-channels.ts: present-only
): Promise<JournalEntry | undefined> {
  if (!j) return undefined;
  // Return the appended entry so callers can use its globally-unique, monotonic,
  // never-regressing `uuid` (K4C-1: the per-round AGENT_USAGE idempotency key — the
  // native analogue of the Claude SDK's `msg.uuid`). Additive: prior callers ignore it.
  return j.append({
    ...base(ctx),
    payload: {
      type: 'assistant',
      blocks,
      api,
      provider,
      model,
      ...(reasoning && reasoning.length ? { reasoning } : {}),
      // The verbatim-replay channels: the round's provider output as sent, every round,
      // one per dialect (see replay-channels.ts). Spread-when-present → absent stays absent.
      ...(anthropicBlocks && anthropicBlocks.length ? { anthropicBlocks } : {}),
      ...(geminiSteps && geminiSteps.length ? { geminiSteps } : {}),
      ...channels,
    },
  });
}

/**
 * Append a tool_use entry (the model called a tool). No-op when journal is absent.
 *
 * §4.3a — `reasoning` (OpenAI/Sakana-scoped) carries the encrypted reasoning items
 * captured off the stream that PRECEDED this call. Persisted on the tool_use entry
 * so a journal re-projection (journalToOpenAIResponsesInput) echoes them before the
 * function_call — stateless reasoning models REQUIRE this on tool turns. Omitted
 * (undefined → field absent) for Anthropic + non-reasoning OpenAI calls → the
 * payload is byte-identical there, and journalToAnthropicMessages never reads it.
 */
export async function appendToolUseEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  tu: { id: string; name: string; input: unknown; thoughtSignature?: string },
  reasoning?: Array<{ id: string; encryptedContent: string; issuer?: string }>,
): Promise<void> {
  if (!j) return;
  await j.append({
    ...base(ctx),
    payload: {
      type: 'tool_use',
      toolUseId: tu.id,
      name: tu.name,
      input: tu.input,
      ...(reasoning && reasoning.length ? { reasoning } : {}),
      // PR6 — persist the Gemini-3 thoughtSignature (absent on non-Gemini-3 →
      // byte-identical). journalToGeminiContents re-emits it on the functionCall.
      ...(tu.thoughtSignature ? { thoughtSignature: tu.thoughtSignature } : {}),
    },
  });
}

/**
 * K5-T2 — Append the PENDING interaction marker, bound to the tool_use that paused
 * (spec §4). One entry per fire: `{ type:'interaction', resolved:false, data:
 * {kind, toolUseId, toolName} }` riding the FROZEN payload. No-op when the journal
 * is absent (in-memory path). Takes `taskId` directly (not the full HarnessContext)
 * so the composio auth-halt path — which only carries a taskId — can call it too.
 *
 * ring 4c — `userId` (the tenant boundary stamped as `workspaceId`) is now an
 * explicit arg (the SDK reads no env). The product callers pass
 * `cfg.runtimeConfig?.userId ?? ''`; absent → `''` → `'sandbox'` (byte-identical to
 * the old `process.env.USER_ID ?? 'sandbox'` for every real input).
 *
 * T3 (subagent-deep-HITL) — OPTIONAL `subagentPath`/`subagentId` route the pending
 * marker's `data` to the leaf subagent that paused (depth ≥ 1). Both absent ⇒ the
 * entry is byte-identical to today (main-agent pause). Inert until a later task
 * populates them.
 */
export async function appendPendingInteractionEntry(
  j: Journal | undefined,
  taskId: string,
  interactionId: string,
  kind: InteractionKind,
  toolUseId: string,
  toolName: string,
  userId = '',
  subagentPath?: SubagentPathSegment[],
  subagentId?: SubagentId,
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string },
): Promise<void> {
  if (!j) return;
  await j.append({
    ...baseFromTaskId(taskId, userId),
    payload: {
      type: 'interaction',
      interactionId,
      resolved: false,
      data: buildPendingInteractionData(kind, toolUseId, toolName, subagentPath, subagentId, weavePending),
    },
  });
}

/**
 * Append a tool_result entry (the tool returned a result). No-op when journal is absent.
 *
 * K4-T7 PROVENANCE NOTE — `context_query` calls:
 * `context_query` is recorded as a standard `tool_use`/`tool_result` pair — no
 * new payload kind (schema frozen). The input `{query}` lands in the `tool_use`
 * entry's `input` field; the result (the fenced `<user_memory>…</user_memory>`
 * block, or `''` on degrade) lands in this `tool_result` entry's blocks. Because
 * the entry headers carry `taskId` and `workspaceId`, P-Nami's eventual write-
 * curator has sufficient provenance to stamp `source_task_id` without any schema
 * change — the journal is already a first-class audit trail for memory reads.
 *
 * `CONTEXT_POLICY: true` (tool_result is a context entry per entry.ts:44) means
 * these pairs replay into the model context on resume — correct, because recalled
 * memory IS part of the conversation, not an out-of-band audit record.
 */
export async function appendToolResultEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  r: { toolUseId: string; text: string; isError: boolean; blocks?: ContentBlock[]; report?: unknown; taint?: 'external' },
): Promise<void> {
  if (!j) return;
  await j.append({
    ...base(ctx),
    payload: {
      type: 'tool_result',
      toolUseId: r.toolUseId,
      // T2: persist the tool-emitted blocks (text + image) when present so a
      // screenshot survives a recycle; else fall back to the historic single
      // text block (byte-identical to every existing non-image caller).
      blocks: r.blocks ?? [{ type: 'text', text: r.text } as ContentBlock],
      isError: r.isError,
      // S2a: persist the browser action report verbatim when present (dispatcher
      // already validated it structurally); spread-when-present keeps every
      // report-less entry byte-identical to today.
      ...(r.report !== undefined && { report: r.report }),
      // W4-1: the dispatcher's taint verdict (the fence already rides r.text/
      // r.blocks); spread-when-present keeps untainted entries byte-identical.
      ...(r.taint !== undefined && { taint: r.taint }),
    },
  });
}

/**
 * P2.1 (Task 4) — journal a SETTLED model round's usage AT THE FOLD (the moment its
 * cost is known and folded into cumulativeCostUsd). CONTEXT_POLICY:false — this is
 * accounting state, NEVER replayed into the model context (isContextEntry → false),
 * so projections + wire bodies stay byte-identical; it exists so a crashed
 * multi-round turn can seed its completed rounds' cost from the journal (Task 5).
 *
 * `costUsd` is the authoritative dollar figure; it rides `raw` alongside the model
 * that produced the round, the fold `source`, and the round's token counts. The
 * payload's existing `intelligence` field mirrors `costUsd` (the credits
 * convention); `actions`/`compute` are 0 for a model round (those meter on other
 * surfaces). The payload SHAPE is unchanged — `usage` was already a schema kind with
 * zero non-test writers; this is its first real writer. No-op when the journal is
 * absent (the in-memory path).
 *
 * `agentPath` scope-tags a subagent round's usage (source:'subagent', a later task);
 * absent for every main-agent fold → byte-identical to an unscoped entry.
 */
export async function appendUsageEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  u: {
    costUsd: number;
    model: string;
    source: 'round' | 'compaction' | 'epilogue' | 'subagent';
    inputTokens: number;
    outputTokens: number;
    agentPath?: SubagentPathSegment[];
  },
): Promise<void> {
  if (!j) return;
  await j.append({
    ...base(ctx, u.agentPath),
    principal: { kind: 'system' },
    payload: {
      type: 'usage',
      intelligence: u.costUsd,
      actions: 0,
      compute: 0,
      raw: {
        costUsd: u.costUsd,
        model: u.model,
        source: u.source,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      },
    },
  });
}

/**
 * P2.1 (Task 4) — Σ of `raw.costUsd` over the journal's `usage` entries: the
 * journal-derived cost of every settled model round recorded so far. Task 5 seeds a
 * resume's `initialCostUsd` from this so a crashed turn's settled rounds are never
 * re-billed. Ignores non-usage entries and any usage entry lacking a numeric cost.
 */
export function sumJournaledCostUsd(entries: readonly JournalEntry[]): number {
  let sum = 0;
  for (const e of entries) {
    if (e.payload.type !== 'usage') continue;
    const raw = e.payload.raw as { costUsd?: unknown } | undefined;
    if (raw && typeof raw.costUsd === 'number') sum += raw.costUsd;
  }
  return sum;
}

/**
 * K5-T3: append a tool_result from a bare taskId (the continue path has no full ctx).
 *
 * ring 4c — `userId` (the tenant boundary) is now an explicit arg; the product
 * callers pass `cfg.runtimeConfig?.userId ?? ''`.
 */
export async function appendToolResultByTaskId(
  j: Journal | undefined,
  taskId: string,
  r: { toolUseId: string; text: string; isError: boolean; blocks?: ContentBlock[]; report?: unknown; taint?: 'external' },
  userId = '',
): Promise<void> {
  if (!j) return;
  await j.append({
    ...baseFromTaskId(taskId, userId),
    payload: {
      type: 'tool_result',
      toolUseId: r.toolUseId,
      // T2: persist tool-emitted blocks when present; else byte-identical fallback.
      blocks: r.blocks ?? [{ type: 'text', text: r.text } as ContentBlock],
      isError: r.isError,
      // S2a: persist the action report verbatim when present (see appendToolResultEntry).
      ...(r.report !== undefined && { report: r.report }),
      // W4-1: taint verdict, spread-when-present (see appendToolResultEntry).
      ...(r.taint !== undefined && { taint: r.taint }),
    },
  });
}

/**
 * Phase 3 (§1.4) — append a `plan` (write_todos) mutation from a bare taskId (the
 * Todos tools have no full HarnessContext, mirroring `appendToolResultByTaskId`).
 * `agentPath` scope-tags the entry so a subagent's plan mutations stay agent-
 * private (AC-P2) — absent for the main agent, byte-identical to a main-scope
 * write. Returns the freshly-projected todo list for THIS scope so the caller can
 * feed it straight to `onTodos` without a second journal read.
 */
export async function appendPlanEntry(
  j: Journal,
  taskId: string,
  userId: string,
  op: 'create' | 'update' | 'delete',
  id: string,
  // §4.7 (the board) — `owner` rides `fields` like every other mutable column:
  // a string assigns, `null` unassigns, an OMITTED key writes nothing (so a
  // plain status flip never silently drops the holder).
  fields?: { content?: string; status?: TodoStatus; activeForm?: string; owner?: string | null },
  agentPath?: SubagentPathSegment[],
): Promise<PlanTodo[]> {
  await j.append({
    ...baseFromTaskId(taskId, userId, agentPath),
    payload: { type: 'plan', op, id, ...fields },
  });
  return readPlan(j, agentPath);
}

/**
 * Phase 3 (§1.4) — read the current todo list for a scope without mutating.
 * Mirrors `appendPlanEntry`'s scoping so TodoGet/TodoList read exactly what a
 * create/update just wrote.
 *
 * MAIN scope (no `agentPath`, the only scope any production caller uses today)
 * reuses `Journal.project()`'s warm leaf-keyed cache via its `todos` field —
 * O(1) after the first read, same as every other main-scope consumer. Only a
 * SUBAGENT scope (once a caller threads a real `agentPath`) falls back to a raw
 * per-call journal scan, since `project()` only folds the main scope.
 */
export async function readPlan(j: Journal, agentPath?: SubagentPathSegment[]): Promise<PlanTodo[]> {
  if (!agentPath || agentPath.length === 0) {
    return (await j.project()).todos;
  }
  // P2.8 — the subagent scope reads the in-memory read-model (no fresh disk drain).
  return projectPlan(projectScope(await j.snapshot(), subagentIdFromPath(agentPath)));
}

/**
 * T5/M1 — journal-bind a subagent-aware HITL pause. ONE place that owns the journal
 * writes a paused subagent must make, so the COLD path (native-harness `onPause`) and
 * the CONTINUE path (the sandbox's `continueSubagentOnPause`) cannot drift again — the
 * exact drift M1 fixed (the continue path silently dropped the bubbled `subagentPath`).
 *
 * The interactionId is minted by the CALLER (cold = InteractionPort.requestInteraction;
 * continue = fireHarnessInteraction) and passed in — the two paths fire the interaction
 * through different gateways but persist it identically here:
 *   1. the PENDING interaction, threading the optional root→leaf `subagentPath` and the
 *      derived `subagentId` (the leaf subagent that actually paused);
 *   2. when the pause bubbled up from a nested subagent (a non-empty path), a
 *      {status:'deferred'} placeholder tool_result for EVERY ancestor Agent tool_use in
 *      the chain, so each tool batch in the tree stays slot-complete + durable; the real
 *      result settles on resume.
 *
 * Absent/empty `subagentPath` ⇒ no `subagentId`, no placeholders ⇒ byte-identical to a
 * plain main-agent (or flag-off collapsed) pause.
 */
export async function journalSubagentPause(
  j: Journal | undefined,
  taskId: string,
  interactionId: string,
  kind: InteractionKind,
  toolUseId: string,
  toolName: string,
  userId = '',
  subagentPath?: SubagentPathSegment[],
  // P3.3 (durable Weave pause) — the Weave tool's captured-leaf hash, frozen onto
  // the PENDING marker as the resume's one-shot match key. Absent on every
  // non-Weave pause ⇒ byte-identical marker data.
  weavePending?: { contentHash: string; nodeSpecHash?: string; scopeId?: string },
): Promise<void> {
  const hasPath = subagentPath !== undefined && subagentPath.length > 0;
  const subagentId = hasPath ? subagentIdFromPath(subagentPath) : undefined;
  await appendPendingInteractionEntry(
    j, taskId, interactionId, kind, toolUseId, toolName, userId,
    subagentPath, subagentId, weavePending,
  );
  if (hasPath) {
    // Each ancestor `Agent` tool_use lives in its PARENT's scope (the path prefix BEFORE
    // its own segment): the depth-1 ancestor (i=0) is the MAIN-scoped Agent tool_use, so
    // its placeholder stays UNSCOPED (main, UNCHANGED); a deeper ancestor (i≥1) is
    // scope-tagged by T10, so its placeholder must be CO-SCOPED into that same scope — else
    // the main projection retains it as a reverse-orphan (a tool_result with no matching
    // tool_use). A tool_result must live in the SAME scope as its tool_use: as of P2.0b
    // ALL FOUR validity floors strip reverse-orphans, so co-scoping is what keeps the
    // deferred result PAIRED (and therefore kept on the wire) — a mis-scoped one would be
    // silently stripped instead of 400ing. Depth-1 has only i=0 ⇒ byte-identical to before.
    for (let i = 0; i < subagentPath.length; i++) {
      const result = { toolUseId: subagentPath[i].agentToolUseId, text: buildDeferredResultContent(), isError: false };
      const parentPath = subagentPath.slice(0, i); // the scope this ancestor's tool_use lives in
      if (parentPath.length === 0) {
        await appendToolResultByTaskId(j, taskId, result, userId); // i=0 — main (UNCHANGED)
      } else if (j) {
        await appendSubagentToolResultEntry(j, parentPath, result); // i≥1 — co-scoped to the parent
      }
    }
  }
}

// ── T10: subagent-scoped journaling (durable subagent deep-HITL, Phase B) ──────

/**
 * T10 — the base for an entry a nested subagent loop journals for its OWN rounds.
 * Reuses `baseFromTaskId` with the PASSED-IN Journal's own task + tenant (read off
 * the journal so the subagent entries can never drift from the journal's identity),
 * and threads the subagent's root→leaf `agentPath` so the entry is scope-tagged. The
 * path is always non-empty here (the loop gates on a present path), so the conditional
 * spread in `baseFromTaskId` always stamps `agentPath`.
 */
function subagentBase(j: Journal, agentPath: SubagentPathSegment[]): Omit<NewEntry, 'payload'> {
  return baseFromTaskId(j.taskId, j.workspaceId, agentPath);
}

/**
 * Append a subagent assistant-text round, scope-tagged by `agentPath`. Mirrors the
 * main loop's assistant entry (text/thinking blocks; the tool_use blocks ride their
 * OWN tool_use entries below and fold in on projection). Single-writer preserved —
 * routes through the passed-in per-task Journal.
 */
export async function appendSubagentAssistantEntry(
  j: Journal,
  agentPath: SubagentPathSegment[],
  blocks: ContentBlock[],
  model: string,
  api: string,
  provider: string,
  channels: SealedChannels = {}, // replay-channels.ts
): Promise<void> {
  await j.append({
    ...subagentBase(j, agentPath),
    payload: { type: 'assistant', blocks, api, provider, model, ...channels },
  });
}

/** Append a subagent tool_use entry, scope-tagged by `agentPath`. */
export async function appendSubagentToolUseEntry(
  j: Journal,
  agentPath: SubagentPathSegment[],
  tu: { id: string; name: string; input: unknown; thoughtSignature?: string | undefined },
): Promise<void> {
  const sig = tu.thoughtSignature ? { thoughtSignature: tu.thoughtSignature } : {}; // PR6 parity (main journal)
  await j.append({
    ...subagentBase(j, agentPath),
    payload: { type: 'tool_use', toolUseId: tu.id, name: tu.name, input: tu.input, ...sig },
  });
}

/** Append a subagent tool_result entry, scope-tagged by `agentPath`. */
export async function appendSubagentToolResultEntry(
  j: Journal,
  agentPath: SubagentPathSegment[],
  r: { toolUseId: string; text: string; isError: boolean; blocks?: ContentBlock[]; taint?: 'external' },
): Promise<void> {
  await j.append({
    ...subagentBase(j, agentPath),
    payload: {
      type: 'tool_result',
      toolUseId: r.toolUseId,
      blocks: r.blocks ?? [{ type: 'text', text: r.text } as ContentBlock],
      isError: r.isError,
      // W4-1: taint verdict, spread-when-present (see appendToolResultEntry).
      ...(r.taint !== undefined && { taint: r.taint }),
    },
  });
}

/**
 * P2.2 (charter c) — journal a SETTLED subagent model round's usage, scope-tagged
 * by `agentPath` with `source:'subagent'`. Mirrors `appendUsageEntry`'s payload
 * exactly (the authoritative `costUsd` rides `raw`; `intelligence` mirrors it;
 * `actions`/`compute` are 0) on the subagent entry base (`subagentBase` — task +
 * tenant read off the Journal so these entries can never drift from the journal's
 * identity). Appended AFTER the round's scope-tagged assistant entry (the same
 * settlement ordering the main loop keeps — the P2.1 seed's invariant).
 *
 * This completes journal-vs-billed parity for subagent-heavy tasks: the Task-5
 * cost seed (`sumJournaledCostUsd`) now sees nested spend, so a seeded resume's
 * baseline can no longer sit below the server's durable cumulative (the PR-1301
 * `journalSeedUsd` under-count hazard). Non-context (CONTEXT_POLICY:false), and
 * every journal→history mapper default-ignores `usage`, so T11b scope-projection
 * re-entry seeds skip these entries untouched.
 */
export async function appendSubagentUsageEntry(
  j: Journal,
  agentPath: SubagentPathSegment[],
  u: { costUsd: number; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await j.append({
    ...subagentBase(j, agentPath),
    principal: { kind: 'system' },
    payload: {
      type: 'usage',
      intelligence: u.costUsd,
      actions: 0,
      compute: 0,
      raw: {
        costUsd: u.costUsd,
        model: u.model,
        source: 'subagent',
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      },
    },
  });
}

/**
 * K5-T3: append the RESOLVED interaction marker (settles the row, makes the continue idempotent).
 *
 * ring 4c — `userId` (the tenant boundary) is now an explicit arg; the product
 * callers pass `cfg.runtimeConfig?.userId ?? ''`.
 */
export async function appendResolvedInteractionEntry(
  j: Journal | undefined,
  taskId: string,
  interactionId: string,
  outcome: InteractionOutcome,
  materializedAt: string = new Date().toISOString(),
  userId = '',
): Promise<void> {
  if (!j) return;
  await j.append({
    ...baseFromTaskId(taskId, userId),
    payload: {
      type: 'interaction',
      interactionId,
      resolved: true,
      data: buildResolvedInteractionData(outcome, materializedAt),
    },
  });
}

/**
 * K4-T4: append the instruction snapshot — a ONE-per-session replay-audit record
 * of the assembled InstructionStack. Reuses the FROZEN `custom` payload kind (NO
 * schema change; entry.ts:18): `custom` is CONTEXT_POLICY:false (entry.ts:59) so
 * it NEVER replays into the model context (isContextEntry → false). The
 * `compact_boundary` single-summaryUuid contract is untouched.
 *
 * Best-effort: writes ONLY on a FRESH session (no prior CONTEXT entry and no snapshot
 * yet — not a resume) and is wrapped never-to-throw (a snapshot failure must not abort
 * the run). No-op when journal or snapshot is absent.
 */
export async function appendInstructionSnapshot(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  snapshot: InstructionSnapshot | undefined,
): Promise<void> {
  if (!j || !snapshot) return;
  try {
    // Fresh-session guard: skip on resume (a CONTEXT entry exists) or once recorded. Never "any entry":
    // the run builder's fire-and-forget construction_params lands first, which skipped 158 of 170 prod sessions.
    for await (const e of j.read()) {
      if (isContextEntry(e) || (e.payload.type === 'custom' && e.payload.key === 'instruction_snapshot')) return;
    }
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'instruction_snapshot',
        data: snapshot,
      },
    });
  } catch {
    /* best-effort: a snapshot write failure must never abort the run */
  }
}

/**
 * CACHE_TIERING_V1 — read back the journaled instruction snapshot (the baseline
 * `appendInstructionSnapshot` stamped at the original session start), so a
 * continue/resume assembly site can assert its REBUILT layers against the
 * original hashes (`assertSessionFrozenLayerHashes`) and warn LOUD when a
 * session-frozen layer (agent_mode / connected_accounts / situation / nami)
 * drifted across the pause — the cross-process cache-buster the in-process
 * transport guard cannot see. Fresh sessions stamp the snapshot as the FIRST entry, so this is an
 * effectively O(1) scan; a legacy journal without one reads to the end once and
 * returns undefined (callers skip the assert). Best-effort: never throws.
 */
export async function readInstructionSnapshot(
  j: Journal | undefined,
): Promise<InstructionSnapshot | undefined> {
  if (!j) return undefined;
  try {
    for await (const entry of j.read()) {
      const p = entry.payload;
      if (p.type === 'custom' && p.key === 'instruction_snapshot') {
        return p.data as InstructionSnapshot;
      }
    }
  } catch {
    /* best-effort: an unreadable journal must never abort the continue */
  }
  return undefined;
}

// ── K5-T5b: construction params (D2') ─────────────────────────────────────────

/**
 * The minimal set the COLD continue (sandbox scaled to zero during the pause)
 * needs to reconstruct the harness from the JOURNAL alone — no side `.meta.json`
 * file (a second mutable store that staleness-rots). `agentPrompt`/`maxBudgetUsd`
 * are optional (a legacy/anonymous run may omit them); `runtime` selects the
 * transport so an `openai_responses` task cold-continues on the OpenAI dialect.
 */
export interface ConstructionParams {
  agentPrompt?: string;
  model: string;
  runtime: HarnessId;
  maxBudgetUsd?: number;
  /** Which constraint minted maxBudgetUsd ('credits' | 'task_limit') — lets a
   *  cold continue's max_budget outcome still name the right knob. */
  maxBudgetSource?: string;
  /**
   * The per-turn spend ceiling, persisted beside `maxBudgetUsd` so a cold continue
   * off a scaled-to-zero sandbox re-arms the runaway guard. Absent ⇒ the re-driven
   * turn is uncapped, which is what a runaway that survived a scale-to-zero needs
   * LEAST. Optional → legacy entries read back undefined.
   */
  turnSpendCeilingUsd?: number;
  /**
   * K6-P6 (E6) — the run-level structured-output target persisted so a cold
   * continue (off a scaled-to-zero sandbox) re-targets the SAME shape the paused
   * turn carried. Absent for any pre-P6 / free-text run. Optional → legacy
   * construction-params entries (which lack the key) read back undefined.
   */
  outputFormat?: OutputFormat;
  /** K6-P6 (E6) — the persisted bounded structured-output re-ask budget (see NativeConfig). */
  maxStructuredOutputRetries?: number;
}

/**
 * Record the run's construction params as a CONTEXT_POLICY:false `custom` entry
 * (entry.ts:18 — FROZEN kind, never replays into the model context). Recorded on
 * each build (latest-wins) so the cold continue reads the PAUSED turn's exact
 * params. Best-effort + never-throws (a failed write degrades the cold continue
 * to the legacy path, it must not abort the run). No-op when journal is absent.
 */
export async function appendConstructionParams(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  params: ConstructionParams,
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'construction_params',
        data: params,
      },
    });
  } catch {
    /* best-effort: a construction-params write failure must never abort the run */
  }
}

// ── Orchestration walls (spec D10): the turn's spawn record ───────────────────

/**
 * Record the turn's spawn/refusal tally as a CONTEXT_POLICY:false `custom` entry
 * (the construction-params precedent — FROZEN kind, never replays into the model
 * context), so "the tree went 3 deep and the wall refused 2" survives a runner
 * recycle instead of living only in a log line. Best-effort + never-throws: a
 * stats write must never abort the run. No-op when the journal is absent.
 */
export async function appendSubagentStats(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  stats: TreeStats,
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'subagent_stats',
        data: stats,
      },
    });
  } catch {
    /* best-effort: a stats write must never abort the run */
  }
}

/**
 * The turn boundary's record-keeping in ONE call: count this turn's spawns and
 * refusals onto the journal, the log and the AGENT_RESULT the server bills from,
 * then drain the journal mirror.
 *
 * WHY THE STATS RESET HERE: `treeStats` accumulates per ROOT task across the whole
 * tree, so without the per-turn reset every later turn would re-report the earlier
 * turns' spawns. The record is written BEFORE the reset, never after.
 *
 * A turn that spawned, refused OR stopped nothing writes nothing (an empty tally is
 * noise, not a reading) — but it still resets, so a wall hit on turn 3 cannot leak
 * into turn 4. `stopped` is in the guard on its own account: a turn whose only event
 * was killing an already-running tree spawned nothing and refused nothing, and
 * without it that turn would go silent AND have its stop counts discarded by the
 * reset. `allowed` (follow-up C) is in the guard for the same reason: a turn whose only
 * wall event was letting a declared hand-off through is exactly the turn you want the
 * record for, and it refused nothing. Phase 3's TEAM counters (§4.9) join them on the same
 * ground: a turn whose only event was a helper messaging a sibling — or taking an item off
 * the lead's plan — spawned nothing and refused nothing, and that is precisely the turn the
 * reading is for. They are zero unless HELPER_TEAMWORK_V1 is on, so with the team surface
 * dark this guard reads as it always did.
 * Walls OFF ⇒ the mirror flush alone ⇒ byte-identical.
 *
 * Lives here rather than inline in native-harness.ts because that file sits at its
 * apps/reconciler file-size ratchet baseline and only goes down.
 */
export async function flushTurnRecords(
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
): Promise<void> {
  if (cfg.subagentWalls === true) {
    const stats = treeStats(ctx.taskId);
    const any = (r: Record<string, number>): boolean => Object.values(r).some((n) => n > 0);
    const team =
      stats.messagesSent + stats.hopRefusals + stats.leadStops + stats.resumes +
      stats.boardClaims + stats.boardDones;
    if (stats.spawned > 0 || any(stats.refused) || any(stats.allowed) || any(stats.stopped) || team > 0) {
      await appendSubagentStats(cfg.journal, ctx, stats);
      console.info(
        `[SubagentStats] task=${ctx.taskId.slice(0, 8)} spawned=${stats.spawned} max_depth=${stats.maxDepth} by_subagents=${stats.spawnedBySubagents} ` +
        `refused=depth:${stats.refused.depth},lone_child:${stats.refused.lone_child},concurrency:${stats.refused.concurrency},budget:${stats.refused.budget},leaf:${stats.refused.leaf},serial_root:${stats.refused.serial_root} ` +
        `allowed=serial_root_dependent:${stats.allowed.serial_root_dependent},serial_root_allowed:${stats.allowed.serial_root_allowed} ` +
        `stopped=user:${stats.stopped.user},parent:${stats.stopped.parent},turn_cap:${stats.stopped.turn_cap}` +
        // R31 — the segment is APPENDED, never always present. The engine cannot read the
        // sandbox's flag, so the counters gate themselves: all six at zero is what a turn
        // under a dark team surface always reads, and the line is then the Phase 2 line byte
        // for byte (the leading space rides the segment, so nothing trails it either).
        (team > 0
          ? ` team=messages:${stats.messagesSent},hop_refused:${stats.hopRefusals},lead_stops:${stats.leadStops},resumes:${stats.resumes}` +
            `,board_claims:${stats.boardClaims},board_dones:${stats.boardDones}`
          : ''),
      );
      cfg.onSubagentStats?.(stats);
    }
    resetTreeStats(ctx.taskId);
  }
  await cfg.journal?.flushMirrorAtTurnEnd();
}

// ── P4 Task 4: initiative turn marker ─────────────────────────────────────────

/**
 * Record an initiative turn's provenance as a CONTEXT_POLICY:false `custom` entry
 * (the instruction-snapshot precedent — FROZEN kind, never replays into the model
 * context), appended alongside the turn's user entry. On a fresh-process resume the
 * driver re-derives "this turn is ambient" from this marker (P2 durability doing its
 * job). No-op for a non-initiative origin (or absent) → byte-identical. Best-effort +
 * never-throws (a marker write failure must not abort the run). No-op when journal
 * is absent.
 */
export async function appendInitiativeMarker(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  origin: MessageOrigin | undefined,
): Promise<void> {
  if (!j || origin?.kind !== 'initiative') return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'initiative',
        data: { trigger: origin.trigger, politeness: origin.politeness },
      },
    });
  } catch {
    /* best-effort: an initiative-marker write failure must never abort the run */
  }
}

// ── TOOL_SEARCH_V1: the session's loaded deferred tools ──────────────────────

/**
 * Record newly loaded deferred tools as a CONTEXT_POLICY:false `custom` entry (the
 * initiative-marker precedent — FROZEN kind, never replays into the model context).
 *
 * WHY THE JOURNAL AND NOT A PROCESS MAP: the loaded set must survive a runner
 * recycle. A model that loaded the browser ring on turn 3, paused for a human, and
 * came back on a fresh runtime hours later must still be able to call those tools —
 * otherwise the resume silently narrows its hands and it re-searches (or worse,
 * calls a tool it can no longer see and reads "Unknown tool"). A process-local Set
 * is exactly the `native-todo-store-volatile-on-resume` defect; the journal is the
 * only state that crosses a recycle.
 *
 * ONE ENTRY PER LOAD, names only. The replay UNIONS them in append order, which is
 * also the order the tools array is rebuilt in — so a recycled runner reproduces a
 * byte-identical wire shape, not merely the same set. Best-effort + never-throws
 * (a persistence failure must not fail the tool call: the tool stays loaded
 * in-memory for this process, and the worst case is a recycle that has to search
 * again). No-op when the journal is absent.
 */
export async function appendToolSearchLoaded(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  names: readonly string[],
): Promise<void> {
  if (!j || names.length === 0) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: { type: 'custom', key: 'tool_search_loaded', data: { names: [...names] } },
    });
  } catch {
    /* best-effort: a loaded-set write failure must never fail the tool call */
  }
}

/**
 * Replay the session's loaded deferred tools, deduped, in FIRST-LOAD order.
 *
 * Reads the in-memory read-model (`snapshot()`), not a fresh disk drain — same
 * entries in the same append order (the `readConstructionParams` precedent).
 * Returns [] for a task that never searched, so a cold start is indistinguishable
 * from a fresh one. Never throws.
 */
export async function readToolSearchLoaded(j: Journal | undefined): Promise<string[]> {
  if (!j) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  try {
    for (const e of await j.snapshot()) {
      if (e.payload.type !== 'custom' || e.payload.key !== 'tool_search_loaded') continue;
      const names = (e.payload.data as { names?: unknown })?.names;
      if (!Array.isArray(names)) continue;
      for (const n of names) {
        if (typeof n !== 'string' || seen.has(n)) continue;
        seen.add(n);
        order.push(n);
      }
    }
  } catch {
    /* a replay failure degrades to "nothing loaded" — the model can search again */
  }
  return order;
}

/**
 * P5 Task 3 — record a capture-worthy turn's surprise assessment as a
 * CONTEXT_POLICY:false `custom` entry (the initiative-marker precedent: FROZEN
 * kind, never replays into the model context, survives recycle via P2's
 * durability). Embeds only the small assessment scalars — the turn's content is
 * referenced by journal position, never copied. Best-effort + never-throws;
 * no-op when journal is absent.
 */
export async function appendCaptureSignalEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  surprise: { correction: boolean; outcomeKind: string; forcing: boolean; score: number },
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'nami_capture',
        data: { surprise },
      },
    });
  } catch {
    /* best-effort: a capture-marker write failure must never abort the run */
  }
}

/**
 * UNIT C — record a per-turn billing-tripwire violation as a CONTEXT_POLICY:false
 * `custom` entry (the capture-signal precedent: FROZEN kind, never replayed into the
 * model context — an accounting ANOMALY, not transcript). Carries the reconcile figures
 * (`expected`/`actual`/`delta`) + the run identity so a later audit can locate the turn.
 * Best-effort + never-throws (an anomaly-record write failure must not abort the turn);
 * no-op when the journal is absent. The console.warn already fired at the check site.
 */
export async function appendBillingTripwireEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  data: {
    reason: string;
    expected: number;
    actual: number;
    delta: number;
    taskId: string;
    runId: string;
    round: number;
  },
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'billing_tripwire',
        data,
      },
    });
  } catch {
    /* best-effort: a tripwire-record write failure must never abort the turn */
  }
}



/**
 * Read the `construction_params` off the journal (raw `read()` — `custom` entries
 * are non-context, so `project()` filters them out). Returns undefined for a
 * legacy task that predates D2' (the caller degrades).
 *
 * `model` + `runtime` are IMMUTABLE per task: a task is constructed with one
 * model/harness and there is no mid-run `/model` switch (the only control command
 * is `/compact`). So they are pinned FIRST-write-wins to the original construction.
 * The per-turn fields (`agentPrompt`, `maxBudgetUsd`, `outputFormat`,
 * `maxStructuredOutputRetries`) stay latest-wins so a cold continue re-targets the
 * PAUSED turn's exact params.
 *
 * This is the fix for the silent opus→sonnet downgrade: a re-drive whose only
 * model source was `config.model` (the sandbox-global default = Sonnet) used to
 * re-stamp a fresh `construction_params`, and last-write-wins then ratcheted the
 * task off the user-picked model permanently. Pinning model/runtime to the first
 * construction makes that re-stamp inert.
 */
export async function readConstructionParams(
  j: Journal,
): Promise<ConstructionParams | undefined> {
  let latest: ConstructionParams | undefined;
  let firstModel: string | undefined;
  let firstRuntime: HarnessId | undefined;
  // P2.8 — read the in-memory read-model, not a fresh whole-file disk drain. Same
  // entries in the same append order, so first-write/last-write pinning is unchanged.
  for (const e of await j.snapshot()) {
    if (e.payload.type === 'custom' && e.payload.key === 'construction_params') {
      const p = e.payload.data as ConstructionParams;
      latest = p;
      if (firstModel === undefined) {
        firstModel = p.model;
        firstRuntime = p.runtime;
      }
    }
  }
  if (!latest) return undefined;
  return { ...latest, model: firstModel ?? latest.model, runtime: firstRuntime ?? latest.runtime };
}

/**
 * The effective per-task model for a (possibly model-less) re-drive.
 *
 * The first USER_MESSAGE carries the server-resolved per-task model as an explicit
 * override; some continuations (HITL tool-permission resolve, the interrupt-redirect
 * re-drive) arrive WITHOUT it. Without recovery the builder's `?? config.model`
 * fallback would silently downgrade the run to the sandbox-global default (Sonnet).
 * Since the model is immutable per task, recover it from the journal's FIRST
 * construction (see `readConstructionParams`, first-write-wins for model). Returns:
 *   - the explicit `modelOverride` when present (first message / server sent it);
 *   - else the model recorded at the task's first construction;
 *   - else undefined (a genuinely fresh task — caller falls back to config.model).
 *
 * Native arms only: the journal exists only for `native` / `openai_responses`, so
 * the caller gates the call to those runtimes.
 */
export async function recoverPerTaskModel(
  modelOverride: string | undefined,
  j: Journal,
): Promise<string | undefined> {
  if (modelOverride !== undefined) return modelOverride;
  return (await readConstructionParams(j))?.model;
}

// ── Message loader ────────────────────────────────────────────────────────────

/**
 * Build the Anthropic MessageParam[] for the next model call.
 *
 * When a journal is present: project() → journalToAnthropicMessages() (durable
 * history, survives sandbox recycles). When absent: return a single-message
 * fallback using the current user turn text (in-memory path, Task 8 behaviour).
 * When absent AND no fallbackTurn: return [] (caller's responsibility to handle).
 */
export async function loadMessages(
  j: Journal | undefined,
  fallbackTurn: { text: string } | undefined,
): Promise<Anthropic.MessageParam[]> {
  if (j) {
    const { messages } = await j.project();
    return journalToAnthropicMessages(messages);
  }
  if (fallbackTurn) {
    return [{ role: 'user', content: fallbackTurn.text }];
  }
  return [];
}
