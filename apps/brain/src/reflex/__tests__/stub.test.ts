import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg } from '../../__tests__/fixtures/goa.js';
import { unsureReflex } from '../reflex.js';

describe('the reflex stub', () => {
  it('is unsure about everything, so the composer decides exactly as if Jev were not there', async () => {
    const read = await unsureReflex.read(msg(2, 'p_priya', 'lol'), { pack: { trip: goaSnapshot(), messages: [], seq: 2 }, runningTasks: [] });
    for (const k of ['forGo', 'complete', 'size', 'taskId', 'fact', 'recordKind', 'reaction', 'risky', 'opening'] as const) {
      expect(read[k]).toEqual({ value: null, sure: false });
    }
  });
});
