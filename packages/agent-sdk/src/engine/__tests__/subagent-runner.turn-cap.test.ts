/**
 * Orchestration walls (spec D6/D7, §4.4) — the per-child TURN CAP is a WRAP-UP, not a
 * cliff, and every run reports WHY it stopped.
 *
 * Before this, a child that hit `maxTurns` mid-tool-call was cut off with whatever text
 * the last round happened to leave (usually none), and the parent got an empty report it
 * could not tell apart from a real answer. Under the walls the loop instead pushes
 * TURN_CAP_DIRECTIVE as a user turn and runs ONE more round with every tool REFUSED at
 * the gate (the same provider-neutral deny the runaway watchdog uses), so the child gets
 * exactly one chance to say what it found. `stopReason` + `turnsUsed` ride the result on
 * BOTH axes so the label layer can mark a partial report as partial.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream, NormalizedUsage } from '../transport.js';
import { runSubagentLoop } from '../subagent-runner.js';
import { TURN_CAP_DIRECTIVE } from '../subagent-walls.js';

type Entry = { role: string; text?: string };
function scripted(rounds: StreamEvent[][]): { t: Transport; history: () => Entry[]; calls: () => number } {
  let i = 0;
  let h: Entry[] = [];
  const t: Partial<Transport> = {
    api: 'fake', provider: 'fake', defaultModel: () => 'm',
    emptyHistory: () => { h = []; return h as unknown as ProviderHistory; },
    pushUser: (hh, text) => { (hh as unknown as Entry[]).push({ role: 'user', text }); },
    pushAssistant: (hh) => { (hh as unknown as Entry[]).push({ role: 'assistant' }); },
    pushToolResult: (hh) => { (hh as unknown as Entry[]).push({ role: 'tool_result' }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => (rounds[i++] ?? [
      { kind: 'text', text: 'wrapped up' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ]) as unknown as ProviderStream,
    readStream: async function* (s) { for (const ev of s as StreamEvent[]) yield ev; },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return { t: t as Transport, history: () => h, calls: () => i };
}

let toolRuns = 0;
const probe: RawToolOptions = {
  name: 'probe', description: 'p', parameters: z.object({ q: z.string() }),
  execute: async () => { toolRuns += 1; return 'r'; },
};
const toolRound = (k: number): StreamEvent[] => [
  { kind: 'tool_use', toolUse: { id: `t${k}`, name: 'probe', input: { q: String(k) } } },
  { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
];
const looping = (n: number): StreamEvent[][] => Array.from({ length: n }, (_, k) => toolRound(k));

/** What the runner emitted, flattened to the fields these pins read. */
type Ev = { kind: string; isError?: boolean; result?: string };
const run = (t: Transport, walls: boolean, maxTurns: number, onEvent: (e: Ev) => void = () => {}): Promise<{
  text: string; stopReason: string; turnsUsed: number;
}> => runSubagentLoop({
  transport: t, model: 'm', system: 'sys', userPrompt: 'go', tools: [probe],
  harness: { gateTool: async () => ({ decision: 'allow' as const }) }, onPause: async () => 'PAUSED',
  maxTurns, onEvent, sharedLoop: true, ...(walls ? { walls: true } : {}),
} as never) as never;

describe('turn cap — a wrap-up, not a cliff', () => {
  it('walls ON: at the cap the directive is pushed, ONE answering round runs with tools refused, stopReason is turn_cap', async () => {
    toolRuns = 0;
    const events: Ev[] = [];
    const { t, history, calls } = scripted(looping(10));
    const res = await run(t, true, 3, (e) => events.push(e));
    expect(res.stopReason).toBe('turn_cap');
    expect(res.turnsUsed).toBe(3);
    expect(history().some((e) => e.role === 'user' && e.text === TURN_CAP_DIRECTIVE)).toBe(true);
    expect(calls()).toBe(4);           // 3 capped rounds + 1 wrap-up round
    expect(toolRuns).toBe(3);          // the wrap-up round's tool call is refused, not run
    expect(res.text).toBe('');         // the scripted 4th round called a tool, so no text
    // The wrap-up round's REFUSED call still reaches the live stream: the drive forwards
    // tool_use/tool_result for it exactly as for any round, so the stream and the journal
    // agree. 4 rounds each called `probe` once ⇒ 4 tool_use + 4 tool_result events.
    expect(events.filter((e) => e.kind === 'tool_use')).toHaveLength(4);
    const refusals = events.filter((e) => e.kind === 'tool_result' && e.isError);
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { result: string }).result).toContain(TURN_CAP_DIRECTIVE);
  });

  it('walls ON: a child that finishes on its own reports completed', async () => {
    const { t } = scripted([[
      { kind: 'text', text: 'done' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]]);
    const res = await run(t, true, 3);
    expect(res.stopReason).toBe('completed');
    expect(res.text).toBe('done');
  });

  /**
   * Follow-up item 2 — the wrap-up asked for a report in the LAST round, so a child that
   * had spent every turn on tools got one shot at composing one, with tools already
   * refused. The founder's researcher spent 99 turns searching and wrote nothing. The
   * directive now also lands at 75% of the cap, where the child still has turns to write
   * in; the cap stays as the hard backstop for one that ignores it.
   */
  it('walls ON: the directive lands at 75% of the cap, with tools still live', async () => {
    toolRuns = 0;
    const { t, history, calls } = scripted(looping(20));
    // maxTurns 8 ⇒ the nudge lands after turn 6 (wrapUpAtTurn(8)).
    const res = await run(t, true, 8);

    const entries = history();
    const firstNudge = entries.findIndex((e) => e.role === 'user' && e.text === TURN_CAP_DIRECTIVE);
    // Six completed rounds precede it: one assistant entry each. Reaching the cap
    // instead would put it behind eight.
    expect(entries.slice(0, firstNudge).filter((e) => e.role === 'assistant')).toHaveLength(6);
    // Every one of the eight capped rounds ran its tool: the nudge STEERS, it does not gate.
    // (Only the wrap-up round's call is refused — the pin above owns that.)
    expect(toolRuns).toBe(8);
    expect(calls()).toBe(9);
    expect(res.turnsUsed).toBe(8);
    // Pushed once at 75% and once at the cap. A child that ignores the nudge is told again
    // with tools actually refused; the second is never a repeat of a directive it obeyed.
    expect(entries.filter((e) => e.text === TURN_CAP_DIRECTIVE)).toHaveLength(2);
  });

  it('walls ON: a child that OBEYS the nudge finishes on its own, well inside the cap', async () => {
    // Six tool rounds, then it writes. Nothing forced the stop, so this is `completed`.
    const { t, history, calls } = scripted([...looping(6), [
      { kind: 'text', text: 'here is what I found' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]]);
    const res = await run(t, true, 8);

    expect(res.stopReason).toBe('completed');
    expect(res.text).toBe('here is what I found');
    expect(res.turnsUsed).toBe(7);
    expect(calls()).toBe(7);                                                   // no wrap-up round needed
    expect(history().filter((e) => e.text === TURN_CAP_DIRECTIVE)).toHaveLength(1);  // the nudge only
  });

  it('flag OFF: no nudge either, at any point in the run', async () => {
    const { t, history } = scripted(looping(20));
    await run(t, false, 8);
    expect(history().some((e) => e.text === TURN_CAP_DIRECTIVE)).toBe(false);
  });

  it('flag OFF: the loop just ends at the cap (no directive, 3 calls) and stopReason still says turn_cap', async () => {
    toolRuns = 0;
    const { t, history, calls } = scripted(looping(10));
    const res = await run(t, false, 3);
    expect(calls()).toBe(3);
    expect(history().some((e) => e.text === TURN_CAP_DIRECTIVE)).toBe(false);
    expect(res.stopReason).toBe('turn_cap');
  });
});

/**
 * D7 (runner half) — a mid-stream abort SETTLES: the shared loop returns (it never
 * throws), keeps the partial text the killed round had already streamed, and says
 * `stopped_by_user`. Task 8's label layer reads exactly that pair to mark the report
 * partial; a throw here would lose both the text and the cost of every settled round.
 */
describe('settle-on-abort — the shared loop returns the streamed partial', () => {
  it('a Stop DURING the wrap-up round is a user stop, not the cap', async () => {
    // The cap trips, the directive is pushed, and the ONE answering round is then killed
    // mid-stream. Reporting `turn_cap` here would tell the parent the child ran out of
    // turns when the user actually stopped it.
    const controller = new AbortController();
    let calls = 0;
    const t: Partial<Transport> = {
      api: 'fake', provider: 'fake', defaultModel: () => 'm',
      emptyHistory: () => [] as unknown as ProviderHistory,
      pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
      pushAssistant: (h) => { (h as unknown[]).push({ role: 'assistant' }); },
      pushToolResult: (h) => { (h as unknown[]).push({ role: 'tool_result' }); },
      buildTools: (raw) => raw as unknown[],
      callModel: () => ({ round: calls++ }) as unknown as ProviderStream,
      readStream: async function* (s) {
        const { round } = s as unknown as { round: number };
        if (round < 2) { for (const ev of toolRound(round)) yield ev; return; }
        // Round 3 IS the wrap-up round (maxTurns 2): it streams, then the user stops.
        yield { kind: 'text', text: 'HALF' } as StreamEvent;
        controller.abort();
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      computeCostUsd: () => 0.01,
      classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
    };

    const res = await runSubagentLoop({
      transport: t as Transport, model: 'm', system: 'sys', userPrompt: 'go', tools: [probe],
      harness: { gateTool: async () => ({ decision: 'allow' as const }) }, onPause: async () => 'PAUSED',
      signal: controller.signal, maxTurns: 2, onEvent: () => {}, sharedLoop: true, walls: true,
    } as never) as { text: string; stopReason: string; turnsUsed: number };

    expect(calls).toBe(3);              // 2 capped rounds + the wrap-up
    expect(res.turnsUsed).toBe(2);      // the wrap-up is not a turn
    expect(res.stopReason).toBe('stopped_by_user');
    expect(res.text).toBe('HALF');      // the partial the killed wrap-up streamed
  });


  it('returns (never throws) with the partial text and stopReason stopped_by_user', async () => {
    const controller = new AbortController();
    let calls = 0;
    const t: Partial<Transport> = {
      api: 'fake', provider: 'fake', defaultModel: () => 'm',
      emptyHistory: () => [] as unknown as ProviderHistory,
      pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
      pushAssistant: (h) => { (h as unknown[]).push({ role: 'assistant' }); },
      pushToolResult: (h) => { (h as unknown[]).push({ role: 'tool_result' }); },
      buildTools: (raw) => raw as unknown[],
      callModel: () => ({ round: calls++ }) as unknown as ProviderStream,
      readStream: async function* (s) {
        const { round } = s as unknown as { round: number };
        if (round === 0) {
          yield { kind: 'tool_use', toolUse: { id: 't0', name: 'probe', input: { q: '0' } } } as StreamEvent;
          yield { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent;
          return;
        }
        // Round 1: the model streams some text, THEN the user interrupts mid-generation.
        yield { kind: 'text', text: 'PART' } as StreamEvent;
        controller.abort();
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      computeCostUsd: () => 0.01,
      classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
    };

    const res = await runSubagentLoop({
      transport: t as Transport, model: 'm', system: 'sys', userPrompt: 'go', tools: [probe],
      harness: { gateTool: async () => ({ decision: 'allow' as const }) }, onPause: async () => 'PAUSED',
      signal: controller.signal, maxTurns: 5, onEvent: () => {}, sharedLoop: true, walls: true,
    } as never) as { text: string; stopReason: string };

    expect(res.text).toBe('PART');
    expect(res.stopReason).toBe('stopped_by_user');
  });

  it('flag OFF: the SAME abort keeps the empty text (the partial is a walls behaviour)', async () => {
    // Reversal of an earlier ruling: flag-off must not start surfacing a killed round's
    // half-sentence as the child's answer. The Agent tool then mints its own
    // `(subagent "x" produced no output)` exactly as it does today.
    const controller = new AbortController();
    let calls = 0;
    const t: Partial<Transport> = {
      api: 'fake', provider: 'fake', defaultModel: () => 'm',
      emptyHistory: () => [] as unknown as ProviderHistory,
      pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
      pushAssistant: (h) => { (h as unknown[]).push({ role: 'assistant' }); },
      pushToolResult: (h) => { (h as unknown[]).push({ role: 'tool_result' }); },
      buildTools: (raw) => raw as unknown[],
      callModel: () => ({ round: calls++ }) as unknown as ProviderStream,
      readStream: async function* (s) {
        const { round } = s as unknown as { round: number };
        if (round === 0) {
          yield { kind: 'tool_use', toolUse: { id: 't0', name: 'probe', input: { q: '0' } } } as StreamEvent;
          yield { kind: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } } as StreamEvent;
          return;
        }
        yield { kind: 'text', text: 'PART' } as StreamEvent;
        controller.abort();
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      computeCostUsd: () => 0.01,
      classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
    };

    const res = await runSubagentLoop({
      transport: t as Transport, model: 'm', system: 'sys', userPrompt: 'go', tools: [probe],
      harness: { gateTool: async () => ({ decision: 'allow' as const }) }, onPause: async () => 'PAUSED',
      signal: controller.signal, maxTurns: 5, onEvent: () => {}, sharedLoop: true,
    } as never) as { text: string };

    expect(res.text).toBe('');
  });
});
