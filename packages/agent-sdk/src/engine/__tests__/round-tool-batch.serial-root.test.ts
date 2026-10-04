/**
 * Orchestration walls, follow-up item 1 — the ROOT wall (spec §0: parallel over depth).
 *
 * The founder's staging run: the MAIN turn spawned one researcher, waited for it, then
 * spawned one again. The lone researcher ran 99 searches while the rest of the plan sat
 * behind it, and a Stop returned nothing. D3 already refuses a DELEGATED helper that hands
 * its whole piece to one child; nothing watched the root doing the same thing across rounds.
 *
 * The first lone spawn stays allowed: one piece of work is one helper. The second in a row,
 * with no other tool call between them, is refused. "Consecutive" is read from the TURN's
 * own tool-call sequence (this round's batch plus the flag the previous round left on the
 * per-turn RunContext), never from a list of tools someone has to keep in step.
 *
 * Each case drives REAL main-loop rounds through one RunContext, which is what a turn is.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { RawToolOptions, ToolExecuteContext } from '../../tools/tool-types.js';
import type { NormalizedUsage, ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, type RoundDeps, type RoundState } from '../round-engine.js';
import { openTurn } from '../native-run-turn.js';
import type { NativeConfig } from '../native-config.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';

import { SERIAL_ROOT_REFUSAL, SERIAL_ROOT_ALLOWED_NOTE, LONE_CHILD_REFUSAL,
  SUBAGENT_DEPTH_CAP, SUBAGENT_TREE_CONCURRENCY, budgetRefusal, concurrencyRefusal, depthRefusal,
  type SubagentRefusalKind, type SubagentAllowKind } from '../subagent-walls.js';

const allow = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };

let spawns = 0;
/** R138 — a spawn tool now SAYS a child started; the wall arms on that, not on the absence
 *  of a refusal. The doubles say it, exactly as the real Agent and Weave tools do. */
const fakeAgent: RawToolOptions = {
  name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
  execute: async (_a: unknown, ctx: ToolExecuteContext) => { ctx.markSpawnAdmitted?.(); spawns += 1; return 'child done'; },
};
let reads = 0;
const fakeRead: RawToolOptions = {
  name: 'Read', description: 'read', parameters: z.object({}).passthrough(),
  execute: async () => { reads += 1; return 'file text'; },
};
let todos = 0;
const fakeTodo: RawToolOptions = {
  name: 'TodoUpdate', description: 'bookkeeping', parameters: z.object({}).passthrough(),
  execute: async () => { todos += 1; return 'todo updated'; },
};
let weaves = 0;
const fakeWeave: RawToolOptions = {
  name: 'Weave', description: 'orchestrate', parameters: z.object({}).passthrough(),
  execute: async (_a: unknown, ctx: ToolExecuteContext) => { ctx.markSpawnAdmitted?.(); weaves += 1; return 'weave done'; },
};

/** Follow-up C item 1 — the two Weave plan shapes the root wall reads apart. Weave has no
 *  declarative plan: the script IS the plan (weave-tool.ts WEAVE_PARAMS), so what "first
 *  layer" means is what the script does first. */
const loneWeave = { meta: { name: 'n', goal: 'g', phases: [] }, budget: { usd: 1 },
  script: 'const r = await task({ description: "one piece", prompt: "do it" });\nreturn r;' };
const parallelWeave = { meta: { name: 'n', goal: 'g', phases: [] }, budget: { usd: 1 },
  script: 'const [a, b] = await parallel([() => task({ prompt: "a" }), () => task({ prompt: "b" })]);\nreturn [a, b];' };

function scripted(rounds: StreamEvent[][]): Transport {
  let i = 0;
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({}); },
    pushAssistant: (h) => { (h as unknown[]).push({}); },
    pushToolResult: (h) => { (h as unknown[]).push({}); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (rounds[i++] ?? [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]) as unknown as ProviderStream,
    readStream: async function* (stream) { for (const ev of stream as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport;
}

const freshState = (): RoundState => ({
  assistantText: '', thinkingBlocks: [], toolUses: [], roundAppended: false,
  inToolBatch: false, stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 }, lastUsageModel: 'm',
});

/** One round's worth of stream events. */
const round = (...calls: Array<{ id: string; name: string; input?: unknown }>): StreamEvent[] => [
  ...calls.map((c) => ({ kind: 'tool_use', toolUse: { id: c.id, name: c.name, input: c.input ?? { prompt: 'x' } } }) as StreamEvent),
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent,
];
/** An IN-TURN spawn under the background flag: only an explicit false blocks the turn. */
const inTurn = { prompt: 'x', run_in_background: false };

/** The round that ENDS a turn: text, no tool calls. `runToolBatch` is skipped entirely for
 *  it (round-engine's `toolUses.length === 0` head), so no wall code runs on it. */
const answerRound: StreamEvent[] = [
  { kind: 'text', text: 'here you go' },
  { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
];

interface Driven { texts: string[]; kinds: SubagentRefusalKind[]; allows: SubagentAllowKind[] }

/** The deps one RUN carries: one RunContext, one transport, reused across its turns. */
function makeDeps(
  taskId: string,
  rounds: StreamEvent[][],
  cfg: Record<string, unknown>,
  kinds: SubagentRefusalKind[],
  tools = [fakeAgent, fakeRead, fakeTodo],
  allows: SubagentAllowKind[] = [],
): RoundDeps {
  const t = scripted(rounds);
  return {
    ctx: { taskId, sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    cfg: {
      ...cfg,
      onSubagentRefused: (k: SubagentRefusalKind) => kinds.push(k),
      onSubagentAllowed: (k: SubagentAllowKind) => allows.push(k),
    },
    transport: t, rc: createRunContext(taskId), harness: allow,
    dispatcher: createNativeHookDispatcher(allow),
    tools, providerTools: [], system: 'sys', onPause: async () => 'PAUSED',
    onAuthHalt: undefined, requestedModel: 'm', cachePrefixHint: undefined,
    history: t.emptyHistory(), turnBlocks: [], pendingTodoBlocks: [],
  } as unknown as RoundDeps;
}

/** Drive `count` rounds through `deps`, a fresh RoundState each (what iterateTurn does). */
async function driveRounds(deps: RoundDeps, count: number): Promise<string[]> {
  const texts: string[] = [];
  for (let r = 0; r < count; r++) {
    const gen = runOneRound(deps, freshState());
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    for (const res of (n.value as { results: Array<{ text?: string }> }).results) {
      if (res.text !== undefined) texts.push(res.text);
    }
  }
  return texts;
}

/**
 * Drive `rounds` as consecutive rounds of ONE turn: one RunContext, one deps object, a
 * fresh RoundState per round (what iterateTurn does).
 */
async function driveTurn(
  taskId: string,
  rounds: StreamEvent[][],
  cfg: Record<string, unknown> = { subagentWalls: true },
  tools?: RawToolOptions[],
): Promise<Driven> {
  spawns = 0; reads = 0; todos = 0; weaves = 0;
  const kinds: SubagentRefusalKind[] = [];
  const allows: SubagentAllowKind[] = [];
  const deps = makeDeps(taskId, rounds, cfg, kinds, tools, allows);
  const texts = await driveRounds(deps, rounds.length);
  return { texts, kinds, allows };
}

describe('the root wall — a second lone in-turn spawn in a row is refused', () => {
  it('two lone spawns in consecutive rounds: the FIRST runs, the SECOND is refused and never spawns', async () => {
    const { texts, kinds } = await driveTurn('sr-two', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts[0]).toBe('child done');          // the first lone spawn is legitimate
    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(1);                        // the second child was never started
    expect(kinds).toEqual(['serial_root']);        // counted once, at delivery
  });

  it('a THIRD in a row is refused too: the streak stays armed, it does not alternate', async () => {
    const { texts, kinds } = await driveTurn('sr-three', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
    ]);

    expect(texts.slice(1)).toEqual([SERIAL_ROOT_REFUSAL, SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
  });

  it('a different tool BETWEEN two lone spawns clears the streak: the second runs', async () => {
    const { texts, kinds } = await driveTurn('sr-between', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'r', name: 'Read', input: { path: 'x' } }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['child done', 'file text', 'child done']);
    expect(spawns).toBe(2);
    expect(reads).toBe(1);
    expect(kinds).toEqual([]);
  });

  it('a lone spawn ALONGSIDE other work in one message is not a lone round', async () => {
    // The round did more than hand off; the next lone spawn starts a fresh streak.
    const { texts, kinds } = await driveTurn('sr-alongside', [
      round({ id: 'a', name: 'Agent' }, { id: 'r', name: 'Read', input: { path: 'x' } }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);
  });

  it('a two-call batch is always allowed, and never arms the streak', async () => {
    const { texts, kinds } = await driveTurn('sr-batch', [
      round({ id: 'a', name: 'Agent' }, { id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
      round({ id: 'd', name: 'Agent' }),
    ]);

    // Rounds 1 and 2 run; only round 3 (the second lone spawn in a row) is refused.
    expect(texts.filter((x) => x === SERIAL_ROOT_REFUSAL)).toHaveLength(1);
    expect(spawns).toBe(3);
    expect(kinds).toEqual(['serial_root']);
  });

  it("a lone call carrying children[] of two or more is a batch, not a lone spawn", async () => {
    const batchInput = { children: [{ prompt: 'x' }, { prompt: 'y' }] };
    const { texts, kinds } = await driveTurn('sr-children', [
      round({ id: 'a', name: 'Agent', input: batchInput }),
      round({ id: 'b', name: 'Agent', input: batchInput }),
    ]);

    expect(texts).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual([]);
  });

  it('under SUBAGENT_BACKGROUND_V1 a backgrounded spawn is exempt; an in-turn one is not', async () => {
    const cfg = { subagentWalls: true, subagentBackgroundAdvertised: true };
    // Omitting run_in_background BACKGROUNDS (the Agent tool's default): these return at
    // once, so serial launches of them already run in parallel.
    const bg = await driveTurn('sr-bg', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
    ], cfg);
    expect(bg.texts).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(bg.kinds).toEqual([]);

    // An explicit false is the spawn the turn waits on, and the wall still holds.
    const live = await driveTurn('sr-bg-inturn', [
      round({ id: 'a', name: 'Agent', input: inTurn }),
      round({ id: 'b', name: 'Agent', input: inTurn }),
    ], cfg);
    expect(live.texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(live.kinds).toEqual(['serial_root']);
  });

  it("a TEAMMATE's own lead advertises no background, so its serial spawns ARE refused", async () => {
    // The flag being on does not mean this run's spawns background: a teammate lead never
    // advertises the field, so its spawns all block its turn. Reading the bare
    // `subagentBackground` flag here would exempt them and switch the wall off for a whole
    // class of leads. The cfg carries the tool's own advertise verdict instead.
    const teammateLead = { subagentWalls: true, subagentBackground: true, subagentBackgroundAdvertised: false };
    const { texts, kinds } = await driveTurn('sr-teammate-lead', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ], teammateLead);

    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual(['serial_root']);
    expect(spawns).toBe(1);
  });

  /**
   * R109 M2 — the same guard the D3 wall twenty lines above carries, for the same reason.
   * A background HELPER runs as its own actor, so it HAS a main loop (rc defined, walls on)
   * while its frozen def may exclude Agent entirely. Two hallucinated lone Agent calls from
   * such a helper must get the plain unknown-tool answer, not "issue them together in ONE
   * message", which is advice for a tool it does not have, and must not ring serial_root
   * for a spawn that never existed.
   */
  it('a holder whose palette has NO Agent gets the unknown-tool answer, and rings nothing', async () => {
    const { texts, kinds } = await driveTurn('sr-no-agent', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ], { subagentWalls: true }, [fakeRead]);   // Read only: this actor was never granted Agent

    expect(texts).toEqual(['Unknown tool: Agent', 'Unknown tool: Agent']);
    expect(texts).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual([]);                  // serial_root stays 0
    expect(spawns).toBe(0);
  });

  it('walls OFF: neither spawn is refused and nothing is counted (byte-identical)', async () => {
    const { texts, kinds } = await driveTurn('sr-off', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ], {});

    expect(texts).toEqual(['child done', 'child done']);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);
  });

  /**
   * The reset in `openTurn` is LOAD-BEARING, not decoration, and this is the shape that
   * proves it. `runToolBatch` is skipped entirely for a round with no tool calls, and the
   * last round of every turn is exactly that round, so the clearing branch never runs at
   * the end of a turn: a turn shaped "spawn one helper, read its result, answer" ends with
   * the flag ARMED. Without the reset the very first lone spawn of the NEXT user turn is
   * refused, in what is probably the most common orchestration shape there is.
   *
   * Driven through the REAL `openTurn`, not a hand-applied assignment, or it would pin the
   * test's own reset rather than the runtime's.
   */
  it('the reset at the turn boundary: turn 2 opens UNARMED after turn 1 ended on a lone spawn', async () => {
    spawns = 0;
    const kinds: SubagentRefusalKind[] = [];
    // Turn 1: one lone spawn, then the plain answer that ends it. Turn 2: one lone spawn.
    const deps = makeDeps('sr-boundary', [round({ id: 'a', name: 'Agent' }), answerRound, round({ id: 'b', name: 'Agent' })],
      { subagentWalls: true }, kinds);

    const turnOne = await driveRounds(deps, 2);
    expect(turnOne).toEqual(['child done']);            // the answer round dispatched nothing
    // The answer round never reached the wall, so turn 1 ends ARMED. This is the state the
    // reset exists to clear; asserting it here is what makes the next expectation mean
    // something rather than passing for want of a streak.
    expect(deps.rc!.lastRoundWasLoneSpawn).toBe(true);

    const { ctx, cfg, transport, rc } = deps as unknown as {
      ctx: HarnessContext<NativeConfig>; cfg: NativeConfig; transport: Transport; rc: typeof deps.rc;
    };
    const gen = openTurn(ctx, cfg, transport, rc!, { text: 'and now this' } as UserTurn, false, 0);
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    expect(n.value).toMatchObject({ stop: 'proceed' });  // no gate ended the turn instead

    const turnTwo = await driveRounds(deps, 1);
    expect(turnTwo).toEqual(['child done']);             // ALLOWED: a new turn, a new plan
    expect(turnTwo).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual([]);
    expect(spawns).toBe(2);
  });

  it('the streak starts UNARMED, so a first lone spawn is never refused', async () => {
    // The flag is the whole memory of the wall: armed at birth, the very first helper of
    // every run would be refused. (The per-TURN half of its life is the reset in
    // native-run-turn, beside mediaTurnSettled's; this pins the per-RUN half.)
    expect(createRunContext('sr-birth').lastRoundWasLoneSpawn).toBe(false);
    const { texts, kinds } = await driveTurn('sr-first', [round({ id: 'a', name: 'Agent' })]);
    expect(texts).toEqual(['child done']);
    expect(kinds).toEqual([]);
  });

  it('a round that calls NO Agent at all clears an armed streak, and the streak RE-arms after', async () => {
    // The clearing branch must not be reachable only once: a turn that spawns, reads a
    // file, spawns again, then spawns a third time is drip-feeding again by the end, and
    // the wall has to notice the SECOND streak as well as forgive the first.
    const { texts, kinds } = await driveTurn('sr-clear', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'r', name: 'Read', input: { path: 'x' } }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['child done', 'file text', 'child done', SERIAL_ROOT_REFUSAL]);
    expect(kinds).toEqual(['serial_root']);
    expect(spawns).toBe(2);
  });

  it('the root is told to PARALLELIZE, never (as a helper is) to do the work itself', async () => {
    const { texts } = await driveTurn('sr-text', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ]);
    expect(texts[1]).not.toBe(LONE_CHILD_REFUSAL);
    expect(texts[1]).toContain('ONE message');
  });
});

/**
 * Follow-up B item 1 — the root wall stopped seeing the drip-feed because the model
 * KEEPS ITS PLAN while it drips.
 *
 * Staging task 406e56a9 (wave-2 drills, 2026-09-04): the main turn spawned three lone
 * foreground researchers one after another (journal seqs 26, 47, 68) with nothing but
 * TodoUpdate calls between them, and serial_root stayed 0. Any non-Agent call cleared
 * the streak, so writing the plan down defeated the wall that exists to stop the plan
 * being drip-fed — and updating a todo list is what a model does between hand-offs.
 *
 * A bookkeeping call is not work: it neither arms the streak nor clears it. Real work
 * between two lone spawns still clears it, which is the line the fix must not cross.
 */
describe('the root wall — plan bookkeeping neither arms nor resets the streak', () => {
  it('the drill shape: lone spawn, TodoUpdate, TodoUpdate, lone spawn → the second is refused', async () => {
    const { texts, kinds } = await driveTurn('sr-book-drill', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 't1', name: 'TodoUpdate', input: { id: '1', status: 'completed' } }),
      round({ id: 't2', name: 'TodoUpdate', input: { id: '2', status: 'in_progress' } }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['child done', 'todo updated', 'todo updated', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);                  // the second child was never started
    expect(todos).toBe(2);                   // and the bookkeeping itself still ran
    expect(kinds).toEqual(['serial_root']);
  });

  it('bookkeeping does not ARM the streak either: the first lone spawn after two of them runs', async () => {
    const { texts, kinds } = await driveTurn('sr-book-arm', [
      round({ id: 't1', name: 'TodoUpdate' }),
      round({ id: 't2', name: 'TodoUpdate' }),
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    // Only the SECOND spawn is refused: the todo rounds left the streak exactly as they
    // found it, so the first helper of the turn is still legitimate.
    expect(texts).toEqual(['todo updated', 'todo updated', 'child done', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root']);
  });

  it('real work between two lone spawns still clears the streak, bookkeeping around it or not', async () => {
    const { texts, kinds } = await driveTurn('sr-book-work', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 't1', name: 'TodoUpdate' }),
      round({ id: 'r', name: 'Read', input: { path: 'x' } }),
      round({ id: 't2', name: 'TodoUpdate' }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts).not.toContain(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(2);
    expect(reads).toBe(1);
    expect(kinds).toEqual([]);
  });

  it('a round of [Agent, TodoUpdate] IS a lone spawn: it arms the streak on its own', async () => {
    // R111 — the shape stated on its own, with an ordinary lone spawn behind it. If the
    // first round were still read as "a spawn alongside other work" it would CLEAR the
    // streak and the second spawn would run; the refusal is what says it armed.
    const { texts, kinds } = await driveTurn('sr-book-arms', [
      round({ id: 'a', name: 'Agent' }, { id: 't1', name: 'TodoUpdate' }),
      round({ id: 'b', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['child done', 'todo updated', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(todos).toBe(1);
    expect(kinds).toEqual(['serial_root']);
  });

  it('the bookkeeping call FIRST reads the same: [TodoUpdate, Agent] is a lone spawn too', async () => {
    // The shape is judged on WHAT is left after the bookkeeping is set aside, never on
    // where it sat in the batch. Ticking the todo before handing off is at least as likely
    // as after, and an order-dependent reading would leave that half of the drill open:
    // index the raw batch instead of the filtered one and every other pin here still passes.
    const { texts, kinds } = await driveTurn('sr-book-first', [
      round({ id: 't1', name: 'TodoUpdate' }, { id: 'a', name: 'Agent' }),
      round({ id: 't2', name: 'TodoUpdate' }, { id: 'b', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['todo updated', 'child done', 'todo updated', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root']);
  });

  it('a lone spawn with only a TodoUpdate beside it is still a lone spawn', async () => {
    // The bookkeeping call is filtered out BEFORE the round's shape is judged, so
    // "hand off one piece and tick the plan" reads as the hand-off it is. Contrast
    // the sr-alongside case, where the round did real work beside the spawn.
    const { texts, kinds } = await driveTurn('sr-book-beside', [
      round({ id: 'a', name: 'Agent' }, { id: 't1', name: 'TodoUpdate' }),
      round({ id: 'b', name: 'Agent' }, { id: 't2', name: 'TodoUpdate' }),
    ]);

    expect(texts).toContain(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root']);
  });

  it('walls OFF: a bookkeeping round changes nothing and neither spawn is refused', async () => {
    const { texts, kinds } = await driveTurn('sr-book-off', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 't1', name: 'TodoUpdate' }),
      round({ id: 'b', name: 'Agent' }),
    ], {});

    expect(texts).toEqual(['child done', 'todo updated', 'child done']);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);
  });
});

/**
 * Follow-up C item 1 — WEAVE IS SPAWN-SHAPED FOR THE ROOT WALL.
 *
 * The serial-fg rerun on staging (2026-09-04, lead a3376767) after follow-up B: the root
 * wall fired three times with the parallelise text, and the model then routed the SAME
 * one-at-a-time plan through Weave (journal seqs 61, 65) and finished it anyway. A depth-0
 * Weave call launches helpers exactly as an Agent call does, so a lone one is the same
 * drip-feed; a wall that only ever says no to one door trains the model to use the other.
 *
 * A Weave plan that OPENS on a fan-out combinator is a batch and clears the streak, which
 * is the shape the wall is asking for in the first place.
 */
describe('the root wall — a lone depth-0 Weave call is spawn-shaped', () => {
  it('Agent lone, then Weave lone: the Weave is REFUSED and never runs', async () => {
    const { texts, kinds } = await driveTurn('sr-weave-after-agent', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'w', name: 'Weave', input: loneWeave }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts[0]).toBe('child done');
    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(weaves).toBe(0);                        // the script was never run
    expect(kinds).toEqual(['serial_root']);
  });

  it('Weave lone ARMS the streak: the Agent call after it is refused', async () => {
    const { texts, kinds } = await driveTurn('sr-agent-after-weave', [
      round({ id: 'w', name: 'Weave', input: loneWeave }),
      round({ id: 'a', name: 'Agent' }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts[0]).toBe('weave done');
    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(0);
    expect(kinds).toEqual(['serial_root']);
  });

  it('a Weave whose plan opens on a two-node parallel layer is a BATCH: allowed, and it clears', async () => {
    const { texts, kinds } = await driveTurn('sr-weave-parallel', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'w', name: 'Weave', input: parallelWeave }),
      round({ id: 'b', name: 'Agent' }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    // The Weave ran (not refused) AND cleared the streak, so the lone spawn behind it runs.
    expect(texts).toEqual(['child done', 'weave done', 'child done']);
    expect(weaves).toBe(1);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);
  });

  it('two lone Weave calls in a row: the second is refused', async () => {
    const { texts, kinds } = await driveTurn('sr-weave-twice', [
      round({ id: 'w1', name: 'Weave', input: loneWeave }),
      round({ id: 'w2', name: 'Weave', input: loneWeave }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(weaves).toBe(1);
    expect(kinds).toEqual(['serial_root']);
  });

  it('a Weave call is IN-TURN even under the background flag: it carries no background field', async () => {
    // Reading `run_in_background !== false` off a Weave input would call it a background
    // spawn and switch the wall off for the whole Weave door, which is the bypass itself.
    const { texts, kinds } = await driveTurn('sr-weave-bg', [
      round({ id: 'a', name: 'Agent', input: inTurn }),
      round({ id: 'w', name: 'Weave', input: loneWeave }),
    ], { subagentWalls: true, subagentBackgroundAdvertised: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual(['serial_root']);
  });

  it('a holder with no Weave in its palette gets the unknown-tool answer, and rings nothing', async () => {
    const { texts, kinds } = await driveTurn('sr-weave-absent', [
      round({ id: 'w1', name: 'Weave', input: loneWeave }),
      round({ id: 'w2', name: 'Weave', input: loneWeave }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead]);

    expect(texts).toEqual(['Unknown tool: Weave', 'Unknown tool: Weave']);
    expect(kinds).toEqual([]);
  });

  it('walls OFF: two lone Weave calls both run (byte-identical)', async () => {
    const { texts, kinds } = await driveTurn('sr-weave-off', [
      round({ id: 'w1', name: 'Weave', input: loneWeave }),
      round({ id: 'w2', name: 'Weave', input: loneWeave }),
    ], {}, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts).toEqual(['weave done', 'weave done']);
    expect(weaves).toBe(2);
    expect(kinds).toEqual([]);
  });
});

/**
 * Follow-up C item 2 — THE ESCAPE HATCH. Sequential work is sometimes legitimate: the
 * second helper genuinely needs the first one's answer. Refusing it anyway is how a wall
 * teaches the model to route around it, which is exactly what the 2026-09-04 rerun showed.
 *
 * A lone spawn that NAMES what it is waiting for runs. It does not clear the streak: the
 * declaration excuses this hand-off, not the plan, so the next undeclared lone spawn is
 * refused on the streak the declared one left armed.
 */
describe('the root wall — depends_on lets a genuinely sequential helper run alone', () => {
  it('lone, then lone WITH depends_on: the second runs, and rings serial_root_dependent', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-dep-allow', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent', input: { prompt: 'y', depends_on: 'the pricing researcher' } }),
    ]);

    expect(texts).toEqual(['child done', 'child done']);
    expect(spawns).toBe(2);
    expect(kinds).toEqual([]);                       // a dependent allow is NOT a refusal
    expect(allows).toEqual(['serial_root_dependent']);
  });

  it('the declaration leaves the streak ARMED: lone, dependent, lone → the third is refused', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-dep-armed', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent', input: { prompt: 'y', depends_on: 'helper a' } }),
      round({ id: 'c', name: 'Agent' }),
    ]);

    expect(texts).toEqual(['child done', 'child done', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(2);
    expect(kinds).toEqual(['serial_root']);
    expect(allows).toEqual(['serial_root_dependent']);
  });

  it('a blank or non-string depends_on is not a declaration: the spawn is still refused', async () => {
    // The hatch has to be SAID. An empty string is the shape a model produces when it is
    // pattern-matching the field rather than naming a dependency.
    const blank = await driveTurn('sr-dep-blank', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent', input: { prompt: 'y', depends_on: '   ' } }),
    ]);
    expect(blank.texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(blank.kinds).toEqual(['serial_root']);
    expect(blank.allows).toEqual([]);

    const wrongType = await driveTurn('sr-dep-type', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent', input: { prompt: 'y', depends_on: true } }),
    ]);
    expect(wrongType.texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(wrongType.kinds).toEqual(['serial_root']);
  });

  it('the FIRST lone spawn of a turn does not ring the counter, declared or not', async () => {
    // Nothing was refused and nothing needed excusing: the streak was not armed yet.
    const { kinds, allows } = await driveTurn('sr-dep-first', [
      round({ id: 'a', name: 'Agent', input: { prompt: 'y', depends_on: 'nothing yet' } }),
    ]);
    expect(kinds).toEqual([]);
    expect(allows).toEqual([]);
  });

  it('a WEAVE call may declare it too: allowed, still armed, and the next bare one refused', async () => {
    // R123 — the hatch is on the CALL, so both spawn-shaped doors carry the same exit. The
    // wall reads the same field with the same predicate; nothing about Weave is special
    // here except that its plan is a script, which is why the field cannot live on a node.
    const declared = { ...loneWeave, depends_on: 'the pricing researcher' };
    const { texts, kinds, allows } = await driveTurn('sr-dep-weave', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'w', name: 'Weave', input: declared }),
      round({ id: 'b', name: 'Agent' }),
    ], { subagentWalls: true }, [fakeAgent, fakeRead, fakeTodo, fakeWeave]);

    expect(texts).toEqual(['child done', 'weave done', SERIAL_ROOT_REFUSAL]);
    expect(weaves).toBe(1);                        // the declared Weave call really ran
    expect(spawns).toBe(1);                        // and the bare spawn behind it did not
    expect(allows).toEqual(['serial_root_dependent']);
    expect(kinds).toEqual(['serial_root']);
  });

  it('the refusal text tells the model how to declare a dependency', async () => {
    const { texts } = await driveTurn('sr-dep-text', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
    ]);
    expect(texts[1]).toContain('depends_on');
  });
});

/**
 * R129 — THE DEPENDENT BUDGET. `depends_on` is an exit, not a key.
 *
 * A declaration excuses a hand-off that genuinely has to wait, and it costs the model one
 * non-blank string. Left unbounded it is the cheapest bypass the wall now has: put a
 * dependency on every lone spawn and the streak never bites again. Three in a turn is a
 * chain the model may well need; a fourth is a pipeline it should have written as one
 * plan, so the fourth stops being excused and is judged as an ordinary lone spawn.
 */
describe('the root wall — depends_on has a per-turn budget of three', () => {
  const dependent = (id: string) => round({ id, name: 'Agent', input: { prompt: 'y', depends_on: `after ${id}` } });

  it('three dependent lone spawns run, and the fourth is refused', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-dep-budget', [
      round({ id: 'a', name: 'Agent' }),
      dependent('b'), dependent('c'), dependent('d'),
      dependent('e'),
    ]);

    expect(texts.slice(0, 4)).toEqual(['child done', 'child done', 'child done', 'child done']);
    expect(texts[4]).toBe(SERIAL_ROOT_REFUSAL);
    expect(spawns).toBe(4);
    expect(allows).toEqual([
      'serial_root_dependent', 'serial_root_dependent', 'serial_root_dependent',
    ]);
    expect(kinds).toEqual(['serial_root']);
  });

  it('past the budget a declaration stops excusing anything: it is judged as a bare lone spawn', async () => {
    // Which means the refusal cap still governs it. Three dependents, then two refusals,
    // then the note — the same landing an undeclared chain gets, because past the budget
    // that is what it is.
    const { texts, kinds, allows } = await driveTurn('sr-dep-budget-then-cap', [
      round({ id: 'a', name: 'Agent' }),
      dependent('b'), dependent('c'), dependent('d'),
      dependent('e'), dependent('f'), dependent('g'),
    ]);

    expect(texts[4]).toBe(SERIAL_ROOT_REFUSAL);
    expect(texts[5]).toBe(SERIAL_ROOT_REFUSAL);
    expect(texts[6]).toBe(`${SERIAL_ROOT_ALLOWED_NOTE}\n\nchild done`);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
    expect(allows).toEqual([
      'serial_root_dependent', 'serial_root_dependent', 'serial_root_dependent', 'serial_root_allowed',
    ]);
  });

  it('the budget counts DECLARED hand-offs only, not every allow the wall grants', async () => {
    // A turn is refused twice, waved through once past the refusal cap, and only THEN starts
    // declaring. All three declarations must still be there: the waved-through spawn was not
    // a declaration, and neither were the refusals. Spending the budget on any allow instead
    // would leave the third declaration to fall through to the note.
    const { texts, kinds, allows } = await driveTurn('sr-dep-budget-scope', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }), round({ id: 'c', name: 'Agent' }), round({ id: 'd', name: 'Agent' }),
      dependent('e'), dependent('f'), dependent('g'),
    ]);

    expect(texts[3]).toBe(`${SERIAL_ROOT_ALLOWED_NOTE}\n\nchild done`);
    expect(texts.slice(4)).toEqual(['child done', 'child done', 'child done']);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
    expect(allows).toEqual([
      'serial_root_allowed',
      'serial_root_dependent', 'serial_root_dependent', 'serial_root_dependent',
    ]);
  });

  it('the budget resets at the TURN boundary, beside the streak and the refusal cap', async () => {
    spawns = 0;
    const kinds: SubagentRefusalKind[] = [];
    const deps = makeDeps('sr-dep-boundary', [
      round({ id: 'a', name: 'Agent' }), dependent('b'), dependent('c'), dependent('d'),
      answerRound,
      round({ id: 'e', name: 'Agent' }), dependent('f'),
    ], { subagentWalls: true }, kinds);

    await driveRounds(deps, 5);                          // four spawn rounds, then the answer
    expect(deps.rc!.serialRootDependents).toBe(3);       // turn 1 spent the whole budget

    const { ctx, cfg, transport, rc } = deps as unknown as {
      ctx: HarnessContext<NativeConfig>; cfg: NativeConfig; transport: Transport; rc: typeof deps.rc;
    };
    const gen = openTurn(ctx, cfg, transport, rc!, { text: 'again' } as UserTurn, false, 0);
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    expect(deps.rc!.serialRootDependents).toBe(0);

    // A fresh budget: turn 2's declaration is honoured rather than judged as a bare spawn.
    const turnTwo = await driveRounds(deps, 2);
    expect(turnTwo).toEqual(['child done', 'child done']);
    expect(kinds).toEqual([]);
  });
});

/**
 * Follow-up C item 3 — THE CAP ON REPEATED REFUSALS. The same turn refuses serial_root at
 * most twice. A third lone spawn onto the armed streak means the model is not taking the
 * advice, and a third identical refusal is a loop that spends the turn rather than the
 * plan: it runs, with the reading prepended to its result so the record still says what
 * happened, and rings serial_root_allowed rather than a refusal.
 */
describe('the root wall — at most two serial_root refusals in a turn', () => {
  it('four lone spawns: run, refuse, refuse, then ALLOW with the note prepended', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-cap', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
      round({ id: 'd', name: 'Agent' }),
    ]);

    expect(texts[0]).toBe('child done');
    expect(texts[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(texts[2]).toBe(SERIAL_ROOT_REFUSAL);
    expect(texts[3]).toBe(`${SERIAL_ROOT_ALLOWED_NOTE}\n\nchild done`);
    expect(spawns).toBe(2);                              // the fourth really ran
    expect(kinds).toEqual(['serial_root', 'serial_root']);
    expect(allows).toEqual(['serial_root_allowed']);
  });

  it('past the cap it stays allowed: a fifth lone spawn is not refused again', async () => {
    const { texts, kinds } = await driveTurn('sr-cap-past', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
      round({ id: 'd', name: 'Agent' }),
      round({ id: 'e', name: 'Agent' }),
    ]);

    expect(texts.filter((t) => t === SERIAL_ROOT_REFUSAL)).toHaveLength(2);
    expect(texts[4]).toContain(SERIAL_ROOT_ALLOWED_NOTE);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
  });

  it('a dependent allow does not spend the cap: two refusals are still available after one', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-cap-dep', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent', input: { prompt: 'y', depends_on: 'helper a' } }),
      round({ id: 'c', name: 'Agent' }),
      round({ id: 'd', name: 'Agent' }),
    ]);

    expect(texts.filter((t) => t === SERIAL_ROOT_REFUSAL)).toHaveLength(2);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
    expect(allows).toEqual(['serial_root_dependent']);
  });

  it('the counter resets at the TURN boundary, beside the streak', async () => {
    // Turn 1 spends both refusals; turn 2 must get its own two, not inherit a spent cap.
    // Driven through the REAL openTurn, or it would pin the test's own reset.
    spawns = 0;
    const kinds: SubagentRefusalKind[] = [];
    const deps = makeDeps('sr-cap-boundary', [
      round({ id: 'a', name: 'Agent' }), round({ id: 'b', name: 'Agent' }), round({ id: 'c', name: 'Agent' }),
      answerRound,
      round({ id: 'd', name: 'Agent' }), round({ id: 'e', name: 'Agent' }),
    ], { subagentWalls: true }, kinds);

    await driveRounds(deps, 4);
    expect(kinds).toEqual(['serial_root', 'serial_root']);   // turn 1 spent the cap

    const { ctx, cfg, transport, rc } = deps as unknown as {
      ctx: HarnessContext<NativeConfig>; cfg: NativeConfig; transport: Transport; rc: typeof deps.rc;
    };
    const gen = openTurn(ctx, cfg, transport, rc!, { text: 'again' } as UserTurn, false, 0);
    let n = await gen.next();
    while (!n.done) n = await gen.next();

    const turnTwo = await driveRounds(deps, 2);
    // A fresh cap: the second lone spawn of turn 2 is refused rather than waved through.
    expect(turnTwo[1]).toBe(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual(['serial_root', 'serial_root', 'serial_root']);
  });

  /**
   * R128 (review B5) — the budget is spent at DELIVERY, and that is not decoration.
   *
   * The decision is made for the whole batch before anything dispatches, but a batch can
   * still stop before the refused tool_use is reached, and a refusal the model never read is
   * not a wall the run hit. Moving the increment up to the decision site leaves every other
   * serial-root pin green, so this is the one that holds it there.
   *
   * The reachable stop is the media turn-settle lock: it denies the whole batch without
   * execution, and it is read AFTER the root wall has already recorded its verdict. The lock
   * is set on the RunContext directly, which is the state a queued media job leaves behind.
   */
  it('a batch denied before delivery does not spend the turn\'s refusal budget', async () => {
    spawns = 0;
    const kinds: SubagentRefusalKind[] = [];
    const deps = makeDeps('sr-cap-undelivered', [
      round({ id: 'a', name: 'Agent' }), round({ id: 'b', name: 'Agent' }), round({ id: 'c', name: 'Agent' }),
    ], { subagentWalls: true, mediaTurnSettle: true }, kinds);

    await driveRounds(deps, 1);                          // the first lone spawn arms the streak
    expect(deps.rc!.lastRoundWasLoneSpawn).toBe(true);

    // Round 2 IS decided as a refusal, and then the whole batch is denied without execution.
    deps.rc!.mediaTurnSettled = true;
    const denied = await driveRounds(deps, 1);
    expect(denied[0]).not.toBe(SERIAL_ROOT_REFUSAL);      // the model read the media denial
    expect(kinds).toEqual([]);                           // nothing rung
    expect(deps.rc!.serialRootRefusals).toBe(0);         // and nothing spent

    // Round 3 delivers, so THIS one spends it — the budget counts what the model was shown.
    deps.rc!.mediaTurnSettled = false;
    const delivered = await driveRounds(deps, 1);
    expect(delivered[0]).toBe(SERIAL_ROOT_REFUSAL);
    expect(kinds).toEqual(['serial_root']);
    expect(deps.rc!.serialRootRefusals).toBe(1);
    expect(spawns).toBe(1);
  });

  it('walls OFF: no cap, no note, no counter', async () => {
    const { texts, kinds, allows } = await driveTurn('sr-cap-off', [
      round({ id: 'a', name: 'Agent' }),
      round({ id: 'b', name: 'Agent' }),
      round({ id: 'c', name: 'Agent' }),
      round({ id: 'd', name: 'Agent' }),
    ], {});

    expect(texts).toEqual(['child done', 'child done', 'child done', 'child done']);
    expect(kinds).toEqual([]);
    expect(allows).toEqual([]);
  });
});

/**
 * Follow-up D item 1 — the streak arms only on an ADMITTED spawn.
 *
 * The serial-fg rerun on the follow-up C runner (staging 2026-09-04, lead 79d7df08): the
 * model's FIRST spawn named `tools:['web_search']`, which is not a tool. The Agent tool
 * refused it on its OWN grounds, but the streak had already armed on the call's SHAPE, so
 * the corrected retry read as a second consecutive lone spawn and got the parallelise text.
 * Nothing ran, and the model ended its turn saying the lookup was running: any bad-argument
 * retry became a wall, and the wall then lied.
 *
 * So the streak arms at DELIVERY, after the tool has run, and only when the tool did not
 * turn the spawn away itself. `ctx.markSpawnRefused()` is that signal — stamped onto the
 * dispatch result as `spawnAdmitted: false`, never read off the refusal's text.
 */
describe('the root wall — only an ADMITTED spawn arms the streak', () => {
  /** What the drill's first spawn got back: the Agent tool's own toolset validation. */
  const UNKNOWN_TOOLS = 'Unknown or unavailable tools: web_search. Available: WebSearch';

  /** The refusals the Agent tool returns on its OWN grounds, in call order; a call past the
   *  end of the queue is an ordinary admitted spawn. */
  let refusals: string[] = [];
  const refusingAgent: RawToolOptions = {
    name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
    execute: async (_args: unknown, ctx: ToolExecuteContext) => {
      const refusal = refusals.shift();
      if (refusal !== undefined) { ctx.markSpawnRefused?.(); return refusal; }
      ctx.markSpawnAdmitted?.();
      spawns += 1;
      return 'child done';
    },
  };
  const tools = [refusingAgent, fakeRead, fakeTodo];
  const threeLone = [
    round({ id: 'a', name: 'Agent' }),
    round({ id: 'b', name: 'Agent' }),
    round({ id: 'c', name: 'Agent' }),
  ];

  it('the drill: a bad tool name, the corrected retry RUNS, and the third is still walled', async () => {
    refusals = [UNKNOWN_TOOLS];
    const { texts, kinds } = await driveTurn('sr-adm-drill', threeLone, { subagentWalls: true }, tools);

    // The refused spawn never armed anything, so the retry is judged as the FIRST spawn again.
    expect(texts).toEqual([UNKNOWN_TOOLS, 'child done', SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root']);   // the wall still fires, one round later
  });

  it("the tool's other refusals do not arm it either: depth, tree concurrency, budget", async () => {
    const texts3 = [
      depthRefusal(SUBAGENT_DEPTH_CAP, SUBAGENT_DEPTH_CAP),
      concurrencyRefusal(SUBAGENT_TREE_CONCURRENCY),
      budgetRefusal(1, 1),
    ];
    refusals = [...texts3];
    const { texts, kinds } = await driveTurn('sr-adm-kinds', threeLone, { subagentWalls: true }, tools);

    expect(texts).toEqual(texts3);
    expect(spawns).toBe(0);
    expect(kinds).toEqual([]);
  });

  /**
   * R138 / L1 — the class, not the site list.
   *
   * Marking every refusal is a list, and a list can be missed: four sites were, and one of
   * them was the incident itself with a different bad argument. So the arming reads an
   * explicit ADMISSION instead of the absence of a refusal. A tool that says nothing started
   * nothing, which is also the truth for a gate deny, a throw and a drain expiry.
   */
  it('a refusal that marks NOTHING does not arm it either', async () => {
    const silent: RawToolOptions = {
      name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
      execute: async () => 'Some future refusal nobody remembered to mark.',
    };
    const { texts, kinds } = await driveTurn(
      'sr-adm-silent', threeLone, { subagentWalls: true }, [silent, fakeRead, fakeTodo],
    );

    expect(texts).toEqual(Array(3).fill('Some future refusal nobody remembered to mark.'));
    expect(kinds).toEqual([]);
  });

  /**
   * R142 — a child that RAN and then paused for a person is a hand-off that happened. The
   * dispatcher's pausedHalt return built its own literal without the verdict, so this read
   * as "nothing started" for a child that had; the streak has to arm exactly as it does on a
   * completed one. Read off the RunContext directly, because a pausedHalt result ends the
   * turn: there is no next round in this turn to observe it through.
   */
  it('a lone spawn whose child PAUSES arms the streak, exactly as a completed one does', async () => {
    const pausing: RawToolOptions = {
      name: 'Agent', description: 'spawn', parameters: z.object({}).passthrough(),
      execute: async (_a: unknown, ctx: ToolExecuteContext) => {
        ctx.markSpawnAdmitted?.();
        ctx.markPausedHalt?.();
        return 'Subagent paused awaiting human approval.';
      },
    };
    const kinds: SubagentRefusalKind[] = [];
    const paused = makeDeps('sr-adm-paused', [round({ id: 'a', name: 'Agent' })],
      { subagentWalls: true }, kinds, [pausing, fakeRead, fakeTodo]);
    await driveRounds(paused, 1);
    expect(paused.rc!.lastRoundWasLoneSpawn).toBe(true);

    // The contrast, through the same door: a child that never started leaves it unarmed.
    const refused = makeDeps('sr-adm-paused-refused', [round({ id: 'a', name: 'Agent' })],
      { subagentWalls: true }, kinds, [refusingAgent, fakeRead, fakeTodo]);
    refusals = ['Unknown or unavailable tools: web_search. Available: WebSearch'];
    await driveRounds(refused, 1);
    expect(refused.rc!.lastRoundWasLoneSpawn).toBe(false);
  });

  it('an ADMITTED lone spawn still arms it: this does not switch the wall off', async () => {
    refusals = [];
    const { texts, kinds } = await driveTurn('sr-adm-armed', threeLone, { subagentWalls: true }, tools);

    expect(texts).toEqual(['child done', SERIAL_ROOT_REFUSAL, SERIAL_ROOT_REFUSAL]);
    expect(spawns).toBe(1);
    expect(kinds).toEqual(['serial_root', 'serial_root']);
  });
});
