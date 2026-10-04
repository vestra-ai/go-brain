/**
 * L5 — the TurnBudget: one root signal, mirrored counters, one end(). No clock: nothing
 * in the budget ever aborts the root (a working turn is never cut on time alone; the
 * wall deadline of #3447 was dropped). Each case names the mutation it catches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTurnBudget } from '../turn-budget.js';

describe('createTurnBudget', () => {
  afterEach(() => vi.useRealTimers());

  it('the root is the one signal: aborting it aborts every derived child, with the same reason', () => {
    const budget = createTurnBudget();
    const children = [budget.child(), budget.child(), budget.child()];
    const seen: string[] = [];
    for (const [i, c] of children.entries()) c.addEventListener('abort', () => seen.push(`child${i}`));
    expect(budget.signal).toBe(budget.controller.signal);
    const stop = new Error('stop');
    budget.controller.abort(stop);
    // Mutation: mint an unlinked child → these stay false.
    expect(children.every((c) => c.aborted)).toBe(true);
    expect(children.every((c) => c.reason === stop)).toBe(true);
    expect(seen).toEqual(['child0', 'child1', 'child2']);
    // A child minted AFTER the abort is born aborted, with the same reason.
    const late = budget.child();
    expect(late.aborted).toBe(true);
    expect(late.reason).toBe(stop);
  });

  it('a child never aborts the root: the linkage runs one way', () => {
    const budget = createTurnBudget();
    budget.child();
    // Nothing a child does reaches the root; only the controller's owner aborts it.
    expect(budget.signal.aborted).toBe(false);
  });

  it('reuses a controller the caller already holds', () => {
    const controller = new AbortController();
    const budget = createTurnBudget({ controller });
    expect(budget.controller).toBe(controller);
    expect(budget.signal).toBe(controller.signal);
  });

  it('a long-running turn with no progress limit is never cut: hours of awake time, no timer, no abort', async () => {
    vi.useFakeTimers();
    // The limits the driver mints with: the turn ceiling and maxTurns, and nothing on time.
    const budget = createTurnBudget({ maxSpendUsd: 5, maxRounds: 100 });
    budget.beginTurn();
    budget.noteRound();
    // Mutation: re-add a wall deadline (a timer that aborts the root) → a timer is armed
    // and the root is aborted somewhere in these three hours.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    // The next round head arrives three hours later. Mutation: a time check read at the
    // round head (no timer at all) → noteRound or exhausted() reports it here.
    expect(budget.noteRound()).toBe(2);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.exhausted()).toBeNull();
    expect(budget.ended).toBeNull();
  });

  it('a spend cap is read at the round head: observeSpend at the ceiling → exhausted() = spend', () => {
    const budget = createTurnBudget({ maxSpendUsd: 0.5 });
    budget.observeSpend(0.49);
    expect(budget.exhausted()).toBeNull();
    // Mutation: `>` instead of `>=` → null here.
    budget.observeSpend(0.5);
    expect(budget.exhausted()).toBe('spend');
    expect(budget.spentUsd).toBe(0.5);
    // The mirror only moves up, and ignores garbage.
    budget.observeSpend(0.2);
    budget.observeSpend(Number.NaN);
    expect(budget.spentUsd).toBe(0.5);
  });

  it('a round cap: noteRound up to maxRounds → exhausted() = rounds', () => {
    const budget = createTurnBudget({ maxRounds: 3 });
    expect(budget.noteRound()).toBe(1);
    budget.noteRound();
    expect(budget.exhausted()).toBeNull();
    budget.noteRound();
    expect(budget.exhausted()).toBe('rounds');
    expect(budget.rounds).toBe(3);
  });

  it('exhausted() only reads: it never aborts the root (the loop\'s own gates stay the deciders)', () => {
    const budget = createTurnBudget({ maxSpendUsd: 0.1, maxRounds: 1 });
    budget.noteRound();
    budget.observeSpend(1);
    expect(budget.exhausted()).toBe('spend');
    // Mutation: make exhaustion abort the root → a new cut the loop never had.
    expect(budget.signal.aborted).toBe(false);
  });

  it('end() twice fires the sinks ONCE and records the first reason', () => {
    const budget = createTurnBudget();
    const reasons: string[] = [];
    budget.onEnd((r) => reasons.push(r));
    expect(budget.end('completed')).toBe(true);
    // Mutation: forget the `ended` latch → the second call fires the sink again.
    expect(budget.end('user_aborted')).toBe(false);
    expect(reasons).toEqual(['completed']);
    expect(budget.ended).toBe('completed');
    // end() records; it never aborts.
    expect(budget.signal.aborted).toBe(false);
  });

  it('a throwing sink never affects the exit (the other sinks still run); an unsubscribed sink does not fire', () => {
    const budget = createTurnBudget();
    const seen: string[] = [];
    budget.onEnd(() => { throw new Error('sink boom'); });
    budget.onEnd((r) => seen.push(r));
    const off = budget.onEnd((r) => seen.push(`off:${r}`));
    off();
    expect(budget.end('completed')).toBe(true);
    expect(seen).toEqual(['completed']);
  });

  it('beginTurn() resets a warm turn: fresh counters, ended cleared, the root untouched', () => {
    const budget = createTurnBudget({ maxRounds: 2, maxSpendUsd: 0.3 });
    const root = budget.controller;
    budget.noteRound(); budget.noteRound();
    budget.observeSpend(0.3);
    budget.end('completed');
    budget.beginTurn();
    // Mutation: skip a reset → turn 2 opens on turn 1's counters or its end.
    expect(budget.rounds).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.ended).toBeNull();
    expect(budget.exhausted()).toBeNull();
    expect(budget.controller).toBe(root);
    // Turn 2 ends once, on its own reason.
    expect(budget.end('max_turns')).toBe(true);
    expect(budget.ended).toBe('max_turns');
  });

  it('no limits: nothing is ever exhausted, and the root is a plain controller', () => {
    const budget = createTurnBudget();
    expect(budget.limits).toEqual({});
    expect(budget.exhausted()).toBeNull();
    budget.controller.abort();
    expect(budget.signal.aborted).toBe(true);
  });
});
