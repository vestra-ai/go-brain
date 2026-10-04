/**
 * context-offload.ts — Phase 3 (§1.5) FS context-offload primitive.
 *
 * At the `gateAndDispatchTool` chokepoint, AFTER cost is captured (a tool's own
 * `execute()` has already run and fired any `addCostUsd`/`addChildCost` billing
 * side effects), a tool result over the threshold is written in full to
 * `${workingDir}/.kernel-offload/${taskId}/<toolCallId>.txt` (session/task-
 * NAMESPACED — never a bare toolCallId, so two tasks in one sandbox can never
 * collide) and the value returned to the caller is a small head/tail preview
 * carrying the file's path. The harness's existing tool_result journaling then
 * records THIS preview as the normal tool_result entry — no new journal entry
 * kind is needed; the preview+path IS the durable "pointer."
 *
 * ORDERING (write-then-pointer, atomicity): the file write is awaited to
 * completion before this function returns, and the caller only journals the
 * tool_result AFTER the dispatcher returns — so a pointer can never be durably
 * recorded before the file it points to exists.
 *
 * MISSING FILE ON RESUME: there is no new re-dispatch machinery here — the
 * offloaded content is read back via the ordinary `Read` tool against a real
 * sandbox-filesystem path. If the file is later GC'd, `Read` returns its normal
 * "not found" result; nothing about that path re-triggers the tool that
 * produced the original result.
 *
 * BINARY: `looksBinary` content is left untouched — `guardToolOutput` (the
 * caller's next step) refuses it outright, so there is no point writing garbage
 * bytes to the offload volume.
 *
 * THRESHOLD: a fraction of the running model's `contextWindowTokens` (Phase 4
 * §1.7 model Profile), so a 1M-context model gets a proportionally larger
 * per-result offload budget than a 200k one. `model` absent (tests, journal-
 * less callers) → the pre-Phase-4 fixed floor, unchanged.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { guardToolOutput, looksBinary } from './tool-output-guard.js';
import { fenceUntrustedText } from '../tools/tool-types.js';
import { truncateToTokenBudget, withinTokenBudget } from '../tools/output-limits.js';
import { truncationMarker, spillRecovery } from '../tools/result-shape.js';
import { toolResultShapeEnabled } from '../policy/feature-flags.js';
import { resolveModelProfile } from '../contract/model-profile.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { toolOutputTokenBudgetEnabled } from '../policy/feature-flags.js';

/** Conservative fixed floor (chars) — the fallback when no model is known. */
export const DEFAULT_OFFLOAD_THRESHOLD_CHARS = 20_000;

/** The offload threshold is this fraction of the model's contextWindowTokens,
 *  expressed in chars via the same "~4 chars/token" heuristic used elsewhere
 *  in this engine (K4-T0's estimateTokens). Clamped to a sane range so a tiny
 *  or huge context window never produces a pathological threshold.
 *
 *  The MIN clamp is deliberately the pre-Phase-4 DEFAULT_OFFLOAD_THRESHOLD_CHARS
 *  (20,000), not an arbitrary smaller floor: a naive 8,000-char min would make
 *  every 200k-context model (claude-sonnet-4-5, opus-4-5, haiku-4-5 — still
 *  live today) compute 200_000*0.02*4=16,000, a REGRESSION vs the fixed floor
 *  every dispatch site already relied on. Model-awareness must only ever RAISE
 *  the threshold for a larger-context model, never lower it for a smaller one. */
const OFFLOAD_WINDOW_FRACTION = 0.02;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MIN_OFFLOAD_THRESHOLD_CHARS = DEFAULT_OFFLOAD_THRESHOLD_CHARS;
const MAX_OFFLOAD_THRESHOLD_CHARS = 200_000;

/**
 * Resolve the offload threshold (chars) for `modelId`, as a fraction of its
 * real contextWindowTokens (Phase 4 model Profile). `modelId` absent/unknown
 * ⇒ the pre-Phase-4 fixed floor (byte-identical fallback). Never throws.
 */
export function offloadThresholdForModel(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_OFFLOAD_THRESHOLD_CHARS;
  const profile = resolveModelProfile(modelId);
  const raw = Math.round(profile.contextWindowTokens * OFFLOAD_WINDOW_FRACTION * CHARS_PER_TOKEN_ESTIMATE);
  return Math.min(MAX_OFFLOAD_THRESHOLD_CHARS, Math.max(MIN_OFFLOAD_THRESHOLD_CHARS, raw));
}

/** C2 — the tool-result budget in tokens for a model row that carries none. */
export const DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET = 10_000;

/**
 * C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1) — the running model's tool-result budget in tokens, or
 * `undefined` while the flag is off (the character limits alone apply, byte-identical). A
 * model row's `toolOutputTokenBudget` wins; absent (every row today, unknown ids, no model
 * threaded) ⇒ the default. Read per dispatch: no module state.
 */
export function activeToolOutputTokenBudget(modelId: string | undefined): number | undefined {
  if (!toolOutputTokenBudgetEnabled()) return undefined;
  return (modelId ? resolveCapabilities(modelId).toolOutputTokenBudget : undefined) ?? DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET;
}

const PREVIEW_HEAD_CHARS = 2_000;
const PREVIEW_TAIL_CHARS = 1_000;

export interface OffloadParams {
  text: string;
  /** The sandbox filesystem root (e.g. `/app/workspace`). */
  workingDir: string;
  taskId: string;
  toolCallId: string;
  thresholdChars?: number;
  /** Phase 4 (§1.7) — the running model, used to derive a window-fraction
   *  threshold when `thresholdChars` is not explicitly supplied. Absent ⇒ the
   *  fixed floor (byte-identical to pre-Phase-4 behavior). */
  model?: string;
  /**
   * W4-1 — the dispatching tool declared `untrustedContent`: the STORED FILE
   * gets the untrusted-content fence around its full body, so a later read-back
   * (Read, Bash cat, Grep) returns marker-carrying bytes the system paragraph
   * already explains — without this, the offload pointer INVITES a Read that
   * re-enters the full hostile body unfenced, bypassing both rings for exactly
   * the oversized class. The RETURNED preview is unchanged (raw head/tail; the
   * dispatcher fences the preview after this call exactly as before), so the
   * journal bytes and every fixture are untouched. Absent ⇒ raw file bytes,
   * byte-identical to today.
   */
  untrusted?: boolean;
  /**
   * C2 — the running model's budget in tokens (TOOL_OUTPUT_TOKEN_BUDGET_V1 on). Present, it
   * replaces the char threshold: a result over it is spilled and returned as head and tail
   * filled to the budget, naming the path. Absent ⇒ the char threshold, byte-identical.
   */
  budgetTokens?: number;
}

export interface OffloadResult {
  /** The value to return to the caller — unchanged, or a head/tail preview + path. */
  text: string;
  offloaded: boolean;
  /** Present only when offloaded — the path RELATIVE to workingDir. */
  path?: string;
}

/**
 * Offload `text` to disk when it exceeds the threshold; otherwise return it
 * unchanged. Never throws — a filesystem failure degrades to the original text
 * (guardToolOutput's hard cap remains the backstop), matching every other
 * degrade-safe seam in this engine.
 */
export async function offloadIfOversized(params: OffloadParams): Promise<OffloadResult> {
  const { text, workingDir, taskId, toolCallId, budgetTokens } = params;

  if (typeof text !== 'string') return { text, offloaded: false };
  // C2: with a budget, it is the one trigger (the char threshold, and its override, apply
  // only while the flag is off).
  const oversized = budgetTokens !== undefined
    ? !withinTokenBudget(text, budgetTokens)
    : text.length > (params.thresholdChars ?? offloadThresholdForModel(params.model));
  if (!oversized) return { text, offloaded: false };
  if (looksBinary(text)) return { text, offloaded: false };

  const relPath = `.kernel-offload/${taskId}/${toolCallId}.txt`;
  const absPath = join(workingDir, relPath);

  try {
    await fs.mkdir(dirname(absPath), { recursive: true });
    // Full fidelity, written BEFORE any pointer is returned. W4-1: a tainted
    // result's file carries the fence (embedded markers defanged), so read-back
    // paths return marker-carrying bytes instead of the raw hostile body.
    await fs.writeFile(absPath, params.untrusted === true ? fenceUntrustedText(text) : text, 'utf8');
  } catch {
    return { text, offloaded: false };
  }

  // C2: head and tail filled to the budget, naming the same path. A result that rode whole
  // under the old threshold keeps as much of itself as the budget allows, never a fixed 3K.
  // The notice names the ABSOLUTE path: a relative one resolves against wherever the shell's
  // cwd has drifted, so the agent had to `find` its own spill (drill f5c905bd).
  if (budgetTokens !== undefined) {
    return { text: truncateToTokenBudget(text, budgetTokens, resolve(absPath)).text, offloaded: true, path: relPath };
  }

  const head = text.slice(0, PREVIEW_HEAD_CHARS);
  const tail = text.slice(-PREVIEW_TAIL_CHARS);
  // T5 (TOOL_RESULT_SHAPE_V1): the one truncation marker, naming the ABSOLUTE spill path the
  // budget path names (a relative one resolves against a drifted cwd). Off: today's preview.
  const preview = toolResultShapeEnabled()
    ? `${head}\n${truncationMarker({
        omitted: `${text.length - head.length - tail.length} characters`,
        from: 'middle',
        recovery: spillRecovery(resolve(absPath)),
      })}\n${tail}`
    : `${head}\n\n…[offloaded: ${text.length} chars total — showing head/tail. ` +
      `Full content: ${relPath} — use Read to page through it.]…\n\n${tail}`;

  return { text: preview, offloaded: true, path: relPath };
}

/**
 * C2 — the flag-on tail of a dispatch: spill over the budget (when the sandbox filesystem is
 * threaded), then the budget itself, then the hard char cap. The budget
 * step binds only when nothing was spilled (no filesystem, or the write failed): head and tail
 * are kept and the marker names the re-run. It runs BEFORE the cap because the cap keeps only
 * the head; binary skips it so the cap's refusal sees every byte. Never throws.
 */
export async function holdToTokenBudget(
  text: string,
  budgetTokens: number,
  toolCallId: string,
  ctx: { workingDir?: string; taskId?: string; offloadThresholdChars?: number; model?: string } = {},
  untrusted = false,
): Promise<string> {
  let out = text;
  if (ctx.workingDir && ctx.taskId) {
    const offload = await offloadIfOversized({
      text, workingDir: ctx.workingDir, taskId: ctx.taskId, toolCallId, budgetTokens,
      ...(ctx.offloadThresholdChars !== undefined && { thresholdChars: ctx.offloadThresholdChars }),
      ...(ctx.model !== undefined && { model: ctx.model }),
      ...(untrusted && { untrusted: true }),
    });
    out = offload.text;
  }
  return guardToolOutput(looksBinary(out) ? out : truncateToTokenBudget(out, budgetTokens).text);
}

/**
 * CONTEXT_ELISION_V1 — spill the full bodies of results the eliding projection is
 * about to stub, into the SAME `.kernel-offload/<taskId>/` namespace the
 * single-result offload above owns. A result large enough to offload at dispatch
 * time is already there (the write is skipped); a result that only became worth
 * removing once it aged lands here instead, so the path the stub names is real.
 *
 * WRITE-BEFORE-STUB: the caller awaits this BEFORE the stubbed projection can
 * reach the wire, matching the offload primitive's write-then-pointer ordering —
 * a stub can never name a file that does not exist yet.
 *
 * BEST-EFFORT + NEVER THROWS: a filesystem failure leaves the stub naming a path
 * that `Read` will report as not-found, which is the same degrade an offloaded
 * result already has after a GC. It deliberately does NOT change the stub text —
 * a stub whose bytes depended on I/O success would differ between two projections
 * of the same journal and bust the prompt cache (see elide.ts's header).
 *
 * Existing files are left untouched (`wx`), so re-spilling across a recycle is a
 * cheap no-op rather than a rewrite.
 */
export async function spillElidedResults(
  spills: ReadonlyArray<{ text: string; path: string }>,
  workingDir: string,
): Promise<number> {
  if (spills.length === 0 || !workingDir) return 0;
  let written = 0;
  for (const s of spills) {
    const absPath = join(workingDir, s.path);
    try {
      await fs.mkdir(dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, s.text, { encoding: 'utf8', flag: 'wx' });
      written++;
    } catch {
      // Already present (the common case — dispatch-time offload wrote it) or
      // unwritable. Either way the stub already names the right path.
    }
  }
  return written;
}
