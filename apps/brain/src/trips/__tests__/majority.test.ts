import { describe, expect, it } from 'vitest';
import type * as C from '@go/contract';
import { createMajorityClose, majorityOf } from '../majority.js';
import { chatAgreed, saveTrip } from '../save-trip.js';

describe('a vote decided by more than half of the trip', () => {
  it('needs more than half of the trip\'s people on one option: 2 of 2, 2 of 3, 3 of 4, 3 of 5', () => {
    expect(majorityOf([2, 0], 2)).toBe(0);
    expect(majorityOf([0, 2, 0], 3)).toBe(1);
    expect(majorityOf([3, 1], 4)).toBe(0);
    expect(majorityOf([1, 3], 5)).toBe(1);
    expect(majorityOf([1, 0], 3)).toBeNull();
    expect(majorityOf([2, 2], 4)).toBeNull();
    expect(majorityOf([1, 1], 3)).toBeNull();
    // A trip of one is never a majority here: its card closes on its own one tap.
    expect(majorityOf([1], 1)).toBeNull();
  });
});

describe("Go closes a vote it opened once one option has the trip's majority", () => {
  const person = (id: string) => ({ person_id: id });
  const dates = (o: Partial<C.Decision> = {}): C.Decision =>
    ({
      decision_id: 'd_dates', question: 'Which dates work?', kind: 'choice', anonymous: false, status: 'open', opened_by_person_id: null,
      options: [{ label: '1 to 5 Nov' }, { label: '8 to 12 Nov' }, { label: 'Other dates' }], voted: 0, of: 3, tally: [0, 0, 0], ...o,
    }) as C.Decision;
  const voted = (tally: number[], tripId = 't_munnar'): C.Event =>
    ({ event_id: 'ev_1', type: 'decision.voted', trip_id: tripId, data: { decision_id: 'd_dates', voted: tally.reduce((a, b) => a + b, 0), of: 3, tally } }) as unknown as C.Event;
  const world = (people: string[], decision: C.Decision, fail = false) => {
    const closes: Array<Record<string, unknown>> = [];
    const said: string[] = [];
    const m = createMajorityClose({
      link: { request: (async (method: string, params: Record<string, unknown>) => {
        if (method !== 'close_vote') throw new Error(`unexpected ${method}`);
        closes.push(params);
        if (fail) throw new Error('409 not open');
        return {};
      }) as never },
      packs: { get: async () => ({ trip: { people: people.map(person), decisions: [decision] } }) as never },
      log: { info: (_o, msg) => void said.push(msg), warn: (_o, msg) => void said.push(msg) },
    });
    return { m, closes, said };
  };

  it("2 of a trip's 3 on one option: Go closes the vote at once, once, so its wake saves the dates", async () => {
    const w = world(['p_saket', 'p_rahul', 'p_ankur'], dates({ voted: 2, tally: [2, 0, 0] }));
    await w.m.onEvent(voted([2, 0, 0]));
    expect(w.closes).toEqual([{ request_id: expect.stringMatching(/^go_close_majority/), trip_id: 't_munnar', decision_id: 'd_dates' }]);
    // The same vote again (a retried event): the same request id, so the Server answers it once.
    await w.m.onEvent(voted([2, 0, 0]));
    expect(w.closes[1]!.request_id).toBe(w.closes[0]!.request_id);
  });

  it('1 of 3, or 2 options at 1 each: nothing yet', async () => {
    const one = world(['p_saket', 'p_rahul', 'p_ankur'], dates({ voted: 1, tally: [1, 0, 0] }));
    await one.m.onEvent(voted([1, 0, 0]));
    await one.m.onEvent(voted([1, 1, 0]));
    expect(one.closes).toEqual([]);
  });

  it("a trip of one, a person's own poll, a vote already closed and other events are left alone", async () => {
    const alone = world(['p_saket'], dates({ voted: 1, of: 1, tally: [1, 0, 0] }));
    await alone.m.onEvent(voted([1, 0, 0]));
    expect(alone.closes).toEqual([]);
    const theirs = world(['p_saket', 'p_rahul'], dates({ opened_by_person_id: 'p_saket', tally: [2, 0, 0] }));
    await theirs.m.onEvent(voted([2, 0, 0]));
    expect(theirs.closes).toEqual([]);
    const done = world(['p_saket', 'p_rahul'], dates({ status: 'closed', tally: [2, 0, 0] }));
    await done.m.onEvent(voted([2, 0, 0]));
    expect(done.closes).toEqual([]);
    const other = world(['p_saket', 'p_rahul'], dates());
    await other.m.onEvent({ event_id: 'ev_2', type: 'decision.opened', trip_id: 't_munnar', data: {} } as unknown as C.Event);
    expect(other.closes).toEqual([]);
  });

  it('a close the Server refuses (closed at the same moment) is logged, never thrown', async () => {
    const w = world(['p_saket', 'p_rahul'], dates({ tally: [2, 0, 0] }), true);
    await expect(w.m.onEvent(voted([2, 0, 0]))).resolves.toBeUndefined();
    expect(w.said.at(-1)).toContain('did not go through');
  });
});

describe('the group agreeing in the chat, with no vote open', () => {
  const people = ['p_aryan', 'p_saket', 'p_rahul'];
  const msg = (seq: number, author: string | null, reactions: Array<[string, string | null]> = []) =>
    ({
      message_id: `m_${seq}`, seq, updated_seq: seq, author: author ? { kind: 'person', person_id: author } : { kind: 'go' }, text: 'x', attachments: [],
      mentions_go: false, mentions: [], reactions: reactions.map(([emoji, person_id]) => ({ emoji, person_id })),
    }) as unknown as C.Message;
  const pack = (messages: C.Message[], who = people) => ({ trip: { people: who.map((id) => ({ person_id: id })), decisions: [] }, messages, seq: 9 }) as never;

  it("saves once more than half of the trip agreed: the proposer and a reply, or reactions on the proposal (Aryan's 4 ✅)", () => {
    expect(chatAgreed(pack([msg(18, 'p_aryan'), msg(19, 'p_saket')]), ['#18', '19'])).toBe(true);
    expect(chatAgreed(pack([msg(18, 'p_aryan', [['✅', 'p_rahul']])]), ['#18'])).toBe(true);
    const five = ['p_aryan', 'p_saket', 'p_rahul', 'p_ankur', 'p_kabir'];
    expect(chatAgreed(pack([msg(18, 'p_aryan', [['✅', 'p_saket'], ['✅', 'p_rahul'], ['👍🏽', 'p_ankur']])], five), ['18'])).toBe(true);
  });

  it("1 of 3 is not agreement: no save, and Go opens the vote; Go's own reactions, other emoji and unknown messages count for nothing", () => {
    expect(chatAgreed(pack([msg(18, 'p_aryan')]), ['18'])).toBe(false);
    expect(chatAgreed(pack([msg(18, 'p_aryan', [['✅', null], ['😂', 'p_saket']])]), ['18'])).toBe(false);
    expect(chatAgreed(pack([msg(18, 'p_aryan'), msg(20, null)]), ['18', '20', '#99'])).toBe(false);
    expect(chatAgreed(pack([]), undefined)).toBe(false);
  });

  it('a group change with only one person agreeing is refused as not decided, before anything is written', async () => {
    const r = await saveTrip(
      { pool: {} as never, now: () => new Date('2026-10-12T00:00:00Z') },
      { link: { request: async () => { throw new Error('nothing is written'); } }, tripId: 't_x', pack: pack([msg(18, 'p_aryan')]), requestId: () => 'r' },
      { dates: { start: '2026-11-01', end: '2026-11-04' }, agreedMessages: ['18'] },
    );
    expect(r).toMatchObject({ ok: false, notDecided: true });
  });
});
