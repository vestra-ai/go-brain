import { goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnRunner } from '../../desk/desk.js';
import { fakeAnthropic, type Reply } from '../fixtures/fake-anthropic.js';
import {
  appliedCount, newSince, postsWith, rightNow, sleep, startRoom, waitTyping, waitWrite, type Room,
} from './harness.js';

// Messages carry a tag, [t:name], that the scripted model and the checks key on.
const tagOf = (text: string): string | null => /\[t:([a-z-]+)\]/.exec(text)?.[1] ?? null;
let failBeforePosting = 1;
let crashAfterPosting: string | null = null; // the message id whose turn dies right after it posted
let crashed = false;

function script(body: any): Reply {
  if (rightNow(body).includes('you just joined this trip')) {
    return { text: 'Hi all, I am Go!' };
  }
  const fresh = newSince(body);
  if (fresh.includes('burst-')) return { text: `Read ${(fresh.match(/burst-\d/g) ?? []).length} new messages.` };
  const tag = tagOf(fresh);
  if (tag === 'crash-before' && failBeforePosting > 0) {
    failBeforePosting -= 1;
    return { throws: new Error('the model fell over') };
  }
  if (tag === 'slow') return { text: 'ok [t:slow]', delayMs: 2_500 };
  if (tag) return { text: `ok [t:${tag}]` };
  return { tools: [{ name: 'stay_silent', input: { reason: 'chatter' } }] };
}

const dieAfterPosting = (run: TurnRunner): TurnRunner => async (t) => {
  await run(t);
  if (!crashed && crashAfterPosting && t.items.some((i) => i.ref === crashAfterPosting)) {
    crashed = true;
    throw new Error('this copy of Go died right after posting');
  }
};

const model = fakeAnthropic(script);
let room: Room;
beforeAll(async () => {
  room = await startRoom({ anthropic: model.client, wrapTurn: dieAfterPosting });
  await room.fake.createTrip(goaFreshTrip());
  await waitWrite(room.fake, (w) => w.method === 'post_message' && w.params.text === 'Hi all, I am Go!');
}, 30_000);
afterAll(async () => {
  await room.stop();
});

const askedAbout = (from: number, text: string) => model.bodies.slice(from).filter((b) => newSince(b).includes(text));

describe('G1: Go holds up', () => {
  it('a burst of five gets one turn that reads all five', async () => {
    const before = model.bodies.length;
    await room.fake.say('p_rahul', 'burst-1 scuba on Sunday?');
    await room.fake.say('p_priya', 'burst-2 yes!!');
    await room.fake.say('p_arjun', 'burst-3 @Go is scuba safe in November?');
    await room.fake.say('p_meher', "burst-4 I can't swim lol");
    await room.fake.say('p_kabir', 'burst-5 snorkelling then');
    const reply = await waitWrite(room.fake, (w) => w.method === 'post_message' && /^Read \d new messages\.$/.test(w.params.text ?? ''));
    expect(reply.params.text).toBe('Read 5 new messages.');
    expect(askedAbout(before, 'burst-')).toHaveLength(1);
    await sleep(800);
    expect(postsWith(room.fake, 'Read ')).toHaveLength(1);
  });

  it('a crash before posting: the turn runs again and posts once', async () => {
    const before = model.bodies.length;
    await room.fake.say('p_arjun', '@Go [t:crash-before] is the villa pet friendly?');
    const reply = await waitWrite(room.fake, (w) => w.method === 'post_message' && w.params.text === 'ok [t:crash-before]');
    expect(appliedCount(room.fake, reply.request_id)).toBe(1);
    expect(askedAbout(before, '[t:crash-before]')).toHaveLength(2);
    await sleep(500);
    expect(postsWith(room.fake, '[t:crash-before]')).toHaveLength(1);
  });

  it('a crash right after posting: the rerun neither posts again nor asks the model again', async () => {
    const before = model.bodies.length;
    const m = await room.fake.say('p_priya', '@Go [t:crash-after] what time is check-in?');
    crashAfterPosting = m.message_id;
    const reply = await waitWrite(room.fake, (w) => w.method === 'post_message' && w.params.text === 'ok [t:crash-after]');
    await sleep(800);
    expect(crashed).toBe(true);
    expect(postsWith(room.fake, '[t:crash-after]')).toHaveLength(1);
    expect(appliedCount(room.fake, reply.request_id)).toBe(1);
    expect(askedAbout(before, '[t:crash-after]')).toHaveLength(1);
  });

  it('the Server reconnects while Go is thinking: the answer goes out once, on the new socket', async () => {
    const sentAt = Date.now();
    await room.fake.say('p_kabir', '@Go [t:slow] can we check in at 10?');
    await waitTyping(room.fake, true, sentAt);
    // The Server drops its socket and dials again 1.1 s later: a new second makes a new upgrade signature
    // (Go accepts each signature once). The model answers 2.5 s after the turn began, so the post meets the new socket.
    await room.fake.reconnect({ downMs: 1_100 });
    expect(room.fake.isOpen()).toBe(true);
    const reply = await waitWrite(room.fake, (w) => w.method === 'post_message' && w.params.text === 'ok [t:slow]', 15_000);
    expect(appliedCount(room.fake, reply.request_id)).toBe(1);
    await sleep(500);
    expect(postsWith(room.fake, '[t:slow]')).toHaveLength(1);
  });
});
