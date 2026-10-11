import { describe, expect, it } from 'vitest';
import { msg } from '../../__tests__/fixtures/goa.js';
import type { TurnCtx } from '../../composer/tools.js';
import type { DeskItem } from '../../desk/desk.js';
import { ALL_SHOWN, LOOKING_FOR_MORE, MORE_ON_THE_WAY, type SeeMoreAnswer } from '../see-more.js';
import { typedMoreAnswer } from '../typed-more.js';

describe('a typed "more"', () => {
  // The lead's tone drill on prod, 11 Oct: "more" got "On it." with its live card, then "Looking for more on ixigo." as a
  // second line of its own.
  it('says a See more toast only when it is an outcome, never "still looking" beside the live card', async () => {
    const card = { kind: 'options', card_id: 'c_opt_1', title: 'Stays in Goa', options: [], fallback_text: 'Stays in Goa' };
    const pack = { trip: {}, messages: [msg(10, null, 'Stays in Goa.', { card } as never), msg(11, 'p_meher', 'more')], seq: 11 };
    const wake: DeskItem[] = [{ id: 'msg:t_goa:m_11', tripId: 't_goa', kind: 'message', ref: 'm_11', dueAt: new Date(), payload: { messageId: 'm_11' } }];
    const run = async (answer: SeeMoreAnswer): Promise<string[]> => {
      const ctx = { lines: [] as string[], answered: false } as unknown as TurnCtx;
      const typed = typedMoreAnswer({
        seeMore: async () => answer,
        results: { card: async () => ({ cardId: 'c_opt_1', card: { decision_id: 'd_1' }, optionKind: 'stay' }) as never },
      });
      expect(await typed({ tripId: 't_goa', wake, pack: pack as never, ctx })).toBe(true);
      expect(ctx.answered).toBe(true);
      return ctx.lines;
    };
    expect(await run({ result: 'done', toast: LOOKING_FOR_MORE })).toEqual([]);
    expect(await run({ result: 'done', toast: MORE_ON_THE_WAY })).toEqual([]);
    expect(await run({ result: 'done' })).toEqual([]);
    // An outcome is still said.
    expect(await run({ result: 'done', toast: ALL_SHOWN })).toEqual([`${ALL_SHOWN}.`]);
  });
});
