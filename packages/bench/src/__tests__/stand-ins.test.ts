import type { Message } from '@go/contract';
import { describe, expect, it } from 'vitest';
import { BenchReflex, allUnsure, countingReflex, labelRead, recordingFor, type Reflex, type ReflexMessage, type ReflexRead } from '../bench-reflex.js';
import { parseChat, type SayLine } from '../chat.js';
import { chatLinesIn, POLICY_GREETING, POLICY_REPLY, PolicyModel, SIDE_REPLY } from '../policy-model.js';
import { recordingClient, type ClientLike } from '../recorder.js';
import { RequestLog, type MessageBody } from '../requests.js';

const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(60);
/** A first round the way P1 builds it: a heading, the chat fenced as data, then right now and new since. */
function composerBody(lines: string[], model = 'claude-sonnet-5-5'): MessageBody {
  return {
    model, max_tokens: 1024,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [
      { type: 'text', text: '# The trip chat so far, oldest first' },
      { type: 'text', text: `<data source="chat, part 1">\n${lines.join('\n')}\n</data>`, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: '# Right now\nIt is 19:40 where the trip is (Asia/Kolkata).' },
      { type: 'text', text: '# New since your last turn\nNothing new.' },
    ] }],
  };
}
async function drain<T>(s: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of s) out.push(ev);
  return out;
}
const policy = (): PolicyModel => new PolicyModel({ composerModel: 'claude-sonnet-5-5', simNow: () => 0 });

function msg(personId: string, text: string): ReflexMessage {
  const m: Message = {
    message_id: `m_${text.length}`, seq: 1, updated_seq: 1, author: { kind: 'person', person_id: personId }, text,
    attachments: [], mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-06T13:30:00Z',
  };
  return m as ReflexMessage;
}
const ctx = {} as Parameters<Reflex['read']>[1];
const chat = parseChat('t', [
  JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'p_rahul', text: '@Go flights Friday?', go_should_speak: true, reflex: { size: 'quick' } }),
  JSON.stringify({ i: 1, at: 5, kind: 'say', person: 'p_priya', text: "I'm veg btw", go_should_speak: false, quiet_ok: true, reflex: { fact: true, reaction: '✅' } }),
  JSON.stringify({ i: 2, at: 9, kind: 'say', person: 'p_kabir', text: 'wait', go_should_speak: 'either', reflex: { complete: false } }),
].join('\n'));
const say = (i: number): SayLine => chat.lines[i] as SayLine;

describe('the policy model', () => {
  it('greets an empty chat, answers a new call to Go once, and stays silent otherwise', async () => {
    const p = policy();
    const first = async (lines: string[]): Promise<unknown> => (await p.client.messages.stream(composerBody(lines)).finalMessage()).content[0];
    expect(await first([])).toMatchObject({ type: 'text', text: POLICY_GREETING });
    expect(await first(['#2 Rahul: Goa is on', '#3 Priya: @Go flights on Friday?'])).toMatchObject({ type: 'text', text: POLICY_REPLY });
    expect(await first(['#2 Rahul: Goa is on', '#3 Priya: @Go flights on Friday?', '#4 Go (you): On it! Checking now.'])).toMatchObject({ type: 'tool_use', name: 'stay_silent' });
    expect(await first(['#3 Priya: @Go flights on Friday?', '#5 Kabir: we need to go back there'])).toMatchObject({ type: 'tool_use', name: 'stay_silent' });
    expect(await first(['#5 Kabir: we need to go back there', '#6 Meher: (reply to #4) ok go, and trains?'])).toMatchObject({ type: 'text', text: POLICY_REPLY });
  });

  it('answers again in the pre-post check round, and ends a tool round quietly', async () => {
    const p = policy();
    const b = composerBody(['#1 Rahul: @Go hi']);
    b.messages.push({ role: 'assistant', content: [{ type: 'text', text: POLICY_REPLY }] }, { role: 'user', content: [{ type: 'text', text: 'New messages:\n<data>\n#2 Priya: and hotels too\n</data>' }] });
    expect((await p.client.messages.stream(b).finalMessage()).content[0]).toMatchObject({ type: 'text', text: POLICY_REPLY });
    const tool = composerBody(['#1 Rahul: @Go hi']);
    tool.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'trip', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] });
    expect((await p.client.messages.stream(tool).finalMessage()).stop_reason).toBe('tool_use');
  });

  it('answers side passes through create: the fold gets a story citing real message numbers, anything else a plain line', async () => {
    const p = policy();
    const notes = await p.client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 1500, system: [{ type: 'text', text: 'You read the turn and propose facts.' }], messages: [{ role: 'user', content: '#7 Meher: allergic to prawns' }] });
    expect(notes.content).toEqual([{ type: 'text', text: SIDE_REPLY, citations: null }]);
    const fold = await p.client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 7000, system: [{ type: 'text', text: 'You keep "the story so far" for Go.' }], messages: [{ role: 'user', content: '#3 Rahul: Goa is on\n#27 Priya: villa it is\nWrite the new story so far, covering everything up to #27.' }] });
    expect(JSON.parse(String(fold.content[0]?.['text']))).toEqual({ lines: [{ text: 'The group kept planning the Goa trip in these messages.', refs: [3, 27], people: [] }] });
    expect(p.log.requests.map((r) => r.role)).toEqual(['side', 'side']);
  });

  it('streams the events a Messages loop reads, with usage from the cache estimate', async () => {
    const p = policy();
    const s = p.client.messages.stream(composerBody(['#1 Rahul: @Go flights?']));
    const events = await drain(s);
    expect(events.map((e) => e['type'])).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const first = await s.finalMessage();
    expect(first.usage.cache_read_input_tokens).toBe(0);
    expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    const second = await p.client.messages.stream(composerBody(['#1 Rahul: @Go flights?'])).finalMessage();
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(p.log.requests[0]?.firstTokenMs).toBeDefined();
    expect(p.log.requests[0]?.usage).toEqual(first.usage);
  });

  it('keeps its own copy of every body', () => {
    const p = policy();
    const b = composerBody(['#1 Rahul: hi']);
    p.client.messages.stream(b);
    b.model = 'changed';
    expect(p.log.requests[0]?.body.model).toBe('claude-sonnet-5-5');
  });

  it('reads chat lines from every user message and nothing else', () => {
    const b = composerBody(['#1 Rahul: Goa is on', 'not a chat line', '#12 Priya Sharma: veg pls', '#13 Meher: (reply to #12) same']);
    b.messages.push({ role: 'assistant', content: [{ type: 'text', text: '#99 Go (you): not from a person' }] }, { role: 'user', content: [{ type: 'text', text: '#14 Kabir: one more' }] });
    expect(chatLinesIn(b)).toEqual([
      { seq: 1, name: 'Rahul', text: 'Goa is on' }, { seq: 12, name: 'Priya Sharma', text: 'veg pls' }, { seq: 13, name: 'Meher', text: 'same' }, { seq: 14, name: 'Kabir', text: 'one more' },
    ]);
  });
});

describe('the recorder', () => {
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 };
  it('records the body, the first text, the end and the provider usage', async () => {
    const real: ClientLike = { messages: { stream: () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start' }; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }; },
      finalMessage: async () => ({ usage }),
    }) } };
    const log = new RequestLog('claude-sonnet-5-5');
    const s = recordingClient(real, log, () => 42).messages.stream(composerBody(['#1 Rahul: @Go hi']));
    await drain(s);
    await s.finalMessage();
    expect(log.requests[0]).toMatchObject({ role: 'composer', simS: 42, usage });
    expect(log.requests[0]?.firstTokenMs).toBeGreaterThanOrEqual(log.requests[0]?.realMs ?? Infinity);
  });
  it('records a side pass made with create', async () => {
    const real: ClientLike = { messages: {
      stream: () => { throw new Error('not used'); },
      create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage }),
    } };
    const log = new RequestLog('claude-sonnet-5-5');
    await recordingClient(real, log, () => 7).messages.create?.({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(log.requests[0]).toMatchObject({ role: 'side', simS: 7, usage });
  });
  it('records a failure and passes it on', async () => {
    const real: ClientLike = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() { throw new Error('overloaded'); }, finalMessage: async () => { throw new Error('overloaded'); } }) } };
    const log = new RequestLog('claude-sonnet-5-5');
    const s = recordingClient(real, log, () => 0).messages.stream(composerBody([]));
    await expect(drain(s)).rejects.toThrow('overloaded');
    expect(log.requests[0]?.error).toBe('overloaded');
  });
});

describe('the bench reflex', () => {
  it('turns hand labels into sure and unsure answers', () => {
    expect(labelRead(say(0))).toMatchObject({ forGo: { value: true, sure: true }, complete: { value: true, sure: true }, size: { value: 'quick', sure: true }, fact: { sure: false } });
    expect(labelRead(say(1))).toMatchObject({ forGo: { value: false, sure: true }, fact: { value: true, sure: true }, reaction: { value: '✅', sure: true } });
    expect(labelRead(say(2))).toMatchObject({ forGo: { value: null, sure: false }, complete: { value: false, sure: true } });
  });

  it('answers by who said what, says unsure about anything else, and counts reads', async () => {
    const r = new BenchReflex(chat.lines);
    expect(await r.read(msg('p_priya', "I'm veg btw"), ctx)).toEqual(labelRead(say(1)));
    expect(await r.read(msg('p_priya', 'something new'), ctx)).toEqual(allUnsure());
    expect(r.reads.get("p_priya\u0000I'm veg btw")).toBe(1);
  });

  it('prefers a recorded Jev read over the hand label', async () => {
    const recorded: ReflexRead = { ...allUnsure(), forGo: { value: false, sure: true } };
    const r = new BenchReflex(chat.lines, new Map([[0, recorded]]));
    expect(await r.read(msg('p_rahul', '@Go flights Friday?'), ctx)).toEqual(recorded);
  });

  it('wraps a live reflex, counts its reads and keeps the first answer for each line', async () => {
    const live = countingReflex(new BenchReflex(chat.lines));
    await live.read(msg('p_kabir', 'wait'), ctx);
    await live.read(msg('p_kabir', 'wait'), ctx);
    expect(live.reads.get('p_kabir\u0000wait')).toBe(2);
    expect(recordingFor(chat, live.recorded, 'jev-1.13.0', '2026-10-06T18:00:00Z')).toEqual({
      jev_model: 'jev-1.13.0', recorded_at: '2026-10-06T18:00:00Z', reads: { '2': labelRead(say(2)) },
    });
  });
});
