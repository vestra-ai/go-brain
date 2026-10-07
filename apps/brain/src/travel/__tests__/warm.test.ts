import { describe, expect, it } from 'vitest';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { warmForTravel } from '../warm.js';

/** A brain with the travel mode switch and the tasks lane's keepWarm, recording each hold. */
function brainIn(mode: string, withComputer = true) {
  const switches = new FakeSwitches();
  void switches.set('TRAVEL_MODE', mode);
  const held: string[] = [];
  const recipeRunners = { keepWarm: (tripId: string) => held.push(tripId) } as never;
  return { brain: { switches, ...(withComputer ? { recipeRunners } : {}) }, held };
}

describe('warmForTravel, the one owner of waking a trip\'s computer for travel', () => {
  it('holds the box awake under ixigo_web for a kind that loads ixigo.com', () => {
    const { brain, held } = brainIn('ixigo_web');
    for (const kind of ['stays', 'trains', 'buses'] as const) warmForTravel(brain, 't_goa', kind);
    expect(held).toEqual(['t_goa', 't_goa', 't_goa']);
  });

  it('never for a link-only kind (flights load nothing), nor in the modes whose searches need no box', () => {
    const web = brainIn('ixigo_web');
    warmForTravel(web.brain, 't_goa', 'flights');
    expect(web.held).toEqual([]);
    for (const mode of ['fake', 'ixigo']) {
      const other = brainIn(mode);
      warmForTravel(other.brain, 't_goa', 'stays');
      expect(other.held, mode).toEqual([]);
    }
  });

  it('does nothing, and never throws, while the trip computer is not set up here', () => {
    const { brain } = brainIn('ixigo_web', false);
    expect(() => warmForTravel(brain, 't_goa', 'stays')).not.toThrow();
  });
});
