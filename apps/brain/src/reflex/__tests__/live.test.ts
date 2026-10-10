import { describe, expect, it } from 'vitest';
import { SWITCH_RULES } from '../../admin/switches.js';
import type { Brain } from '../../app.js';
import { silentLog } from '../../log.js';
import { parseLive } from '../live.js';
import { registerReflex } from '../register.js';

describe('parseLive', () => {
  it('reads numbers or names and keeps only questions whose test set passed', () => {
    expect([...parseLive('q1,q2,q3', [1, 2, 3]).live]).toEqual(['for_go', 'complete', 'size']);
    expect([...parseLive('q8,q1', [1, 8]).live]).toEqual(['for_go', 'risky']);
    expect([...parseLive('q1,q2,q3,q4', [1, 2, 3]).live]).toEqual(['for_go', 'complete', 'size']);
    expect([...parseLive('q1,q2,q3,q4,q5,q6,q7,q8,q9', [1, 2, 3, 8]).live]).toEqual(['for_go', 'complete', 'size', 'risky']);
  });
  it('treats "off" as no call and an empty value as all shadow', () => {
    expect(parseLive('off', [1, 2, 3])).toEqual({ call: false, live: new Set() });
    expect(parseLive('', [1, 2, 3])).toEqual({ call: true, live: new Set() });
    expect(parseLive('banana, q12, 1', [1, 2, 3]).live.size).toBe(0);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('off')).toBe(true);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('q1,q2,q3')).toBe(true);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('all')).toBe(false);
  });
  it('reads questions 10 and 11, and still nothing past them', () => {
    expect([...parseLive('q1,q10', [1, 10]).live]).toEqual(['for_go', 'recipe']);
    expect([...parseLive('q10', [1]).live]).toEqual([]);
    expect([...parseLive('q1,q11', [1, 11]).live]).toEqual(['for_go', 'actionable']);
    expect(parseLive('q11,q100', [1, 10]).live.size).toBe(0);
    expect(parseLive('q12', [12]).live.size).toBe(0);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('q1,q10')).toBe(true);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('q1,q11')).toBe(true);
    expect(SWITCH_RULES.REFLEX_LIVE.valid('q1,q12')).toBe(false);
  });
});

describe('registerReflex', () => {
  it('replaces the stub and hands its keep-warm stop to brain.onStop', async () => {
    const stops: Array<() => Promise<void> | void> = [];
    // No TYPESAFE_API_KEY: the client makes no request and starts no timer, so the test stays offline.
    const brain = {
      env: { TYPESAFE_BASE_URL: 'https://jev.example', JEV_MODEL: 'jev-1.13.0', JEV_DEADLINE_MS: 450, JEV_DAILY_CALLS_PER_TRIP: 0 },
      pool: {},
      switches: { get: () => 'off', set: async () => undefined },
      now: () => new Date('2026-10-07T10:00:00Z'),
      log: silentLog,
      reflex: null,
      hooks: { onRead: () => undefined }, // Task 17 (prefetch) adds an onRead hook here
      onStop: (fn: () => Promise<void> | void) => {
        stops.push(fn);
      },
    } as unknown as Brain;
    await registerReflex(brain);
    expect(brain.reflex).not.toBeNull();
    expect(stops).toHaveLength(1);
    await stops[0]!();
  });
});
