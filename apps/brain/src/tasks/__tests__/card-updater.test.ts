import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLink } from '../testing/lane-brain.js';
import { createCardUpdater } from '../card-updater.js';
import type { WorkingCardT } from '../working-card.js';

const card = (n: number, state: WorkingCardT['state'] = 'running'): WorkingCardT => ({
  card_id: 'c_work_1', kind: 'working', fallback_text: `v${n}`, task_id: 'gt_1', title: 'Finding villas', state, steps: [], updated_at: '2026-10-07T12:00:00.000Z', actions: [],
});

describe('the card updater', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function posted(link: FakeLink, n: number) {
    await link.request('post_message', { trip_id: 't_goa', request_id: `go_${n}`, card: card(0) });
  }

  it('sends the first update at once, folds the ones in the next 6 s into the newest, and sends a state change at once', async () => {
    const link = new FakeLink();
    await posted(link, 1);
    const log = { warn: vi.fn() };
    const cards = createCardUpdater({ link, log });
    cards.push('t_goa', card(1));
    await vi.advanceTimersByTimeAsync(0);
    cards.push('t_goa', card(2));
    cards.push('t_goa', card(3));
    await vi.advanceTimersByTimeAsync(1000);
    expect(link.sent('replace_card').map((p) => (p.card as WorkingCardT).fallback_text)).toEqual(['v1']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(link.sent('replace_card').map((p) => (p.card as WorkingCardT).fallback_text)).toEqual(['v1', 'v3']);
    cards.push('t_goa', card(4));
    cards.push('t_goa', card(5, 'done'), { now: true });
    await cards.flush();
    expect(link.sent('replace_card').map((p) => (p.card as WorkingCardT).fallback_text)).toEqual(['v1', 'v3', 'v5']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('tries a failed update once more a little later, for a card that rides with a turn and is not posted yet', async () => {
    const link = new FakeLink();
    const log = { warn: vi.fn() };
    const cards = createCardUpdater({ link, log, gapMs: 0, retryMs: 3000 });
    cards.push('t_goa', card(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await posted(link, 2);
    await vi.advanceTimersByTimeAsync(3000);
    await cards.flush();
    expect(link.sent('replace_card')).toHaveLength(2);
    expect(link.card('c_work_1')?.fallback_text).toBe('v1');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
