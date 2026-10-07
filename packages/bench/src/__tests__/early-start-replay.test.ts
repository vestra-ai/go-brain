// Offline replay of the early start in the bench's own travel mode (fake): every ask in the definitive live run (run
// 37488230324, docs/demo/evidence), as its line, through the early start and the right-now block as they are now, on
// the bench's trip and on the same trip with its dates (6 to 9 Nov) saved. In that run each search ask took two model
// calls, search then show_options, because the early start ran only under ixigo_web and read none of the asks'
// conditions. Here, the asks the early start reads get the search's answer in the turn, their conditions applied
// ("after 7 pm", "can't leave before 6"), so show_options can be the one call; the rest search as before.
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

const evidence = JSON.parse(readFileSync(new URL('../../../../docs/demo/evidence/bench-live-2026-10-06-definitive.json', import.meta.url), 'utf8')) as { at: string; live: LiveRun[] };
const now = (): Date => new Date(evidence.at);
const TODAY = evidence.at.slice(0, 10);

/** Each ask's line through the early start, and what the turn's right-now block then says first. */
async function replay(run: LiveRun, dates: { start: string; end: string } | null) {
  const chat = loadChat(run.chat);
  const switches = new FakeSwitches();
  await switches.set('TRAVEL_MODE', 'fake');
  const fake = createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' } as never);
  const travel = createTravelLayer({ switches, now, fake, ixigo: null, results: { offer: async () => null }, today: async () => TODAY });
  const early = createEarlyStart({ travel: () => travel, switches, today: async () => TODAY, now, log: { warn: () => undefined } });
  const block = earlySearchNow({ early, results: { save: async (s: object) => ({ ...s, resultsId: 'r_early' }) } as never, travel, now });
  const trip = { ...goaFreshTrip(), dates };
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

const runs = async (dates: { start: string; end: string } | null) => (await Promise.all(evidence.live.map((r) => replay(r, dates)))).flat();

describe('the early start, replayed on the definitive live run in the fake travel mode', () => {
  for (const [name, dates] of [['the bench trip, no dates', null], ['the trip with its dates', { start: '2026-11-06', end: '2026-11-09' }]] as const) {
    it(`${name}: starts only searches the model ran for that ask, of the kind it ran`, async () => {
      for (const a of await runs(dates)) {
        if (a.started) expect(a.searched, a.line).toEqual([a.started.kind]);
      }
    });

    it(`${name}: every search it starts reaches the turn with its results_id, so show_options is the one call`, async () => {
      for (const a of (await runs(dates)).filter((x) => x.started)) {
        expect(a.first, a.line).toMatch(/^Already searched for #\d+, checked just now: results_id r_early, \d+ options\.$/);
      }
    });
  }

  it('the bench trip, no dates: the flights asks start; a stay needs the trip\'s dates, and the bench trip has none', async () => {
    const started = (await runs(null)).filter((a) => a.started).map((a) => [a.line, a.started]);
    expect(started).toEqual([
      ['goa-300 L9', { kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-11-06' } }],
      // The bench trip has no dates, so "Friday" is the coming one; the block lets the model search again for the trip's.
      ['goa-300 L122', { kind: 'flights', query: { from: 'bangalore', to: 'goa', date: '2026-10-09', departAfter: '19:00' } }],
      ['goa-50 L9', { kind: 'flights', query: { from: 'delhi', to: 'goa', date: '2026-10-09', departAfter: '18:00' } }],
    ]);
  });

  it("the flights asks' answers hold their conditions, so the model has none left to search for", async () => {
    const all = await runs(null);
    expect(all.find((a) => a.line === 'goa-50 L9')!.said).toContain('4 of the 10 flights from delhi to goa on 2026-10-09 fit leaving after 6');
    expect(all.find((a) => a.line === 'goa-300 L122')!.said).toContain('2 of the 3 flights from bangalore to goa on 2026-10-09 fit leaving after 7');
  });

  it('the trip with its dates: the villa asks start too; the vote and the booking ask start nothing', async () => {
    const all = await runs({ start: '2026-11-06', end: '2026-11-09' });
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
