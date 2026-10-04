/**
 * step-memo.ts — P2.3 step-result-as-checkpoint memo store (PR-5).
 *
 * The kernel half of the headline P2.3 mechanism: a settled unit of durable work
 * (a Weave node, a subagent run) is journaled as a `step_result` entry keyed by a
 * stable hash of its spec. On re-execution the dispatcher consults the memo BEFORE
 * admitting the unit and returns the journaled outcome at $0 — so a killed
 * mid-orchestration run resumes re-running ZERO settled units.
 *
 * PURE + root-safe: contract imports + `node:crypto` only (the `clock.ts` precedent —
 * `randomUUID` is already in the pure root; only `node:fs` is excluded). No consumers
 * are wired in this slice; Task 8 (PR-6) adds the Weave/subagent consult.
 */

import { createHash } from 'node:crypto';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { SubagentPathSegment } from '../../contract/subagent-path.js';
import type { Journal } from './journal.js';

/** The concrete `step_result` payload shape (the memo record findStepMemo returns). */
export type StepResultPayload = Extract<JournalPayload, { type: 'step_result' }>;

/** resultText is bounded to this many UTF-8 bytes at the append boundary (`≤64KB`). */
export const MAX_RESULT_TEXT_BYTES = 64 * 1024;

/** Appended to a clamped resultText so a memo hit reads as visibly truncated. */
export const STEP_RESULT_TRUNCATION_MARKER = '\n[...truncated]';

/**
 * Recursively canonicalize a value so equal specs stringify identically regardless of
 * object key order (arrays keep their order — a spec's lists are order-significant).
 * `undefined`/functions drop exactly as JSON.stringify would; this only sorts keys.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

/**
 * A 12-char sha256 prefix of a stably-stringified spec — the `hash12` idiom from
 * instruction-stack.ts, over a key-order-independent canonical form. Stable across a
 * re-run so a settled unit's memo is found on resume; discriminating so an edited spec
 * (changed prompt/opts) MISSES the memo and re-runs.
 */
export function hashNodeSpec(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(spec))).digest('hex').slice(0, 12);
}

/**
 * P3.3b (M1) — the FULL sha256 hex of a canonicalized spec. The 12-hex prefix above
 * is fine for memo lookups (a collision is benign — worst case a wrong $0 replay),
 * but the Weave one-shot APPROVAL key authorizes a side-effect: a ~2^47
 * second-preimage against a 48-bit prefix is not absurd for an attacker who can
 * prompt-inject leaf content. Approval keys + leaf execution records use this
 * full-width hash; node memos keep hash12.
 */
export function hashLeafCall(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(spec))).digest('hex');
}

/**
 * The LAST `step_result` in `entries` matching both `scope` and `specHash`, or
 * undefined. Last-wins because a re-executed unit appends a fresh memo that must
 * supersede its predecessor (append-only journal — the older row still exists).
 */
export function findStepMemo(
  entries: readonly JournalEntry[],
  scope: string,
  specHash: string,
): StepResultPayload | undefined {
  let found: StepResultPayload | undefined;
  for (const e of entries) {
    const p = e.payload;
    if (p.type === 'step_result' && p.scope === scope && p.specHash === specHash) {
      found = p;
    }
  }
  return found;
}

/** A scope → (specHash → memo) view over a journal snapshot's step_result entries. */
export type StepMemoIndex = Map<string, Map<string, StepResultPayload>>;

/**
 * P2.8 — build the scope→specHash memo index ONCE from a journal snapshot, so a
 * turn's many Agent/Weave memo consults become O(1) map lookups instead of an O(n)
 * `findStepMemo` linear scan each (the tool-side half of the read-amplification: one
 * Agent/Weave invocation drained + linear-scanned the whole journal per consult).
 * Last-wins per (scope, specHash) — exactly `findStepMemo`'s precedence (a
 * re-executed unit's fresher memo supersedes its predecessor in the append-only
 * journal, so the later entry overwrites the earlier one as we fold in append order).
 */
export function indexStepMemos(entries: readonly JournalEntry[]): StepMemoIndex {
  const index: StepMemoIndex = new Map();
  for (const e of entries) {
    const p = e.payload;
    if (p.type !== 'step_result') continue;
    let byHash = index.get(p.scope);
    if (!byHash) {
      byHash = new Map();
      index.set(p.scope, byHash);
    }
    byHash.set(p.specHash, p); // append-order fold ⇒ last-wins, same as findStepMemo
  }
  return index;
}

/**
 * P2.8 — the memo for (scope, specHash) from an `indexStepMemos` map, or undefined.
 * Byte-identical result to `findStepMemo(entries, scope, specHash)` over the same
 * entries; the index just makes the lookup O(1).
 */
export function lookupStepMemo(
  index: StepMemoIndex,
  scope: string,
  specHash: string,
): StepResultPayload | undefined {
  return index.get(scope)?.get(specHash);
}

/**
 * P2.8 — ONE journal snapshot + step-memo index shared across every Agent/Weave
 * invocation in a run (built lazily, frozen at first consult). Before this, each
 * tool `execute` drained + linear-scanned the WHOLE journal from disk per consult;
 * this reads the in-memory read-model ONCE (`journal.snapshot()` — no disk) and
 * derives a scope→specHash index for O(1) lookups shared by both tools.
 *
 * FROZEN-ONCE is correct: a run's own step_result memos are never self-consulted (the
 * Agent scope is the durable per-child tool_use id; the Weave scope keys on the WEAVE
 * tool_use id + a per-content callIndex), so distinct invocations live under distinct
 * scopes and a snapshot taken before this run's appends can never miss a memo it
 * should have matched. A resume runs in a FRESH process → a fresh holder → it sees the
 * prior process's memos. A journal-less run yields an empty index (no memos, no disk).
 */
export interface StepMemoSnapshot {
  /** The full frozen read-model (Weave's projectScope re-entry seed needs every entry). */
  entries(): Promise<readonly JournalEntry[]>;
  /** The memo for (scope, specHash), O(1). Undefined when journal-less or no match. */
  find(scope: string, specHash: string): Promise<StepResultPayload | undefined>;
}

export function createStepMemoSnapshot(journal: Journal | undefined): StepMemoSnapshot {
  let entriesPromise: Promise<readonly JournalEntry[]> | null = null;
  let indexPromise: Promise<StepMemoIndex> | null = null;
  const readEntries = (): Promise<readonly JournalEntry[]> => {
    entriesPromise ??= freezeEntries(journal);
    return entriesPromise;
  };
  const readIndex = (): Promise<StepMemoIndex> => {
    indexPromise ??= readEntries().then(indexStepMemos);
    return indexPromise;
  };
  return {
    entries: readEntries,
    async find(scope, specHash) {
      return lookupStepMemo(await readIndex(), scope, specHash);
    },
  };
}

/**
 * COPY the read-model at freeze time: Journal.snapshot() returns the LIVE array by
 * reference and doAppend mutates it in place, so a held reference would drift as the
 * run appends its own memos. A shallow copy freezes it (entries are immutable
 * append-only), matching the old per-execute drained snapshot exactly. Prefers the
 * in-memory read-model; falls back to a one-shot read() drain for a structural journal
 * stub that predates snapshot() (test doubles).
 */
async function freezeEntries(journal: Journal | undefined): Promise<readonly JournalEntry[]> {
  if (!journal) return [];
  if (typeof journal.snapshot === 'function') return [...await journal.snapshot()];
  const all: JournalEntry[] = [];
  for await (const e of journal.read()) all.push(e);
  return all;
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Clamp resultText to MAX_RESULT_TEXT_BYTES UTF-8 bytes INCLUDING the marker, trimming
 * on a codepoint boundary (binary search over the codepoint prefix — never splits a
 * surrogate pair). Under budget ⇒ returned unchanged.
 */
function clampResultText(text: string): string {
  if (utf8Len(text) <= MAX_RESULT_TEXT_BYTES) return text;
  const codepoints = Array.from(text);
  const budget = MAX_RESULT_TEXT_BYTES - utf8Len(STEP_RESULT_TRUNCATION_MARKER);
  let lo = 0;
  let hi = codepoints.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Len(codepoints.slice(0, mid).join('')) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return codepoints.slice(0, lo).join('') + STEP_RESULT_TRUNCATION_MARKER;
}

/** The entry-header attribution a step_result carries beyond the journal's own identity. */
export interface StepMemoCtx {
  /**
   * T10 scope tag — present ONLY when a subagent settles the unit, so the memo entry
   * lives in that subagent's scoped conversation like its other rounds. Conditional
   * spread: absent ⇒ no `agentPath` key ⇒ byte-identical to a main-agent entry.
   */
  agentPath?: SubagentPathSegment[];
}

/** The memo fields a caller supplies; `resultText` is clamped, `settledAt` is passed in. */
export interface StepMemoInput {
  scope: string;
  specHash: string;
  status: 'ok' | 'error';
  resultText: string;
  costUsd: number;
  settledAt: string;
}

/**
 * Append a `step_result` memo via the Journal class API (taskId/workspaceId come from
 * the journal; system-attributed like the kernel's other synthesized entries). The
 * clock is NEVER read here — `settledAt` is the caller's settle time. No-op-safe only
 * on a real Journal; `resultText` is clamped to ≤64KB before it is durably written.
 */
export async function appendStepResult(
  j: Journal,
  ctx: StepMemoCtx,
  memo: StepMemoInput,
): Promise<void> {
  await j.append({
    taskId: j.taskId,
    rootTaskId: j.taskId,
    spawnDepth: 0,
    workspaceId: j.workspaceId,
    agentId: 'system',
    principal: { kind: 'system' },
    timestamp: '',
    ...(ctx.agentPath && ctx.agentPath.length ? { agentPath: ctx.agentPath } : {}),
    payload: {
      type: 'step_result',
      scope: memo.scope,
      specHash: memo.specHash,
      status: memo.status,
      resultText: clampResultText(memo.resultText),
      costUsd: memo.costUsd,
      settledAt: memo.settledAt,
    },
  });
}
