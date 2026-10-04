/**
 * A STOP GATE NEVER ACTS ON AN ESTIMATED PRICE (founder law: a working task is never
 * stopped; only proven non-progress cuts a turn).
 *
 * Prod 09-23, task fee1bd62: a runner one bundle behind did not know gpt-6-luna, so
 * its transport priced every round at the fail-closed per-bucket max; the live-spend
 * ledger read $11.05 for a turn the server billed $0.11 and the $10 per-turn ceiling
 * stopped real work. These price every round with the REAL OpenAI transport (its
 * computeCostUsd and its pricedAtFailClosed) on ids with no raw rate row — an unknown id
 * and an alias the capabilities table folds onto a known row — and pin that:
 *  - no gate that reads the ledger — the per-turn ceiling, the wallet cap, a subagent
 *    loop head, the children[] pool budget — trips on it (the turn-head budget reads
 *    the same turn delta right after openTurn's mark, so it cannot see one either);
 *  - billing is untouched: the claims still carry the full transport price;
 *  - once the price book gives the id a row, the NEXT round counts like any other.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import type { Transport, ProviderHistory, ProviderStream } from '../transport.js';
import type { HarnessContext, UserTurn, GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import { OPENAI_TOKEN_PRICING, adoptPriceBook, priceForModel, pricesAtFailClosed, type TokenPrice } from '../../contract/openai-pricing.js';
import { priceUsageUsd } from '../../contract/usage-pricing.js';
import { resolveCapabilities } from '../../contract/model-capabilities.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';
import { createLiveSpendLedger, foldModelSpend, turnSpendCeilingReached, type LiveSpendLedger } from '../live-spend.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { fanOutChildren } from '../subagent-pool.js';
import { buildToolExecCtx } from '../round-tool-sequential.js';
import { resolveRoutedSpawn, UnknownSpawnModelError } from '../../composition/routed-spawn.js';

/** An OpenAI-family id this bundle has no row for — exactly the old-bundle luna shape. */
const UNKNOWN = 'gpt-gates-ignore-estimates-test';
/** An alias the capabilities table (and so the biller) folds onto sol — but no RAW row. */
const ALIAS = 'gpt-5.6-gates-alias';
/** The transport that prices every round below — the real one, not a fake's opinion. */
const openai = new OpenAIResponsesTransport();
/** The row the server's book hands over — a round of 1M output tokens bills $12. */
const BOOK_ROW: TokenPrice = { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 12, verifiedAt: '2026-09-25', sources: ['test'] };
const CEILING_USD = 10;
/** One round's usage: 1M output tokens, so a round's price IS its row's output rate. */
const USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 1_000_000 };
const ESTIMATED_ROUND_USD = priceForModel(UNKNOWN).outputPerMTok;

/** The runner's price-book rail, in the window where a book can still correct the price. */
const HOLD = (): boolean => true;

afterEach(() => {
  delete OPENAI_TOKEN_PRICING[UNKNOWN];
  delete OPENAI_TOKEN_PRICING[ALIAS];
});

function toolRound(id: string): StreamEvent[] {
  return [
    { kind: 'tool_use', toolUse: { id, name: 'noop', input: {} } } as StreamEvent,
    { kind: 'done', stopReason: 'tool_use', usage: USAGE },
  ];
}

function textRound(): StreamEvent[] {
  return [{ kind: 'text', text: 'done' } as StreamEvent, { kind: 'done', stopReason: 'end_turn', usage: USAGE }];
}

/** `tools` tool rounds then a terminator, every one priced by the REAL OpenAI transport. */
class PricedScriptTransport extends FakeTransport {
  calls = 0;
  constructor(
    private readonly tools: number,
    private readonly beforeCall?: (i: number) => void,
  ) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const i = this.calls++;
    this.beforeCall?.(i);
    return i < this.tools ? toolRound(`t${i}`) : textRound();
  }
  override computeCostUsd(usage: NormalizedUsage, model: string): number {
    return openai.computeCostUsd(usage, model);
  }
  pricedAtFailClosed(model: string): boolean {
    return openai.pricedAtFailClosed(model);
  }
}

const noopToolHost: ToolHost = {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'ok',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  },
};

type TurnEnd = Extract<HarnessEvent, { kind: 'turn_end' }>;

async function runTurns(opts: {
  model?: string;
  transport: PricedScriptTransport;
  liveSpend: LiveSpendLedger;
  turnSpendCeilingUsd?: number;
  maxBudgetUsd?: number;
}): Promise<TurnEnd[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: opts.transport,
    toolHost: noopToolHost,
    liveSpend: opts.liveSpend,
    ...(opts.turnSpendCeilingUsd !== undefined ? { turnSpendCeilingUsd: opts.turnSpendCeilingUsd } : {}),
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: 'task-estimates',
    sessionId: 's-estimates',
    cwd: '/tmp',
    model: opts.model ?? UNKNOWN,
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go' };
  })();
  const ends: TurnEnd[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) {
    if (ev.kind === 'turn_end') ends.push(ev as TurnEnd);
  }
  return ends;
}

describe('the premise — both ids price at the fail-closed max, and a big one', () => {
  it('no raw row for either, and ONE estimated round alone is past the $10 ceiling', () => {
    expect(pricesAtFailClosed(UNKNOWN)).toBe(true);
    expect(pricesAtFailClosed(ALIAS)).toBe(true);
    expect(ESTIMATED_ROUND_USD).toBeGreaterThan(CEILING_USD);
  });

  it('the biller would call the alias priced — which is why the gate asks the transport instead', () => {
    expect(resolveCapabilities(ALIAS).id).toBe('gpt-5.6-sol');
    expect(priceUsageUsd(ALIAS, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).not.toBeNull();
    expect(openai.computeCostUsd(USAGE, ALIAS)).toBeCloseTo(ESTIMATED_ROUND_USD, 6);
  });
});

describe.each([
  ['an unknown id', UNKNOWN],
  ['an alias with no raw row', ALIAS],
])('the parent loop never stops on an estimate — %s', (_label, model) => {
  it('neither the per-turn ceiling nor the wallet cap trips — the turn completes every round', async () => {
    const liveSpend = createLiveSpendLedger(undefined, HOLD);
    const transport = new PricedScriptTransport(3);
    const ends = await runTurns({ model, transport, liveSpend, turnSpendCeilingUsd: CEILING_USD, maxBudgetUsd: CEILING_USD });
    expect(transport.calls).toBe(4);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
    // The gates' reading holds only priced money; the estimate lives in its own bucket.
    expect(liveSpend.readTurnUsd()).toBe(0);
    expect(liveSpend.readTurnEstimatedUsd()).toBeCloseTo(4 * ESTIMATED_ROUND_USD, 6);
    // Billing is untouched: the claim still carries the full transport price.
    expect(ends[0].billing?.cumulativeCostUsd).toBeCloseTo(4 * ESTIMATED_ROUND_USD, 6);
  });

  for (const gate of ['ceiling', 'wallet'] as const) {
    it(`once the book gives the id a row, the NEXT round counts — the ${gate} trips on it`, async () => {
      const liveSpend = createLiveSpendLedger(undefined, HOLD);
      // The beat lands between round 1 and round 2 (the runner adopts on an OK beat).
      const transport = new PricedScriptTransport(5, (i) => {
        if (i === 2) adoptPriceBook({ [model]: BOOK_ROW });
      });
      const ends = await runTurns({
        model,
        transport,
        liveSpend,
        ...(gate === 'ceiling' ? { turnSpendCeilingUsd: CEILING_USD } : { maxBudgetUsd: CEILING_USD }),
      });
      // Rounds 0-1 estimated (ignored), round 2 priced at $12 >= $10 → the next head stops.
      expect(transport.calls).toBe(3);
      expect(ends[0].exitReason).toBe(gate === 'ceiling' ? 'turn_spend_ceiling' : 'max_budget');
      expect(liveSpend.readTurnUsd()).toBeCloseTo(BOOK_ROW.outputPerMTok, 6);
      expect(liveSpend.readTurnEstimatedUsd()).toBeCloseTo(2 * ESTIMATED_ROUND_USD, 6);
    });
  }
});

describe('with no price book left to correct it, an estimate is the bill — it counts', () => {
  it('a host with no hold (no price-book rail, or the window closed): the ceiling trips as before the rail', async () => {
    const liveSpend = createLiveSpendLedger();
    const transport = new PricedScriptTransport(3);
    const ends = await runTurns({ transport, liveSpend, turnSpendCeilingUsd: CEILING_USD });
    // One estimated round is already past $10, so the second head stops.
    expect(transport.calls).toBe(1);
    expect(ends[0].exitReason).toBe('turn_spend_ceiling');
    expect(liveSpend.readTurnEstimatedUsd()).toBe(0);
  });
});

describe('a child model override runs as a KNOWN canonical id, or not at all', () => {
  const parent = { transport: openai, model: 'gpt-6-luna' };

  it('an id the registry does not know is refused at spawn — it never runs unpriced', () => {
    for (const m of ['o3', 'gpt-5', 'gpt-4.1', UNKNOWN]) {
      expect(() => resolveRoutedSpawn({ model: m }, parent, () => openai), m).toThrow(UnknownSpawnModelError);
    }
  });

  it('an alias canonicalizes and counts at its real price, with no hold at all', () => {
    const { model } = resolveRoutedSpawn({ model: 'gpt-5.6' }, parent, () => openai);
    expect(model).toBe('gpt-5.6-sol');
    const liveSpend = createLiveSpendLedger();
    const usd = openai.computeCostUsd(USAGE, model);
    foldModelSpend(liveSpend, openai, usd, model);
    expect(usd).toBeCloseTo(priceForModel('gpt-5.6-sol').outputPerMTok, 6);
    expect(usd).toBeLessThan(ESTIMATED_ROUND_USD);
    expect(liveSpend.readTurnUsd()).toBeCloseTo(usd, 9);
  });
});

// ── the subagent gates ───────────────────────────────────────────────────────

function subTransport(): { transport: Transport; calls: () => number } {
  let calls = 0;
  const t: Partial<Transport> = {
    api: 'fake',
    provider: 'fake',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h, text) => {
      (h as unknown[]).push({ role: 'user', text });
    },
    pushAssistant: (h) => {
      (h as unknown[]).push({ role: 'assistant' });
    },
    pushToolResult: (h, r) => {
      (h as unknown[]).push({ role: 'tool', id: r.toolUseId });
    },
    buildTools: (raw) => raw as unknown[],
    defaultModel: () => UNKNOWN,
    historyFromJournal: () => [] as unknown as ProviderHistory,
    callModel: () => {
      const i = calls++;
      const evs: StreamEvent[] = [
        { kind: 'text', text: `round-${i}` },
        { kind: 'tool_use', toolUse: { id: `tu-${i}`, name: 'noop', input: {} } } as StreamEvent,
        { kind: 'done', stopReason: 'tool_use', usage: USAGE },
      ];
      return evs as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: (usage, model) => openai.computeCostUsd(usage, model),
    pricedAtFailClosed: (model) => openai.pricedAtFailClosed(model),
  };
  return { transport: t as Transport, calls: () => calls };
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

describe('a subagent loop head never stops on an estimate', () => {
  for (const sharedLoop of [false, true]) {
    it(`${sharedLoop ? 'shared' : 'legacy'} loop — runs every round, and still bills them`, async () => {
      const liveSpend = createLiveSpendLedger(undefined, HOLD);
      const { transport, calls } = subTransport();
      const res = await runSubagentLoop({
        transport,
        model: UNKNOWN,
        system: 's',
        userPrompt: 'p',
        tools: [],
        harness: passHarness,
        onPause: noPause,
        maxTurns: 4,
        onEvent: () => {},
        childId: 'child-1',
        sharedLoop,
        liveSpend,
        turnSpendExceeded: () => turnSpendCeilingReached({ turnSpendCeilingUsd: CEILING_USD, liveSpend }),
      });
      expect(calls()).toBe(4);
      expect(res.text).not.toContain('turn spend ceiling');
      expect(res.costUsd).toBeCloseTo(4 * ESTIMATED_ROUND_USD, 6);
      expect(liveSpend.readTurnUsd()).toBe(0);
    });
  }
});

describe('the children[] launch gate reads the priced figure', () => {
  it("the pool budget getter is the ledger's priced turn reading: estimates never move it, priced money does", () => {
    const liveSpend = createLiveSpendLedger(undefined, HOLD);
    const rc = { billing: { cumulativeCostUsd: 0 } };
    const execCtx = buildToolExecCtx({
      ctx: { taskId: 't', model: UNKNOWN, config: {} } as never,
      cfg: { liveSpend, maxBudgetUsd: CEILING_USD } as never,
      rc: rc as never,
      dispatcher: {} as never,
      queue: { push: () => {} } as never,
    });
    foldModelSpend(liveSpend, openai, ESTIMATED_ROUND_USD, UNKNOWN);
    rc.billing.cumulativeCostUsd += ESTIMATED_ROUND_USD; // the completion-fed claim carries it
    expect(execCtx.getCumulativeCostUsd?.()).toBe(0);
    foldModelSpend(liveSpend, openai, 0.5, 'gpt-6-luna');
    expect(execCtx.getCumulativeCostUsd?.()).toBeCloseTo(0.5, 9);
  });

  it("the dispatch ctx's budget getter excludes estimates, so every child launches", async () => {
    const liveSpend = createLiveSpendLedger(undefined, HOLD);
    // The completion-fed claim carries the estimate; the ledger holds it apart.
    const rc = { billing: { cumulativeCostUsd: 0 } };
    const execCtx = buildToolExecCtx({
      ctx: { taskId: 't', model: UNKNOWN, config: {} } as never,
      cfg: { liveSpend, maxBudgetUsd: CEILING_USD } as never,
      rc: rc as never,
      dispatcher: {} as never,
      queue: { push: () => {} } as never,
    });
    const launched: number[] = [];
    await fanOutChildren(['a', 'b', 'c'], {
      maxBudgetUsd: CEILING_USD,
      ...(execCtx.getCumulativeCostUsd !== undefined && { getCumulativeCostUsd: execCtx.getCumulativeCostUsd }),
      turnSpendExceeded: () => turnSpendCeilingReached({ turnSpendCeilingUsd: CEILING_USD, liveSpend }),
      onLaunch: (i) => launched.push(i),
      runChild: async (_spec, i) => {
        // Each child burns one estimated round (folded live, and rolled into the claim).
        foldModelSpend(liveSpend, openai, ESTIMATED_ROUND_USD, UNKNOWN);
        rc.billing.cumulativeCostUsd += ESTIMATED_ROUND_USD;
        return { text: `ran ${i}`, pausedHalt: false };
      },
    });
    expect(launched).toEqual([0, 1, 2]);
    expect(execCtx.getCumulativeCostUsd?.()).toBe(0);
  });
});
