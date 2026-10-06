import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLink } from '../../__tests__/fixtures/fake-link.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { withSchema } from '../../db/test-db.js';
import { SocketCallError } from '../../door/rpc.js';
import { reactOnce, withholdCheck } from '../reactions.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(() => db.drop());

describe('a ✅ and taking it back, on one message', () => {
  it('never interleave: a take-back started while the ✅ is on its way waits for it, then takes it back once', async () => {
    const { link, calls } = fakeLink({ add_reaction: () => ({ seq: 1 }), remove_reaction: () => ({ seq: 2 }) });
    const m = msg(5, 'p_priya', 'paid something for the snacks');
    const sending = reactOnce(db.pool, link, 't_rx', m, '✅');
    const back = withholdCheck(db.pool, link, 't_rx', 'm_5');
    expect(await sending).toBe('sent');
    expect(await back).toBe('taken_back');
    expect(calls.map((c) => c.method)).toEqual(['add_reaction', 'remove_reaction']);
    expect(calls[1]?.params).toMatchObject({ trip_id: 't_rx', message_id: 'm_5', emoji: '✅', request_id: expect.stringMatching(/^go_unreact_[0-9a-f]{24}$/) });
    // Taking it back again does nothing, and a later ✅ (the notes pass) is never sent.
    expect(await withholdCheck(db.pool, link, 't_rx', 'm_5')).toBe('held');
    expect(await reactOnce(db.pool, link, 't_rx', m, '✅')).toBe('skipped');
    expect(calls).toHaveLength(2);
  });

  it('holds a message with no ✅ yet without a call, and a ✅ the Server no longer has counts as taken back', async () => {
    const { link, calls } = fakeLink({
      add_reaction: () => ({ seq: 3 }),
      remove_reaction: () => { throw new SocketCallError(404, 'no such reaction', 'not_found'); },
    });
    expect(await withholdCheck(db.pool, link, 't_rx', 'm_6')).toBe('held');
    expect(await reactOnce(db.pool, link, 't_rx', msg(6, 'p_arjun', 'paid for the boat'), '✅')).toBe('skipped');
    expect(calls).toEqual([]);
    const m = msg(7, 'p_kabir', 'got the tickets');
    expect(await reactOnce(db.pool, link, 't_rx', m, '✅')).toBe('sent');
    expect(await withholdCheck(db.pool, link, 't_rx', 'm_7')).toBe('taken_back');
    expect(await reactOnce(db.pool, link, 't_rx', m, '✅')).toBe('skipped');
    expect(calls.map((c) => c.method)).toEqual(['add_reaction', 'remove_reaction']);
  });
});
