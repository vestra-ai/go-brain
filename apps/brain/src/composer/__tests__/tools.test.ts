import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeLink, type FakeAnswers } from '../../__tests__/fixtures/fake-link.js';
import { goaSnapshot, msg, vote } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import { SocketCallError } from '../../door/rpc.js';
import { reactionRequestId, reactOnce } from '../../memory/reactions.js';
import { TravelError } from '../../travel/mcp-travel.js';
import type { Travel } from '../../travel/travel.js';
import { NOT_DECIDED } from '../../trips/save-trip.js';
import { nextDates, roomTools } from '../room-tools.js';
import { createTools, makeTurnCtx, SAY_NOTHING, type QuickTool } from '../tools.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

const pack = () => ({
  trip: goaSnapshot(),
  messages: [
    // The organizer's word: what a title, place or dates change cites (save-trip.ts groupDecided).
    msg(55, 'p_rahul', "let's lock it in"),
    msg(56, 'p_priya', "I'm veg btw"),
    msg(57, 'p_arjun', 'can someone book?'),
    msg(58, 'p_meher', 'Kabir is allergic to nuts'),
    msg(59, 'p_kabir', 'I land at 6', { reactions: [{ emoji: '✅', person_id: null }] }),
  ],
  seq: 59,
});
function ctxWith(answers: FakeAnswers = {}, turnId = 'turn_T') {
  const f = fakeLink(answers);
  const ctx = makeTurnCtx({ tripId: 't_goa', turnId, link: f.link, pack: pack(), wake: [], signal: new AbortController().signal });
  return { ctx, ...f };
}
/** The organizer's message in pack(), cited for a title, place or dates change. */
const ORG = ['m_55'];
const tool = (name: string) => {
  const t = roomTools({ now: () => new Date('2026-10-06T09:00:00Z'), pool: db.pool }).find((x) => x.name === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
};

describe('the room\'s tools', () => {
  it('react finds "#56" and reacts with the request id of that message and emoji, tagged with the turn', async () => {
    const { ctx, calls } = ctxWith({ add_reaction: () => ({ seq: 60 }) });
    expect(await tool('react').run({ message_id: '#56', emoji: '✅' }, ctx)).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      method: 'add_reaction',
      params: { request_id: reactionRequestId('t_goa', 'm_56', '✅'), trip_id: 't_goa', message_id: 'm_56', emoji: '✅' },
      turnId: 'turn_T',
    });
    expect(ctx.outcome.reactions).toBe(1);
    // A later turn asking for the same reaction sends nothing: Go's own record says it holds it.
    const later = ctxWith({ add_reaction: () => ({ seq: 61 }) }, 'turn_later');
    expect(await tool('react').run({ message_id: '#56', emoji: '✅' }, later.ctx)).toMatchObject({ ok: true, note: expect.any(String) });
    expect(later.calls).toHaveLength(0);
    expect(later.ctx.outcome.reactions).toBe(0);
  });

  it("react after the reflex's quiet ✅ on the same message is a no-op success, never a second call", async () => {
    const { link, ctx, calls } = ctxWith({ add_reaction: () => ({ seq: 62 }) });
    const m = ctx.pack.messages.find((x) => x.message_id === 'm_58')!;
    // The reflex reacts first, outside the turn; the composer's react follows seconds later.
    expect(await reactOnce(db.pool, link, 't_goa', m, '✅')).toBe('sent');
    expect(await tool('react').run({ message_id: '#58', emoji: '✅' }, ctx)).toMatchObject({ ok: true, note: expect.any(String) });
    expect(calls.filter((c) => c.method === 'add_reaction')).toHaveLength(1);
    expect(ctx.outcome.reactions).toBe(0);
    // Another emoji on that message is a new reaction.
    expect(await tool('react').run({ message_id: '#58', emoji: '👍' }, ctx)).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === 'add_reaction')).toHaveLength(2);
  });

  it('react while the reflex is still sending the same reaction waits for it and sends nothing more', async () => {
    const { link, ctx, calls } = ctxWith({ add_reaction: () => ({ seq: 63 }) });
    const m = ctx.pack.messages.find((x) => x.message_id === 'm_57')!;
    // Both start before either reaches the Server: the second joins the first's send.
    const reflex = reactOnce(db.pool, link, 't_goa', m, '✅');
    const composer = tool('react').run({ message_id: '#57', emoji: '✅' }, ctx);
    expect(await reflex).toBe('sent');
    expect(await composer).toMatchObject({ ok: true, note: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(ctx.outcome.reactions).toBe(0);
  });

  it('react on a message the pack shows Go already reacted to sends nothing', async () => {
    const { ctx, calls } = ctxWith({ add_reaction: () => ({ seq: 64 }) });
    expect(await tool('react').run({ message_id: '#59', emoji: '✅' }, ctx)).toMatchObject({ ok: true, note: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it('react: an unknown message goes back to the model, an earlier reaction is fine, and a failure says so', async () => {
    const { ctx } = ctxWith({ add_reaction: () => { throw new SocketCallError(409, 'already reacted', 'conflict'); } });
    expect(await tool('react').run({ message_id: '#99', emoji: '✅' }, ctx)).toMatchObject({ ok: false });
    expect(await tool('react').run({ message_id: 'm_57', emoji: '👍' }, ctx)).toMatchObject({ ok: true });
    expect(ctx.outcome.reactions).toBe(0);
    const down = ctxWith({ add_reaction: () => { throw new SocketCallError(503, 'not now', 'unavailable'); } });
    expect(await tool('react').run({ message_id: 'm_57', emoji: '🙌' }, down.ctx)).toMatchObject({ ok: false });
    expect(down.ctx.outcome.reactions).toBe(0);
  });

  it('open_vote opens the vote and puts its card on the turn\'s message', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_new', seq: 60 }) });
    const r = await tool('open_vote').run(
      { question: 'Where do we stay?', options: [{ label: 'Villa Sol', note: '3 nights, pool' }, { label: 'Casa Azul' }], line: 'Vote is up, tap your pick.' },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, decision_id: 'd_new' });
    expect(calls[0]?.params).toEqual({
      request_id: 'go_vote_turn_T_1', trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false,
      options: [{ label: 'Villa Sol', note: '3 nights, pool' }, { label: 'Casa Azul' }],
    });
    expect(ctx.cards).toEqual([{ kind: 'vote', card_id: 'c_vote_turn_T_1', fallback_text: 'Vote: Where do we stay?', decision_id: 'd_new' }]);
    // Its line is the words posted with the card; the Server never sees it.
    expect(ctx.lines).toEqual(['Vote is up, tap your pick.']);
  });

  it('open_vote asks for a secret ballot when the model sets anonymous, and an open one otherwise', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_secret', seq: 62 }) });
    const args = tool('open_vote').input.parse({ question: 'Who should cook on Saturday?', options: [{ label: 'Rahul' }, { label: 'Priya' }], anonymous: true, line: 'Secret vote is up.' });
    expect(await tool('open_vote').run(args, ctx)).toMatchObject({ ok: true, decision_id: 'd_secret' });
    expect(calls[0]?.params).toMatchObject({ question: 'Who should cook on Saturday?', anonymous: true });
    expect(tool('open_vote').description).toContain('secret or anonymous vote');
  });

  it('open_vote passes every option field through, so a vote made from search results carries the offer', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_villa', seq: 61 }) });
    const sol = {
      label: 'Villa Sol, Anjuna', image_url: 'https://img.example/villa-sol.jpg', price_minor: 5_420_000, currency: 'INR',
      option_ref: 'ixg_offer_81', note: '3 nights, pool',
    };
    const azul = {
      label: 'Casa Azul, Vagator', image_url: 'https://img.example/casa-azul.jpg', price_minor: 4_980_000, currency: 'INR',
      option_ref: 'ixg_offer_82', note: null,
    };
    // Parsed the way the loop parses the model's arguments: no field is dropped on the way in.
    const args = tool('open_vote').input.parse({ question: 'Which villa?', options: [sol, azul], line: 'Vote is up.' });
    expect(await tool('open_vote').run(args, ctx)).toMatchObject({ ok: true, decision_id: 'd_villa' });
    expect(calls[0]?.params.options).toEqual([
      sol,
      { label: 'Casa Azul, Vagator', image_url: 'https://img.example/casa-azul.jpg', price_minor: 4_980_000, currency: 'INR', option_ref: 'ixg_offer_82' },
    ]);
  });

  it('open_vote refuses a closing time in the past without asking the Server', async () => {
    const { ctx, calls } = ctxWith({ open_vote: () => ({ decision_id: 'd_new', seq: 60 }) });
    const r = await tool('open_vote').run({ question: 'When?', options: [{ label: 'Fri' }, { label: 'Sat' }], closes_at: '2026-10-06T08:00:00Z', line: 'Vote is up.' }, ctx);
    expect(r).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    expect(ctx.lines).toEqual([]);
  });

  it('close_vote says who won, fenced; a vote that is not open goes back to the model', async () => {
    const closed = vote({ decision_id: 'd_stay', status: 'closed', voted: 4, tally: [3, 1], result_index: 0, closed_at: '2026-10-06T09:00:00Z' });
    const { ctx } = ctxWith({ close_vote: (p) => {
      if (p.decision_id === 'd_old') throw new SocketCallError(409, 'vote not open', 'conflict');
      return { decision: closed, seq: 61 };
    } });
    expect(await tool('close_vote').run({ decision_id: 'd_stay' }, ctx)).toEqual({
      ok: true, winner: '<data>Villa Sol</data>', tally: ['<data>Villa Sol</data> 3', '<data>Casa Azul</data> 1'], voted: 4, of: 5,
    });
    expect(await tool('close_vote').run({ decision_id: 'd_old' }, ctx)).toEqual({ ok: false, error: 'That vote is not open.' });
  });

  it('update_trip sends only what changes, in the contract\'s shape', async () => {
    const { ctx, calls } = ctxWith({ update_trip: () => ({ seq: 62 }) });
    expect(await tool('update_trip').run({}, ctx)).toEqual({ ok: false, error: 'Nothing to change.' });
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-11-09', end: '2026-11-06' } }, ctx)).toMatchObject({ ok: false });
    // The trip is already North Goa: only the dates change.
    expect(await tool('update_trip').run({ proof_message_ids: ORG, destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx)).toEqual({
      ok: true, changed: ['dates'],
    });
    expect(calls[0]?.params).toEqual({ request_id: 'go_trip_turn_T_1', trip_id: 't_goa', dates: { start: '2026-11-06', end: '2026-11-09' } });
  });

  // p2's re-audit of Keshav's Varkala trip, 11 Oct: South Goa was set from one member's quick-reply tap while the group
  // was split three ways, and the dates twice from single members; Go then claimed two people had said South Goa.
  it("changes the title, place or dates only on the organizer's word, two people agreeing in words, or a closed vote", async () => {
    const dates = { start: '2026-12-01', end: '2026-12-07' };
    const withLines = (extra: ReturnType<typeof msg>[], decisions: ReturnType<typeof vote>[] = []) => {
      const f = fakeLink({ update_trip: () => ({ seq: 80 }) });
      const p = pack();
      p.messages.push(...extra);
      p.trip.decisions = decisions;
      return { ...f, ctx: makeTurnCtx({ tripId: 't_goa', turnId: 'turn_G', link: f.link, pack: p, wake: [], signal: new AbortController().signal }) };
    };
    // One member's word, a quick-reply tap too: refused in code, with a vote offered and nothing claimed.
    const one = withLines([msg(61, 'p_priya', 'South Goa')]);
    for (const a of [{ dates }, { dates, proof_message_ids: ['m_61'] }, { title: 'Wingardium Leviosa', proof_message_ids: ['m_61'] }]) {
      expect(await tool('update_trip').run(a, one.ctx)).toMatchObject({
        ok: false, error: NOT_DECIDED, tell_the_room: expect.stringContaining('offer to put it to a vote'),
      });
    }
    expect((await tool('update_trip').run({ dates }, one.ctx) as { tell_the_room: string }).tell_the_room).toContain('never say who said or picked what unless their own message says it');
    // A bare 👍 is no word: still one person.
    const thumbs = withLines([msg(61, 'p_priya', 'Dec 1 to 7'), msg(62, 'p_arjun', '👍')]);
    expect(await tool('update_trip').run({ dates, proof_message_ids: ['m_61', 'm_62'] }, thumbs.ctx)).toMatchObject({ ok: false, error: NOT_DECIDED });
    expect([...one.calls, ...thumbs.calls]).toEqual([]);
    // Two people in words, the organizer alone, or a closed vote: saved.
    const two = withLines([msg(61, 'p_priya', 'Dec 1 to 7'), msg(62, 'p_arjun', 'yes 1 to 7 Dec works')]);
    expect(await tool('update_trip').run({ dates, proof_message_ids: ['m_61', 'm_62'] }, two.ctx)).toEqual({ ok: true, changed: ['dates'] });
    const organizer = withLines([]);
    expect(await tool('update_trip').run({ dates, proof_message_ids: ORG }, organizer.ctx)).toEqual({ ok: true, changed: ['dates'] });
    const voted = withLines([], [vote({ decision_id: 'd_dates', status: 'closed', result_index: 0 })]);
    expect(await tool('update_trip').run({ dates, decision_id: 'd_dates' }, voted.ctx)).toEqual({ ok: true, changed: ['dates'] });
    // An open vote decides nothing yet.
    const open = withLines([], [vote({ decision_id: 'd_open' })]);
    expect(await tool('update_trip').run({ dates, decision_id: 'd_open' }, open.ctx)).toMatchObject({ ok: false, error: NOT_DECIDED });
    // The stay and the vibe keep their own checks, with no proof needed.
    expect(await tool('update_trip').run({ vibe: ['beach'] }, one.ctx)).toMatchObject({ ok: true });
  });

  // Prod, 11 Oct: "Goa" and "1 to 7 Dec" were saved, and their ✅ came off two seconds later because the reply ended on
  // a next-step question. A line whose plan point update_trip saved is noted, so its ✅ stays.
  it('update_trip marks the lines the turn woke for as noted when it changed the trip, and only then', async () => {
    const f = fakeLink({ update_trip: () => ({ seq: 62 }) });
    const wake = [{ id: 'd_1', tripId: 't_goa', kind: 'message' as const, ref: 'm_59', dueAt: new Date(), payload: { messageId: 'm_59' } }];
    const ctx = makeTurnCtx({ tripId: 't_goa', turnId: 'turn_T', link: f.link, pack: pack(), wake, signal: new AbortController().signal });
    expect(await tool('update_trip').run({ proof_message_ids: ORG, destination: 'North Goa' }, ctx)).toMatchObject({ ok: false });
    expect(ctx.outcome.noted ?? []).toEqual([]);
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx)).toEqual({ ok: true, changed: ['dates'] });
    expect(ctx.outcome.noted).toEqual(['m_59']);
  });

  describe('update_trip and a decided vote', () => {
    const sol = { kind: 'stay', title: 'Villa Sol', place: { name: 'Villa Sol', address: 'Anjuna, North Goa' }, area: 'Anjuna' };
    const casa = { kind: 'stay', title: 'Casa Mareia', place: { name: 'Casa Mareia', address: 'Vagator, North Goa' }, area: 'Vagator' };
    const north = { kind: 'place', title: 'North Goa', place: { name: 'North Goa', address: null }, area: null };
    const options: Record<string, unknown> = { opt_sol: sol, opt_casa: casa, opt_north: north, opt_south: { ...north, title: 'South Goa', place: { name: 'South Goa', address: null } } };
    // The places ixigo resolves (placeFor, p4's travel lane).
    const GOA = { name: 'Goa', place_id: 'ixigo_goa', lat: 15.3, lng: 74.1, photo_url: 'https://images.ixigo.com/goa.jpg' };
    const places: Record<string, unknown> = {
      goa: GOA,
      'north goa': { name: 'North Goa', place_id: 'ixigo_north_goa', lat: 15.6, lng: 73.8, photo_url: 'https://images.ixigo.com/north-goa.jpg' },
      kerala: { name: 'Kerala', place_id: 'ixigo_kerala', lat: 10.85, lng: 76.27, photo_url: 'https://images.ixigo.com/kerala.jpg' },
    };
    // ixigo's own type and second line for the places it knows as areas or cities (placeFor's kind and within).
    const sorts: Record<string, { kind: string; within: string[] }> = {
      candolim: { kind: 'area', within: ['Goa'] },
      'old manali': { kind: 'area', within: ['Manali', 'Himachal Pradesh'] },
      panaji: { kind: 'city', within: ['Goa'] },
      manali: { kind: 'city', within: ['Himachal Pradesh'] },
    };
    Object.assign(places, {
      candolim: { name: 'Candolim', place_id: 'ixigo:1101', lat: 15.52, lng: 73.76 },
      'old manali': { name: 'Old Manali', place_id: 'ixigo:2202', lat: 32.25, lng: 77.18 },
      panaji: { name: 'Panaji', place_id: 'ixigo:3303', lat: 15.49, lng: 73.83 },
      manali: { name: 'Manali', place_id: 'ixigo:2200', lat: 32.24, lng: 77.19 },
    });
    const travel = {
      placeOf: async (id: string) => options[id] ?? null,
      placeFor: async (words: string) => {
        if (words === 'Unreachable') throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
        const place = places[words.toLowerCase()];
        return place ? { place, ...(sorts[words.toLowerCase()] ?? { kind: 'state', within: [] }) } : null;
      },
    } as unknown as Travel;
    // Built in each test: the database is ready only once beforeAll has run.
    const updateTrip = { run: (a: unknown, ctx: Parameters<QuickTool['run']>[1]) => roomTools({ now: () => new Date('2026-10-06T09:00:00Z'), pool: db.pool, travel: () => travel }).find((x) => x.name === 'update_trip')!.run(a, ctx) };
    const closed = (id: string, refs: string[], won: number, at: string) =>
      vote({ decision_id: id, status: 'closed', result_index: won, closed_at: at, options: refs.map((r) => ({ label: r, option_ref: r })), tally: refs.map(() => 0) });
    const run = (decisions: ReturnType<typeof vote>[], destination: typeof GOA | null = null) => {
      const f = fakeLink({ update_trip: () => ({ seq: 70 }) });
      const p = pack();
      p.trip.decisions = decisions;
      if (destination) p.trip.destination = destination;
      return { ...f, ctx: makeTurnCtx({ tripId: 't_goa', turnId: 'turn_S', link: f.link, pack: p, wake: [], signal: new AbortController().signal }) };
    };

    it('saves the stay the vote picked from the option\'s own data, not the words it was given, and refuses a different stay', async () => {
      const { ctx, calls } = run([closed('d_stay', ['opt_sol', 'opt_casa'], 0, '2026-10-05T18:00:00Z')]);
      expect(await updateTrip.run({ stay: 'Villa Sol, Assagao' }, ctx)).toEqual({ ok: true, changed: ['stay'], stay: 'Villa Sol, Anjuna' });
      expect(calls[0]?.params).toMatchObject({ stay: 'Villa Sol, Anjuna' });
      expect(await updateTrip.run({ stay: 'Casa Mareia, Vagator' }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('Villa Sol in Anjuna'), tell_the_room: SAY_NOTHING });
      expect(calls).toHaveLength(1);
    });

    it('goes by the latest closed vote whose winner is a stay', async () => {
      const { ctx, calls } = run([closed('d_old', ['opt_sol', 'opt_casa'], 0, '2026-10-04T18:00:00Z'), closed('d_new', ['opt_sol', 'opt_casa'], 1, '2026-10-05T18:00:00Z')]);
      expect(await updateTrip.run({ stay: 'casa mareia' }, ctx)).toEqual({ ok: true, changed: ['stay'], stay: 'Casa Mareia, Vagator' });
      expect(calls).toHaveLength(1);
    });

    it('saves a place the vote picked as ixigo\'s full Place, refuses another, and changes nothing it cannot resolve', async () => {
      // North vs South as a real place vote stays allowed: saved as the Place ixigo resolves, never a bare name.
      const { ctx, calls } = run([closed('d_area', ['opt_north', 'opt_south'], 0, '2026-10-05T18:00:00Z')], GOA);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'north goa' }, ctx)).toEqual({ ok: true, changed: ['destination'] });
      expect(calls[0]?.params.destination).toEqual(places['north goa']);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'South Goa' }, ctx)).toMatchObject({ ok: false, tell_the_room: SAY_NOTHING });
      // With no resolved Place, nothing changes: the destination is never sent as {name} alone.
      const unresolved = run([closed('d_area', ['opt_north', 'opt_south'], 1, '2026-10-05T18:00:00Z')], GOA);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'south goa' }, unresolved.ctx)).toMatchObject({ ok: false, error: expect.stringContaining("can't look up South Goa"), tell_the_room: SAY_NOTHING });
      expect(unresolved.calls).toEqual([]);
    });

    it('staging 09:32: a vote on where to stay in Goa sets the stay to its winner and leaves Goa the destination, with its place_id', async () => {
      const stayVote = vote({
        decision_id: 'd_where', question: 'Where should we stay in Goa: Candolim or Anjuna?', status: 'closed', result_index: 0,
        closed_at: '2026-10-08T09:32:01Z', options: [{ label: 'Candolim' }, { label: 'Anjuna' }], tally: [3, 1],
      });
      const { ctx, calls } = run([stayVote], GOA);
      // What the composer sent on staging.
      const r = await updateTrip.run({ proof_message_ids: ORG, destination: 'Candolim, Goa', stay: 'Villa with a pool in Candolim' }, ctx);
      expect(r).toMatchObject({ ok: true, changed: ['stay'], stay: 'Candolim', note: expect.stringContaining("can't look up Candolim, Goa") });
      expect(calls.map((c) => c.params)).toEqual([{ request_id: expect.any(String), trip_id: 't_goa', stay: 'Candolim' }]);
      expect((ctx.pack.trip.destination as typeof GOA)).toEqual(GOA);
    });

    it("never saves a wish as the stay: the group agreed 'a villa with a pool', which is no pick until a vote or a booking", async () => {
      const { ctx, calls } = run([], GOA);
      expect(await updateTrip.run({ stay: 'Villa with a pool' }, ctx)).toMatchObject({
        ok: false, error: expect.stringContaining('no stay the group picked yet'), tell_the_room: SAY_NOTHING,
      });
      // Said with dates, the dates still save and the wish does not.
      expect(await updateTrip.run({ proof_message_ids: ORG, stay: 'Villa with a pool in Candolim', dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx))
        .toMatchObject({ ok: true, changed: ['dates'], note: expect.stringContaining('no stay the group picked yet') });
      expect(calls.map((c) => c.params.stay)).toEqual([undefined]);
    });

    it('sends a new destination as ixigo\'s full Place, never a bare name; one ixigo cannot find changes nothing', async () => {
      const { ctx, calls } = run([], GOA);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Kerala' }, ctx)).toEqual({ ok: true, changed: ['destination'] });
      expect(calls[0]?.params.destination).toEqual(places['kerala']);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Atlantis' }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("can't look up Atlantis"), tell_the_room: SAY_NOTHING });
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'goa' }, ctx)).toMatchObject({ ok: false, error: 'The trip already has that.' });
      expect(calls).toHaveLength(1);
    });

    it("refuses what ixigo calls an area, or puts inside the trip's destination, by its own data, never the words", async () => {
      const { ctx, calls } = run([], GOA);
      // "Candolim" has no "Goa" in it: ixigo's type and second line say it is an area of Goa.
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Candolim' }, ctx)).toMatchObject({
        ok: false, error: expect.stringContaining('Candolim is an area in Goa: where to stay, never where the trip goes'), tell_the_room: SAY_NOTHING,
      });
      // A city ixigo puts inside Goa is no new destination either.
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Panaji' }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('Panaji is a place in Goa') });
      // An area is never a destination, whatever the trip is: Old Manali on this Goa trip.
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Old Manali' }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining('Old Manali is an area in Manali, Himachal Pradesh') });
      // Said with dates, the dates still save.
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Candolim', dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx))
        .toMatchObject({ ok: true, changed: ['dates'], note: expect.stringContaining('Candolim is an area in Goa') });
      expect(calls.map((c) => c.params.destination)).toEqual([undefined]);
      // A city outside the destination is a real move: Goa to Manali goes as Manali's full Place.
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Manali' }, ctx)).toEqual({ ok: true, changed: ['destination'] });
      expect(calls[1]?.params.destination).toEqual(places['manali']);
    });

    it('changes nothing when ixigo cannot be reached (a TravelError from placeFor), and the rest of the change still saves', async () => {
      const { ctx, calls } = run([], GOA);
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Unreachable' }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("ixigo didn't answer when Go looked up Unreachable, twice"), tell_the_room: SAY_NOTHING });
      expect(await updateTrip.run({ proof_message_ids: ORG, destination: 'Unreachable', dates: { start: '2026-11-06', end: '2026-11-09' } }, ctx))
        .toMatchObject({ ok: true, changed: ['dates'], note: expect.stringContaining("ixigo didn't answer when Go looked up Unreachable") });
      expect(calls.map((c) => c.params.destination)).toEqual([undefined]);
    });
  });

  it('update_trip refuses dates before today where the trip is, says nothing in the chat, and names the days it likely meant', async () => {
    const { ctx, calls } = ctxWith({ update_trip: () => ({ seq: 65 }) });
    // 6 Oct 2026, 2:30 pm in Goa. The vote said "6-9 Nov" and the model guessed the year.
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2025-11-06', end: '2025-11-09' } }, ctx)).toEqual({
      ok: false,
      error: 'Those dates are before today (2026-10-06 where the trip is). Use this year or next: 2026-11-06 to 2026-11-09, if that is what the group meant.',
      tell_the_room: SAY_NOTHING,
    });
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-05', end: '2026-10-09' } }, ctx)).toMatchObject({ ok: false, tell_the_room: SAY_NOTHING });
    expect(calls).toHaveLength(0);
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-06', end: '2026-10-09' } }, ctx)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("update_trip reads today in the trip's own time zone, and a trip under way keeps the start it has", async () => {
    // 8 pm on 5 Oct in UTC: already 6 Oct in Goa, still 5 Oct in Los Angeles.
    const late = (name: string) => roomTools({ now: () => new Date('2026-10-05T20:00:00Z'), pool: db.pool }).find((x) => x.name === name)!;
    await db.pool.query(`insert into trips (trip_id, tz) values ('t_la', 'America/Los_Angeles') on conflict do nothing`);
    const goa = ctxWith({ update_trip: () => ({ seq: 66 }) });
    expect(await late('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-05', end: '2026-10-07' } }, goa.ctx)).toMatchObject({ ok: false });
    const f = fakeLink({ update_trip: () => ({ seq: 67 }) });
    const la = makeTurnCtx({ tripId: 't_la', turnId: 'turn_la', link: f.link, pack: pack(), wake: [], signal: new AbortController().signal });
    expect(await late('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-05', end: '2026-10-07' } }, la)).toMatchObject({ ok: true });
    // Under way since 4 Oct: the end may move, the start stays as it is.
    const away = ctxWith({ update_trip: () => ({ seq: 68 }) });
    away.ctx.pack.trip = { ...away.ctx.pack.trip, dates: { start: '2026-10-04', end: '2026-10-08' } };
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-04', end: '2026-10-09' } }, away.ctx)).toMatchObject({ ok: true });
    expect(await tool('update_trip').run({ proof_message_ids: ORG, dates: { start: '2026-10-03', end: '2026-10-09' } }, away.ctx)).toMatchObject({ ok: false });
  });

  it('a "6-9 Nov" decision means 2026-11-06 to 2026-11-09 when today is 6 Oct 2026; days already past this year mean next year', () => {
    expect(nextDates({ start: '2025-11-06', end: '2025-11-09' }, '2026-10-06')).toEqual({ start: '2026-11-06', end: '2026-11-09' });
    expect(nextDates({ start: '2025-10-06', end: '2025-10-08' }, '2026-10-06')).toEqual({ start: '2026-10-06', end: '2026-10-08' });
    expect(nextDates({ start: '2026-01-02', end: '2026-01-05' }, '2026-10-06')).toEqual({ start: '2027-01-02', end: '2027-01-05' });
    expect(nextDates({ start: '2025-12-30', end: '2026-01-02' }, '2026-10-06')).toEqual({ start: '2026-12-30', end: '2027-01-02' });
  });

  it('stay_silent marks the turn silent', async () => {
    const { ctx } = ctxWith();
    await tool('stay_silent').run({ reason: 'just chatter' }, ctx);
    expect(ctx.outcome.silent).toBe(true);
  });

  it('offer_replies puts up to six tap-to-answer choices on the turn, short, and asks Go not to list them (1.1 A3)', async () => {
    const { ctx } = ctxWith({});
    const offer = tool('offer_replies');
    expect(offer.input.safeParse({ replies: [{ label: 'Beach' }] }).success).toBe(false);
    expect(offer.input.safeParse({ replies: Array.from({ length: 7 }, (_, k) => ({ label: `Day ${k}` })) }).success).toBe(false);
    expect(offer.input.safeParse({ replies: [{ label: 'x'.repeat(41) }, { label: 'Hills' }] }).success).toBe(false);
    const out = await offer.run(offer.input.parse({ replies: [{ label: 'Beach' }, { label: 'Mountains', text: 'Mountains for me' }] }), ctx);
    expect(ctx.quickReplies).toEqual([{ label: 'Beach' }, { label: 'Mountains', text: 'Mountains for me' }]);
    expect(out).toMatchObject({ ok: true, shown: ['Beach', 'Mountains'], tell_the_room: expect.stringContaining('do not list them') });
    // The whole message comes after the call, a hello included, never the question alone (staging drill, 10 Oct).
    expect((out as { tell_the_room: string }).tell_the_room).toContain('Now write your whole message, everything you meant to say');
  });

  it('no tool can pay, book or touch a card', () => {
    const names = roomTools({ now: () => new Date(), pool: db.pool }).map((t) => t.name).sort();
    expect(names).toEqual(['close_vote', 'offer_replies', 'open_vote', 'react', 'stay_silent', 'update_trip']);
    for (const n of names) expect(n).not.toMatch(/pay|book|card|spend|charge/);
  });
});

describe('the turn context and the registry', () => {
  it('a rerun of the same turn gets the same ids, in the same order', () => {
    const a = ctxWith({}, 'turn_same').ctx;
    const b = ctxWith({}, 'turn_same').ctx;
    const ids = (c: typeof a) => [c.stableId('go_post'), c.stableId('go_post'), c.stableId('go_react'), c.stableId('c_vote')];
    expect(ids(a)).toEqual(['go_post_turn_same_1', 'go_post_turn_same_2', 'go_react_turn_same_1', 'c_vote_turn_same_1']);
    expect(ids(b)).toEqual(ids(ctxWith({}, 'turn_same').ctx));
  });

  it('a turn with limits carries them; a turn without has neither key', () => {
    const f = fakeLink();
    const base = { tripId: 't_goa', turnId: 'turn_R', link: f.link, pack: pack(), wake: [], signal: new AbortController().signal };
    const limited = makeTurnCtx({ ...base, limits: { tools: ['react', 'post_notice'], mayPostText: false } });
    expect(limited.allowedTools).toEqual(['react', 'post_notice']);
    expect(limited.mayPostText).toBe(false);
    const free = makeTurnCtx({ ...base, limits: null });
    expect('allowedTools' in free).toBe(false);
    expect('mayPostText' in free).toBe(false);
  });

  it('takes snake_case names once each and lists them in name order', () => {
    const tools = createTools();
    const t = (name: string): QuickTool<{ x: string }> => ({ name, description: 'd', input: z.object({ x: z.string() }), run: async () => ({}) });
    tools.register(t('search_stays'));
    tools.register(t('ask_to_pay'));
    expect(() => tools.register(t('search_stays'))).toThrow(/already/);
    expect(() => tools.register(t('Search Stays'))).toThrow(/snake_case/);
    expect(tools.list().map((x) => x.name)).toEqual(['ask_to_pay', 'search_stays']);
  });

  it('leaves a tool out of the list while it says it is not offered, read at every list (call_business with calls off)', () => {
    const tools = createTools();
    let on = false;
    tools.register({ name: 'call_business', description: 'd', input: z.object({}), run: async () => ({}), offered: () => on });
    tools.register({ name: 'react', description: 'd', input: z.object({}), run: async () => ({}) });
    expect(tools.list().map((x) => x.name)).toEqual(['react']);
    on = true;
    expect(tools.list().map((x) => x.name)).toEqual(['call_business', 'react']);
  });
});
