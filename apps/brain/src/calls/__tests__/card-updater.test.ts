import { describe, expect, it } from 'vitest';
import { manualTime } from '../../proactive/fakes.js';
import { CardUpdater } from '../card-updater.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('CardUpdater', () => {
  it('sends at once, then at most once every 3 s with the latest card', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    const u = new CardUpdater<string>(async (c) => { sent.push(c); }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    u.update('c');
    await flush();
    expect(sent).toEqual(['a']);
    time.advance(2999);
    await flush();
    expect(sent).toEqual(['a']);
    time.advance(1);
    await flush();
    expect(sent).toEqual(['a', 'c']);
  });

  it('always sends the final card, dropping a pending one', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    const u = new CardUpdater<string>(async (c) => { sent.push(c); }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    await u.final('end');
    u.update('late');
    time.advance(10_000);
    await flush();
    expect(sent).toEqual(['a', 'end']);
  });

  it('keeps going after a failed update', async () => {
    const time = manualTime('2026-10-06T10:00:00Z');
    const sent: string[] = [];
    let fail = true;
    const u = new CardUpdater<string>(async (c) => {
      if (fail) { fail = false; throw new Error('server busy'); }
      sent.push(c);
    }, { now: time.now, schedule: time.schedule, minGapMs: 3000, log: { warn: () => {} } });
    u.update('a');
    await flush();
    u.update('b');
    time.advance(3000);
    await flush();
    expect(sent).toEqual(['b']);
  });
});
