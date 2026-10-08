import { describe, expect, it } from 'vitest';
import { createRunLog, KEPT_EVENTS, KEPT_FRAME_RUNS, pathOf, type RunEvent } from '../runs.js';

function world() {
  let nowMs = Date.parse('2026-10-08T06:00:00Z');
  let n = 0;
  const log = createRunLog({ now: () => new Date(nowMs), mint: (prefix) => `${prefix}${++n}` });
  const seen: RunEvent[] = [];
  log.subscribe('t_goa', (e) => seen.push(e));
  return { log, seen, advance: (ms: number) => { nowMs += ms; } };
}

const frame = (page_url: string, at_ms = 100) => ({ label: 'results', at_ms, page_url, jpeg_base64: '/9j/AA==' });

describe('the run log', () => {
  it("a call is its host and path, never its query, and ixigo's own host is left out", () => {
    expect(pathOf('https://www.ixigo.com/hotels/api/v6/search?checkinDate=06112026&adultCount=4')).toBe('/hotels/api/v6/search');
    expect(pathOf('https://ixigotrainsapi.confirmtkt.com/api/v1/trains/search?sourceStationCode=NDLS')).toBe('ixigotrainsapi.confirmtkt.com/api/v1/trains/search');
    expect(pathOf('/trains/v1/pnr/status?pnr=1234567890')).toBe('/trains/v1/pnr/status');
  });

  it('tells one run as it goes: its speeds, its calls and how it ended', () => {
    const w = world();
    const run = w.log.start('t_goa', 'trains.between', 'Trains between two stations');
    run.named('Delhi to Goa trains, Fri 6 Nov');
    run.attempt('fast');
    w.advance(400);
    run.trace({ speed: 'fast', started_at: Date.parse('2026-10-08T06:00:00Z') + 10, elapsed_ms: 380, calls: [{ method: 'GET', url: 'https://ixigotrainsapi.confirmtkt.com/api/v1/trains/search?x=1', status: 200, ms: 366 }] });
    run.end(true, { rows: 6 });
    expect(w.seen).toEqual([
      { type: 'run_start', run_id: 'run_1', group_id: 'grp_2', recipe_id: 'trains.between', label: 'Trains between two stations', at: '2026-10-08T06:00:00.000Z' },
      { type: 'named', run_id: 'run_1', label: 'Delhi to Goa trains, Fri 6 Nov' },
      { type: 'attempt', run_id: 'run_1', speed: 'fast', at_ms: 0 },
      { type: 'call', run_id: 'run_1', speed: 'fast', method: 'GET', path: 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search', status: 200, at_ms: 390, ms: 366 },
      { type: 'run_end', run_id: 'run_1', ok: true, speed: 'fast', ms: 400, rows: 6 },
      { type: 'group_end', group_id: 'grp_2', runs: 1, wall_ms: 400, sum_ms: 400 },
    ]);
  });

  it("a page run's trace says when the computer woke, when the page showed, and each call kept", () => {
    const w = world();
    const run = w.log.start('t_goa', 'hotels.search', 'Stays');
    run.attempt('page');
    run.trace({
      speed: 'page', started_at: Date.parse('2026-10-08T06:00:00Z') + 5, elapsed_ms: 9_000, woke: true,
      timings: { wake_ms: 4_000, nav_ms: 5_200, first_capture_ms: 7_000, done_ms: 8_900 },
      calls: [{ url: 'https://www.ixigo.com/hotels/api/v6/search?page=1', status: 200, at_ms: 7_000 }],
    });
    expect(w.seen.filter((e) => e.type === 'step' || e.type === 'call')).toEqual([
      { type: 'step', run_id: 'run_1', text: 'The computer woke (4000 ms)', at_ms: 4_005 },
      { type: 'step', run_id: 'run_1', text: 'The page showed', at_ms: 5_205 },
      { type: 'call', run_id: 'run_1', speed: 'page', method: 'GET', path: '/hotels/api/v6/search', status: 200, at_ms: 7_005 },
    ]);
  });

  it('a failed call is a step that says so, and the run falls to the page', () => {
    const w = world();
    const run = w.log.start('t_goa', 'buses.between', 'Buses');
    run.attempt('fast');
    run.trace({ speed: 'fast', started_at: Date.parse('2026-10-08T06:00:00Z'), elapsed_ms: 5_000, calls: [], failed: { status: 504, why: 'the page call took too long' } });
    run.attempt('page');
    run.end(false, { why: 'ixigo took too long to answer.' });
    expect(w.seen.filter((e) => e.type !== 'run_start' && e.type !== 'group_end')).toEqual([
      { type: 'attempt', run_id: 'run_1', speed: 'fast', at_ms: 0 },
      { type: 'step', run_id: 'run_1', text: 'fast: 504, the page call took too long', at_ms: 5_000 },
      { type: 'attempt', run_id: 'run_1', speed: 'page', at_ms: 0 },
      { type: 'run_end', run_id: 'run_1', ok: false, speed: 'page', ms: 0, why: 'ixigo took too long to answer.' },
    ]);
  });

  it('runs that overlap are one group, its wall time set against the sum; the next run starts a new group', () => {
    const w = world();
    const flights = w.log.start('t_goa', 'flights.search', 'Delhi to Goa flights');
    w.advance(100);
    const trains = w.log.start('t_goa', 'trains.between', 'Mumbai to Goa trains');
    w.advance(400);
    trains.end(true, { speed: 'fast', rows: 6 });
    w.advance(3_600);
    flights.end(true, { speed: 'page', rows: 14 });
    const later = w.log.start('t_goa', 'buses.between', 'Bangalore to Goa buses');
    const starts = w.seen.filter((e) => e.type === 'run_start');
    expect(starts.map((e) => e.type === 'run_start' && e.group_id)).toEqual(['grp_2', 'grp_2', 'grp_5']);
    expect(w.seen.filter((e) => e.type === 'group_end')).toEqual([{ type: 'group_end', group_id: 'grp_2', runs: 2, wall_ms: 4_100, sum_ms: 4_500 }]);
    later.end(true);
  });

  it("a lookup is a run of its own under its search, in the search's group, and not counted in the group's sum", () => {
    const w = world();
    const search = w.log.start('t_goa', 'trains.between', 'Trains');
    const lookup = search.child('trains.station_lookup', "ixigo's station box");
    w.advance(300);
    lookup.end(true, { speed: 'page' });
    w.advance(500);
    search.end(true, { speed: 'page' });
    expect(w.seen.find((e) => e.type === 'run_start' && e.recipe_id === 'trains.station_lookup')).toMatchObject({ parent: 'run_1', group_id: 'grp_2' });
    expect(w.seen.filter((e) => e.type === 'group_end')).toEqual([{ type: 'group_end', group_id: 'grp_2', runs: 1, wall_ms: 800, sum_ms: 800 }]);
  });

  it('pictures only of the pages the live card may show, and only the newest runs are kept for a new viewer', () => {
    const w = world();
    const run = w.log.start('t_goa', 'hotels.search', 'Stays');
    run.frames([frame('https://www.ixigo.com/hotels/search/result?locationId=1'), frame('https://www.ixigo.com/payments/view/abc', 200)]);
    expect(w.seen.filter((e) => e.type === 'frames')).toEqual([
      { type: 'frames', run_id: 'run_1', frames: [{ label: 'results', at_ms: 100, page: '/hotels/search/result', jpeg_base64: '/9j/AA==' }] },
    ]);
    run.frames([frame('https://www.ixigo.com/payments/view/abc')]);
    expect(w.seen.filter((e) => e.type === 'frames')).toHaveLength(1);
    for (let i = 0; i < KEPT_FRAME_RUNS + 2; i++) w.log.start('t_goa', 'buses.between', 'Buses').frames([frame('https://www.ixigo.com/buses/bus_search/x')]);
    const kept = w.log.recent('t_goa').filter((e) => e.type === 'frames');
    expect(kept).toHaveLength(KEPT_FRAME_RUNS);
    expect(kept.some((e) => e.type === 'frames' && e.run_id === 'run_1')).toBe(false);
  });

  it('keeps the last events per trip, and a trip with none answers an empty list', () => {
    const w = world();
    const run = w.log.start('t_goa', 'hotels.search', 'Stays');
    for (let i = 0; i < KEPT_EVENTS + 20; i++) run.step(`step ${i}`);
    const recent = w.log.recent('t_goa');
    expect(recent).toHaveLength(KEPT_EVENTS);
    expect(recent.at(-1)).toMatchObject({ type: 'step', text: `step ${KEPT_EVENTS + 19}` });
    expect(w.log.recent('t_other')).toEqual([]);
  });

  it('a run that ended says nothing more; a viewer that throws never reaches the run, and one that left hears nothing', () => {
    const w = world();
    const off = w.log.subscribe('t_goa', () => {
      throw new Error('viewer down');
    });
    const run = w.log.start('t_goa', 'hotels.search', 'Stays');
    run.end(true);
    run.end(false);
    run.step('late');
    run.attempt('page');
    expect(w.seen.filter((e) => e.type === 'run_end')).toHaveLength(1);
    expect(w.seen.some((e) => e.type === 'step' || e.type === 'attempt')).toBe(false);
    off();
    const heard: RunEvent[] = [];
    const leave = w.log.subscribe('t_goa', (e) => heard.push(e));
    leave();
    w.log.start('t_goa', 'buses.between', 'Buses');
    expect(heard).toEqual([]);
  });
});
