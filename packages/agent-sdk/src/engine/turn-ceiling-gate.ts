/**
 * The parent turn loop's PER-TURN SPEND CEILING gate (2026-08-24 burn).
 *
 * Two pieces, both owned here so the loop file keeps only its call sites (R3: it
 * ratchets DOWN — the same reason the compaction body lives in compaction-run.ts):
 * the predicate the loop head reads, and the outcome a trip finalizes to.
 *
 * THE HEAD CHECK stops the loop BEFORE the next model call once THIS TURN's live
 * spend reaches the ceiling. The reading is the live ledger's turn delta (baseline
 * marked in openTurn), so a turn whose CHILDREN are burning trips while they burn —
 * the burn's gates all read a completion-fed counter frozen at $0.19 while 475 child
 * rounds spent $31, and none of them ever fired.
 *
 * Deliberately SEPARATE from `maxBudgetUsd` (the task-lifetime overdraft guard) —
 * never min() them. RESUMABLE: the turn finalizes as the same recoverable max_budget
 * family the budget gate uses (native-run-turn.ts), so a later user message opens a
 * fresh turn with a fresh baseline.
 *
 * A tripped CHILD stops at its own loop head and settles its accumulated cost
 * normally (money spent is money booked), and the launch gate refuses to start new
 * ones — so the worst-case overshoot after the trip is one in-flight round per
 * already-running child, and the parent's head check finalizes the turn once the
 * batch settles.
 *
 * THE FINALIZATION routes the turn AROUND finalizeTurn: the epilogue can drive its
 * own model call, and a ceiling that buys one more request is not a ceiling. It is
 * the recoverable max_budget family carrying the ONE outcome shape the whole rail is
 * keyed on (the server maps `raw.subtype` to the user-facing copy). run()'s
 * terminalTurnEnd carries the billing (cumulative + journalSeedUsd + this turn's real
 * delta), exactly as it does for the budget gate: the trip is a stop, not a lost
 * receipt. The work streamed so far rides `turnBlocks` unchanged.
 */
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { RunContext } from './run-context.js';
import type { LiveSpendLedger } from './live-spend.js';

// The ceiling's ONE predicate lives with the ledger it reads (shared with both
// subagent loop heads and the children[] launch gate); re-exported so the parent
// loop reaches the whole rail through this gate.
export { turnSpendCeilingReached as turnCeilingReached } from './live-spend.js';

/** The outcome a tripped turn finalizes to, in place of finalizeTurn's epilogue. */
export function buildTurnCeilingOutcome(rc: RunContext): TurnOutcome {
  return {
    kind: 'max_budget',
    costUsd: rc.billing.cumulativeCostUsd,
    triggeredBy: 'turn_ceiling',
    raw: { subtype: 'turn_spend_ceiling', errors: [] },
  };
}

// ── THE WALLET CAP, at the same head (founder 09-03: credits first-class) ─────
//
// `maxBudgetUsd` is minted per message from the LIVE balance — the NEW spend the
// account can afford from here (openTurn's budget gate, native-run-turn.ts). It
// used to be read ONLY there, at the turn head, right after markTurnStart()
// zeroed the turn's ledger — so it compared $0 against the cap and could trip
// only when the cap itself was $0. A funded-but-thin turn then ran unbounded:
// four staging drills spent 2.5× a $0.01 cap and ended `completed`; a 51-step
// production turn ran past zero. The ceiling above already has the discipline
// this needs — read the live turn delta at EVERY round head, stop BEFORE the
// next model call, finalize as the recoverable max_budget family — so the
// wallet shares its call site. The ceiling is checked first and keeps its own
// name when both would trip at one head.

export type WalletCapSource = 'credits' | 'task_limit';

/** The binding constraint once THIS TURN's live spend reaches the wallet cap
 *  (the live mint first, the static as the cold-resume fallback), else null. */
export function walletCapReached(cfg: {
  maxBudgetUsd?: number | undefined;
  maxBudgetSource?: WalletCapSource | undefined;
  getBudgetMint?: (() => { usd?: number; source?: WalletCapSource }) | undefined;
  liveSpend?: LiveSpendLedger | undefined;
}): WalletCapSource | null {
  if (cfg.liveSpend === undefined) return null;
  const mint = cfg.getBudgetMint?.();
  const budgetUsd = mint?.usd ?? cfg.maxBudgetUsd;
  if (budgetUsd === undefined || cfg.liveSpend.readTurnUsd() < budgetUsd) return null;
  return (mint?.source ?? cfg.maxBudgetSource) === 'task_limit' ? 'task_limit' : 'credits';
}

/** The outcome a wallet-capped turn finalizes to — the same recoverable family
 *  the head gate yields, so a top-up (or a raised limit) resumes it. */
export function buildWalletCapOutcome(rc: RunContext, source: WalletCapSource): TurnOutcome {
  return {
    kind: 'max_budget',
    costUsd: rc.billing.cumulativeCostUsd,
    triggeredBy: source,
    raw: { subtype: 'max_budget', errors: [] },
  };
}
