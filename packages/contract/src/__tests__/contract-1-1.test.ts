import { describe, expect, it } from 'vitest';
import {
  ActionOpen, AddExpense, Booking, Card, CardTap, CONTRACT_VERSION, CreateLink, Decision, Event, Expense, ItineraryItem, Message, Option, Place,
  PostMessage, TripSnapshot,
} from '../index.js';

// Contract 1.1: the Server team's additive proposal (A1 to A11, B1, B2, B3a, B4). Every addition is optional, so what
// 1.0 wrote still reads, and a 1.0 reader that ignores fields it does not know keeps working.
const at = '2026-10-08T07:00:00Z';

describe('contract 1.1', () => {
  it('is version 1.1.0', () => {
    expect(CONTRACT_VERSION).toBe('1.1.0');
  });

  it('A1 an option, and a vote option, can carry details; A2 a return leg, both prices, and cab', () => {
    const details = {
      gallery_urls: ['https://cdn.example.com/1.jpg'], caption: 'Sea view', why: ['Pool, as Priya asked'],
      costs: [{ label: 'Room, 3 nights', emoji: '🛏️', amount_minor: 1200000, currency: 'INR' }], total_minor: 1200000,
      amenities: ['Pool'], activities: ['Kayaking'], facts: [{ label: 'Check-in', value: '2 pm' }], cancellation: 'Free until 4 Nov',
      rating: 9.2, review_count: 141, go_note: 'The quietest of the three.',
    };
    const journey = {
      mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: at, arrive_at: at,
    };
    const option = { option_id: 'o_1', title: 'IndiGo 6E 2134', highlights: [], details, journey, return_journey: journey, price_oneway_minor: 592000, price_round_minor: 1100000 };
    expect(Option.parse(option).details?.rating).toBe(9.2);
    const card = { card_id: 'c_1', kind: 'options', fallback_text: 'Cabs', title: 'Cabs to Anjuna', option_kind: 'cab', checked_at: at, options: [option] };
    expect(Card.parse(card).kind).toBe('options');
    expect(Decision.shape.options.element.parse({ label: 'Villa Maya', details }).details?.go_note).toBe('The quietest of the three.');
    expect(CardTap.parse({ tap_id: 'tp_1', trip_id: 't', card_id: 'c_1', action_id: 'pick', person_id: 'p', option_id: 'o_1', payload: { trip: 'round' } }).payload?.trip).toBe('round');
    expect(CardTap.safeParse({ tap_id: 'tp_1', trip_id: 't', card_id: 'c_1', action_id: 'pick', person_id: 'p', payload: { trip: 'both' } }).success).toBe(false);
  });

  it('A3 Go can offer up to six quick replies, kept on the message', () => {
    const replies = [{ label: 'Yes, book it' }, { label: 'Show cheaper', text: '@Go show us something cheaper' }];
    expect(PostMessage.parse({ request_id: 'rq_1', trip_id: 't', text: 'Book Villa Maya?', quick_replies: replies }).quick_replies).toHaveLength(2);
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `r${i}` }));
    expect(PostMessage.safeParse({ request_id: 'rq_1', trip_id: 't', text: 'x', quick_replies: seven }).success).toBe(false);
    expect(PostMessage.safeParse({ request_id: 'rq_1', trip_id: 't', text: 'x', quick_replies: [{ label: 'x'.repeat(41) }] }).success).toBe(false);
    expect(Message.shape.quick_replies.parse(replies)).toHaveLength(2);
  });

  it("A4 an open can be one of the App's own screens (go://), still never javascript:", () => {
    expect(ActionOpen.parse({ result: 'open', url: 'go://trip/t_goa/plan', expires_at: at }).url).toBe('go://trip/t_goa/plan');
    expect(ActionOpen.parse({ result: 'open', url: 'https://www.ixigo.com/hotels', expires_at: at }).result).toBe('open');
    expect(ActionOpen.safeParse({ result: 'open', url: 'javascript:alert(1)', expires_at: at }).success).toBe(false);
  });

  it('A5 and A9 a vote can be flexible or taken back, with no option; a decision counts the flexible', () => {
    const voted = (data: Record<string, unknown>) =>
      Event.parse({ event_id: 'e', trip_id: 't', seq: 3, occurred_at: at, type: 'decision.voted', data: { decision_id: 'd_1', voted: 3, of: 5, tally: [1, 1], ...data } });
    expect(voted({ person_id: 'p_kabir', flexible: true }).type).toBe('decision.voted');
    expect(voted({ person_id: 'p_kabir', retracted: true }).type).toBe('decision.voted');
    expect(Decision.shape.flexible_count.parse(1)).toBe(1);
  });

  it('A6 a location attachment, and how long a file plays', () => {
    const att = Message.shape.attachments.element;
    expect(att.parse({ kind: 'location', lat: 15.6, lng: 73.7, name: 'Anjuna beach' }).kind).toBe('location');
    expect(att.safeParse({ kind: 'location', lat: 95, lng: 73.7 }).success).toBe(false);
    expect(att.parse({ kind: 'file', url: 'https://cdn.example.com/v.m4a', name: 'voice.m4a', mime: 'audio/mp4', size_bytes: 1200, duration_s: 7.5 }).kind).toBe('file');
  });

  it('A7 a booking can carry details, a return leg, passengers and documents Go signs a link to', () => {
    const b = Booking.parse({
      booking_id: 'b_1', kind: 'train', status: 'confirmed', title: '12608', vendor: 'ixigo', ref: 'PNR 4512', amount_minor: 80000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], created_at: at,
      details: [{ label: 'Coach', value: 'C2' }], passengers: [{ person_id: 'p_rahul', seat: 'C2 41', pnr: '4512' }],
      documents: [{ document_id: 'doc_1', name: '6E5313-K7QX2M.pdf', mime: 'application/pdf', size_bytes: 184233, pages: 2, visibility: 'covered', url: 'https://go.example.com/docs/doc_1?sig=x' }],
    });
    expect(b.documents?.[0]?.visibility).toBe('covered');
    expect(Booking.shape.documents.safeParse([{ ...b.documents![0], visibility: 'shared' }]).success).toBe(false);
  });

  it('A8 an itinerary item can be for some people and private; a day can have a picture; A11 a place has its time zone', () => {
    expect(ItineraryItem.parse({ title: 'Spa', category: 'activities', status: 'planned', person_ids: ['p_priya'], audience: 'private' }).audience).toBe('private');
    expect(Place.parse({ name: 'Goa', timezone: 'Asia/Kolkata' }).timezone).toBe('Asia/Kolkata');
    expect(Place.safeParse({ name: 'Goa', timezone: 'not a zone!' }).success).toBe(false);
    expect(TripSnapshot.shape.itinerary.element.parse({ date: '2026-11-06', items: [], image_url: 'https://cdn.example.com/d1.jpg' }).image_url).toBeTruthy();
  });

  it('B1 a confirmed payback is an event; B4 an expense has its answers, and its event says approved or disputed', () => {
    const settled = Event.parse({
      event_id: 'e', trip_id: 't', seq: 9, occurred_at: at, type: 'settlement.recorded',
      data: {
        settlement: {
          settlement_id: 'st_1', from_person_id: 'p_aarav', to_person_id: 'p_rahul', amount_minor: 580000, currency: 'INR', method: 'upi',
          note: 'villa + groceries', status: 'confirmed', recorded_at: at, confirmed_at: at,
        },
        by: { kind: 'person', person_id: 'p_rahul' },
      },
    });
    expect(settled.type).toBe('settlement.recorded');
    // Only confirmed ones are sent.
    const pending = { settlement_id: 'st_2', from_person_id: 'p_a', to_person_id: 'p_b', amount_minor: 1, currency: 'INR', method: 'cash', status: 'pending', confirmed_at: at };
    expect(Event.safeParse({ event_id: 'e', trip_id: 't', seq: 9, occurred_at: at, type: 'settlement.recorded', data: { settlement: pending, by: { kind: 'system' } } }).success).toBe(false);
    const expense = Expense.parse({
      expense_id: 'x_1', paid_by_person_id: 'p_rahul', amount_minor: 240000, currency: 'INR', note: 'Cab', category: 'getting_around',
      split_person_ids: ['p_rahul', 'p_priya', 'p_arjun'], created_at: at, status: 'disputed',
      confirmations: [{ person_id: 'p_priya', state: 'approved', at }, { person_id: 'p_arjun', state: 'disputed', at, reason: 'I took the bus' }],
    });
    expect(expense.confirmations?.[1]?.state).toBe('disputed');
    // add_expense says which vault payment paid it, so the Server approves it at once; without one it is pending.
    const add = { request_id: 'rq_x', trip_id: 't', paid_by_person_id: 'p_rahul', amount_minor: 840000, currency: 'INR', note: 'Villa Maya', category: 'stay', split_person_ids: ['p_rahul', 'p_priya'] };
    expect(AddExpense.parse({ ...add, approval_id: 'ap_7f3a' }).approval_id).toBe('ap_7f3a');
    expect(AddExpense.parse(add).approval_id).toBeUndefined();
    for (const change of ['approved', 'disputed']) {
      expect(Event.parse({ event_id: 'e', trip_id: 't', seq: 10, occurred_at: at, type: 'expense.changed', data: { expense, change, by: { kind: 'system' }, by_person_id: 'p_priya' } }).type).toBe('expense.changed');
    }
  });

  it('B2 a checklist card, and a vault link to add documents with its context; B3a a call has its recording', () => {
    const checklist = {
      kind: 'checklist', card_id: 'c_visa', title: 'Indonesia e-VOA', subtitle: 'Due before you fly', due_at: '2026-12-10',
      rows: [{ person_id: 'p_aarav', status: 'todo', label: 'Not yet', sub: 'Passport, photo' }, { person_id: 'p_rahul', status: 'done', label: 'Done' }],
      suggestion: { text: 'You and Arjun land together. Share a cab?', cta: { action_id: 'cab', label: 'Book' } }, actions: [], fallback_text: 'Indonesia e-VOA: 1 of 2 done',
    };
    expect(Card.parse(checklist).kind).toBe('checklist');
    expect(Card.safeParse({ ...checklist, rows: [{ person_id: 'p_aarav', label: 'x', status: 'maybe' }] }).success).toBe(false);
    expect(Card.safeParse({ ...checklist, due_at: '2026-12-10T10:00:00Z' }).success).toBe(false);
    expect(CreateLink.parse({ kind: 'vault', person_id: 'p', start: 'add_documents', context: { trip_id: 't_bali', purpose: 'visa' } }).start).toBe('add_documents');
    const call = Card.parse({
      card_id: 'c_call', kind: 'call', fallback_text: 'Go called the villa', call_id: 'call_1', business: 'Villa Maya', goal: 'Ask about late check-in',
      state: 'ended', recording_url: 'https://go.example.com/rec/call_1.mp3', duration_s: 94,
    });
    expect(call.kind === 'call' && call.duration_s).toBe(94);
  });

  it('what 1.0 wrote still reads: none of the additions is required', () => {
    expect(Option.safeParse({ option_id: 'o', title: 'x', highlights: [] }).success).toBe(true);
    expect(Expense.safeParse({ expense_id: 'x', paid_by_person_id: 'p', amount_minor: 1, currency: 'INR', note: 'n', category: 'food', split_person_ids: ['p'], created_at: at }).success).toBe(true);
    expect(CardTap.safeParse({ tap_id: 'tp', trip_id: 't', card_id: 'c', action_id: 'pick', person_id: 'p' }).success).toBe(true);
    expect(CreateLink.safeParse({ kind: 'vault', person_id: 'p', start: 'add_card' }).success).toBe(true);
  });
});
