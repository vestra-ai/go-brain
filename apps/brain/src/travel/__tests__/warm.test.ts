import { describe, expect, it, vi } from 'vitest';
import { FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { CHECK_WAKE_LEAD_MS, createIxigoWarm, IXIGO_WARM_STEP, IXIGO_WARM_TRIES, startComputerAtSetup, wakeForCheck, warmForTravel } from '../warm.js';

/** A brain with the travel mode switch and the tasks lane's keepWarm and start, recording each hold and each start. */
function brainIn(mode: string, withComputer = true, startFails = false, status: 'ready' | 'waking' | 'skipped' = 'waking', primeFails = 0) {
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
      return status;
    },
    // primeFails: how many visits in a row ixigo does not answer, then it does.
    prime: async (tripId: string) => {
      if (primeFails > 0) {
        primeFails -= 1;
        throw new Error("ixigo's page did not answer on the trip's computer.");
      }
      primed.push(tripId);
    },
  } as never;
  let nowMs = Date.parse('2026-10-08T08:00:00Z');
  const log = { warn: vi.fn() };
  const now = () => {
    nowMs += 1_500;
    return new Date(nowMs);
  };
  return { brain: { switches, log: log as never, now, ...(withComputer ? { recipeRunners } : {}) }, held, started, primed, log };
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

describe(`createIxigoWarm (${IXIGO_WARM_STEP}): the new computer's first ixigo visit, after the organiser's login prompt`, () => {
  it('visits ixigo under ixigo_web, and only there', async () => {
    const web = brainIn('ixigo_web');
    await createIxigoWarm(web.brain).run('t_new');
    expect(web.primed).toEqual(['t_new']);
    for (const mode of ['fake', 'ixigo']) {
      const other = brainIn(mode);
      await createIxigoWarm(other.brain).run('t_new');
      expect(other.primed, mode).toEqual([]);
    }
    await expect(createIxigoWarm(brainIn('ixigo_web', false).brain).run('t_new')).resolves.toBeUndefined();
  });

  it('throws while ixigo does not answer, so setup tries again, and is done once it does', async () => {
    const b = brainIn('ixigo_web', true, false, 'waking', 1);
    const warm = createIxigoWarm(b.brain);
    await expect(warm.run('t_new')).rejects.toThrow(/did not answer/);
    await warm.run('t_new');
    expect(b.primed).toEqual(['t_new']);
    expect(b.log.warn).not.toHaveBeenCalled();
  });

  it(`gives up after ${IXIGO_WARM_TRIES} tries: done with a warning in the log and the health view`, async () => {
    const b = brainIn('ixigo_web', true, false, 'waking', 99);
    const warm = createIxigoWarm(b.brain);
    for (let i = 1; i < IXIGO_WARM_TRIES; i += 1) await expect(warm.run('t_down')).rejects.toThrow(/did not answer/);
    await expect(warm.run('t_down')).resolves.toBeUndefined();
    expect(b.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't_down', tries: IXIGO_WARM_TRIES }), expect.stringContaining('its warm is done with a warning'));
    expect(warm.stat()).toEqual({ recipe: IXIGO_WARM_STEP, speed: 'page', runs: IXIGO_WARM_TRIES, failed: IXIGO_WARM_TRIES, p50_ms: null, p90_ms: null });
    // The trip's stays head start asks this, and runs nothing for it.
    expect(warm.gaveUp('t_down')).toBe(true);
    // Another trip's count is its own.
    await expect(warm.run('t_other')).rejects.toThrow(/did not answer/);
    expect(warm.gaveUp('t_other')).toBe(false);
  });

  it('says nothing in the health view before its first visit, then how often and how fast ixigo answered', async () => {
    const b = brainIn('ixigo_web');
    const warm = createIxigoWarm(b.brain);
    expect(warm.stat()).toBeNull();
    await warm.run('t_new');
    expect(warm.stat()).toEqual({ recipe: IXIGO_WARM_STEP, speed: 'page', runs: 1, failed: 0, p50_ms: 1_500, p90_ms: 1_500 });
  });
});

describe("wakeForCheck: a watch's check wakes its trip's computer before its page", () => {
  it('wakes the box with no hold, and gives a box that was not up CHECK_WAKE_LEAD_MS before the page', async () => {
    for (const status of ['waking', 'skipped'] as const) {
      const { brain, started, held } = brainIn('ixigo_web', true, false, status);
      const slept: number[] = [];
      await wakeForCheck(brain, 't_watch', async (ms) => { slept.push(ms); });
      expect(started, status).toEqual(['t_watch']);
      expect(held, status).toEqual([]);
      expect(slept, status).toEqual([CHECK_WAKE_LEAD_MS]);
    }
  });

  it('goes straight on when the box is up, and wakes none in the other modes nor without the trip computer', async () => {
    const up = brainIn('ixigo_web', true, false, 'ready');
    const slept: number[] = [];
    await wakeForCheck(up.brain, 't_watch', async (ms) => { slept.push(ms); });
    expect(up.started).toEqual(['t_watch']);
    expect(slept).toEqual([]);
    for (const mode of ['fake', 'ixigo']) {
      const other = brainIn(mode);
      await wakeForCheck(other.brain, 't_watch', async (ms) => { slept.push(ms); });
      expect(other.started, mode).toEqual([]);
    }
    await expect(wakeForCheck(brainIn('ixigo_web', false).brain, 't_watch')).resolves.toBeUndefined();
    expect(slept).toEqual([]);
  });

  it('throws a /v1 refusal, so the runner logs it and the page wakes the box itself', async () => {
    await expect(wakeForCheck(brainIn('ixigo_web', true, true).brain, 't_watch', async () => undefined)).rejects.toThrow(/warm_limit/);
  });
});
