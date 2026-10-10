import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { FakeLink } from '../../tasks/testing/lane-brain.js';
import type { EngineAnswer } from '../book/engine.js';
import { showBusDrops } from '../bus-drops.js';
import { buildOptionsCard, type CardPick } from '../cards.js';
import { createResultsStore, type ResultOption, type ResultsStore } from '../results.js';

// The lead, 10 Oct (the C3 drill): ixigo's list said Paulo arrives 7:20 am while its seat layout dropped Panjim 9:20 and
// Mapusa 10:30 am, so the card and the answer disagreed. Once the top bus's layout is read, its card line says its drops.
let db: Awaited<ReturnType<typeof withSchema>>;
let results: ResultsStore;
beforeAll(async () => {
  db = await withSchema();
  results = createResultsStore(db.pool);
});
afterAll(() => db.drop());

const bus = (title: string, depart: string, arrive: string, type: string): ResultOption => ({
  kind: 'bus', title, priceMinor: 225_000, currency: 'INR', priceNote: 'per seat, from', highlights: [type], facts: { bus_type: type },
  journey: { mode: 'bus', origin: { name: 'Bengaluru' }, destination: { name: 'Goa' }, depart_at: depart, arrive_at: arrive, carrier_name: title },
  sourceUrl: 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O#x@20:00',
});

async function busCard(tripId: string, cardId: string) {
  const options = [
    bus('Paulo Travels Express', '2026-11-06T20:00:00+05:30', '2026-11-07T07:20:00+05:30', 'VE AC Seater/Sleeper (2 + 1)'),
    bus('VRL Travels', '2026-11-06T18:00:00+05:30', '2026-11-07T07:00:00+05:30', 'Eicher AC Sleeper'),
  ];
  const set = await results.save({ tripId, optionKind: 'bus', source: 'search', query: {}, options, checkedAt: '2026-11-01T10:00:00.000Z' });
  const picks: Array<CardPick & { n: number }> = set.options.map((option, i) => ({ n: i + 1, optionId: `opt_${cardId}_${i + 1}`, option, imageUrl: null }));
  const card = buildOptionsCard({ cardId, title: 'Buses, Bangalore to Goa', optionKind: 'bus', checkedAt: set.checkedAt, picks });
  await results.saveCard({ cardId, tripId, resultsId: set.resultsId, title: card.title, optionKind: 'bus', card }, picks, set.checkedAt);
  return card;
}

const layout = (drops: unknown): EngineAnswer => ({
  as: 'facts', title: 'Paulo Travels Express at 20:00: its stops', rows: [{ bus: 'Paulo Travels Express', ...(drops !== undefined ? { drop_times: drops } : {}) }],
  page: 'https://www.ixigo.com/buses/bus_search/Bengaluru/7/Goa/102/06-11-2026/O', checkedAt: '2026-11-01T10:01:00.000Z', ms: 5_000,
});

describe("the top bus's own drops on its card", () => {
  it("say its first and last drop with their times in place of ixigo's one arrival, and change nothing else", async () => {
    const before = await busCard('t_drops', 'c_drops');
    expect(before.options[0]!.subtitle).toBe('8:00 pm to 7:20 am next day, VE AC Seater/Sleeper (2 + 1)');
    const link = new FakeLink();
    const drops = [{ name: 'Cuncolim', at: '07:50' }, { name: 'Panjim', at: '09:20' }, { name: 'Mapusa', at: '10:30' }];
    expect(await showBusDrops({ results, link }, 't_drops', { cardId: 'c_drops', optionId: 'opt_c_drops_1' }, layout(drops))).toBe(true);
    const replaced = C.OptionsCard.parse(link.sent('replace_card')[0]!['card']);
    expect(replaced.options[0]!.subtitle).toBe('8:00 pm, drops Cuncolim 7:50 am to Mapusa 10:30 am next day, VE AC Seater/Sleeper (2 + 1)');
    expect(replaced.options[1]).toEqual(before.options[1]);
    expect({ ...replaced.options[0], subtitle: before.options[0]!.subtitle }).toEqual(before.options[0]);
  });

  it('say one drop as one, and change nothing for a layout with no drop times or an option not kept', async () => {
    await busCard('t_drops2', 'c_drops2');
    const link = new FakeLink();
    const pick = { cardId: 'c_drops2', optionId: 'opt_c_drops2_2' };
    expect(await showBusDrops({ results, link }, 't_drops2', pick, layout([{ name: 'Madgaon', at: '07:00' }]))).toBe(true);
    expect(C.OptionsCard.parse(link.sent('replace_card')[0]!['card']).options[1]!.subtitle).toBe('6:00 pm, drops Madgaon 7:00 am next day, Eicher AC Sleeper');
    expect(await showBusDrops({ results, link }, 't_drops2', pick, layout(undefined))).toBe(false);
    expect(await showBusDrops({ results, link }, 't_drops2', pick, layout([{ name: '', at: 'later' }]))).toBe(false);
    expect(await showBusDrops({ results, link }, 't_drops2', { ...pick, optionId: 'opt_gone' }, layout([{ name: 'Madgaon', at: '07:00' }]))).toBe(false);
    expect(link.sent('replace_card')).toHaveLength(1);
  });
});
