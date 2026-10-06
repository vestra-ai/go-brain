import type { HealthJson } from '@go/brain/dist/admin/register.js';
import { describe, expect, it } from 'vitest';
import { BeatTimer, formatSheet, logLine, passed, preflight, type BeatRun } from '../sheet.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** quiet passed, flights in 2.1 s, the notice 0.5 s late, memory never answered, the rest not reached. */
function sampleRuns(): BeatRun[] {
  const c = clock();
  const timer = new BeatTimer(c.now);
  timer.check('quiet', true, '3 lines, Go said nothing');
  const flights = c.now();
  c.advance(2_100);
  timer.done('flights', flights);
  const notice = c.now();
  c.advance(2_500);
  timer.done('notice', notice);
  timer.miss('memory', 'nothing in 20.0 s');
  return timer.results();
}

describe('the beat timer', () => {
  it('passes a beat inside its budget, fails one over it, and keeps the run sheet order with beats never reached', () => {
    const c = clock();
    const timer = new BeatTimer(c.now);
    const weather = c.now();
    c.advance(1_200);
    timer.done('weather', weather, { ok: false, note: 'the villa job was done' });
    // A beat timed to when it happened, not to when the runner wrote it down.
    const forget = c.now();
    c.advance(5_000);
    timer.done('forget', forget, { endedAt: forget + 1_500 });
    const runs = [...sampleRuns()];
    expect(runs.map((r) => r.id)).toEqual([
      'quiet', 'flights', 'villa_start', 'call_line', 'weather', 'call', 'call_outcome', 'villa_done', 'pay_card',
      'notice', 'refusal_en', 'refusal_hi', 'memory', 'forget',
    ]);
    expect(runs.find((r) => r.id === 'flights')).toMatchObject({ ms: 2_100, result: 'PASS', note: '' });
    expect(runs.find((r) => r.id === 'notice')).toMatchObject({ ms: 2_500, result: 'FAIL', note: 'over by 0.5 s' });
    expect(runs.find((r) => r.id === 'memory')).toMatchObject({ ms: null, result: 'FAIL', note: 'nothing in 20.0 s' });
    expect(runs.find((r) => r.id === 'call')).toMatchObject({ ms: null, result: 'NOT REACHED' });
    expect(timer.results().find((r) => r.id === 'weather')).toMatchObject({ ms: 1_200, result: 'FAIL', note: 'the villa job was done' });
    expect(timer.results().find((r) => r.id === 'forget')).toMatchObject({ ms: 1_500, result: 'PASS' });
  });

  it('keeps the first result for a beat', () => {
    const c = clock();
    const timer = new BeatTimer(c.now);
    timer.miss('pay_card', 'not reached: no mandate card after the vote closed');
    const t = c.now();
    c.advance(100);
    timer.done('pay_card', t);
    expect(timer.results().find((r) => r.id === 'pay_card')).toMatchObject({ result: 'FAIL', note: 'not reached: no mandate card after the vote closed' });
  });

  it('a run passes only when every beat passed', () => {
    expect(passed(sampleRuns())).toBe(false);
    const c = clock();
    const timer = new BeatTimer(c.now);
    timer.check('quiet', true, '');
    timer.check('call_outcome', true, '');
    for (const id of ['flights', 'villa_start', 'call_line', 'weather', 'call', 'villa_done', 'pay_card', 'notice', 'refusal_en', 'refusal_hi', 'memory', 'forget'] as const) {
      const t = c.now();
      c.advance(500);
      timer.done(id, t);
    }
    expect(passed(timer.results())).toBe(true);
  });
});

describe('the sheet', () => {
  it("prints the run sheet's table with the totals, and no em dash", () => {
    const text = formatSheet(sampleRuns(), { go: 'https://brain.example.com', tripId: 't_reh_20261008133502', at: new Date('2026-10-08T13:35:02Z') });
    expect(text.split('\n')).toEqual([
      '# Rehearsal, 2026-10-08 19:05 (Asia/Kolkata)',
      '',
      'Go: https://brain.example.com. Trip: t_reh_20261008133502.',
      '',
      '| Time | Beat | Budget | Took | Result | Note |',
      '|---|---|---|---|---|---|',
      '| 0:15 | Quiet through the chatter | none | none | PASS | 3 lines, Go said nothing |',
      '| 0:30 | Flights card | 3.0 s | 2.1 s | PASS |  |',
      '| 0:45 | Working card for the villa job | 5.0 s | none | NOT REACHED |  |',
      '| 1:00 | Call announced, 30 s to say stop | 3.0 s | none | NOT REACHED |  |',
      '| 1:10 | Weather answer while the job runs | 3.0 s | none | NOT REACHED |  |',
      '| 1:30 | Call card dialing | 35.0 s | none | NOT REACHED |  |',
      '| 2:20 | Call outcome in the chat and the record | none | none | NOT REACHED |  |',
      '| 2:20 | Villa job done | 95.0 s | none | NOT REACHED |  |',
      '| 2:50 | Pay card after "Yes, book it" | 5.0 s | none | NOT REACHED |  |',
      '| 3:40 | Notice after the watch fires | 2.0 s | 2.5 s | FAIL | over by 0.5 s |',
      '| 3:55 | Refusal (English) | 3.0 s | none | NOT REACHED |  |',
      '| 3:55 | Refusal (Hinglish) | 3.0 s | none | NOT REACHED |  |',
      '| 4:10 | Memory answer | 3.0 s | none | FAIL | nothing in 20.0 s |',
      '| 4:20 | Forget answer | 3.0 s | none | NOT REACHED |  |',
      '',
      'Passed 2 of 14. Slowest against its budget: Notice after the watch fires, 2.5 s of 2.0 s.',
    ]);
    expect(text).not.toMatch(/[\u2014\u2013]/);
  });

  it("gives the row for the run sheet's rehearsal log", () => {
    expect(logLine(sampleRuns(), { run: '3', date: '2026-10-08' })).toBe('| 3 | 2026-10-08 | 2 of 14 | Notice after the watch fires, 2.5 s of 2.0 s |  |');
    expect(logLine(sampleRuns(), { run: '4', date: '2026-10-09', fixes: 'notice | slow promoter' })).toBe(
      '| 4 | 2026-10-09 | 2 of 14 | Notice after the watch fires, 2.5 s of 2.0 s | notice / slow promoter |',
    );
  });
});

describe('the checks before a rehearsal', () => {
  const health = (o: Partial<HealthJson> = {}): HealthJson => ({
    at: '2026-10-08T13:30:00.000Z', trip_id: 't_goa', server_socket_open: false, probes: [],
    switches: { TRAVEL_MODE: 'fake', PAY_RAIL: 'fake', CALLS_MODE: 'allowlist', REFLEX_LIVE: 'q1,q2,q3' },
    calls: { mode: 'allowlist', allowlist: ['Anjuna Dive Shop'], allowlist_count: 1 },
    ...o,
  });

  it('runs when calls go only to a list that has someone on it', () => {
    expect(preflight(health())).toEqual([]);
  });

  it('refuses when calls are on the allowlist but the list is empty', () => {
    const reasons = preflight(health({ calls: { mode: 'allowlist', allowlist: [], allowlist_count: 0 } }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/CALLS_ALLOWLIST is empty/);
    expect(reasons[0]).toMatch(/dive shop/);
  });

  it('does not mind an empty list while calls are off', () => {
    expect(preflight(health({ calls: { mode: 'off', allowlist: [], allowlist_count: 0 } }))).toEqual([]);
  });

  it('refuses when a Server is connected: that is the stage Go, and rehearsals never share it', () => {
    const reasons = preflight(health({ server_socket_open: true }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/brain-rehearsal/);
  });
});
