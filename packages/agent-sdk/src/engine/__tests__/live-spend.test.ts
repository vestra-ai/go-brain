/**
 * The run-scoped INCLUSIVE live spend ledger (2026-08-24 burn).
 *
 * The ledger exists because every spend gate read `rc.billing.cumulativeCostUsd`,
 * which a child's spend reaches only when the child COMPLETES and folds — so
 * during the burn it sat frozen at $0.19 while 475 child rounds burned $31.
 * These tests pin the two properties that make it usable as a gate input: it is
 * bumped per ROUND (not per completion), and nothing it is handed can make it
 * throw — a billing path that throws is worse than one that under-reports.
 */
import { describe, it, expect } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type {
  StreamEvent,
  Transport,
  NormalizedUsage,
  ProviderHistory,
  ProviderStream,
} from '../transport.js';
import { FakeTransport } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { summarizeSpan, type CompactionDeps } from '../compaction-run.js';
import { createLiveSpendLedger, foldModelSpend } from '../live-spend.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';

describe('LiveSpendLedger — inclusive, monotonic, run-scoped', () => {
  it('sums folded rounds', () => {
    const ledger = createLiveSpendLedger();
    expect(ledger.readUsd()).toBe(0);
    ledger.addUsd(0.5);
    ledger.addUsd(0.25);
    expect(ledger.readUsd()).toBe(0.75);
  });

  it('ignores non-finite and negative input (monotonic — a fold never walks the total back)', () => {
    const ledger = createLiveSpendLedger();
    ledger.addUsd(1);
    ledger.addUsd(NaN);
    ledger.addUsd(-1);
    ledger.addUsd(Infinity);
    ledger.addUsd(-Infinity);
    expect(ledger.readUsd()).toBe(1);
  });

  it('fires onSpend with the RUNNING TOTAL after each fold', () => {
    const seen: number[] = [];
    const ledger = createLiveSpendLedger((total) => seen.push(total));
    ledger.addUsd(0.5);
    ledger.addUsd(0.25);
    expect(seen).toEqual([0.5, 0.75]);
  });

  it('does not fire onSpend for input it ignored', () => {
    const seen: number[] = [];
    const ledger = createLiveSpendLedger((total) => seen.push(total));
    ledger.addUsd(NaN);
    ledger.addUsd(-1);
    expect(seen).toEqual([]);
  });

  it('never lets a throwing observer break the billing path', () => {
    const ledger = createLiveSpendLedger(() => {
      throw new Error('observer blew up');
    });
    expect(() => ledger.addUsd(0.5)).not.toThrow();
    // The total still advanced — the observer runs AFTER the fold.
    expect(ledger.readUsd()).toBe(0.5);
  });
});

// ── The TURN-scoped reading (the per-turn ceiling's input) ────────────────────
// The run total is the wrong number for a per-turn gate: a warm session's second
// turn would start already over the line. `markTurnStart()` marks the run total as
// this turn's zero, and `readTurnUsd()` reads the delta against that mark.

describe('LiveSpendLedger — the turn-scoped reading', () => {
  it('reads the RUN total until a turn is marked (mark defaults to 0 at creation)', () => {
    const ledger = createLiveSpendLedger();
    expect(ledger.readTurnUsd()).toBe(0);
    ledger.addUsd(0.4);
    expect(ledger.readTurnUsd()).toBe(0.4);
  });

  it('re-zeroes at each mark while the run total keeps climbing', () => {
    const ledger = createLiveSpendLedger();
    ledger.addUsd(0.4);
    ledger.markTurnStart();
    expect(ledger.readTurnUsd()).toBe(0);
    ledger.addUsd(0.25);
    expect(ledger.readTurnUsd()).toBe(0.25);
    expect(ledger.readUsd()).toBe(0.65);
    ledger.markTurnStart();
    expect(ledger.readTurnUsd()).toBe(0);
    expect(ledger.readUsd()).toBe(0.65);
  });

  it('marking twice with no spend between is idempotent', () => {
    const ledger = createLiveSpendLedger();
    ledger.addUsd(1);
    ledger.markTurnStart();
    ledger.markTurnStart();
    expect(ledger.readTurnUsd()).toBe(0);
  });
});

// ── Estimated folds: held out of the gates only while the host says so ────────
// A round priced at the fail-closed max is an estimate; prod 09-23 fee1bd62 stopped a
// $0.11 turn on a $11.05 one. The host (the runner's price-book rail) holds an estimate
// out of every gate reading while a book can still correct it; otherwise it counts.

const HOLD = (): boolean => true;

describe('LiveSpendLedger — estimated folds', () => {
  it('a HELD estimate stays out of readUsd and readTurnUsd, in its own turn reading', () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    ledger.addUsd(0.5, { estimated: false, model: 'claude-opus-4-8' });
    ledger.addUsd(11, { estimated: true, model: 'gpt-unknown' });
    expect(ledger.readUsd()).toBe(0.5);
    expect(ledger.readTurnUsd()).toBe(0.5);
    expect(ledger.readTurnEstimatedUsd()).toBe(11);
  });

  it('an estimate nobody holds COUNTS — no host rail, a host that says no, or a hook that throws', () => {
    const noRail = createLiveSpendLedger();
    const refused = createLiveSpendLedger(undefined, () => false);
    const faulty = createLiveSpendLedger(undefined, () => {
      throw new Error('hook blew up');
    });
    for (const ledger of [noRail, refused, faulty]) {
      expect(() => ledger.addUsd(11, { estimated: true, model: 'gpt-unknown' })).not.toThrow();
      expect(ledger.readTurnUsd()).toBe(11);
      expect(ledger.readTurnEstimatedUsd()).toBe(0);
    }
  });

  it('marks the held reading at the turn boundary like the counted one', () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    ledger.addUsd(11, { estimated: true, model: 'gpt-unknown' });
    ledger.markTurnStart();
    expect(ledger.readTurnEstimatedUsd()).toBe(0);
    ledger.addUsd(3, { estimated: true, model: 'gpt-unknown' });
    expect(ledger.readTurnEstimatedUsd()).toBe(3);
  });

  it('asks the hook with the model on every estimated fold; a held one never fires onSpend', () => {
    const spent: number[] = [];
    const asked: Array<[string, number]> = [];
    const ledger = createLiveSpendLedger(
      (total) => spent.push(total),
      (model, usd) => {
        asked.push([model, usd]);
        return asked.length === 1; // hold the first, count the second
      },
    );
    ledger.addUsd(11, { estimated: true, model: 'gpt-unknown' });
    ledger.addUsd(11, { estimated: true, model: 'gpt-unknown' });
    ledger.addUsd(0.5);
    expect(asked).toEqual([['gpt-unknown', 11], ['gpt-unknown', 11]]);
    expect(spent).toEqual([11, 11.5]);
  });

  it('ignores non-finite/negative estimates without asking', () => {
    let asked = 0;
    const ledger = createLiveSpendLedger(undefined, () => ++asked > 0);
    ledger.addUsd(NaN, { estimated: true, model: 'gpt-unknown' });
    ledger.addUsd(-1, { estimated: true, model: 'gpt-unknown' });
    expect(asked).toBe(0);
    expect(ledger.readTurnEstimatedUsd()).toBe(0);
  });
});

describe('foldModelSpend — the transport that priced the round says whether it hit the fail-closed max', () => {
  const openai = new OpenAIResponsesTransport();
  const anthropic = new AnthropicMessagesTransport();
  const gemini = new GeminiInteractionsTransport();

  it('the OpenAI card: a raw row counts; no raw row (unknown id OR an alias) is an estimate', () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    foldModelSpend(ledger, openai, 0.25, 'gpt-6-luna');
    foldModelSpend(ledger, openai, 9, 'gpt-not-a-real-model');
    // The capabilities table folds this alias onto sol, but the transport priced the RAW id.
    foldModelSpend(ledger, openai, 9, 'gpt-5.6-some-alias');
    expect(ledger.readUsd()).toBeCloseTo(0.25, 9);
    expect(ledger.readTurnEstimatedUsd()).toBeCloseTo(18, 9);
  });

  it("family fallbacks still COUNT: Anthropic's Sonnet default, Gemini's pro tier", () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    foldModelSpend(ledger, anthropic, 0.25, 'claude-opus-4-8');
    foldModelSpend(ledger, anthropic, 0.5, 'claude-not-a-family');
    foldModelSpend(ledger, gemini, 0.25, 'gemini-3.8-flash');
    foldModelSpend(ledger, gemini, 0.5, 'gemini-not-a-family');
    expect(ledger.readUsd()).toBeCloseTo(1.5, 9);
    expect(ledger.readTurnEstimatedUsd()).toBe(0);
  });

  it("the Anthropic transport's desync arm (an OpenAI id with no row) IS the fail-closed max", () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    foldModelSpend(ledger, anthropic, 9, 'gpt-not-a-real-model');
    foldModelSpend(ledger, anthropic, 0.25, 'gpt-6-luna');
    expect(ledger.readUsd()).toBeCloseTo(0.25, 9);
    expect(ledger.readTurnEstimatedUsd()).toBeCloseTo(9, 9);
  });

  it('a transport with no fail-closed path (the fakes) always counts', () => {
    const ledger = createLiveSpendLedger(undefined, HOLD);
    foldModelSpend(ledger, new FakeTransport([]), 1, 'gpt-not-a-real-model');
    expect(ledger.readUsd()).toBe(1);
  });

  it('is a no-op without a ledger', () => {
    expect(() => foldModelSpend(undefined, openai, 1, 'gpt-6-luna')).not.toThrow();
  });
});

// ── The fold contract: once per round, on EITHER subagent path ────────────────
// round-engine.ts and subagent-runner.ts both price rounds, and both now fold into
// the ledger. They are alternatives on `opts.sharedLoop` — subagent-runner.ts guards
// the shared body with `if (opts.sharedLoop && !pausedHalt)` and the legacy body with
// `if (!opts.sharedLoop && !pausedHalt)`, strict complements on a value never
// reassigned, and only the shared body reaches runOneRound. These pin that: the
// ledger must land on the run's OWN total, never double it.

/** A scripted transport playing one stream per round (subagent-runner.childcost idiom). */
function fakeTransport(opts: { rounds: NormalizedUsage[]; costPerRound: number[] }): Transport {
  const { rounds, costPerRound } = opts;
  let callIdx = 0;
  let costIdx = 0;
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
    defaultModel: () => 'claude-opus-4-8',
    historyFromJournal: () => [] as unknown as ProviderHistory,
    callModel: () => {
      const i = callIdx++;
      const u = rounds[i] ?? { inputTokens: 0, outputTokens: 0 };
      const isLast = i >= rounds.length - 1;
      const evs: StreamEvent[] = [
        { kind: 'text', text: `round-${i}` },
        ...(isLast
          ? []
          : [{ kind: 'tool_use', toolUse: { id: `tu-${i}`, name: 'noop', input: {} } } as StreamEvent]),
        { kind: 'done', stopReason: isLast ? 'end_turn' : 'tool_use', usage: u },
      ];
      return evs as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const ev of stream as StreamEvent[]) yield ev;
    },
    computeCostUsd: () => costPerRound[costIdx++] ?? 0,
  };
  return t as Transport;
}

const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
const noPause = async (): Promise<string> => 'PAUSED';

describe('the fold: a subagent round reaches the ledger exactly once', () => {
  for (const sharedLoop of [false, true]) {
    it(`${sharedLoop ? 'shared' : 'legacy'} loop — folds each round once, live`, async () => {
      const seen: number[] = [];
      const liveSpend = createLiveSpendLedger((total) => seen.push(total));
      const res = await runSubagentLoop({
        transport: fakeTransport({ rounds: [{ inputTokens: 100, outputTokens: 50 }, { inputTokens: 40, outputTokens: 20 }], costPerRound: [0.1, 0.04] }),
        model: 'claude-opus-4-8',
        system: 's',
        userPrompt: 'p',
        tools: [],
        harness: passHarness,
        onPause: noPause,
        maxTurns: 5,
        onEvent: () => {},
        childId: 'child-1',
        sharedLoop,
        liveSpend,
      });
      // EXACTLY the run's own spend — a second fold would read 0.28.
      expect(liveSpend.readUsd()).toBeCloseTo(res.costUsd, 9);
      expect(liveSpend.readUsd()).toBeCloseTo(0.14, 9);
      // And it was visible PER ROUND, not once at completion.
      expect(seen.length).toBe(2);
      expect(seen[0]).toBeCloseTo(0.1, 9);
    });
  }

  it('is inert when the host threads no ledger (byte-identical to pre-rail)', async () => {
    const res = await runSubagentLoop({
      transport: fakeTransport({ rounds: [{ inputTokens: 10, outputTokens: 5 }], costPerRound: [0.02] }),
      model: 'claude-opus-4-8',
      system: 's',
      userPrompt: 'p',
      tools: [],
      harness: passHarness,
      onPause: noPause,
      maxTurns: 5,
      onEvent: () => {},
      childId: 'child-1',
    });
    expect(res.costUsd).toBeCloseTo(0.02, 9);
  });
});

describe('the fold: side-calls land in the ledger too', () => {
  it('the compaction summarize call folds its own cost, live', async () => {
    const liveSpend = createLiveSpendLedger();
    const deps = {
      ctx: { model: 'claude-opus-4-8', config: { liveSpend } },
      transport: fakeTransport({ rounds: [{ inputTokens: 900, outputTokens: 300 }], costPerRound: [0.07] }),
    } as unknown as CompactionDeps;
    const out = await summarizeSpan(deps, []);
    expect(out.costUsd).toBeCloseTo(0.07, 9);
    expect(liveSpend.readUsd()).toBeCloseTo(out.costUsd, 9);
  });
});
