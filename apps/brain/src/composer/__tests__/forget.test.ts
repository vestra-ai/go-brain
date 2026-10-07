import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { silentLog } from '../../log.js';
import * as memoryFence from '../../memory/fence.js';
import { notesView } from '../../memory/fence.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext, forgottenNote } from '../context.js';
import { chatLine, HIDDEN, isForgotten, roomView, type Forgotten } from '../fence.js';
import { renderMessageWake } from '../wakes.js';

// The drill on staging (trip t_p1b_2c72baaa): Kabir's forget went through (4 facts deleted, 0 left), and the next three
// answers were "Kabir said he'd book the cab from Mopa airport for everyone.", "Yes, Kabir is allergic to peanuts.", and
// "Earlier I said Kabir doesn't drink, but … he can do it himself with "Forget me in this trip"". The composer's chat
// showed every line; only the side passes hid his.
const BEFORE = [
  msg(2, 'p_kabir', "I'll book the cab from Mopa airport for all of us, leave that to me"),
  msg(3, 'p_meher', 'btw my birthday is on the 7th, just saying 🎂'),
  msg(4, 'p_kabir', "also I'm allergic to peanuts, keep that in mind when we eat out"),
  msg(5, 'p_rahul', "@Go who doesn't drink?"),
  msg(6, null, "Kabir doesn't drink. Nobody else has said anything about it."),
  msg(7, 'p_kabir', '@Go please forget everything you know about me'),
];
const ASKS = [
  msg(8, 'p_rahul', "@Go who said they'd book the cab?"),
  msg(9, 'p_meher', '@Go is anyone allergic to anything?'),
  msg(10, 'p_rahul', "@Go who doesn't drink?"),
];
const KABIR_SAID = ['Mopa airport for all of us', 'allergic to peanuts', 'forget everything you know about me'];
const FORGOT: Forgotten = new Map([['p_kabir', 7]]);

const packOf = (messages = [...BEFORE, ...ASKS]): TripPack => ({ trip: goaSnapshot(), messages, seq: messages.at(-1)!.seq });
function context(forgotten: Forgotten | null = FORGOT) {
  const c = createContext(silentLog);
  c.addWake('message', renderMessageWake);
  if (forgotten) c.setForgotten({ get: async () => forgotten });
  return c;
}
const build = (pack: TripPack, ask: (typeof ASKS)[number], seenSeq: number, forgotten?: Forgotten | null) =>
  context(forgotten).build({
    tripId: 't_goa', pack, seenSeq, now: new Date('2026-10-07T13:00:00Z'), tz: 'Asia/Kolkata',
    wake: [{ id: `w${ask.seq}`, tripId: 't_goa', kind: 'message', ref: ask.message_id, dueAt: new Date(), payload: { messageId: ask.message_id, namesGo: true } }],
  });
const userText = (p: { user: Array<{ text: string }> }): string => p.user.map((b) => b.text).join('\n');

describe('Forget me in the composer', () => {
  it("hides a forgotten person's earlier lines in the chat, and only theirs: the room, Go's lines and their later words stay", async () => {
    const later = msg(11, 'p_kabir', "I'm landing at 9 pm btw");
    const p = await build(packOf([...BEFORE, ...ASKS, later]), ASKS[0]!, 7);
    const text = userText(p);
    for (const seq of [2, 4, 7]) expect(text).toContain(`#${seq} ${HIDDEN}`);
    for (const said of KABIR_SAID) expect(text).not.toContain(said);
    expect(text).toContain('#3 Meher: btw my birthday is on the 7th');
    expect(text).toContain("#6 Go (you): Kabir doesn't drink.");
    // What he says after the forget is new: Forget me does not stop Go from learning (the guide, 05-your-requests).
    expect(text).toContain("#11 Kabir: I'm landing at 9 pm btw");
    expect(p.forgotten).toBe(FORGOT);
  });

  it('names the forgotten person under "right now": the forget is done, and nothing about them from earlier, Go\'s own lines included', async () => {
    const p = await build(packOf(), ASKS[2]!, 9);
    const now = p.user.at(-2)!.text;
    expect(now).toContain(
      '## asked Go to forget\nKabir used "Forget me in this trip" in the App, so Go forgot what it knew about them, and their earlier messages are hidden. ' +
        'Never repeat anything about Kabir from earlier in the chat, your own messages included. ' +
        'If someone asks, say only that they asked you to forget what you knew about them, without naming any of it.',
    );
    // Before "why you woke", after the cache point: the chat blocks and the rules are as they were.
    expect(now.indexOf('## asked Go to forget')).toBeLessThan(now.indexOf('## Why you woke'));
    expect(p.user.slice(0, -2).every((b) => !b.text.includes('asked Go to forget'))).toBe(true);
  });

  it('says nothing about forgetting in a trip where nobody was forgotten, and shows every line', async () => {
    for (const forgotten of [null, new Map()]) {
      const p = await build(packOf(), ASKS[0]!, 7, forgotten);
      const text = userText(p);
      expect(text).not.toContain('asked Go to forget');
      expect(text).not.toContain(HIDDEN);
      expect(text).toContain("#4 Kabir: also I'm allergic to peanuts");
    }
    expect(forgottenNote(packOf(), new Map())).toBeNull();
  });

  it("carries nothing Kabir said before his forget into the drill's three asks: the cab, the allergy and the drink", async () => {
    for (const [k, ask] of ASKS.entries()) {
      const p = await build(packOf([...BEFORE, ...ASKS.slice(0, k + 1)]), ask, ask.seq - 1);
      const text = userText(p);
      for (const said of KABIR_SAID) expect(text, ask.text!).not.toContain(said);
      expect(text, ask.text!).toContain('Never repeat anything about Kabir from earlier in the chat, your own messages included.');
    }
  });
});

describe('one chat-line renderer for every prompt', () => {
  const pack = packOf();
  const room = roomView(pack, FORGOT);
  const notes = notesView(pack, FORGOT);

  it("draws a forgotten person's earlier line the same in the composer's chat and the side passes', from the one function", () => {
    for (const m of BEFORE.filter((x) => isForgotten(x, FORGOT))) {
      expect(chatLine(m, room)).toBe(`#${m.seq} ${HIDDEN}`);
      expect(chatLine(m, notes)).toBe(chatLine(m, room));
    }
    // Memory has no renderer or forgotten test of its own any more: it draws through the composer's chatLine.
    expect(Object.keys(memoryFence)).not.toContain('chatLine');
    expect(Object.keys(memoryFence)).not.toContain('isForgotten');
  });

  it('keeps each prompt\'s own labels for a visible line', () => {
    const meher = BEFORE[1]!;
    expect(chatLine(meher, room)).toBe('#3 Meher: btw my birthday is on the 7th, just saying 🎂');
    expect(chatLine(meher, notes)).toBe('#3 [person Meher | p_meher]: btw my birthday is on the 7th, just saying 🎂');
    expect(chatLine(BEFORE[4]!, room)).toBe("#6 Go (you): Kabir doesn't drink. Nobody else has said anything about it.");
    expect(chatLine(BEFORE[4]!, notes)).toBe("#6 [Go]: Kabir doesn't drink. Nobody else has said anything about it.");
     // #174's mark for a line that is part of an ask to Go rides the same view; a forgotten line stays hidden.
    const toGo = notesView(pack, FORGOT, (m) => m.seq === 5);
    expect(chatLine(BEFORE[3]!, toGo)).toBe("#5 [person Rahul | p_rahul | to Go]: @Go who doesn't drink?");
    expect(chatLine(BEFORE[1]!, toGo)).toBe('#3 [person Meher | p_meher]: btw my birthday is on the 7th, just saying 🎂');
    expect(chatLine(BEFORE[0]!, notesView(pack, FORGOT, () => true))).toBe(`#2 ${HIDDEN}`);
  });

  it("leaves a message the composer never shows out, a forgotten person's or not", () => {
    const gone = msg(4, 'p_kabir', 'deleted', { deleted: true });
    expect(chatLine(gone, room)).toBeNull();
    expect(chatLine(gone, roomView(pack, new Map()))).toBeNull();
  });

  it('forgets a person only up to their forget, and never Go or anyone else', () => {
    expect(isForgotten(msg(7, 'p_kabir', 'x'), FORGOT)).toBe(true);
    expect(isForgotten(msg(8, 'p_kabir', 'x'), FORGOT)).toBe(false);
    expect(isForgotten(msg(3, 'p_meher', 'x'), FORGOT)).toBe(false);
    expect(isForgotten(msg(6, null, 'Kabir is p_kabir'), FORGOT)).toBe(false);
  });
});
