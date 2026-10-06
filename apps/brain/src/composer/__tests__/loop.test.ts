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
    expect(body.max_tokens).toBe(1024);
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toEqual([{ type: 'text', text: 'You are Go.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: USER }]);
    expect(body.tools.map((t: any) => t.name)).toEqual(['echo', 'react', 'open_vote', 'close_vote', 'update_trip', 'stay_silent']);
    for (const t of body.tools) {
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema.$schema).toBeUndefined();
    }
    expect(markersIn(body)).toBe(2);
  });

  it('sends no thinking field on Haiku 4.5', async () => {
    const { bodies, run } = setup([{ text: 'Hi' }], { model: 'claude-haiku-4-5' });
    await run();
    expect(bodies[0].thinking).toBeUndefined();
    expect(bodies[0].max_tokens).toBe(1024);
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

  it('stops after 4 rounds, and no request ever carries more than 4 markers', async () => {
    const { bodies, run } = setup(() => ({ tools: [echoCall('again')] }));
    const r = await run();
    expect(bodies).toHaveLength(MAX_ROUNDS);
    expect(r).toMatchObject({ rounds: 4, stopReason: 'max_rounds' });
    for (const b of bodies) expect(markersIn(b)).toBeLessThanOrEqual(4);
    expect(markersIn(bodies[3])).toBe(3);
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

  it('a continued exchange carries the rolling marker from its first round', async () => {
    const { bodies, run } = setup([{ text: 'ok' }], { continuing: true });
    await run();
    expect(bodies[0].messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(markersIn(bodies[0])).toBe(3);
  });
});
