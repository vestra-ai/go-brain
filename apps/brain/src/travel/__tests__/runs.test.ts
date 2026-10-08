import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../book/run-event.js';
import { createRunLog, GROUP_JOIN_MS, KEPT_EVENTS, KEPT_FRAME_RUNS, type LiveEvent } from '../runs.js';

function world() {
  let nowMs = Date.parse('2026-10-08T06:00:00Z');
  const log = createRunLog({ now: () => new Date(nowMs) });
  const seen: LiveEvent[] = [];
  log.subscribe('t_goa', (e) => seen.push(e));
  const start = (run_id: string, recipe_id: string, more: Partial<Extract<RunEvent, { type: 'run_start' }>> = {}): void =>
    log.record('t_goa', { type: 'run_start', run_id, recipe_id, label: 'Goa', speed: 'page', at: new Date(nowMs).toISOString(), ...more });
  const end = (run_id: string, ms: number, more: Partial<Extract<RunEvent, { type: 'run_end' }>> = {}): void =>
    log.record('t_goa', { type: 'run_end', run_id, ok: true, ms, ...more });
  const groupOf = (runId: string): string | undefined => {
    const s = seen.find((e) => e.type === 'run_start' && e.run_id === runId);
    return s?.type === 'run_start' ? s.group_id : undefined;
  };
  return { log, seen, start, end, groupOf, advance: (ms: number) => { nowMs += ms; } };
}

const ends = (seen: LiveEvent[]) => seen.filter((e) => e.type === 'group_end');

describe('the run log', () => {
  it("passes the engine's events on as they are, a run's start with the group it is in", () => {
    const w = world();
    w.start('r1', 'trains.between', { speed: 'fast' });
    w.log.record('t_goa', { type: 'call', run_id: 'r1', method: 'GET', path: 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search', status: 200, at_ms: 380, ms: 366 });
    w.advance(400);
    w.end('r1', 400, { rows: 6 });
    expect(w.seen.map((e) => e.type)).toEqual(['run_start', 'call', 'run_end', 'group_end']);
    expect(w.seen[0]).toMatchObject({ run_id: 'r1', recipe_id: 'trains.between', speed: 'fast', group_id: w.groupOf('r1') });
    expect(ends(w.seen)).toEqual([{ type: 'group_end', group_id: w.groupOf('r1'), runs: 1, wall_ms: 400, sum_ms: 400 }]);
  });

  it('runs that overlap are one group, its wall time set against the sum; the next run after it starts a new one', () => {
    const w = world();
    w.start('r1', 'flights.search');
    w.advance(100);
    w.start('r2', 'trains.between', { speed: 'fast' });
    w.advance(400);
    w.end('r2', 400);
    w.advance(3_600);
    w.end('r1', 4_100);
    w.start('r3', 'buses.between');
    expect(w.groupOf('r2')).toBe(w.groupOf('r1'));
    expect(w.groupOf('r3')).not.toBe(w.groupOf('r1'));
    expect(ends(w.seen)).toEqual([{ type: 'group_end', group_id: w.groupOf('r1'), runs: 2, wall_ms: 4_100, sum_ms: 4_500 }]);
  });

  it("a lookup is in its search's group and never counts in it; a fallen speed's next one keeps the group open", () => {
    const w = world();
    w.start('s1', 'trains.between', { speed: 'fast' });
    w.start('k1', 'trains.station_lookup', { parent: 's1' });
    w.advance(300);
    w.end('k1', 300, { picked: 'Udaipur City (UDZ)' });
    w.advance(200);
    // The fast speed fails: nothing is going for a moment, but the page speed is coming.
    w.end('s1', 500, { ok: false, fell_to: 'page', why: 'unreachable: 403' });
    expect(ends(w.seen)).toEqual([]);
    w.start('s2', 'trains.between', { fell_from: 's1' });
    w.advance(1_500);
    w.end('s2', 1_500, { rows: 6 });
    expect([w.groupOf('k1'), w.groupOf('s2')]).toEqual([w.groupOf('s1'), w.groupOf('s1')]);
    expect(ends(w.seen)).toEqual([{ type: 'group_end', group_id: w.groupOf('s1'), runs: 1, wall_ms: 2_000, sum_ms: 2_000 }]);
  });

  it('a group left open by a run that never ended takes no new run after a minute', () => {
    const w = world();
    w.start('lost', 'hotels.search');
    w.advance(GROUP_JOIN_MS + 1);
    w.start('later', 'buses.between');
    expect(w.groupOf('later')).not.toBe(w.groupOf('lost'));
  });

  it("keeps the newest runs' pictures apart from the events, for a new viewer", () => {
    const w = world();
    for (let i = 0; i < KEPT_FRAME_RUNS + 2; i++) {
      w.log.record('t_goa', { type: 'frames', run_id: `r${i}`, frames: [{ label: 'results', at_ms: 100, page: '/hotels/search/result', jpeg_base64: '/9j/AA==' }] });
    }
    const kept = w.log.recent('t_goa').filter((e) => e.type === 'frames');
    expect(kept.map((e) => e.type === 'frames' && e.run_id)).toEqual(['r2', 'r3', 'r4', 'r5']);
    expect(w.seen.filter((e) => e.type === 'frames')).toHaveLength(KEPT_FRAME_RUNS + 2);
  });

  it('keeps the last events per trip, and a trip with none answers an empty list', () => {
    const w = world();
    w.start('r1', 'hotels.search');
    for (let i = 0; i < KEPT_EVENTS + 20; i++) w.log.record('t_goa', { type: 'step', run_id: 'r1', text: `step ${i}`, at_ms: i });
    const recent = w.log.recent('t_goa');
    expect(recent).toHaveLength(KEPT_EVENTS);
    expect(recent.at(-1)).toMatchObject({ type: 'step', text: `step ${KEPT_EVENTS + 19}` });
    expect(w.log.recent('t_other')).toEqual([]);
  });

  it('a viewer that throws never reaches the engine, and one that left hears nothing', () => {
    const w = world();
    const off = w.log.subscribe('t_goa', () => {
      throw new Error('viewer down');
    });
    expect(() => w.start('r1', 'hotels.search')).not.toThrow();
    off();
    const heard: LiveEvent[] = [];
    const leave = w.log.subscribe('t_goa', (e) => heard.push(e));
    leave();
    w.start('r2', 'buses.between');
    expect(heard).toEqual([]);
  });
});
