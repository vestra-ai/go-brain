/**
 * Run-scoped, monotonic, INCLUSIVE spend counter. Unlike rc.billing.cumulativeCostUsd
 * (which a child's spend reaches only when the child COMPLETES and folds), this ledger
 * is bumped once per model round at the price-fold site — parent rounds, subagent rounds
 * at any depth, compaction and epilogue side-calls — so a reader sees money the moment
 * it is spent. 2026-08-24: every gate read a completion-fed counter frozen at $0.19
 * while 475 child rounds burned $31; this ledger is the cure. NEVER bumped at
 * completion folds (that would double-count).
 *
 * The completion folds deliberately left alone — verified by grep over the package:
 * round-tool-batch.ts's `addCostUsd: (usd) => { rc.billing.cumulativeCostUsd += usd; }`
 * (the Agent tool rolling a FINISHED child's total into the parent) and the same
 * roll-up one level down, subagent-runner.ts's execCtx `addCostUsd: (usd: number)`.
 * Both re-add money this ledger already counted round-by-round, so touching either
 * would count every nested round twice. Only per-round/side-call PRICE folds bump it.
 */
import type { Transport } from './transport.js';

/**
 * How one fold was priced. `estimated` = the transport that priced it fell back to the
 * fail-closed MAXIMUM (Transport.pricedAtFailClosed): its rate lookup had no row for the
 * model, so the figure is a bound, up to 100× the real price, not a price.
 */
export interface SpendFold {
  estimated: boolean;
  /** The model the call was priced as — named to the `holdEstimate` hook. */
  model: string;
}

/**
 * A STOP GATE NEVER ACTS ON AN ESTIMATE A PRICE BOOK CAN STILL CORRECT. Prod 09-23, task
 * fee1bd62: a runner that did not know gpt-6-luna priced it at the fail-closed max, this
 * ledger read $11.05 for a turn the server billed $0.11, and the $10 per-turn ceiling
 * stopped real work. An estimated fold the host HOLDS (`holdEstimate`) therefore lives
 * in its own bucket, which every reading a gate (or the RUNNER_STATUS beat) takes
 * excludes. One the host does not hold COUNTS like any price: with no book left to
 * correct it, the estimate is what the server bills (it cannot price the id either), and
 * a gate that ignored it would let an unpriced model run unbounded. Billing is untouched —
 * the claims still carry the full transport price and the server reprices at write.
 */
export interface LiveSpendLedger {
  /** Fold one round/side-call's cost. Non-finite or negative input is ignored.
   *  No `fold` = priced (every non-model fold: web, senses). */
  addUsd(usd: number, fold?: SpendFold): void;
  /** USD folded so far (monotonic). Excludes held estimates. */
  readUsd(): number;
  /**
   * Mark the CURRENT totals as this turn's zero. Called once per user turn, where
   * openTurn snapshots its other per-turn billing baselines.
   */
  markTurnStart(): void;
  /**
   * PRICED USD folded since the last `markTurnStart()` — the reading a PER-TURN gate
   * wants. The mark defaults to 0 at creation, so an unmarked run reads the run
   * total. Never the run total on a warm session: turn 2 of a long conversation
   * would start already past any per-turn line. Excludes held estimates.
   */
  readTurnUsd(): number;
  /** HELD estimated USD folded since the last `markTurnStart()` — telemetry only; no gate reads it. */
  readTurnEstimatedUsd(): number;
}

/**
 * `onSpend` fires AFTER the counted total updates, inside a try/catch — a throwing
 * observer never breaks a billing path (an under-reported gate beats a crashed round).
 * `holdEstimate` is asked on EVERY estimated fold whether a price book can still correct
 * that model's price: `true` holds the dollars out of the gates. Absent (a host with no
 * price-book rail), `false`, or a throw → the estimate counts, as before the rail.
 */
export function createLiveSpendLedger(
  onSpend?: (totalUsd: number) => void,
  holdEstimate?: (model: string, usd: number) => boolean,
): LiveSpendLedger {
  let totalUsd = 0;
  let turnStartUsd = 0;
  let estimatedUsd = 0;
  let turnStartEstimatedUsd = 0;
  const held = (model: string, usd: number): boolean => {
    try {
      return holdEstimate?.(model, usd) === true;
    } catch {
      return false; // A faulting hook holds nothing: the estimate counts.
    }
  };
  return {
    addUsd(usd, fold) {
      if (!Number.isFinite(usd) || usd < 0) return;
      if (fold?.estimated === true && held(fold.model, usd)) {
        estimatedUsd += usd;
        return;
      }
      totalUsd += usd;
      try {
        onSpend?.(totalUsd);
      } catch {
        // Observer faults are never the billing path's problem.
      }
    },
    readUsd: () => totalUsd,
    markTurnStart() {
      turnStartUsd = totalUsd;
      turnStartEstimatedUsd = estimatedUsd;
    },
    readTurnUsd: () => totalUsd - turnStartUsd,
    readTurnEstimatedUsd: () => estimatedUsd - turnStartEstimatedUsd,
  };
}

/**
 * Fold one priced MODEL call — the door all four price-fold sites share (round-engine,
 * subagent-runner's legacy loop, compaction's summarize, the structured-output
 * epilogue). Whether the price is an estimate is asked of the transport that computed
 * it, by the SAME lookup it priced with, against the live table the lease beat's price
 * book adopts into: once the server's row lands, the model's next round is a price.
 *
 * Not the biller's question on purpose. priceUsageUsd resolves an alias through the
 * capabilities table (`gpt-5.6-x` → sol) before it looks for a row; the transport
 * prices the RAW id, so that alias was charged here at the fail-closed max — the
 * fee1bd62 class — while the biller would call it explicitly priced.
 */
export function foldModelSpend(
  ledger: LiveSpendLedger | undefined,
  transport: Transport,
  usd: number,
  model: string,
): void {
  if (ledger === undefined) return;
  ledger.addUsd(usd, { estimated: transport.pricedAtFailClosed?.(model) === true, model });
}

/**
 * The PER-TURN spend ceiling predicate — ONE definition, read at every site that
 * can start new model work: the parent round-loop head (native-harness), both
 * subagent loop heads (subagent-runner) and the children[] launch gate
 * (subagent-pool). Deliberately SEPARATE from `maxBudgetUsd`, which is the
 * task-lifetime overdraft guard: never min() them, they answer different
 * questions ("has this turn run away?" vs "is the task out of money?").
 *
 * Needs BOTH the knob and the ledger — a host that threads neither gates nothing,
 * which is what makes the whole rail inert until it is wired.
 */
export function turnSpendCeilingReached(cfg: {
  turnSpendCeilingUsd?: number | undefined;
  liveSpend?: LiveSpendLedger | undefined;
}): boolean {
  return (
    cfg.turnSpendCeilingUsd !== undefined &&
    cfg.liveSpend !== undefined &&
    cfg.liveSpend.readTurnUsd() >= cfg.turnSpendCeilingUsd
  );
}
