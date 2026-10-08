import { describe, expect, it } from 'vitest';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { IXIGO_WARM_STEP, startComputerAtSetup, warmForTravel, warmIxigoAtSetup } from '../warm.js';

/** A brain with the travel mode switch and the tasks lane's keepWarm and start, recording each hold and each start. */
function brainIn(mode: string, withComputer = true, startFails = false, primeFails = false) {
  const switches = new FakeSwitches();
  void switches.set('TRAVEL_MODE', mode);
  const held: string[] = [];
  const started: string[] = [];
  const primed: string[] = [];
  const recipeRunners = {
    keepWarm: (tripId: string) => held.push(tripId),
    start: async (tripId: string) => {
      if (startFails) throw new Error('warm_limit: too many computers are waking');
      started.push(tripId);
    },
    prime: async (tripId: string) => {
      if (primeFails) throw new Error("ixigo's page did not answer on the trip's computer.");
      primed.push(tripId);
    },
  } as never;
  return { brain: { switches, ...(withComputer ? { recipeRunners } : {}) }, held, started, primed };
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

describe("startComputerAtSetup: a new trip's computer, made when the trip is", () => {
  it('makes the box under ixigo_web, with no hold, so the first search never waits for its making', async () => {
    const { brain, started, held } = brainIn('ixigo_web');
    await startComputerAtSetup(brain, 't_new');
    expect(started).toEqual(['t_new']);
    expect(held).toEqual([]);
  });

  it('makes none in the modes whose searches need no box, nor while the trip computer is not set up here', async () => {
    for (const mode of ['fake', 'ixigo']) {
      const other = brainIn(mode);
      await startComputerAtSetup(other.brain, 't_new');
      expect(other.started, mode).toEqual([]);
    }
    await expect(startComputerAtSetup(brainIn('ixigo_web', false).brain, 't_new')).resolves.toBeUndefined();
  });

  it('throws when /v1 turns it away, so setup tries again on its next pass', async () => {
    await expect(startComputerAtSetup(brainIn('ixigo_web', true, true).brain, 't_new')).rejects.toThrow(/warm_limit/);
  });
});

describe(`warmIxigoAtSetup (${IXIGO_WARM_STEP}): the new computer's first ixigo visit, before the organiser's login prompt`, () => {
  it('visits ixigo under ixigo_web, and only there', async () => {
    const web = brainIn('ixigo_web');
    await warmIxigoAtSetup(web.brain, 't_new');
    expect(web.primed).toEqual(['t_new']);
    for (const mode of ['fake', 'ixigo']) {
      const other = brainIn(mode);
      await warmIxigoAtSetup(other.brain, 't_new');
      expect(other.primed, mode).toEqual([]);
    }
    await expect(warmIxigoAtSetup(brainIn('ixigo_web', false).brain, 't_new')).resolves.toBeUndefined();
  });

  it('throws when ixigo did not answer, so setup tries again and the login prompt waits', async () => {
    await expect(warmIxigoAtSetup(brainIn('ixigo_web', true, false, true).brain, 't_new')).rejects.toThrow(/did not answer/);
  });
});
