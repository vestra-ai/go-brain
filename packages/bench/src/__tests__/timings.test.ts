import { describe, expect, it } from 'vitest';
import { parseChat } from '../chat.js';
import type { MessageBody, RecordedRequest } from '../requests.js';
import type { GoFrame, ReplayRecord } from '../score.js';
import { replyLengths } from '../report-md.js';
import { askTimings, sentencesIn, type Timeline } from '../timings.js';

const T0 = 1_800_000_000_000;
const chat = parseChat('t', [
  JSON.stringify({ i: 0, at: 0, kind: 'say', person: 'p_rahul', text: 'hello all', go_should_speak: false }),
  JSON.stringify({ i: 1, at: 60, kind: 'say', person: 'p_priya', text: '@Go flights to Goa on Friday?', go_should_speak: true }),
].join('\n'));
const t1 = T0 + 1_000;
const body = (over: Partial<MessageBody> = {}): MessageBody => ({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'the chat' }], ...over });
const tools = [{ name: 'search_flights' }, { name: 'recall' }];
const requests: RecordedRequest[] = [
  { n: 0, role: 'composer', body: body({ tools }), realMs: t1 + 300, simS: 60, firstTokenMs: t1 + 1_300, doneMs: t1 + 2_000 },
  // A side pass inside the turn's time, on the same model: no tools, so it is not one of the turn's calls.
  { n: 1, role: 'composer', body: body(), realMs: t1 + 2_100, simS: 60, firstTokenMs: t1 + 2_200, doneMs: t1 + 2_200 },
  {
    n: 2, role: 'composer', simS: 60, realMs: t1 + 2_600, firstTokenMs: t1 + 3_200, doneMs: t1 + 3_900,
    body: body({ tools, messages: [{ role: 'user', content: 'the chat' }, { role: 'assistant', content: [{ type: 'tool_use', name: 'search_flights', id: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'three flights' }] }] }),
  },
];
const frames: GoFrame[] = [
  { method: 'typing', params: { trip_id: 't_goa', on: true }, at: t1 + 10 },
  { method: 'post_message', params: { trip_id: 't_goa', request_id: 'rq1', text: 'Three flights on Friday.' }, at: t1 + 4_100 },
];
const record: ReplayRecord = {
  chat, mode: 'live', composerModel: 'claude-sonnet-5-5', reflexSource: 'live', startedMs: T0 - 500, endedMs: T0 + 20_000,
  delivered: [{ i: 0, realMs: T0, simS: 0, messageId: 'm0', seq: 2 }, { i: 1, realMs: t1, simS: 60, messageId: 'm1', seq: 3 }],
  frames, requests, recall: [], unreadByReflex: 0,
};

describe('where an ask\'s reply time goes', () => {
  it('splits it into before the turn, the model calls, the gaps where tools ran, and the post', () => {
    const timeline: Timeline = {
      desk: [{ ref: 'm0', kind: 'message', dueMs: T0 + 2_000, turnId: null }, { ref: 'm1', kind: 'message', dueMs: t1 + 20, turnId: 'tu1' }],
      turns: [{ turnId: 'tu1', startedMs: t1 + 250, postedMs: t1 + 4_100, endedMs: t1 + 4_200 }],
    };
    expect(askTimings(record, timeline)).toEqual([
      {
        line: 1, dueMs: 20, waited: false, typingMs: 10, turnStartMs: 250,
        calls: [
          { startMs: 300, firstWordMs: 1_300, endMs: 2_000, toolsAfter: ['search_flights'], outputTokens: null },
          { startMs: 2_600, firstWordMs: 3_200, endMs: 3_900, toolsAfter: [], outputTokens: null },
        ],
        postMs: 4_100,
        reply: { chars: 24, sentences: 1, outputTokens: null },
        parts: { beforeTurnMs: 250, modelMs: 3_000, betweenMs: 600, afterModelMs: 200 },
      },
    ]);
  });

  it('marks an ask that waited for more lines', () => {
    const timeline: Timeline = {
      desk: [{ ref: 'm1', kind: 'message', dueMs: t1 + 2_000, turnId: 'tu1' }],
      turns: [{ turnId: 'tu1', startedMs: t1 + 2_050, postedMs: null, endedMs: null }],
    };
    const [a] = askTimings({ ...record, requests: [], frames: [] }, timeline);
    expect(a).toMatchObject({ line: 1, dueMs: 2_000, waited: true, turnStartMs: 2_050, calls: [], postMs: null });
  });

  it('records how long the answer was, and the output tokens of the call that wrote it', () => {
    const timeline: Timeline = {
      desk: [{ ref: 'm1', kind: 'message', dueMs: t1 + 20, turnId: 'tu1' }],
      turns: [{ turnId: 'tu1', startedMs: t1 + 250, postedMs: t1 + 4_100, endedMs: t1 + 4_200 }],
    };
    const withUsage = requests.map((r, k) => ({ ...r, usage: { input_tokens: 9_000, output_tokens: [61, 5, 118][k]! } }));
    const said = 'Friday evening flights from Delhi, all after 6 pm. The cheapest is IndiGo at ₹5,640.50 a head! Want a vote?';
    const posted: GoFrame[] = [frames[0]!, { method: 'post_message', params: { trip_id: 't_goa', request_id: 'rq1', text: said }, at: t1 + 4_100 }];
    const [a] = askTimings({ ...record, requests: withUsage, frames: posted }, timeline);
    expect(a?.calls.map((c) => c.outputTokens)).toEqual([61, 118]);
    expect(a?.reply).toEqual({ chars: [...said].length, sentences: 3, outputTokens: 118 });
    expect(replyLengths({ model: 'claude-sonnet-5-5', chat: 'goa-50', asks: [a!] } as never)).toBe(
      `- claude-sonnet-5-5, goa-50: 1 answer, median ${[...said].length} characters, 3 sentences, 118 output tokens.`,
    );
  });

  it('counts sentences by their ends, not by a decimal point, and a last one with no mark', () => {
    expect(sentencesIn('Three flights on Friday.')).toBe(1);
    expect(sentencesIn('Arjun can leave after 6.30 pm. Meher has no prawns (#5).')).toBe(2);
    expect(sentencesIn("Everyone, please vote by tonight 🗳️")).toBe(1);
    expect(sentencesIn('Done! Want a vote? Or should I wait...')).toBe(3);
    expect(sentencesIn('  ')).toBe(0);
  });
});
