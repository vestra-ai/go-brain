import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { createSwitches } from '../switches.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

function clock(start = Date.parse('2026-10-06T09:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

describe('switches', () => {
  it('reads the stored value, else the environment, else the safe default', async () => {
    const c = clock();
    const s = createSwitches({ pool: db.pool, env: { TRAVEL_MODE: 'ixigo' }, now: c.now });
    await s.refresh();
    expect(s.get('TRAVEL_MODE')).toBe('ixigo');
    expect(s.get('PAY_RAIL')).toBe('fake');
    expect(s.get('CALLS_MODE')).toBe('off');
    expect(s.get('REFLEX_LIVE')).toBe('');
    await s.set('TRAVEL_MODE', 'fake');
    expect(s.get('TRAVEL_MODE')).toBe('fake');
  });

  it('refuses a value the switch cannot hold', async () => {
    const s = createSwitches({ pool: db.pool, env: {}, now: clock().now });
    await expect(s.set('PAY_RAIL', 'card')).rejects.toThrow(/PAY_RAIL/);
    await expect(s.set('CALLS_MODE', 'everyone')).rejects.toThrow(/CALLS_MODE/);
    await expect(s.set('REFLEX_LIVE', 'q1,q11')).rejects.toThrow(/REFLEX_LIVE/);
    await expect(s.set('REFLEX_LIVE', 'off,q1')).rejects.toThrow(/REFLEX_LIVE/);
    await s.set('REFLEX_LIVE', 'q1,q2,q3');
  });

  it('REFLEX_LIVE also holds "off", the reflex kill switch (no Jev call at all)', async () => {
    const s = createSwitches({ pool: db.pool, env: {}, now: clock().now });
    await s.set('REFLEX_LIVE', 'off');
    expect(s.get('REFLEX_LIVE')).toBe('off');
    await s.set('REFLEX_LIVE', '');
    expect(s.get('REFLEX_LIVE')).toBe('');
  });

  it('another copy of the service sees a change within 2 seconds, with no redeploy', async () => {
    const c = clock();
    const a = createSwitches({ pool: db.pool, env: {}, now: c.now });
    const b = createSwitches({ pool: db.pool, env: {}, now: c.now });
    await a.refresh();
    await b.refresh();
    await a.set('CALLS_MODE', 'allowlist');
    c.advance(1_000);
    expect(b.get('CALLS_MODE')).toBe('off');
    c.advance(1_500);
    b.get('CALLS_MODE');
    await vi.waitFor(() => expect(b.get('CALLS_MODE')).toBe('allowlist'));
  });
});
