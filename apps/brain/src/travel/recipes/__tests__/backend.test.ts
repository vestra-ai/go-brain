import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { createIxigoWebBackend } from '../backend.js';
import type { RecipeOption } from '../recipe.js';
import type { RecipeRunner } from '../runners.js';

const OPTION: RecipeOption = {
  kind: 'flight', title: 'IndiGo 6E 5341', priceMinor: 789_600, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 },
  sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=4&children=0&infants=0&class=e&source=Search%20Form',
};

function runner() {
  const runs: Array<{ tripId: string; recipe: string; slots: unknown }> = [];
  const r: RecipeRunner = {
    name: 'agent_job',
    async run(tripId, recipe, slots) {
      runs.push({ tripId, recipe: recipe.id, slots });
      return { options: [OPTION], checkedAt: '2026-10-07T12:00:03.000Z', ms: 3_100 };
    },
  };
  return { r, runs };
}

const backend = (r: RecipeRunner | null) => createIxigoWebBackend({ runner: () => r, peopleOf: async () => 4 });

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

  it('never holds, confirms or reads a status: the group books on ixigo, from the link', async () => {
    const b = backend(runner().r);
    await expect(b.hold('ixigo:x', { name: 'Meher', personIds: ['p_meher'] })).rejects.toBeInstanceOf(TravelError);
    await expect(b.confirm('ixigo:h', { approvalId: 'ap', railRef: 'r' })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('booked on ixigo') });
    await expect(b.status({ kind: 'pnr', pnr: '1234567890' })).rejects.toMatchObject({ code: 'refused' });
  });
});
