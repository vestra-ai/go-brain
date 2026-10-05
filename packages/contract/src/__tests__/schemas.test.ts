import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Card, Event, Message, PostMessage, SOCKET_METHODS, SocketError, SpendApprovalResult, TripSnapshot, parseParams } from '../index.js';
import { readFileSync } from 'node:fs';

const at = '2026-10-05T07:00:00Z';

describe('contract schemas', () => {
  it('a message from Go needs text, a card, or both', () => {
    expect(PostMessage.safeParse({ request_id: 'rq_1', trip_id: 't_goa' }).success).toBe(false);
    expect(PostMessage.safeParse({ request_id: 'rq_1', trip_id: 't_goa', text: 'Booked.' }).success).toBe(true);
    expect(PostMessage.safeParse({ request_id: 'rq_1', trip_id: 't_goa', card: { card_id: 'c_1', kind: 'plan', fallback_text: 'The plan' } }).success).toBe(true);
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
  it('every socket method has named params and result schemas, so the docs and the Python models get real names', () => {
    for (const x of SOCKET_METHODS) for (const s of [x.params, x.result]) if (s) expect(z.globalRegistry.get(s)?.id, x.name).toBeTruthy();
  });
  it('method names are unique, and only typing is a notification', () => {
    expect(new Set(SOCKET_METHODS.map((x) => x.name)).size).toBe(SOCKET_METHODS.length);
    expect(SOCKET_METHODS.filter((x) => x.result === null).map((x) => x.name).sort()).toEqual(['person_typing', 'typing']);
  });
  it('checks params by method: unknown methods and bad params are refused', () => {
    expect(parseParams('open_vote', { request_id: 'rq', trip_id: 't', question: 'Where?', kind: 'choice', anonymous: false,
      options: [{ label: 'A' }, { label: 'B' }] }).ok).toBe(true);
    expect(parseParams('open_vote', { trip_id: 't' })).toMatchObject({ ok: false, code: 422 });
    expect(parseParams('launch_rockets', {})).toMatchObject({ ok: false, code: -32601 });
  });
  it('a card tap carries its own id, so a resent or doubled tap is done once', () => {
    const tap = { trip_id: 't', card_id: 'c', action_id: 'yes_book', person_id: 'p' };
    expect(parseParams('card_tap', tap)).toMatchObject({ ok: false, code: 422 });
    expect(parseParams('card_tap', { ...tap, tap_id: 'tap_1' }).ok).toBe(true);
  });
  it('a 429 can say how long to wait', () => {
    const busy = { jsonrpc: '2.0', id: 'gs_1', error: { code: 429, message: 'slow down', data: { code: 'rate_limited', retry_after_seconds: 5 } } };
    expect(SocketError.safeParse(busy).success).toBe(true);
    expect(SocketError.safeParse({ ...busy, error: { ...busy.error, data: { code: 'rate_limited', retry_after_seconds: 0 } } }).success).toBe(false);
  });
  it('the emitted frame schemas keep their id property, so the Python models can read it', () => {
    const doc = JSON.parse(readFileSync(new URL('../../openapi/go-brain.json', import.meta.url), 'utf8'));
    for (const name of ['SocketRequest', 'SocketResult', 'SocketError']) {
      expect(doc.components.schemas[name].properties.id, name).toBeTruthy();
    }
  });
});
