import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { createIxigoWebBackend } from '../backend.js';
import type { RecipeOption } from '../recipe.js';
import type { RecipeRunner } from '../runners.js';

const OPTION: RecipeOption = {
  kind: 'flight', title: 'IndiGo 6E 5341', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function runner(fail = false) {
  const runs: Array<{ tripId: string; recipe: string; slots: unknown }> = [];
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = null;
  const r: RecipeRunner = {
    name: 'agent_job',
    async run(tripId, recipe, slots) {
      runs.push({ tripId, recipe: recipe.id, slots });
      if (gate) await gate;
      if (fail) throw new TravelError('unreachable', 'ixigo took too long to answer.');
      return { options: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', ms: 3_100 };
    },
  };
  /** Holds every run until released, so two searches meet while one is in flight. */
  const hold = () => {
    gate = new Promise((resolve) => {
      release = resolve;
    });
  };
  return { r, runs, hold, release: () => release() };
}

let nowMs = Date.parse('2026-10-07T12:00:00Z');
const backend = (r: RecipeRunner | null) => createIxigoWebBackend({ runner: () => r, peopleOf: async () => 4, now: () => new Date(nowMs) });
const FLIGHTS = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };

describe('the ixigo_web backend', () => {
  it("runs the kind's recipe in the trip's browser, for the trip's head count when nobody gave a number", async () => {
    const { r, runs } = runner();
    const found = await backend(r).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    expect(runs).toEqual([{ tripId: 't_goa', recipe: 'ixigo.flights', slots: { from: 'DEL', to: 'GOI', date: '2026-11-06', adults: 4 } }]);
    expect(found).toEqual({ results: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z' });
    await backend(r).search('stays', { area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 7 }, { tripId: 't_goa' });
    expect(runs[1]).toMatchObject({ recipe: 'ixigo.stays', slots: { adults: 7, rooms: 4 } });
  });

  it("refuses a search without a trip, without the trip's computer, or for a place it has no code for, before anything runs", async () => {
    const { r, runs } = runner();
    await expect(backend(r).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).rejects.toMatchObject({ code: 'refused' });
    await expect(backend(null).search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('not set up') });
    await expect(backend(r).search('buses', { from: 'Pune', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unknown_place' });
    expect(runs).toEqual([]);
  });

  it('keeps a search for ten minutes by recipe and slots, so "Delhi" and "DEL" are one page load, and any trip can use it', async () => {
    const { r, runs } = runner();
    const b = backend(r);
    await b.search('flights', FLIGHTS, { tripId: 't_goa' });
    await b.search('flights', { from: 'DEL', to: 'GOI', date: '2026-11-06' }, { tripId: 't_other' });
    expect(runs).toHaveLength(1);
    // Another head count is another search: it asks ixigo for other adults.
    await b.search('flights', { ...FLIGHTS, guests: 6 }, { tripId: 't_goa' });
    expect(runs).toHaveLength(2);
    nowMs += 10 * 60_000;
    await b.search('flights', FLIGHTS, { tripId: 't_goa' });
    expect(runs).toHaveLength(3);
  });

  it('lets a search join the same one in flight, so an early start and the composer make one page load', async () => {
    const one = runner();
    const b = backend(one.r);
    one.hold();
    const early = b.search('flights', FLIGHTS, { tripId: 't_goa' });
    const composer = b.search('flights', { from: 'New Delhi', to: 'Goa', date: '2026-11-06' }, { tripId: 't_goa' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    one.release();
    expect(await composer).toEqual(await early);
    expect(one.runs).toHaveLength(1);
  });

  it('never keeps a failed search: the next ask runs it again', async () => {
    const failing = runner(true);
    const b = backend(failing.r);
    await expect(b.search('flights', FLIGHTS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    await expect(b.search('flights', FLIGHTS, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(failing.runs).toHaveLength(2);
  });

  it('never holds, confirms or reads a status: the group books on ixigo, from the link', async () => {
    const b = backend(runner().r);
    await expect(b.hold('ixigo:x', { name: 'Meher', personIds: ['p_meher'] })).rejects.toBeInstanceOf(TravelError);
    await expect(b.confirm('ixigo:h', { approvalId: 'ap', railRef: 'r' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('booked on ixigo') });
    await expect(b.status({ kind: 'pnr', pnr: '1234567890' })).rejects.toMatchObject({ code: 'refused' });
  });
});
