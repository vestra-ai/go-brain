import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import type { DeskItem } from '../../desk/desk.js';
import { silentLog } from '../../log.js';
import type { TripPack } from '../../trips/pack.js';
import { createContext } from '../context.js';
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
const woke = (seq: number, namesGo: boolean, over: Partial<DeskItem> = {}): DeskItem => ({
  id: `w${seq}`, tripId: 't_goa', kind: 'message', ref: `m_${seq}`, dueAt: new Date(), payload: { messageId: `m_${seq}`, namesGo }, ...over,
});

function context() {
  const c = createContext(silentLog);
  c.addWake('message', renderMessageWake);
  c.addWake('trip_change', renderTripChangeWake);
  c.addWake('setup', renderSetupWake);
  c.addWakeNote(quietNote);
  c.addWakeNote(askNote);
  return c;
}

describe('the length note for an ask', () => {
  it('is there for every ask: one or two short sentences, unless a list, recap or comparison, and message numbers kept', () => {
    for (const [who, text] of ASKS) {
      expect(askNote([woke(2, true)], packOf([[who, text]])), text).toBe(
        '#2 asks you: answer in one or two short sentences, unless they asked for a list, a recap or a comparison. ' +
          'When you cite what someone said, keep its message number.',
      );
    }
  });

  it('rides under "why you woke", after the cache point, with the rules unchanged', async () => {
    const pack = packOf([ASKS[0]!]);
    const p = await context().build({ tripId: 't_goa', pack, wake: [woke(2, true)], seenSeq: 0, now: new Date('2026-10-07T09:00:00Z'), tz: 'Asia/Kolkata' });
    const now = p.user.at(-2);
    expect(now?.text).toContain("## Why you woke\n- message #2 from Rahul, it names you\n- #2 asks you: answer in one or two short sentences");
    expect(now?.cache_control).toBeUndefined();
    expect(p.system[0]?.text).toBe(GO_RULES);
    expect(GO_RULES).not.toContain('one or two short sentences');
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
    expect(askNote(items, pack)).toMatch(/^#2 and #4 ask you: answer in one or two short sentences/);
    expect(quietNote(items, pack)).toMatch(/^#3 doesn't name you/);
  });
});
