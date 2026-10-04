/**
 * The sweep can finish, and it never lies (tell-it-once, 2026-09-25).
 *
 * Prod 09-03 to 09-25: 54% of 858 sweeps on a reasoning model spent the whole 1024-token budget
 * reasoning, wrote no FACT line, and their usage row still said `ok`. The call now asks for 2048
 * tokens at the low reasoning floor, and the row says how the sweep ended: ok (at least one
 * fact), none (the model said NONE), capped (the output cap cut it), empty (no fact and no
 * NONE). A line the cap cut mid-sentence never deposits: on 09-15 one did, as "Shubham wants
 * Vestra".
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOffloopSweep, sweepOutcome, completeLines } from '../memory-sweep.js';
import { laneUsageEvent } from '../offloop-usage.js';
import { FakeTransport, type StreamEvent } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';

/** Records what the sweep asked for; replays the scripted events. */
class SweepTransport extends FakeTransport {
  calls: Array<{ maxTokens: number; reasoningEffort?: 'low' | undefined; history: unknown[] }> = [];
  override callModel(p: Parameters<FakeTransport['callModel']>[0]) {
    this.calls.push({ maxTokens: p.maxTokens, reasoningEffort: p.reasoningEffort, history: p.history as unknown[] });
    return super.callModel(p);
  }
}

async function journalWith(text: string): Promise<Journal> {
  const taskId = `sweep-${Math.random().toString(36).slice(2)}`;
  const journal = new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `sweep-outcome-${process.pid}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });
  await journal.append({
    taskId,
    rootTaskId: taskId,
    spawnDepth: 0,
    workspaceId: 'w',
    agentId: 'native',
    timestamp: '',
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text }] },
  });
  return journal;
}

const done = (stopReason: string | null): StreamEvent => ({
  kind: 'done',
  stopReason,
  usage: { inputTokens: 900, outputTokens: 2048 },
});

async function sweepWith(events: StreamEvent[], extra: { paused?: boolean } = {}) {
  const transport = new SweepTransport(events);
  const result = await runOffloopSweep({
    transport,
    journal: await journalWith('post each reply in the matching thread, one by one'),
    model: 'gpt-6-luna',
    system: 'S',
    providerTools: [],
    elision: null,
    ...extra,
  });
  return { transport, result };
}

describe('runOffloopSweep: the call can finish', () => {
  it('asks for 2048 output tokens at the low reasoning floor', async () => {
    const { transport } = await sweepWith([{ kind: 'text', text: 'NONE' }, done('end_turn')]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].maxTokens).toBe(2048);
    expect(transport.calls[0].reasoningEffort).toBe('low');
  });
});

describe('runOffloopSweep: the row says how the sweep ended', () => {
  it('ok: at least one fact', async () => {
    const { result } = await sweepWith([{ kind: 'text', text: 'FACT [identity] The user builds Vestra.\n' }, done('end_turn')]);
    expect(result.status).toBe('ok');
    expect(result.facts).toHaveLength(1);
  });

  it('none: the model looked and said NONE', async () => {
    const { result } = await sweepWith([{ kind: 'text', text: 'NONE' }, done('end_turn')]);
    expect(result.status).toBe('none');
    expect(result.facts).toEqual([]);
  });

  it('capped: the whole budget went to reasoning and no line was written (Responses reports max_output_tokens)', async () => {
    const { result } = await sweepWith([done('max_output_tokens')]);
    expect(result.status).toBe('capped');
  });

  it('capped: a line the cap cut mid-sentence never deposits; the complete lines above it do', async () => {
    const { result } = await sweepWith([
      { kind: 'text', text: 'FACT [identity] The user builds Vestra.\nFACT [preference] Shubham wants Vestra' },
      done('max_tokens'),
    ]);
    expect(result.status).toBe('capped');
    expect(result.facts.map((f) => f.observation)).toEqual(['The user builds Vestra.']);
  });

  it('empty: the model replied, but with no fact and no NONE', async () => {
    const { result } = await sweepWith([{ kind: 'text', text: 'Sure, here is what I learned about them.' }, done('end_turn')]);
    expect(result.status).toBe('empty');
  });

  it('the usage row carries the outcome as its lane status', () => {
    expect(laneUsageEvent('sweep', { status: 'capped', model: 'gpt-6-luna' }, 't1', 3)).toMatchObject({
      lane: 'sweep',
      laneStatus: 'capped',
    });
  });

  it("the usage row carries the call's wall time when the caller timed it, and no key when it did not", () => {
    expect(laneUsageEvent('sweep', { status: 'ok', model: 'gpt-6-luna' }, 't1', 3, 2_400)).toMatchObject({ latencyMs: 2_400 });
    expect('latencyMs' in laneUsageEvent('sweep', { status: 'ok', model: 'gpt-6-luna' }, 't1', 3)!).toBe(false);
  });
});

describe('sweepOutcome / completeLines (pure)', () => {
  it('a cap wins over a fact count: the model had more to say', () => {
    expect(sweepOutcome('FACT [identity] x\n', [{ epistemic: 'identity', observation: 'x' }], 'incomplete')).toBe('capped');
  });

  it('an uncapped reply is kept whole; a capped one loses only its unterminated last line', () => {
    expect(completeLines('a\nb', false)).toBe('a\nb');
    expect(completeLines('a\nb', true)).toBe('a\n');
    expect(completeLines('a\n', true)).toBe('a\n');
    expect(completeLines('only a cut line', true)).toBe('');
  });

  it('NONE is recognised bulleted, dotted, lowercase, or as a FACT line', () => {
    for (const text of ['NONE', '- NONE', 'NONE.', 'FACT NONE', 'none']) {
      expect(sweepOutcome(text, [], 'end_turn'), text).toBe('none');
    }
  });
});
