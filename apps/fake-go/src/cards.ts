// The five Go cards the fake Go posts, one kind after another, so the App can draw each one and the Server can
// store and forward each one. Every card passes the contract's Card schema. The pay card is a test card: its
// approval_id is fake (ap_fake_...) and nothing is ever charged.
import type { Card } from '@go/contract';

export const FAKE_CARD_KINDS = ['options', 'working', 'call', 'pay', 'notice'] as const;
export type FakeCardKind = (typeof FAKE_CARD_KINDS)[number];

export interface CardContext {
  /** A running number, so every card_id is new. */
  n: number;
  payerId: string;
  publicUrl: string;
  now: Date;
}

export function fakeCard(kind: FakeCardKind, c: CardContext): Card {
  const n = String(c.n).padStart(4, '0');
  const at = c.now.toISOString();
  const card_id = `c_fake_${n}_${kind}`;
  switch (kind) {
    case 'options':
      return {
        kind,
        card_id,
        fallback_text: 'Two test flights from the fake Go, Delhi to Goa, from ₹5,640 per person.',
        title: 'Test flights, Delhi to Goa',
        option_kind: 'flight',
        checked_at: at,
        options: [
          {
            option_id: `opt_fake_${n}_1`,
            title: 'IndiGo 6E 2134',
            subtitle: '6:10 pm to 8:45 pm, non-stop',
            price_minor: 592000,
            currency: 'INR',
            price_note: 'per person',
            highlights: ['Non-stop', 'Test data'],
            journey: {
              mode: 'flight',
              origin: { name: 'Delhi', code: 'DEL' },
              destination: { name: 'Goa', code: 'GOI' },
              depart_at: '2026-11-06T18:10:00+05:30',
              arrive_at: '2026-11-06T20:45:00+05:30',
              carrier_name: 'IndiGo',
              carrier_code: '6E',
              number: '6E 2134',
              stops: 0,
            },
          },
          {
            option_id: `opt_fake_${n}_2`,
            title: 'IndiGo, 9:20 pm',
            subtitle: '9:20 pm to 11:55 pm, non-stop',
            price_minor: 564000,
            currency: 'INR',
            price_note: 'per person',
            highlights: ['Cheapest', 'Test data'],
          },
        ],
        actions: [
          { action_id: 'pick', label: "I'll take this", style: 'primary', per_option: true },
          { action_id: 'vote', label: 'Put it to a vote', style: 'secondary' },
        ],
      };
    case 'working':
      return {
        kind,
        card_id,
        fallback_text: 'The fake Go is working on a test job.',
        task_id: `task_fake_${n}`,
        title: 'A test job from the fake Go',
        state: 'running',
        steps: [
          { text: 'Open the test website', state: 'done' },
          { text: 'Look through the test results', state: 'doing' },
          { text: 'Pick the best three', state: 'todo' },
        ],
        updated_at: at,
        actions: [
          { action_id: 'watch', label: 'Watch', style: 'primary' },
          { action_id: 'stop', label: 'Stop', style: 'secondary' },
        ],
      };
    case 'call':
      return {
        kind,
        card_id,
        fallback_text: 'The fake Go is on a test call to Test Villa.',
        call_id: `call_fake_${n}`,
        business: 'Test Villa',
        goal: 'A test call from the fake Go',
        state: 'talking',
        started_at: at,
        last_line: { who: 'them', text: 'This is a test line from the fake Go.' },
        actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' }],
      };
    case 'pay':
      return {
        kind,
        card_id,
        fallback_text: 'A test payment from the fake Go: ₹1,000. Nothing is charged.',
        for_person_ids: [c.payerId],
        approval_id: `ap_fake_${n}`, // fake: not a spend approval, and nothing can be paid with it
        payer_person_id: c.payerId,
        amount_minor: 100000,
        currency: 'INR',
        merchant: 'Fake Go test merchant',
        purpose: 'A test payment. Nothing is charged.',
        expires_at: new Date(c.now.getTime() + 10 * 60_000).toISOString(),
        state: 'waiting',
        actions: [
          { action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: [c.payerId] },
          { action_id: 'decline', label: 'Decline', style: 'secondary', only_for_person_ids: [c.payerId] },
        ],
      };
    case 'notice':
      return {
        kind,
        card_id,
        fallback_text: 'Good to know: this notice comes from the fake Go.',
        tone: 'info',
        title: 'Good to know (a test)',
        body: 'This notice comes from the fake Go, so the App can draw it. The real Go puts news and deadlines here, with where it got them.',
        source: { name: 'the fake Go' },
        checked_at: at,
      };
  }
}
