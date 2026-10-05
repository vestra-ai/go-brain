import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Card, Event, Message, PostMessage, ROUTES, SpendApprovalResult, TripSnapshot } from '../index.js';

const at = '2026-10-05T07:00:00Z';

describe('contract schemas', () => {
  it('a message from Go needs text, a card, or both', () => {
    expect(PostMessage.safeParse({ request_id: 'rq_1' }).success).toBe(false);
    expect(PostMessage.safeParse({ request_id: 'rq_1', text: 'Booked.' }).success).toBe(true);
    expect(PostMessage.safeParse({ request_id: 'rq_1', card: { card_id: 'c_1', kind: 'plan', fallback_text: 'The plan' } }).success).toBe(true);
  });
  it('every card needs fallback text', () => {
    expect(Card.safeParse({ card_id: 'c_1', kind: 'ticket', booking_id: 'b_1' }).success).toBe(false);
  });
  it('an unknown card kind or event type is refused here (readers skip what they do not know; writers never send it)', () => {
    expect(Card.safeParse({ card_id: 'c_1', kind: 'confetti', fallback_text: 'x' }).success).toBe(false);
    expect(Event.safeParse({ event_id: 'e', trip_id: 't', seq: 1, occurred_at: at, type: 'trip.exploded', data: {} }).success).toBe(false);
  });
  it('unknown fields are ignored, so either side can add fields without breaking the other', () => {
    const r = Event.parse({ event_id: 'e', trip_id: 't', seq: 1, occurred_at: at, type: 'person.left', data: { person_id: 'p', mood: 'sad' }, extra: 1 });
    expect(r.type).toBe('person.left');
  });
  it('links must be http or https', () => {
    const photo = (url: string) => Message.shape.attachments.element.safeParse({ kind: 'photo', url });
    expect(photo('https://cdn.example.com/a.jpg').success).toBe(true);
    expect(photo('javascript:alert(1)').success).toBe(false);
  });
  it('money is whole minor units, never a float', () => {
    const r = SpendApprovalResult.safeParse({ status: 'approved', approval_id: 'ap', approval: 'x.y.z', expires_at: at });
    expect(r.success).toBe(true);
    expect(TripSnapshot.shape.money.shape.spent_minor.safeParse(10.5).success).toBe(false);
  });
  it('the trip snapshot never carries who picked which budget', () => {
    expect(Object.keys(TripSnapshot.shape.budget.shape).sort()).toEqual(['answered', 'lowest', 'of']);
  });
  it('every route body is a named schema, so OpenAPI and the Python models get real names', () => {
    for (const r of ROUTES) for (const s of [r.request, r.response]) if (s) expect(z.globalRegistry.get(s)?.id, r.id).toBeTruthy();
  });
});
