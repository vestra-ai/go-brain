/**
 * How a round's tool batch is PARTITIONED into concurrent/sequential segments, and
 * the queryable record of that decision.
 *
 * Extracted from round-engine.ts (which only ratchets down — apps/reconciler
 * file-size lint) so the partitioner, its contract, and the telemetry that observes
 * it live together: the shape record is derived from `partitionToolBatch`'s own
 * output, so a change to one that fails to update the other is a change to a single
 * file. Behaviour is a verbatim move; only the tool_use element type is now generic
 * (it was `RoundState['toolUses']`) so the module owes nothing to the engine's state.
 */
import { REEXECUTE_BOUND_TOOLS } from '../kernel/index.js';
import { toolConcurrencyClassesEnabled } from '../policy/feature-flags.js';
import type { RawToolOptions } from '../tools/tool-types.js';

/** The only field the partitioner reads off a tool_use. */
export type BatchToolUse = { name: string };

/** The tool-definition fields the class resolver reads. */
export type ConcurrencyDecl = Pick<RawToolOptions, 'name' | 'concurrency' | 'concurrencySafe'>;

/**
 * L2 — the names in this round's registry whose calls may overlap with batch
 * siblings (the partitioner's second run predicate; Agent is eligible regardless,
 * via REEXECUTE_BOUND_TOOLS). Classes OFF: the W3-2 `concurrencySafe` marker alone,
 * byte-identical to before. Classes ON: the declared class; an undeclared tool
 * keeps its legacy marker (so the server's concurrencySafe-only tools keep their
 * overlap), and anything else is exclusive. Unknown names are never in the set.
 */
export function sharedToolNames(
  tools: readonly ConcurrencyDecl[],
  classesOn: boolean = toolConcurrencyClassesEnabled(),
): Set<string> {
  const shared = (t: ConcurrencyDecl): boolean =>
    classesOn
      ? (t.concurrency ?? (t.concurrencySafe === true ? 'shared' : 'exclusive')) === 'shared'
      : t.concurrencySafe === true;
  return new Set(tools.filter(shared).map((t) => t.name));
}

/**
 * A contiguous run of a round's tool batch that executes as one unit. A
 * `concurrent` run is ≥2 CONSECUTIVE run-eligible tool_uses — `Agent`
 * (REEXECUTE_BOUND_TOOLS) or `concurrencySafe`-declared (W3-2) — that overlap
 * through the `:turnbatch` pool; a `sequential` run is everything else —
 * undeclared tools AND a lone eligible call — run one-at-a-time. Segments execute
 * in batch order, each FULLY settling before the next, so exact relative order is
 * preserved (K3) and an undeclared tool between two runs is a hard barrier.
 */
export interface ToolBatchSegment<T extends BatchToolUse = BatchToolUse> {
  concurrent: boolean;
  tus: T[];
}

/**
 * Partition a round's tool batch into ordered concurrent/sequential segments.
 *
 * The T6 concurrent fast path used to require the ENTIRE round be `Agent` calls
 * (`toolUses.every(isAgent)`), so ONE bookkeeping tool_use (TaskCreate/TaskUpdate,
 * a todo write) emitted alongside real Agent dispatches demoted the whole round to
 * the sequential path and serialized the "parallel" subagents (prod task 7f77166a:
 * the more diligent the model's todo bookkeeping, the more parallelism it lost).
 * Partitioning instead runs each maximal ≥2 run of CONSECUTIVE Agent calls
 * concurrently while the rest stay sequential — so the bookkeeping+dispatch pattern
 * keeps its parallelism, and the historic all-`Agent` round is just the special
 * case of ONE full-width concurrent run.
 *
 * `mainLoop` (deps.sub === undefined) gates concurrency ENTIRELY unless
 * `nestedConcurrent` is set: a subagent batch NEVER forms a concurrent run
 * (deadlock discipline — the `:turnbatch` pool is main-loop-only; P2.2 gate 5), so
 * it returns as a single sequential segment, byte-identical to the historic nested
 * body. Under the orchestration walls the caller passes `nestedConcurrent`, and the
 * nested batch partitions on exactly the main-loop rules (spec §4.2) — see the
 * early return for why the deadlock that rule guarded against cannot form there. A
 * main-loop round with no ≥2-consecutive-eligible run likewise coalesces to a single
 * sequential segment == the historic `for (const tu of st.toolUses)` sweep.
 *
 * W3-2 — `isConcurrencySafe` is the SECOND run predicate: a tool whose definition
 * declares `concurrencySafe: true` (no side effects, no ordering dependence on
 * batch siblings) is run-eligible alongside Agent, so three Reads and a Grep in
 * one round overlap instead of costing four serial round-trips — and a lone Agent
 * beside a safe call now makes a 2-wide mixed run. The predicate is deliberately
 * SEPARATE from REEXECUTE_BOUND_TOOLS: that set also drives interaction
 * re-execution/resume shapes (strategy.ts), and adding names there would change
 * how their pauses materialize. Absent predicate = fail-closed (Agent-only runs,
 * byte-identical to pre-W3-2).
 */
export function partitionToolBatch<T extends BatchToolUse>(
  toolUses: T[],
  mainLoop: boolean,
  isConcurrencySafe: (name: string) => boolean = () => false,
  opts: { nestedConcurrent?: boolean } = {},
): Array<ToolBatchSegment<T>> {
  const eligible = (t: { name: string }): boolean =>
    REEXECUTE_BOUND_TOOLS.has(t.name) || isConcurrencySafe(t.name);
  // Orchestration walls (spec §4.2): a NESTED batch partitions exactly like the main
  // loop. The "nested is always sequential" rule existed to keep a slot-holding parent
  // off the pool its children need; under the walls admission is by refusal (a parent
  // holds no slot), so the deadlock it guarded against cannot form. Absent the option:
  // one sequential segment (never concurrent) — the historic body.
  if (!mainLoop && opts.nestedConcurrent !== true) {
    return toolUses.length ? [{ concurrent: false, tus: toolUses }] : [];
  }
  const segments: Array<ToolBatchSegment<T>> = [];
  let seq: T[] = [];
  const flushSeq = (): void => {
    if (seq.length) {
      segments.push({ concurrent: false, tus: seq });
      seq = [];
    }
  };
  let i = 0;
  const n = toolUses.length;
  while (i < n) {
    if (eligible(toolUses[i])) {
      let j = i + 1;
      while (j < n && eligible(toolUses[j])) j += 1;
      if (j - i >= 2) {
        // ≥2 consecutive eligible calls → a concurrent run. It is a BARRIER for the
        // pending sequential run, which must fully settle first (exact order).
        flushSeq();
        segments.push({ concurrent: true, tus: toolUses.slice(i, j) });
        i = j;
        continue;
      }
      // A lone eligible call (run of 1) coalesces into the sequential run below.
    }
    seq.push(toolUses[i]);
    i += 1;
  }
  flushSeq();
  return segments;
}

/** The per-round record `appendToolBatchShapeEntry` journals. See that helper for
 *  the query shapes it exists to answer. */
export interface ToolBatchShape {
  round: number;
  api: string;
  model: string;
  tools: number;
  eligible: number;
  agents: number;
  widths: number[];
}

/**
 * Derive the round's segment-shape record — or `undefined` when the round had NO
 * batching decision to observe, which is the gate that keeps this cheap.
 *
 * RECORDED: ≥2 tool_uses (a real partition), or ≥1 run-eligible call. That second
 * clause is load-bearing, not generosity: a round whose single tool_use is an
 * `Agent` IS the "my parallel subagents ran one at a time" defect, and the obvious
 * `tools >= 2` gate would render exactly that shape invisible — the same blind spot
 * that made the original diagnosis cost a hand reconstruction of round boundaries.
 * SKIPPED: the lone undeclared tool_use, whose shape is a constant (one sequential
 * segment, width 1) and is derivable from its own tool_use entry anyway. On the
 * seven-week staging corpus that gate writes 1,388 rows where an ungated leg writes
 * 7,546 — ~3% journal growth instead of ~16%.
 *
 * `agents` counts off REEXECUTE_BOUND_TOOLS rather than a literal 'Agent': that set
 * IS the SDK's statement of the subagent-spawning tool's identity, so counting from
 * it mints no further mirrored copy of the name to drift. `widths` carries only the
 * CONCURRENT runs — `[2,2]` (two runs split by a barrier) stays distinguishable from
 * `[4]` (one 4-wide run), and `[]` means nothing overlapped.
 *
 * Pure: the caller owns the main-loop gate and the append.
 */
export function toolBatchShape(
  toolUses: readonly BatchToolUse[],
  segments: readonly ToolBatchSegment<BatchToolUse>[],
  isConcurrencySafe: (name: string) => boolean,
  ident: { round: number; api: string; model: string },
): ToolBatchShape | undefined {
  const agents = toolUses.filter((t) => REEXECUTE_BOUND_TOOLS.has(t.name)).length;
  const eligible = toolUses.filter(
    (t) => REEXECUTE_BOUND_TOOLS.has(t.name) || isConcurrencySafe(t.name),
  ).length;
  if (toolUses.length < 2 && eligible < 1) return undefined;
  return {
    ...ident,
    tools: toolUses.length,
    eligible,
    agents,
    widths: segments.filter((s) => s.concurrent).map((s) => s.tus.length),
  };
}
