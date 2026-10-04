/**
 * SWEEP_PARITY_BY_PREFIX_V1: the rows SWEEP_PREFIX_PARITY_V1 turns down (Anthropic at high effort
 * or above) that CANNOT take a per-message effort change (Fable 5, Mythos 5, the Opus 4 rows) ride
 * the loop's request when the history a floored sweep would rewrite is over the row's break-even,
 * computed from the provider's real rates (memory-sweep.ts parityBreakEvenTokens). The rows that can
 * take one never use this rule (sweepParityPlan): SWEEP_EFFORT_MESSAGE_V1 rides them at a lowered
 * effort instead (the #4381 review, MED-4).
 *
 *   - the plan: which rule each row and flag set gets, read off the registry;
 *   - the price table: every break-even row's figure is the formula over its own rates, and an id
 *     with no rate family of its own never qualifies (LOW-5);
 *   - the economics: past the break-even, parity priced at its WORST (thinking to the whole output
 *     cap) still costs less than the floored sweep at its BEST (only the rewrite charged);
 *   - the prod proof: the 8 recorded claude-fable-5-1 floored sweeps (30 days to 2026-10-04),
 *     decided by the formula and priced both ways;
 *   - the measure: what the floored request sends (no context updates, MED-1), from the model's
 *     first output to the final reply (LOW-6, LOW-7), and the boundary through runOffloopSweep;
 *   - a real turn and its sweep through the NativeHarness, for EACH high-effort model: a break-even
 *     row's long history rides the loop's request and a short one keeps the floored sweep; a capable
 *     row never takes the break-even, and rides with its own turn lowered when that flag is on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { NativeHarness } from '../native-harness.js';
import { AnthropicMessagesTransport } from '../../transports/anthropic-transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { KNOWN_MODEL_IDS, resolveCapabilities } from '../../contract/model-capabilities.js';
import { resolveFamilyRate } from '../native-pricing.js';
import {
  floorRewriteTokens, parityBreakEvenTokens, runOffloopSweep, SWEEP_PARITY_MAX_TOKENS, sweepParityPaysOff, sweepParityPlan,
  sweepTakesEffortMessage,
} from '../memory-sweep.js';
import { FakeTransport } from '../transport.js';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const HIGH_EFFORT = KNOWN_MODEL_IDS.filter((id) => resolveCapabilities(id).provider === 'anthropic' && !sweepParityPaysOff(id));
/** The rows the break-even is the rule for: high effort, no per-message effort change. */
const BREAK_EVEN_ROWS = HIGH_EFFORT.filter((id) => !sweepTakesEffortMessage(id));
/** High effort, but they take a per-message effort change: never the break-even. */
const CAPABLE_HIGH = HIGH_EFFORT.filter((id) => sweepTakesEffortMessage(id));

describe('the plan: which rule a row gets, read off the registry', () => {
  it('the break-even rows are the high-effort rows without the change; the capable high rows are the others', () => {
    expect(BREAK_EVEN_ROWS).toEqual(expect.arrayContaining(['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8']));
    expect(BREAK_EVEN_ROWS).not.toContain('claude-fable-5-1');
    expect(BREAK_EVEN_ROWS).not.toContain('claude-opus-5');
    expect([...CAPABLE_HIGH].sort()).toEqual(['claude-fable-5-1', 'claude-opus-5']);
    expect(HIGH_EFFORT).not.toContain('claude-opus-5-5');
    expect(HIGH_EFFORT).not.toContain('claude-sonnet-5-5');
  });

  const ALL = { effortMessage: true, byPrefix: true };
  const NONE = { effortMessage: false, byPrefix: false };
  it('a capable high row: lowered with the effort flag, else the floored request; never the break-even', () => {
    expect(sweepParityPlan('claude-fable-5-1', ALL)).toEqual({ parityEffort: 'low' });
    expect(sweepParityPlan('claude-fable-5-1', { effortMessage: false, byPrefix: true })).toBeNull();
    expect(sweepParityPlan('claude-opus-5', NONE)).toBeNull();
  });

  it('a capable medium row: lowered with the effort flag, else parity as before', () => {
    expect(sweepParityPlan('claude-opus-5-5', ALL)).toEqual({ parityEffort: 'low' });
    expect(sweepParityPlan('claude-sonnet-5-5', NONE)).toEqual({});
  });

  it('a break-even row: past its break-even with the prefix flag, else the floored request; never an effort message', () => {
    expect(sweepParityPlan('claude-fable-5', ALL)).toEqual({ parityMinRewriteTokens: parityBreakEvenTokens('claude-fable-5') });
    expect(sweepParityPlan('claude-fable-5', { effortMessage: true, byPrefix: false })).toBeNull();
    expect(sweepParityPlan('claude-opus-4-8', NONE)).toBeNull();
  });

  it('every known row, every flag set: an effort message only where the row takes one, a break-even only where it does not', () => {
    const sets = [ALL, NONE, { effortMessage: true, byPrefix: false }, { effortMessage: false, byPrefix: true }];
    for (const id of KNOWN_MODEL_IDS) {
      for (const flags of sets) {
        const plan = sweepParityPlan(id, flags);
        if (plan?.parityEffort) expect(sweepTakesEffortMessage(id), id).toBe(true);
        if (plan?.parityMinRewriteTokens !== undefined) expect(sweepTakesEffortMessage(id), id).toBe(false);
        if (sweepParityPaysOff(id)) expect(plan, id).not.toBeNull(); // parity where it pays, as before
      }
    }
  });
});

describe('the break-even, from each break-even row\'s real rates', () => {
  it.each(BREAK_EVEN_ROWS)('%s: cap x output rate / (cache write - cache read), and parity past it is cheaper even at its worst', (model) => {
    const { rate } = resolveFamilyRate(model);
    const breakEven = parityBreakEvenTokens(model);
    expect(breakEven).toBe(Math.ceil((SWEEP_PARITY_MAX_TOKENS * rate.out) / (rate.cacheWrite - rate.cacheRead)));
    expect(breakEven).toBeGreaterThan(10_000);
    expect(breakEven).toBeLessThan(60_000);
    // One token past it: what parity adds (its whole cap of output) is less than what it saves (the rewrite).
    const rewrite = breakEven + 1;
    expect(SWEEP_PARITY_MAX_TOKENS * rate.out).toBeLessThan(rewrite * (rate.cacheWrite - rate.cacheRead));
  });

  it('the named rows, at today\'s card', () => {
    // Fable 5.1 rides the per-message change now; its figure is the one the prod proof below checks.
    expect(parityBreakEvenTokens('claude-fable-5-1')).toBe(33_437); // $50 out, $12.50 write, $0.25 read
    expect(parityBreakEvenTokens('claude-fable-5')).toBe(35_618); // $50 out, $12.50 write, $1.00 read
    expect(parityBreakEvenTokens('claude-mythos-5')).toBe(35_618); // $50 out, $12.50 write, $1.00 read
    expect(parityBreakEvenTokens('claude-opus-4-8')).toBe(35_618); // $25 out, $6.25 write, $0.50 read
  });

  it('LOW-5: an id with no rate family of its own never qualifies (no break-even from a default rate)', () => {
    // Mutation: ignore isDefault → the Sonnet default rate yields a finite break-even here.
    expect(parityBreakEvenTokens('claude-unheard-of-9')).toBe(Number.POSITIVE_INFINITY);
    expect(parityBreakEvenTokens('gpt-6.1-sol')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the prod proof: the 8 recorded claude-fable-5-1 floored sweeps (30 days to 2026-10-04)', () => {
  // [cache read, cache write, uncached input, output] of each floored sweep, and the input of the main round before it.
  const SWEEPS: Array<[string, number, number, number, number, number]> = [
    ['f5b8f6c1', 59_616, 1_752, 4, 438, 59_620], ['5285d653', 61_149, 1_018, 4, 152, 61_151], ['1ccafd12', 60_103, 1_763, 4, 205, 60_105],
    ['c169b04b', 60_341, 35_577, 4, 404, 94_307], ['3431aceb 11:45', 50_010, 31_792, 4, 269, 80_276], ['3431aceb 11:52', 50_010, 38_074, 4, 363, 86_512],
    ['3431aceb 12:04', 50_010, 69_509, 4, 487, 117_898], ['3431aceb 12:11', 49_990, 105_925, 4, 660, 154_263],
  ];
  it('the rule sends the 4 long conversations to parity, and the 8 cost at most 37% less even at the worst case', () => {
    const r = resolveFamilyRate('claude-fable-5-1').rate;
    const breakEven = parityBreakEvenTokens('claude-fable-5-1');
    let today = 0;
    let withRule = 0;
    const picks: string[] = [];
    for (const [, cr, cw, ri, out, mainInput] of SWEEPS) {
      const floored = (cr * r.cacheRead + cw * r.cacheWrite + ri * r.in + out * r.out) / 1e6;
      const rewrite = mainInput - cr; // what the floored sweep rewrote of the loop's input
      const tail = cw - rewrite; // the final reply and the prompt, written either way
      const parityWorst = (mainInput * r.cacheRead + tail * r.cacheWrite + SWEEP_PARITY_MAX_TOKENS * r.out) / 1e6;
      const parity = rewrite > breakEven;
      picks.push(parity ? 'parity' : 'floored');
      if (parity) expect(parityWorst).toBeLessThan(floored); // never worse, sweep by sweep
      today += floored;
      withRule += parity ? parityWorst : floored;
    }
    expect(picks).toEqual(['floored', 'floored', 'floored', 'parity', 'floored', 'parity', 'parity', 'parity']);
    expect(today).toBeCloseTo(3.827, 2);
    expect(withRule).toBeCloseTo(2.397, 2);
    expect(1 - withRule / today).toBeGreaterThan(0.37);
  });
});

const e = (seq: number, payload: JournalPayload): JournalEntry =>
  ({ uuid: `e${seq}`, parentUuid: null, seq, taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g', principal: { kind: 'system' }, timestamp: '', payload }) as JournalEntry;
const text = (s: string) => [{ type: 'text' as const, text: s }];
const contextUpdate = (seq: number, body: string) => e(seq, { type: 'user', blocks: text(body), injected: 'context_update' } as JournalPayload);

describe('floorRewriteTokens: what a floored sweep would rewrite', () => {
  const first = [e(1, { type: 'user', blocks: text('x'.repeat(4000)) }), e(2, { type: 'assistant', blocks: text('reply') })];
  const longer = [...first, e(3, { type: 'user', blocks: text('y'.repeat(8000)) }), e(4, { type: 'assistant', blocks: text('z'.repeat(400)) })];

  it('LOW-6: a single-round first turn measures 0; later, from the first output on, not counting the final reply', () => {
    expect(floorRewriteTokens(first, null)).toBe(0);
    // 'reply' + the second ask count; the first ask (read from cache either way) and the final reply do not.
    expect(floorRewriteTokens(longer, null)).toBeGreaterThan(1_900);
    expect(floorRewriteTokens(longer, null)).toBeLessThan(2_200);
  });

  it('LOW-6: a multi-round first turn measures its own earlier rounds, a tool-led first round from its tool call', () => {
    const rounds = [
      e(1, { type: 'user', blocks: text('Tidy the notes.') }),
      e(2, { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { path: 'notes.md' } }),
      e(3, { type: 'tool_result', toolUseId: 'tu_1', blocks: text('n'.repeat(8000)) }),
      e(4, { type: 'assistant', blocks: text('Done.') }),
    ];
    expect(floorRewriteTokens(rounds, null)).toBeGreaterThan(1_900); // the tool call and its 8,000-char result
    expect(floorRewriteTokens(rounds, null)).toBeLessThan(2_300);
  });

  it('MED-1: a context update is not counted: the floored request never sends it', () => {
    const withUpdate = [...longer.slice(0, 3), contextUpdate(5, 'u'.repeat(40_000)), longer[3]!];
    // Mutation: measure the unfiltered projection → +10,000 tokens the floored sweep would never rewrite.
    expect(floorRewriteTokens(withUpdate, null)).toBe(floorRewriteTokens(longer, null));
  });

  it('LOW-7: an entry injected after the final reply leaves the final reply out', () => {
    const trailing = [...longer, e(6, { type: 'user', blocks: text('t'.repeat(80)), injected: 'engine' } as JournalPayload)];
    // Mutation: end at the last entry only when it is an assistant → the 400-char final reply counts.
    expect(floorRewriteTokens(trailing, null)).toBe(floorRewriteTokens(longer, null));
  });
});

describe('the boundary, through runOffloopSweep', () => {
  class Recording extends FakeTransport {
    params: Array<Parameters<FakeTransport['callModel']>[0]> = [];
    constructor() {
      super([{ kind: 'text', text: 'FACT [preference] (user_direct) Likes summaries.\n' }, { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 9 } }]);
    }
    override callModel(p: Parameters<FakeTransport['callModel']>[0]) {
      this.params.push(p);
      return super.callModel(p);
    }
  }
  const LOOP = { model: 'claude-fable-5', system: 'the loop system', tools: [] };
  async function journalOf(entries: JournalEntry[]): Promise<Journal> {
    const taskId = `t-boundary-${Math.random().toString(36).slice(2)}`;
    const journal = new Journal({
      taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)), mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-10-04T09:00:00.000Z'),
    });
    for (const x of entries) {
      await journal.append({ taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: x.principal, timestamp: '', payload: x.payload });
    }
    return journal;
  }
  async function sweepAt(entries: JournalEntry[], threshold: (r: number) => number) {
    const journal = await journalOf(entries);
    const r = floorRewriteTokens((await journal.project()).messages, null);
    const t = new Recording();
    await runOffloopSweep({
      transport: t, journal, elision: null, model: 'claude-fable-5', system: 'S', providerTools: [],
      loopRequest: LOOP, parityMinRewriteTokens: threshold(r),
    });
    expect(t.params).toHaveLength(1);
    return t.params[0]!;
  }
  const isParity = (p: Parameters<FakeTransport['callModel']>[0]) => p.maxTokens === SWEEP_PARITY_MAX_TOKENS && p.reasoningEffort === undefined;
  const longer = [
    e(1, { type: 'user', blocks: text('x'.repeat(4000)) }), e(2, { type: 'assistant', blocks: text('reply') }),
    e(3, { type: 'user', blocks: text('y'.repeat(8000)) }), e(4, { type: 'assistant', blocks: text('z'.repeat(400)) }),
  ];

  it('at the break-even: the floored request; one token past: the loop request', async () => {
    expect(isParity(await sweepAt(longer, (r) => r))).toBe(false);
    expect(isParity(await sweepAt(longer, (r) => r - 1))).toBe(true);
  });

  it('MED-1 at the boundary: a large context update never tips a short history into parity', async () => {
    const withUpdate = [...longer.slice(0, 3), contextUpdate(5, 'u'.repeat(40_000)), longer[3]!];
    const journal = await journalOf(longer);
    const bare = floorRewriteTokens((await journal.project()).messages, null);
    // The threshold sits between the history and the history plus the update: still floored.
    const p = await sweepAt(withUpdate, () => bare + 5_000);
    expect(isParity(p)).toBe(false);
    expect(p.reasoningEffort).toBe('low');
  });
});

// ── A real turn and its sweep, for each high-effort model ────────────────────

const FLAGS = ['SWEEP_PREFIX_PARITY_V1', 'SWEEP_PARITY_BY_PREFIX_V1'] as const;
const FLEET = 'FLEET-STATIC '.repeat(800);
const SYSTEM = FLEET + '\n\nSESSION-TAIL ' + 'user/session layers '.repeat(200);
const dir = join(tmpdir(), `sweep-by-prefix-${process.pid}-${Math.random().toString(36).slice(2)}`);
afterEach(async () => {
  for (const f of FLAGS) delete process.env[f];
  await rm(dir, { recursive: true, force: true });
});

function answer(text: string) {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
  ];
  return {
    async *[Symbol.asyncIterator]() { yield* events; },
    async finalMessage() {
      return { stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 40 }, content: [{ type: 'text', text }] };
    },
  };
}

/** A history of `turns` earlier exchanges (each reply ~`replyTokens`), then one real turn and its sweep. */
async function turnAndSweep(model: string, turns: number, replyTokens: number): Promise<[Anthropic.MessageCreateParams, Anthropic.MessageCreateParams]> {
  const taskId = `t-${model}-${turns}-${Math.random().toString(36).slice(2, 6)}`;
  const journal = new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)), mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-04T09:00:00.000Z'),
  });
  const meta = (user: boolean): Omit<NewEntry, 'payload'> => ({
    taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
    principal: user ? { kind: 'user', userId: 'user-1' } : { kind: 'agent', agentId: 'native' }, timestamp: '',
  });
  for (let i = 1; i <= turns; i++) {
    await journal.append({ ...meta(true), payload: { type: 'user', blocks: [{ type: 'text', text: `Question ${i} about the plan.` }] } });
    await journal.append({ ...meta(false), payload: { type: 'assistant', blocks: [{ type: 'text', text: `Answer ${i}. ${'detail '.repeat(replyTokens / 2)}` }] } });
  }
  const requests: Anthropic.MessageCreateParams[] = [];
  const transport = new AnthropicMessagesTransport({
    client: { messages: { stream: (p: Anthropic.MessageCreateParams) => (requests.push(JSON.parse(JSON.stringify(p))), answer(requests.length === 1 ? 'Here is the summary.' : 'FACT: likes summaries')) } } as never,
  });
  const cfg = {
    onAttached: () => {}, maxTurns: 4, transport, journal,
    systemPrompt: SYSTEM, systemFleetPrefixChars: FLEET.length,
    runtimeConfig: { userId: 'user-1' }, namiOffloopSweep: true,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = { taskId, sessionId: taskId, cwd: '/tmp', model, signal: new AbortController().signal, config: cfg };
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run((async function* () { yield { text: 'Summarise where we are, please.' }; })(), ctx)) events.push(ev);
  expect(requests).toHaveLength(2); // the main round, then the sweep
  return [requests[0]!, requests[1]!];
}

const effortOf = (p: Anthropic.MessageCreateParams) => (p as { output_config?: { effort?: string } }).output_config?.effort;
const systemBlocks = (p: Anthropic.MessageCreateParams) => (p.system as unknown[]).length;

describe.each(BREAK_EVEN_ROWS)('%s: a real turn and its sweep', (model) => {
  it('a long history (past the break-even) rides the loop\'s request: its system and effort', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    // Six earlier exchanges of ~10K tokens each: ~60K to rewrite, past every row's break-even.
    const [main, sweep] = await turnAndSweep(model, 6, 10_000);
    // Mutation: drop the rule (today's static exclusion) → the floored request: one block, effort low.
    expect(JSON.stringify(sweep.system)).toBe(JSON.stringify(main.system));
    expect(effortOf(sweep)).toBe(effortOf(main));
    expect(effortOf(sweep)).not.toBe('low');
  });

  it('a short history (under the break-even) keeps the floored sweep', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    const [main, sweep] = await turnAndSweep(model, 1, 1_000);
    expect(systemBlocks(main)).toBe(2);
    expect(systemBlocks(sweep)).toBe(1);
    expect(effortOf(sweep)).toBe('low');
  });

  it('flag off: the long history keeps today\'s floored sweep (byte-identical)', async () => {
    process.env.SWEEP_PREFIX_PARITY_V1 = 'true';
    const [, sweep] = await turnAndSweep(model, 6, 10_000);
    expect(systemBlocks(sweep)).toBe(1);
    expect(effortOf(sweep)).toBe('low');
  });
});

describe.each(CAPABLE_HIGH)('%s (takes a per-message effort change): a real turn and its sweep', (model) => {
  it('the break-even is never its rule: a long history keeps the floored sweep with only the prefix flags on', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    const [, sweep] = await turnAndSweep(model, 6, 10_000);
    expect(systemBlocks(sweep)).toBe(1);
    expect(effortOf(sweep)).toBe('low');
  });

  it('with SWEEP_EFFORT_MESSAGE_V1: even a short history rides the loop request, its own turn lowered', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    process.env.SWEEP_EFFORT_MESSAGE_V1 = 'true';
    try {
      const [main, sweep] = await turnAndSweep(model, 1, 1_000);
      expect(JSON.stringify(sweep.system)).toBe(JSON.stringify(main.system));
      expect(effortOf(sweep)).toBe(effortOf(main)); // the top-level effort stays the loop's
      expect(JSON.stringify(sweep.messages)).toContain('"output_config":{"effort":"low"}');
    } finally {
      delete process.env.SWEEP_EFFORT_MESSAGE_V1;
    }
  });
});
