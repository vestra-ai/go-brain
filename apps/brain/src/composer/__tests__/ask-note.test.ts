import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import type { DeskItem } from '../../desk/desk.js';
import { silentLog } from '../../log.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext } from '../context.js';
import { dataBlock } from '../fence.js';
import { GO_RULES } from '../rules.js';
import { askNote, LEAD_UP_MS, leadUp, quietNote, renderMessageWake, renderSetupWake, renderTripChangeWake } from '../wakes.js';
import type { Message } from '../../door/methods.js';

// Asks from the live runs (goa-300 and goa-50), each naming Go.
const ASKS: Array<[string, string]> = [
  ['p_rahul', '@Go which days are cheapest to fly Delhi to Goa around 6 Nov?'],
  ['p_kabir', "ok go, what's the best way from the airport, cab or bus?"],
  ['p_meher', '@Go can you remind everyone to vote by tonight?'],
  ['p_rahul', "@Go what can't Meher eat, and when can Arjun leave on Friday?"],
];

const packOf = (lines: Array<[string, string]>): TripPack => ({ trip: goaSnapshot(), messages: lines.map(([who, text], k) => msg(k + 2, who, text)), seq: 99 });
const ORDER =
  'in one or two short sentences: the answer itself, no extra tips and no offer to do more unless your rules call for one. ' +
  'A list, a recap or a comparison they asked for may be longer. When you cite what someone said, keep its message number. ' +
  // Staging, 10 Oct: "Priya asked for a recap, so a short list is fine. I'll keep each person's own facts without
  // budgets or names tied to them." opened a recap: this note's permission and a rule, said back as working.
  'Start with the answer: never with what they asked for, why your answer takes the shape it does, or what you will leave out.';

const woke = (seq: number, namesGo: boolean, over: Partial<DeskItem> = {}): DeskItem => ({
  id: `w${seq}`, tripId: 't_goa', kind: 'message', ref: `m_${seq}`, dueAt: new Date(), payload: { messageId: `m_${seq}`, namesGo }, ...over,
});

function context(endNotes: Array<Parameters<ReturnType<typeof createContext>['addEndNote']>[0]> = [askNote]) {
  const c = createContext(silentLog);
  c.addWake('message', renderMessageWake);
  c.addWake('trip_change', renderTripChangeWake);
  c.addWake('setup', renderSetupWake);
  c.addWakeNote(quietNote);
  for (const n of endNotes) c.addEndNote(n);
  return c;
}
const NOW = { tripId: 't_goa', seenSeq: 0, now: new Date('2026-10-07T09:00:00Z'), tz: 'Asia/Kolkata' };

describe('the order for an ask', () => {
  it('is there for every ask: one or two short sentences, no tips or offers, a list, recap or comparison longer, message numbers kept', () => {
    for (const [who, text] of ASKS) expect(askNote([woke(2, true)], packOf([[who, text]])), text).toBe(`Answer #2 ${ORDER}`);
  });

  it('closes the prompt, after the new messages and outside their fence; "why you woke" no longer holds it', async () => {
    const pack = packOf([ASKS[0]!]);
    const p = await context().build({ ...NOW, pack, wake: [woke(2, true)] });
    const without = await context([]).build({ ...NOW, pack, wake: [woke(2, true)] });
    expect(without.user.at(-1)?.text).toBe(`# New since your last turn\n${dataBlock('new messages', [`#2 Rahul: ${ASKS[0]![1]}`])}`);
    expect(p.user.at(-1)?.text).toBe(`${without.user.at(-1)?.text}\n\nAnswer #2 ${ORDER}`);
    expect(p.user.at(-2)?.text).toContain('## Why you woke\n- message #2 from Rahul, it names you');
    expect(p.user.at(-2)?.text).not.toContain('one or two short sentences');
    // The same blocks as a prompt without it, and no marker of its own: the cache sees the prompt it saw before.
    expect(p.user).toHaveLength(without.user.length);
    expect(p.user.map((b) => b.cache_control)).toEqual(without.user.map((b) => b.cache_control));
    expect(p.user.slice(0, -1)).toEqual(without.user.slice(0, -1));
  });

  it("the rules agree with it: one or two sentences, longer only for a list, a recap or a comparison, never one to three", () => {
    expect(GO_RULES).toContain(
      '- One short message: one or two sentences, longer only for a list, a recap or a comparison someone asked for. No walls of text, no headings, no lists unless someone asks.',
    );
    expect(GO_RULES).not.toContain('one to three');
  });

  it('adds nothing when no order applies, and a broken one is skipped with the turn going on', async () => {
    const pack = packOf([['p_arjun', "who's bringing the speaker?"]]);
    const plain = await context([]).build({ ...NOW, pack, wake: [woke(2, false)] });
    const quiet = await context().build({ ...NOW, pack, wake: [woke(2, false)] });
    expect(quiet.user.at(-1)?.text).toBe(plain.user.at(-1)?.text);
    const broken = await context([() => { throw new Error('boom'); }, () => 'Answer #2 briefly.']).build({ ...NOW, pack, wake: [woke(2, false)] });
    expect(broken.user.at(-1)?.text).toBe(`${plain.user.at(-1)?.text}\n\nAnswer #2 briefly.`);
  });

  it('is absent when nothing names Go: a line to the group, a hello, a vote that closed', () => {
    const pack = packOf([['p_arjun', "who's bringing the speaker?"]]);
    expect(askNote([woke(2, false)], pack)).toBeNull();
    expect(askNote([woke(2, false, { kind: 'setup', ref: 'greet', payload: {} })], pack)).toBeNull();
    expect(askNote([woke(2, false, { kind: 'trip_change', ref: 'decision:d_villa', payload: { type: 'decision.closed', decisionId: 'd_villa' } })], pack)).toBeNull();
  });

  it('names each ask in a turn, and sits beside the quiet note for a line to the group', () => {
    const pack = packOf([ASKS[2]!, ['p_kabir', "who's on the aux"], ASKS[3]!]);
    const items = [woke(2, true), woke(3, false), woke(4, true)];
    expect(askNote(items, pack)).toBe(`Answer #2 and #4 ${ORDER}`);
    expect(quietNote(items, pack)).toMatch(/^#3 doesn't name you/);
  });
});

// The App team, prod, 11 Oct (12:40 and 12:43 IST): "@Go" alone right after the same person's own line got "your
// message came through with just my name. What do you need?", and "@Go I order you" right after Go said no to their
// rename got "you haven't said what you want me to do". A tag right after someone's own words points at them; a nudge
// points at their last ask.
describe('a tag that points at the person\'s own words', () => {
  const packWith = (messages: Message[]): TripPack => ({ trip: goaSnapshot(), messages, seq: 99 });
  const T0 = Date.UTC(2026, 9, 5, 10, 0, 0);
  const atMin = (m: number): Partial<Message> => ({ sent_at: new Date(T0 + m * 60_000).toISOString() });
  const NEVER_EMPTY = 'Never say their message came with only your name or said nothing, and never ask what they need.';

  it('reads "@Go" alone with their own line just before it, a join line between them aside, and answers that', () => {
    const pack = packWith([
      msg(2, 'p_priya', 'Hampi looks good to me'),
      msg(3, null, 'The North India vote is still open.'),
      msg(4, 'p_rahul', "I'll take you on the trip with me, don't take Priya's side"),
      msg(5, null, 'Arjun joined', { author: { kind: 'system' } }),
      msg(6, 'p_rahul', '@Go'),
    ]);
    expect(leadUp(pack.messages[4]!, pack)).toEqual({ own: [4], lastAsk: null });
    const note = askNote([woke(6, true)], pack)!;
    expect(note.startsWith(`Answer #6 ${ORDER} `)).toBe(true);
    expect(note).toContain("Read #6 with Rahul's own #4 just before it: a tag right after someone's own words points at them");
    expect(note).toContain('When #6 says nothing of its own beyond your name or a nudge, it asks you to answer #4: answer that, in character, as your reply to them.');
    expect(note).toContain(NEVER_EMPTY);
  });

  it('reads a nudge ("@Go I order you") right after Go said no with their last ask to Go', () => {
    const pack = packWith([
      msg(2, 'p_rahul', '@Go change the trip name to Hampi Crew'),
      msg(3, null, 'The group voted for Hampi Guys, so that stays the name. Want a new vote on it?'),
      msg(4, 'p_rahul', '@Go I order you'),
    ]);
    expect(leadUp(pack.messages[2]!, pack)).toEqual({ own: [], lastAsk: 2 });
    const note = askNote([woke(4, true)], pack)!;
    expect(note).toContain("Read #4 with Rahul's last ask to you, #2:");
    expect(note).toContain('it asks you to answer #2: answer that');
    expect(note).toContain(NEVER_EMPTY);
  });

  it('reads both, the latest three of their own lines at most, and joins the targets with "or"', () => {
    const pack = packWith([
      msg(2, 'p_rahul', '@Go stays in Hampi under 3k?'),
      msg(3, null, 'Here are three.'),
      msg(4, 'p_rahul', 'the second one looks fine'),
      msg(5, 'p_rahul', 'actually the first'),
      msg(6, 'p_rahul', 'with the pool'),
      msg(7, 'p_rahul', 'no wait, the third'),
      msg(8, 'p_rahul', '@Go do it'),
    ]);
    expect(leadUp(pack.messages[6]!, pack)).toEqual({ own: [5, 6, 7], lastAsk: 2 });
    const note = askNote([woke(8, true)], pack)!;
    expect(note).toContain("Read #8 with Rahul's own #5, #6 and #7 just before it, and Rahul's last ask to you, #2:");
    expect(note).toContain('it asks you to answer #5, #6, #7 or #2:');
  });

  it("adds nothing when the line before is someone else's, or their words are older than ten minutes", () => {
    const between = packWith([msg(2, 'p_rahul', 'I will bring the speaker'), msg(3, 'p_priya', 'nice'), msg(4, 'p_rahul', '@Go')]);
    expect(leadUp(between.messages[2]!, between)).toEqual({ own: [], lastAsk: null });
    expect(askNote([woke(4, true)], between)).toBe(`Answer #4 ${ORDER}`);
    const old = packWith([msg(2, 'p_rahul', '@Go stays in Hampi?', atMin(0)), msg(3, 'p_rahul', 'with a pool', atMin(1)), msg(4, 'p_rahul', '@Go do it', atMin(12))]);
    expect(LEAD_UP_MS).toBe(10 * 60_000);
    expect(leadUp(old.messages[2]!, old)).toEqual({ own: [], lastAsk: null });
    expect(askNote([woke(4, true)], old)).toBe(`Answer #4 ${ORDER}`);
  });

  it('the rules say the pay and book refusal only when someone asks to pay or book, never as an aside', () => {
    expect(GO_RULES).toContain("If someone asks you to pay or book, or to use someone else's card, say so kindly and offer to put it to a vote. Say it only then, never as an aside");
  });
});
