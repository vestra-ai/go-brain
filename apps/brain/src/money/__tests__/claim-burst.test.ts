import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reply } from '../../__tests__/fixtures/fake-anthropic.js';
import { afterTools, bodyText, goaWithStayVote, startMoneyRoom } from './money-room.js';

let room: Awaited<ReturnType<typeof startMoneyRoom>>;
/** The closed vote's turn is on its first model round. */
let closing = false;

/**
 * The model: on the closed vote's turn it says the result (slowly: 2.5 s, so Rahul's line lands while it works and the
 * turn pulls it in), and once Rahul has said he will pay it sets the mandate with him as the payer. After a tool it says
 * what Go told it to say. Nothing else wakes it to act.
 */
function script(body: any): Reply {
  const text = bodyText(body);
  if (afterTools(body)) {
    const said = /Rahul, you're booking for all \d+\./.exec(text);
    return { text: said ? `${said[0]} Tap Yes, book it when you're ready.` : 'Done.' };
  }
  if (text.includes('I will pay for it')) {
    return { tools: [{ name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, refundable_only: false, payer_person_id: 'p_rahul' } }] };
  }
  if (text.includes('Villa Sol</data> won (')) {
    closing = true;
    return { text: 'Villa Sol won, 4 to 1.', delayMs: 2_500 };
  }
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] };
}

beforeAll(async () => {
  room = await startMoneyRoom({ script });
}, 30_000);
afterAll(async () => {
  await room.stop();
});

describe('claiming in words in the burst as a vote closes (contract 1.1 A10)', () => {
  it('"I will pay for it" lands while the closed vote\'s turn works: that turn pulls it in, Rahul holds the claim, and Go says so', async () => {
    const s = room.server;
    await s.createTrip(goaWithStayVote('open'));
    const tripId = s.trip().trip_id;
    for (const [person, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1], ['p_meher', 0], ['p_kabir', 0]] as const) {
      await s.vote('d_villa', person, option);
    }
    if (s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.status === 'open') await s.closeVoteByTime('d_villa');
    await s.waitFor(() => (closing ? true : null), 10_000);
    await s.say('p_rahul', '@Go Villa Sol it is, I will pay for it');

    const mandate = await s.waitFor(() => s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.mandate, 10_000);
    expect(mandate).toMatchObject({ choice_index: 0, payer_person_id: 'p_rahul' });
    const posted = await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'mandate'), 10_000);
    expect(posted.text).toMatch(new RegExp(`^Rahul, you.re booking for all ${s.trip().people.length}\\. `));

    // One turn: the vote's result and Rahul's line, both answered by the turn the closed vote woke.
    const { rows } = await room.db.pool.query<{ kind: string; turn_id: string }>("select kind, turn_id from desk_items where trip_id = $1 and kind in ('message', 'trip_change')", [tripId]);
    expect(rows.map((r) => r.kind).sort()).toEqual(['message', 'trip_change']);
    expect(new Set(rows.map((r) => r.turn_id)).size).toBe(1);
    // Rahul already took it, so nobody is asked to tap I'll book it.
    expect(s.messages().some((m) => m.card?.card_id === 'c_claim_d_villa')).toBe(false);
  });
});
