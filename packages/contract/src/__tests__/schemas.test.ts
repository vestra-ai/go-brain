import { describe, expect, it } from 'vitest';
import { MessageIn, MessageOut, SpendApprovalResponse, TripState } from '../index.js';

describe('contract schemas', () => {
  it('reads a room message and fills the defaults', () => {
    const m = MessageIn.parse({ message_id: 'm1', trip_id: 't1', member: { id: 'p', name: 'Priya' }, text: 'scuba sunday?', sent_at: '2026-10-05T10:00:00+05:30' });
    expect(m.mentions_go).toBe(false);
    expect(m.attachments).toEqual([]);
  });
  it('a message from Go needs text or a card', () => {
    expect(MessageOut.safeParse({ out_id: 'o1', trip_id: 't1', sent_at: '2026-10-05T10:00:00Z' }).success).toBe(false);
    expect(MessageOut.safeParse({ out_id: 'o1', trip_id: 't1', text: 'Booked.', sent_at: '2026-10-05T10:00:00Z' }).success).toBe(true);
  });
  it('a live card updates in place', () => {
    const m = MessageOut.parse({ out_id: 'o2', trip_id: 't1', sent_at: '2026-10-05T10:00:00Z',
      card: { id: 'c-booking', upsert: true, body: { kind: 'live', title: 'Booking Villa Sol', state: 'running', progress: { done: 3, total: 4 } } } });
    expect(m.card?.body.kind).toBe('live');
  });
  it('a spend approval answer is either a token or a reason', () => {
    expect(SpendApprovalResponse.parse({ status: 'denied', reason: 'over_cap' }).status).toBe('denied');
    expect(SpendApprovalResponse.safeParse({ status: 'approved' }).success).toBe(false);
  });
  it('trip state never carries who picked which budget', () => {
    const t = TripState.parse({ id: 't1', title: 'Goa', budget: { lowest: null, answered: 3, of: 5 }, members: [], decisions: [], bookings: [],
      money: { total_minor: 0, currency: 'INR', each_minor: 0 } });
    expect(Object.keys(t.budget).sort()).toEqual(['answered', 'lowest', 'of']);
  });
});
