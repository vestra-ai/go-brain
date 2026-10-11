import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reply } from '../../__tests__/fixtures/fake-anthropic.js';
import { afterTools, bodyText, goaWithStayVote, startMoneyRoom } from './money-room.js';

let room: Awaited<ReturnType<typeof startMoneyRoom>>;

/**
 * The model: once Rahul has said he will pay it sets the mandate with him as the payer. After a tool it says what Go told
 * it to say. The closed stays vote's own turn needs no model (claim-taps.ts stayClosedAnswer), and nothing else wakes it
 * to act.
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
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing for Go' } }] };
}

beforeAll(async () => {
  room = await startMoneyRoom({ script });
}, 30_000);
afterAll(async () => {
  await room.stop();
});

describe('claiming in words as a vote closes (contract 1.1 A10)', () => {
  it('the closed vote says the stay and its I\'ll book it at once; "I will pay for it" right after is Rahul\'s claim, and Go says so', async () => {
    const s = room.server;
    await s.createTrip(goaWithStayVote('open'));
    for (const [person, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1], ['p_meher', 0], ['p_kabir', 0]] as const) {
      await s.vote('d_villa', person, option);
    }
    if (s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.status === 'open') await s.closeVoteByTime('d_villa');
    // The stay comes first (Saket's test, 11 Oct): one plain line and its I'll book it, nothing about flights.
    const closed = await s.waitFor(() => s.messages().find((m) => m.author.kind === 'go' && m.text?.includes("Villa Sol it is. Tap I'll book it to book it.")), 10_000);
    expect(closed.text).not.toMatch(/flight|tell me when/i);
    await s.waitFor(() => s.messages().find((m) => m.card?.card_id === 'c_claim_d_villa'), 10_000);
    await s.say('p_rahul', '@Go Villa Sol it is, I will pay for it');

    const mandate = await s.waitFor(() => s.trip().decisions.find((d) => d.decision_id === 'd_villa')?.mandate, 10_000);
    expect(mandate).toMatchObject({ choice_index: 0, payer_person_id: 'p_rahul' });
    const posted = await s.waitFor(() => s.messages().find((m) => m.card?.kind === 'mandate'), 10_000);
    expect(posted.text).toMatch(new RegExp(`^Rahul, you.re booking for all ${s.trip().people.length}\\. `));

    // His words took it: the card says he is booking, and nobody else can.
    await s.waitFor(() => (s.messages().find((m) => m.card?.card_id === 'c_claim_d_villa')?.card?.title === `Rahul is booking for all ${s.trip().people.length}` ? true : null), 10_000);
    expect(await s.tap('c_claim_d_villa', 'claim', 'p_priya')).toMatchObject({ result: 'refused', toast: 'Rahul is already booking this.' });
  });
});
