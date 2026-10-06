import { describe, expect, it } from 'vitest';
import { parseChat } from '../chat.js';
import type { MessageBody, RecordedRequest } from '../requests.js';
import { assertWallClock, groupsOf, providerNumbers, scoreReplay, wrongSpeak, type GoFrame, type ReplayRecord } from '../score.js';
import { percentile } from '../stats-math.js';

const T0 = 1_800_000_000_000;
const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(60);
const chat = parseChat('s', [
  JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'p_rahul', text: 'hello all', go_should_speak: false }),
  JSON.stringify({ i: 1, at: 60, kind: 'say', person: 'p_priya', text: '@Go flights to Goa on Friday?', go_should_speak: true }),
  JSON.stringify({ i: 2, at: 120, kind: 'say', person: 'p_meher', text: "I'm allergic to prawns", go_should_speak: false, quiet_ok: true }),
  JSON.stringify({ i: 3, at: 180, kind: 'say', person: 'p_kabir', text: 'lol', go_should_speak: false }),
  JSON.stringify({ i: 4, at: 240, kind: 'say', person: 'p_arjun', text: 'Dinner at Bua place on Sunday', go_should_speak: false }),
  JSON.stringify({ i: 5, at: 245, kind: 'delete', of: 4 }),
  JSON.stringify({ i: 6, at: 300, kind: 'say', person: 'p_rahul', text: 'what did Meher say?', go_should_speak: false }),
].join('\n'));
const at = (i: number): number => T0 + i * 1000;

function body(chatText: string): MessageBody {
  return {
    model: 'claude-sonnet-5-5', max_tokens: 1024,
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: chatText, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'Right now: nothing.' }] }],
  };
}
const requests: RecordedRequest[] = [
  { n: 0, role: 'composer', body: body('#2 Rahul: hello all\n#3 Priya: @Go flights to Goa on Friday?'), realMs: at(1) + 100, simS: 60, usage: { input_tokens: 700, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { n: 1, role: 'composer', body: body('#2 Rahul: hello all\n#6 Arjun: Dinner at Bua place on Sunday'), realMs: at(6) + 100, simS: 300, usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } },
];
const answer: GoFrame[] = [
  { method: 'typing', params: { trip_id: 't_goa', on: true }, at: at(1) + 120 },
  { method: 'post_message', params: { trip_id: 't_goa', request_id: 'rq1', text: 'On it! Checking now.' }, at: at(1) + 900 },
  { method: 'add_reaction', params: { trip_id: 't_goa', request_id: 'rq2', message_id: 'm2', emoji: '✅' }, at: at(2) + 50 },
  { method: 'add_reaction', params: { trip_id: 't_goa', request_id: 'rq3', message_id: 'm3', emoji: '✅' }, at: at(3) + 50 },
  { method: 'add_record_line', params: { trip_id: 't_goa', request_id: 'rq4' }, at: at(2) + 100 },
];

function record(over: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    chat, mode: 'fast', composerModel: 'claude-sonnet-5-5', reflexSource: 'labels', startedMs: T0 - 500, endedMs: T0 + 20_000,
    delivered: chat.lines.map((l) => ({ i: l.i, realMs: at(l.i), simS: l.at, ...(l.kind === 'say' ? { messageId: `m${l.i}`, seq: l.i + 2 } : {}) })),
    frames: answer, requests, recall: [], unreadByReflex: 0,
    ...over,
  };
}
const post = (requestId: string, text: string, when: number): GoFrame => ({ method: 'post_message', params: { trip_id: 't_goa', request_id: requestId, text }, at: when });
const hasBadNumber = (v: unknown): boolean =>
  typeof v === 'number' ? !Number.isFinite(v) : Array.isArray(v) ? v.some(hasBadNumber) : v !== null && typeof v === 'object' ? Object.values(v).some(hasBadNumber) : false;

describe('scoring a replay', () => {
  it('scores a clean ask: typing, the reply and one prompted post', () => {
    const s = scoreReplay(record());
    expect(s.typing).toMatchObject({ n: 1, p50Ms: 120, missing: 0 });
    expect(s.reply).toMatchObject({ n: 1, p50Ms: 900 });
    expect(s.speak).toMatchObject({ asks: 1, answered: 1, posts: 1, missed: [], unprompted: [], duplicates: [] });
    expect(s.speak.byKind.prompted).toBe(1);
    expect(wrongSpeak(s)).toBe(0);
  });

  it('allows a quiet reaction only where the line says so', () => {
    const s = scoreReplay(record());
    expect(s.quiet).toEqual({ reactions: 2, wrongReactions: [{ line: 3, emoji: '✅' }], recordLines: 1 });
  });

  it('a resend with the same request_id is one post', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq1', 'On it! Checking now.', at(1) + 2500)] }));
    expect(s.speak.posts).toBe(1);
  });

  it('the same text twice with nothing new in between is a duplicate', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq9', 'On it! Checking now.', at(1) + 950)] }));
    expect(s.speak.duplicates.length).toBe(1);
    expect(wrongSpeak(s)).toBe(1);
  });

  it('a quick second post is a follow-up; a post with nothing to answer is unprompted', () => {
    const s = scoreReplay(record({ frames: [...answer, post('rq5', 'Fares go up on Fridays, by the way.', at(3) + 500), post('rq6', 'Random thought', at(6) + 9000)] }));
    expect(s.speak.byKind.follow_up).toBe(1);
    expect(s.speak.unprompted).toEqual([{ at: at(6) + 9000, afterLine: 6, text: 'Random thought' }]);
  });

  it('names a missed ask', () => {
    const s = scoreReplay(record({ frames: answer.filter((f) => f.method !== 'post_message') }));
    expect(s.speak.missed).toEqual([{ line: 1, text: '@Go flights to Goa on Friday?' }]);
    expect(s.reply.p50Ms).toBeNull();
  });

  it('counts the model waking per person message', () => {
    expect(scoreReplay(record()).wake).toEqual({ turns: 2, messages: 6, rate: 2 / 6 });
  });

  it('deleted text in a later prompt is a leak; a prompt already in flight is not', () => {
    expect(scoreReplay(record()).leaks).toEqual([{ line: 4, requestN: 1 }]);
    const early = requests.map((r) => (r.n === 1 ? { ...r, realMs: at(5) + 500 } : r));
    expect(scoreReplay(record({ requests: early })).leaks).toEqual([]);
  });

  it('a recall probe passes only with the right message number and the answer', () => {
    const probe = { question: 'What is Meher allergic to?', answer: 'prawn', line: 2 };
    const right = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: [{ text: "I'm allergic to prawns", messageId: 'm2', seq: 4 }] }] }));
    expect(right.recall).toMatchObject({ probes: 1, ran: true, passed: 1, failed: [] });
    const wrongSeq = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: [{ text: "I'm allergic to prawns", messageId: 'm9', seq: 11 }] }] }));
    expect(wrongSeq.recall.passed).toBe(0);
    expect(wrongSeq.recall.failed[0]).toMatchObject({ line: 2, seq: 4 });
    const notRun = scoreReplay(record({ recall: [{ probe, afterLine: 6, realMs: at(6) + 200, results: null }] }));
    expect(notRun.recall.ran).toBe(false);
  });

  it("scores a chat with only Go's lines without a single NaN", () => {
    const onlyGo = parseChat('only-go', JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'go', text: 'Hi all', go_should_speak: 'either' }));
    const s = scoreReplay(record({ chat: onlyGo, delivered: [], requests: [], frames: [post('rq1', "Hi all, I'm Go.", T0 + 100)] }));
    expect(s.wake.rate).toBeNull();
    expect(s.typing.p50Ms).toBeNull();
    expect(s.reply.p50Ms).toBeNull();
    expect(s.speak.byKind.greeting).toBe(1);
    expect(s.cache.status).toBe('no_requests');
    expect(s.messages.goLinesSkipped).toBe(1);
    expect(hasBadNumber(s)).toBe(false);
  });

  it('fails loudly when a frame was stamped by another clock', () => {
    expect(() => assertWallClock([{ method: 'typing', params: {}, at: 5 }], T0, T0 + 10_000)).toThrow(/not stamping frames with the wall clock/);
    expect(() => assertWallClock(answer, T0 - 500, T0 + 20_000)).not.toThrow();
  });

  it('groups a person\'s lines at most five seconds apart', () => {
    const burst = parseChat('b', [0, 1, 2, 9].map((t, i) => JSON.stringify({ i, at: t, kind: 'say', person: 'p_kabir', text: `line ${i}`, go_should_speak: i === 2 ? true : 'either' })).join('\n'));
    expect(groupsOf(burst).map((g) => ({ lines: g.lines, expect: g.expect }))).toEqual([{ lines: [0, 1, 2], expect: true }, { lines: [3], expect: 'either' }]);
  });

  it('reads the provider\'s own cache numbers, leaving out the run\'s first request', () => {
    expect(providerNumbers(requests)).toMatchObject({ requests: 2, cacheHit: 600 / 700 });
  });

  it('takes nearest-rank percentiles and ignores what is not a number', () => {
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 50)).toBe(5);
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([Number.NaN, 3], 50)).toBe(3);
  });
});
