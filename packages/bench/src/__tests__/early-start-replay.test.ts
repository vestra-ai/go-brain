// Offline replay of the early start in the bench's own travel mode (fake): every ask in the live run of 2026-10-06 (run
// 37488230324, fixtures/live-2026-10-06.json), as its line, through the early start and the right-now block as they are now, on
// the bench's trip and on the same trip with its dates (6 to 9 Nov) saved. In that run each search ask took two model
// calls, search then show_options, because the early start ran only under ixigo_web and read none of the asks'
// conditions. Here, the asks the early start reads get the search's answer in the turn, their conditions applied
// ("after 7 pm", "can't leave before 6"), so show_options can be the one call; the rest search as before. The bench's
// trip has no dates set, so a day of the week is read only once the group's dates are in its record (the measurement run
// 37582427795 searched 9 Oct for "Friday" on the 6 to 9 Nov trip, and the model rightly searched again for 6 Nov).
import { readFileSync } from 'node:fs';
import * as C from '@go/contract';
import { UNSURE_READ } from '@go/brain/dist/reflex/reflex.js';
import { FakeSwitches } from '@go/brain/dist/tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '@go/brain/dist/travel/fake-ixigo/data.js';
import { createTravelLayer } from '@go/brain/dist/travel/layer.js';
import { createFakeTravel } from '@go/brain/dist/travel/mcp-travel.js';
import { createEarlyStart } from '@go/brain/dist/travel/recipes/early.js';
import { earlySearchNow } from '@go/brain/dist/travel/recipes/now.js';
import { goaFreshTrip } from '@go/sim';
import { describe, expect, it } from 'vitest';
import { loadChat, type SayLine } from '../chat.js';

interface LiveRun {
  chat: string;
  asks: Array<{ line: number; calls: Array<{ toolsAfter: string[] }> }>;
}

const evidence = JSON.parse(readFileSync(new URL('./fixtures/live-2026-10-06.json', import.meta.url), 'utf8')) as { at: string; live: LiveRun[] };
const now = (): Date => new Date(evidence.at);
const TODAY = evidence.at.slice(0, 10);

/** Each ask's line through the early start, and what the turn's right-now block then says first. */
type TripState = { dates: { start: string; end: string } | null; record: unknown[] };
/** The bench's trip as it starts, the same once the group's dates are agreed in its record, and a trip with its dates. */
const BENCH: TripState = { dates: null, record: [] };
const AGREED: TripState = {
  dates: null,
  record: [{
    line_id: 'r_dates', kind: 'agreed', text: '6 to 9 Nov, Diwali long weekend', status: 'active', proof: [{ message_id: 'm_0', person_id: 'p_rahul' }],
    person_ids: ['p_rahul'], source: 'go', created_at: evidence.at, updated_at: evidence.at,
  }],
};
const DATED: TripState = { dates: { start: '2026-11-06', end: '2026-11-09' }, record: [] };

async function replay(run: LiveRun, state: TripState) {
  const chat = loadChat(run.chat);
  const switches = new FakeSwitches();
  await switches.set('TRAVEL_MODE', 'fake');
  const fake = createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' } as never);
  const travel = createTravelLayer({ switches, now, fake, ixigo: null, results: { offer: async () => null }, today: async () => TODAY });
  const early = createEarlyStart({ travel: () => travel, switches, today: async () => TODAY, now, log: { warn: () => undefined } });
  const block = earlySearchNow({ early, results: { save: async (s: object) => ({ ...s, resultsId: 'r_early' }) } as never, travel, now });
  const trip = { ...goaFreshTrip(), ...state };
  const pack = { trip, messages: [] } as never;
  const out = [];
  for (const ask of run.asks) {
    const l = chat.lines.find((x): x is SayLine => x.i === ask.line && x.kind === 'say')!;
    const m = C.Message.parse({
      message_id: `m_${l.i}`, seq: l.i, updated_seq: l.i, author: { kind: 'person', person_id: l.person }, text: l.text, attachments: [],
      mentions_go: /@go\b/i.test(l.text), mentions: [], reactions: [], withheld: false, deleted: false, edited: false, sent_at: now().toISOString(),
    });
    await early.onRead(m, UNSURE_READ, pack);
    const started = early.searchFor(trip.trip_id, m.message_id);
    const said = started
      ? await block.render(trip.trip_id, [{ id: `msg:${l.i}`, tripId: trip.trip_id, kind: 'message', ref: m.message_id, dueAt: now(), payload: { messageId: m.message_id, seq: l.i } } as never])
      : null;
    const searched = [...new Set(ask.calls.flatMap((c) => c.toolsAfter).filter((t) => t.startsWith('search_')).map((t) => t.slice('search_'.length)))];
    out.push({ line: `${run.chat} L${l.i}`, searched, started: started ? { kind: started.kind, query: started.query } : null, first: said?.split('\n')[0] ?? null, said });
  }
  return out;
}

const runs = async (state: TripState) => (await Promise.all(evidence.live.map((r) => replay(r, state)))).flat();

describe('the early start, replayed on the 2026-10-06 live run in the fake travel mode', () => {
  for (const [name, state] of [['the bench trip, no dates', BENCH], ['its dates agreed in the record', AGREED], ['the trip with its dates', DATED]] as const) {
    it(`${name}: starts only searches the model ran for that ask, of the kind it ran`, async () => {
      for (const a of await runs(state)) {
        if (a.started) expect(a.searched, a.line).toEqual([a.started.kind]);
      }
    });

    it(`${name}: every search it starts reaches the turn with its results_id, so show_options is the one call`, async () => {
      for (const a of (await runs(state)).filter((x) => x.started)) {
        expect(a.first, a.line).toMatch(/^Already searched for #\d+, checked just now: results_id r_early, \d+ options\.$/);
      }
    });
  }

  it("the bench trip, no dates: only the ask with a date of its own starts; \"Friday\" and a stay wait for the trip's dates", async () => {
    const started = (await runs(BENCH)).filter((a) => a.started).map((a) => [a.line, a.started]);
    expect(started).toEqual([['goa-300 L9', { kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-11-06' } }]]);
  });

  it("its dates agreed in the record: the flights asks' answers are for the trip's Friday and hold their conditions", async () => {
    const all = await runs(AGREED);
    expect(all.find((a) => a.line === 'goa-50 L9')!.said).toContain('4 of the 10 flights from delhi to goa on 2026-11-06 fit leaving after 6');
    expect(all.find((a) => a.line === 'goa-300 L122')!.said).toContain('2 of the 3 flights from bangalore to goa on 2026-11-06 fit leaving after 7');
    expect(all.filter((a) => a.started).map((a) => a.line)).toEqual((await runs(DATED)).filter((a) => a.started).map((a) => a.line));
  });

  it('the trip with its dates: the villa asks start too; the vote and the booking ask start nothing', async () => {
    const all = await runs(DATED);
    const started = all.filter((a) => a.started).map((a) => a.line);
    expect(started).toEqual(['goa-300 L9', 'goa-300 L73', 'goa-300 L122', 'goa-50 L9', 'goa-50 L24']);
    expect(all.find((a) => a.line === 'goa-50 L24')!.started).toEqual({ kind: 'stays', query: { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] } });
    // "Friday" is the trip's Friday on a trip with its dates.
    expect(all.find((a) => a.line === 'goa-50 L9')!.started!.query).toMatchObject({ date: '2026-11-06', departAfter: '18:00' });
    expect(all.find((a) => a.line === 'goa-300 L122')!.started!.query).toMatchObject({ date: '2026-11-06', departAfter: '19:00' });
    // The model searched stays for these, to put them to a vote and to book: not a search ask.
    for (const line of ['goa-300 L175', 'goa-50 L46']) expect(all.find((a) => a.line === line)!.started, line).toBeNull();
  });
});
