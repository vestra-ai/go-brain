import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import type { DeskItem } from '../../desk/desk.js';
import { silentLog } from '../../log.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext } from '../context.js';
import { dataBlock } from '../fence.js';
import { GO_RULES } from '../rules.js';
import { askNote, quietNote, renderMessageWake, renderSetupWake, renderTripChangeWake } from '../wakes.js';

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
