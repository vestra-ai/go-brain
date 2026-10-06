import { goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic, type Reply } from '../fixtures/fake-anthropic.js';
import {
  afterTools, appliedCount, newSince, rightNow, sleep, startRoom, typingOf, waitTyping, waitWrite, writesOf, type Room,
} from './harness.js';

function goScript(body: any): Reply {
  if (rightNow(body).includes('you just joined this trip')) {
    return afterTools(body)
      ? { text: 'Hi all, I am Go! I can find stays and flights, run votes and keep the plan. First up, where should we stay?' }
      : { tools: [{ name: 'open_vote', input: { question: 'Where should we stay?', options: [{ label: 'North Goa villa' }, { label: 'South Goa resort' }] } }] };
  }
  if (/@go/i.test(newSince(body))) return { text: 'Friday evening flights from Delhi after 6 pm, on it.' };
  return { tools: [{ name: 'stay_silent', input: { reason: 'chatter' } }] };
}

const model = fakeAnthropic(goScript);
let room: Room;
beforeAll(async () => {
  room = await startRoom({ anthropic: model.client });
}, 30_000);
afterAll(async () => {
  await room.stop();
});

describe('G1: Go hears the room', () => {
  it('greets a new trip and opens the first vote', async () => {
    await room.fake.createTrip(goaFreshTrip());
    const vote = await waitWrite(room.fake, (w) => w.method === 'open_vote');
    expect(vote.params.question).toBe('Where should we stay?');
    const hello = await waitWrite(room.fake, (w) => w.method === 'post_message' && w.params.card?.kind === 'vote');
    expect(hello.params.text).toMatch(/^Hi all, I am Go!/);
    expect(hello.params.text).not.toMatch(/[—–]/);
    expect(hello.request_id).toMatch(/^go_post_turn_/);
    expect(appliedCount(room.fake, hello.request_id)).toBe(1);
    expect(room.fake.messages().filter((m) => m.author.kind === 'go')).toHaveLength(1);
  });

  it('"@Go ..." shows typing in under 0.5 s, then an answer, then typing off', async () => {
    const sentAt = Date.now();
    await room.fake.say('p_arjun', "@Go flights Delhi to Goa Friday evening? I can't leave before 6");
    const typing = await waitTyping(room.fake, true, sentAt);
    expect(typing.at - sentAt).toBeLessThan(500);
    const reply = await waitWrite(room.fake, (w) => w.method === 'post_message' && w.at >= sentAt);
    expect(reply.params.text).toBe('Friday evening flights from Delhi after 6 pm, on it.');
    expect(appliedCount(room.fake, reply.request_id)).toBe(1);
    await waitTyping(room.fake, false, reply.at);
  });

  it('chatter gets nothing: no typing, no message', async () => {
    const sentAt = Date.now();
    await room.fake.say('p_meher', 'lol');
    await sleep(1_500);
    expect(writesOf(room.fake).filter((w) => w.at >= sentAt && w.method === 'post_message')).toEqual([]);
    expect(typingOf(room.fake).filter((t) => t.at >= sentAt && t.on)).toEqual([]);
  });

  it('a tap on a card Go does not know is refused kindly', async () => {
    // FakeServer.tap only taps cards the trip shows, so a stale card goes straight to Go, as an old screen in the App would.
    const answer = await room.fake.askGo(
      'card_tap',
      { tap_id: 'tap_e2e_1', trip_id: 't_goa', card_id: 'c_unknown', action_id: 'watch', person_id: 'p_priya' },
      3_500,
    );
    expect(answer).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
  });
});
