import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeAnthropic, type Script } from '../../__tests__/fixtures/fake-anthropic.js';
import { fakeLink } from '../../__tests__/fixtures/fake-link.js';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import type { TextBlock, TurnLimits } from '../context.js';
import { countMarkers, MAX_ROUNDS, runLoop, type LoopInput } from '../loop.js';
import { roomTools } from '../room-tools.js';
import { makeTurnCtx, SAY_NOTHING, type QuickTool } from '../tools.js';

const HOUR = { type: 'ephemeral', ttl: '1h' } as const;
const SYSTEM: TextBlock[] = [{ type: 'text', text: 'You are Go.', cache_control: HOUR }];
const USER: TextBlock[] = [
  { type: 'text', text: '# The trip chat so far, oldest first' },
  { type: 'text', text: '<data source="chat, part 1">\n#2 Priya: hi\n</data>', cache_control: HOUR },
  { type: 'text', text: '# Right now\nIt is Tue, 6 Oct, 2:30 pm.' },
  { type: 'text', text: '# New since your last turn\n<data source="new messages">\n#3 Arjun: @Go hello\n</data>' },
];
const echo: QuickTool<{ say: string }> = {
  name: 'echo', description: 'Says it back.', input: z.object({ say: z.string() }), run: async (a) => ({ said: a.say }),
};
const echoCall = (say: string) => ({ name: 'echo', input: { say } });

// The react tool keeps Go's record of its reactions in Postgres.
let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

let trips = 0;
function setup(script: Script, more: Partial<LoopInput> = {}, limits: TurnLimits | null = null) {
  const { client, bodies } = fakeAnthropic(script);
  const { link } = fakeLink({ add_reaction: () => ({ seq: 9 }) });
  const ctx = makeTurnCtx({
    // A trip of its own per setup: Go reacts to a message once, so a reaction one test sent would be a no-op in the next.
    tripId: `t_loop_${++trips}`, turnId: 'turn_L', link, wake: [], signal: new AbortController().signal,
    pack: { trip: goaSnapshot(), messages: [msg(3, 'p_arjun', '@Go hello')], seq: 3 },
    limits,
  });
  const run = () =>
    runLoop({
      client, model: 'claude-sonnet-5-5', system: SYSTEM, messages: [{ role: 'user', content: USER }],
      tools: [echo, ...roomTools({ now: () => new Date(), pool: db.pool })], ctx, signal: AbortSignal.timeout(5_000), ...more,
    });
  return { bodies, ctx, run };
}
const markersIn = (body: any) => countMarkers(body.system, body.tools, body.messages);

describe('the reply after a refused call (8 Oct rerun)', () => {
  const noter: QuickTool<{ who: string }> = {
    name: 'noter', description: 'Notes a job against a name.', input: z.object({ who: z.string() }),
    claims: /\bnoted\b/i,
    run: async (a) => (a.who === 'arjun' ? { refused: 'only Arjun can say so', tell_the_room: SAY_NOTHING } : { saved: 'r_1' }),
  };
  const told = "The noter call was refused, so I'll just say it here.\n\nNoted, Arjun has the speaker. Arjun, can you confirm?";

  it("drops the sentences that narrate a quiet refusal or claim the refused tool's work; the rest is the reply", async () => {
    const { run } = setup([{ tools: [{ name: 'noter', input: { who: 'arjun' } }] }, { text: told }], { tools: [noter] });
    expect((await run()).text).toBe('Arjun, can you confirm?');
  });

  it("keeps a claim when the claiming tool wasn't called this turn, even when another tool refused quietly", async () => {
    // A plain "Noted" with no record call stays: only a tool that was called, and refused every time, loses its claims.
    const none = setup([{ text: 'Noted, Priya, a pool it is.' }], { tools: [noter, echo] });
    expect((await none.run()).text).toBe('Noted, Priya, a pool it is.');
    const blocker: QuickTool<{ say: string }> = { ...echo, name: 'blocker', run: async () => ({ refused: 'no', tell_the_room: SAY_NOTHING }) };
    const other = setup([{ tools: [{ name: 'blocker', input: { say: 'x' } }] }, { text: 'Noted, Priya, a pool it is.' }], { tools: [noter, blocker] });
    expect((await other.run()).text).toBe('Noted, Priya, a pool it is.');
  });

  it('keeps a claim when the tool went through in the turn', async () => {
    const { run } = setup([{ tools: [{ name: 'noter', input: { who: 'kabir' } }] }, { text: 'Noted, Kabir has the cab.' }], { tools: [noter] });
    expect((await run()).text).toBe('Noted, Kabir has the cab.');
  });
});

describe('the composer loop', () => {
  it('two or more calls in a reply that share a round summary get one tally line after their results; a lone call gets none', async () => {
    const tally = (rs: Array<{ content: string; isError: boolean }>): string => `${rs.length} looks: ${rs.map((r) => (JSON.parse(r.content) as { said: string }).said).join(', ')}`;
    const look: QuickTool<{ say: string }> = { ...echo, name: 'look', summarizeRound: tally };
    const lookAgain: QuickTool<{ say: string }> = { ...echo, name: 'look_again', summarizeRound: tally };
    const { bodies, run } = setup(
      [
        { tools: [{ name: 'look', input: { say: 'a' } }, { name: 'look_again', input: { say: 'b' } }, echoCall('c')] },
        { tools: [{ name: 'look', input: { say: 'd' } }] },
        { text: 'done' },
      ],
      { tools: [echo, look, lookAgain] },
    );
    await run();
    const second = bodies[1].messages.at(-1).content;
    expect(second.map((b: { type: string }) => b.type)).toEqual(['tool_result', 'tool_result', 'tool_result', 'text']);
    expect(second.at(-1).text).toBe('2 looks: a, b');
    expect(bodies[2].messages.at(-1).content.map((b: { type: string }) => b.type)).toEqual(['tool_result']);
  });

  it('one round: the final text is the answer, and the wire body is what Go needs', async () => {
    const { bodies, run } = setup([{ text: 'Hello!' }]);
    const r = await run();
    expect(r).toMatchObject({ text: 'Hello!', silent: false, rounds: 1, stopReason: 'end_turn' });
    const body = bodies[0];
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toEqual([{ type: 'text', text: 'You are Go.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: [...USER.slice(0, -1), { ...USER.at(-1), cache_control: { type: 'ephemeral' } }] }]);
    expect(body.tools.map((t: any) => t.name)).toEqual(['echo', 'react', 'open_vote', 'close_vote', 'update_trip', 'offer_replies', 'stay_silent']);
    for (const t of body.tools) {
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema.$schema).toBeUndefined();
    }
    expect(markersIn(body)).toBe(3);
  });

  it('sends no thinking field on Haiku 4.5', async () => {
    const { bodies, run } = setup([{ text: 'Hi' }], { model: 'claude-haiku-4-5' });
    await run();
    expect(bodies[0].thinking).toBeUndefined();
    expect(bodies[0].output_config).toBeUndefined();
    expect(bodies[0].max_tokens).toBe(2048);
  });

  it("thinking goes back to the model as it came, first in its round, and never into the room's words", async () => {
    const { bodies, run } = setup([{ thinking: 'sig_1', tools: [echoCall('a')] }, { thinking: 'sig_2', text: 'Done.' }]);
    const r = await run();
    expect(r.text).toBe('Done.');
    const said = bodies[1].messages[1];
    expect(said.role).toBe('assistant');
    expect(said.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig_1' });
    expect(said.content[1]).toMatchObject({ type: 'tool_use', name: 'echo' });
  });

  it('a tool round runs the calls together and puts one rolling marker on the newest block', async () => {
    const { bodies, run } = setup([{ tools: [echoCall('a'), echoCall('b')] }, { text: 'Done.' }]);
    const r = await run();
    expect(r).toMatchObject({ text: 'Done.', rounds: 2 });
    const second = bodies[1];
    expect(second.messages).toHaveLength(3);
    const results = second.messages[2].content;
    expect(results.map((b: any) => b.content)).toEqual(['{"said":"a"}', '{"said":"b"}']);
    expect(results.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(results[0].cache_control).toBeUndefined();
    expect(second.messages[0].content[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(markersIn(second)).toBe(3);
  });

  it('stay_silent ends the turn in the same round, with no extra call', async () => {
    const { bodies, ctx, run } = setup([
      { tools: [{ name: 'react', input: { message_id: '#3', emoji: '👍' } }, { name: 'stay_silent', input: { reason: 'just a hello' } }] },
      { text: 'never asked' },
    ]);
    const r = await run();
    expect(bodies).toHaveLength(1);
    expect(r).toMatchObject({ text: '', silent: true, stopReason: 'stay_silent' });
    expect(ctx.outcome).toMatchObject({ silent: true, reactions: 1 });
  });

  it('stops after 4 rounds of tools, and no request ever carries more than 4 markers', async () => {
    const { bodies, run } = setup(() => ({ tools: [echoCall('again')] }));
    const r = await run();
    // 4 rounds that may call tools, then the closing round, which may not.
    expect(bodies).toHaveLength(MAX_ROUNDS + 1);
    expect(bodies.slice(0, MAX_ROUNDS).every((b) => (b as { tool_choice: { type: string } }).tool_choice.type === 'auto')).toBe(true);
    expect((bodies[MAX_ROUNDS] as { tool_choice: { type: string } }).tool_choice).toEqual({ type: 'none' });
    expect(r).toMatchObject({ rounds: MAX_ROUNDS + 1, stopReason: 'max_rounds' });
    for (const b of bodies) expect(markersIn(b)).toBeLessThanOrEqual(4);
    expect(markersIn(bodies[3])).toBe(3);
  });

  // Staging drill, 10 Oct: a turn that ran out of rounds posted its last round's working ("The message ID format is "",
  // so I'll use that as the proof."), written before its tool calls. The closing round writes the reply instead.
  it("never posts the working a tool round wrote: out of rounds, the closing round's words are the reply", async () => {
    let n = 0;
    const { run } = setup(() => {
      n += 1;
      return n <= MAX_ROUNDS ? { text: 'The message ID format is "", so I\'ll use that as the proof.', tools: [echoCall('again')] } : { text: 'Locked in: about 26k each.' };
    });
    const r = await run();
    expect(r).toMatchObject({ text: 'Locked in: about 26k each.', stopReason: 'max_rounds' });
  });

  it('gives bad arguments back to the model to fix', async () => {
    const { bodies, run } = setup([{ tools: [{ name: 'react', input: { emoji: '👍' } }] }, { text: 'Fixed.' }]);
    await run();
    const result = bodies[1].messages[2].content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Invalid arguments for react');
  });

  it('an unknown tool is an error result, not a crash', async () => {
    const { bodies, run } = setup([{ tools: [{ name: 'pay_now', input: {} }] }, { text: 'ok' }]);
    await run();
    expect(bodies[1].messages[2].content[0]).toMatchObject({ is_error: true, content: 'There is no tool named pay_now.' });
  });

  it('a turn with limits refuses any other tool and never runs it; stay_silent always works; the definitions never change', async () => {
    let echoed = 0;
    const counted: QuickTool<{ say: string }> = { ...echo, run: async (a) => { echoed += 1; return { said: a.say }; } };
    const free = setup([{ text: 'Hi' }]);
    await free.run();
    const limited = setup(
      [
        { tools: [echoCall('x'), { name: 'react', input: { message_id: '#3', emoji: '👍' } }] },
        { tools: [{ name: 'stay_silent', input: { reason: 'noted' } }] },
      ],
      { tools: [counted, ...roomTools({ now: () => new Date(), pool: db.pool })] },
      { tools: ['react'], mayPostText: false },
    );
    const r = await limited.run();
    expect(echoed).toBe(0);
    const results = limited.bodies[1].messages[2].content;
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0].content).toContain('echo is not allowed this turn');
    expect(results[0].content).toContain(SAY_NOTHING);
    expect(results[1].is_error).toBeUndefined();
    expect(limited.ctx.outcome.reactions).toBe(1);
    expect(r).toMatchObject({ silent: true, stopReason: 'stay_silent' });
    // The same tool definitions as a turn with no limits, so the one-hour cache on the rules and tools still reads.
    expect(limited.bodies[0].tools).toEqual(free.bodies[0].tools);
    expect(limited.bodies[0].system).toEqual(free.bodies[0].system);
  });

  it('ends the turn on a tool that answered itself with its card and line: no model round after it', async () => {
    const line = 'Pool stays in North Goa for 6 to 9 Nov, from ₹4,334 a night.';
    const answering: QuickTool<{ say: string }> = {
      ...echo,
      name: 'search_stays',
      run: async (_a, ctx) => {
        ctx.cards.push({ card_id: 'c_opt_1', kind: 'options' } as never);
        ctx.lines.push(line);
        ctx.answered = true;
        return { answered: true };
      },
    };
    const { bodies, ctx, run } = setup([{ tools: [{ name: 'search_stays', input: { say: 'x' } }] }, { text: 'never asked' }], { tools: [answering] });
    const r = await run();
    expect(bodies).toHaveLength(1);
    expect(r).toMatchObject({ text: line, rounds: 1, stopReason: 'cards_up' });
    // The tool saw that it was its round's only call.
    expect(ctx.roundTools).toEqual(['search_stays']);
  });

  it('when the last round writes nothing, the latest earlier text is the answer', async () => {
    const { run } = setup([{ text: 'Opening a vote now!', tools: [echoCall('x')] }, {}]);
    expect((await run()).text).toBe('Opening a vote now!');
  });

  it('sums the usage of every round, with the cost', async () => {
    const { run } = setup([
      { tools: [echoCall('x')], usage: { input_tokens: 50, cache_read_input_tokens: 4_000, output_tokens: 10 } },
      { text: 'ok', usage: { input_tokens: 60, cache_read_input_tokens: 4_100, cache_creation_input_tokens: 200, output_tokens: 20 } },
    ]);
    const { usage } = await run();
    expect(usage).toMatchObject({ input: 110, cacheRead: 8_100, cacheWrite: 200, output: 30 });
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("times every round for the turn's log: its tools, first token, whole reply, output tokens and stop", async () => {
    const { run } = setup([
      { tools: [echoCall('x')], usage: { output_tokens: 15 } },
      { text: 'ok', usage: { output_tokens: 25 } },
    ]);
    const { timings } = await run();
    expect(timings).toEqual([
      { tools: ['echo'], firstTokenMs: expect.any(Number), modelMs: expect.any(Number), toolMs: expect.any(Number), output: 15, stop: 'tool_use' },
      { tools: [], firstTokenMs: expect.any(Number), modelMs: expect.any(Number), toolMs: 0, output: 25, stop: 'end_turn' },
    ]);
  });

  it('the turn\'s signal stops a slow model', async () => {
    const { run } = setup([{ text: 'late', delayMs: 2_000 }], { signal: AbortSignal.timeout(50) });
    await expect(run()).rejects.toThrow();
  });

  it('calls the first-token callback once', async () => {
    let n = 0;
    const { run } = setup([{ tools: [echoCall('x')] }, { text: 'two' }], { onFirstToken: () => { n += 1; } });
    await run();
    expect(n).toBe(1);
  });

  it('the first round marks its newest block too, so the second reads the first one\'s whole prompt from the cache', async () => {
    const { bodies, run } = setup([{ tools: [echoCall('a')] }, { text: 'Done.' }]);
    await run();
    const [first, second] = bodies;
    const unmarked = (blocks: any[]) => blocks.map(({ cache_control, ...b }: any) => (cache_control?.ttl === '1h' ? { ...b, cache_control } : b));
    // Round 1 writes the cache up to "New since your last turn"; round 2 sends those same bytes first, then its tool round.
    expect(first.messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(unmarked(second.messages[0].content)).toEqual(unmarked(first.messages[0].content));
    expect(second.messages[0].content.at(-1).cache_control).toBeUndefined();
    expect(second.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    for (const body of bodies) expect(markersIn(body)).toBeLessThanOrEqual(4);
    expect(markersIn(first)).toBe(3);
  });
});
