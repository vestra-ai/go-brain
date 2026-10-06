// What the fake Go does on top of the socket (docs/guide/10-build-and-test.md, "The fake Go"):
//  - when a message.created event mentions Go, it sends typing, read_trip, a ✅ with add_reaction, then
//    post_message with a reply and one of Go's own cards, a different kind each time, then typing off;
//  - it answers card_tap, catch_up, the people requests and vault_link with fixed answers.
// A repeated tap_id gets its first answer back. Only a pay card's payer can approve it.
import { randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { TripSnapshot, type CardActionResult, type CardTap, type Event } from '@go/contract';
import { FAKE_CARD_KINDS, fakeCard, type FakeCardKind } from './cards.js';
import type { Link } from './link.js';
import type { Behaviour } from './server.js';

type TapAnswer = z.infer<typeof CardActionResult>;
type Tap = z.infer<typeof CardTap>;
type MessageCreated = Extract<Event, { type: 'message.created' }>;

export interface BehaviourOptions {
  /** The fake Go's own base URL; its watch and vault links point at its /fake/page/... pages. */
  publicUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The guide's catch-up example (docs/guide/05-your-requests.md). */
export const FIXED_CATCH_UP = {
  summary: 'While you were away, the group picked Villa Sol and Go booked it.',
  items: [
    { kind: 'decided', text: 'Villa Sol won the vote, 4 to 1', message_id: 'm_0158' },
    { kind: 'booked', text: 'Villa Sol, 3 nights, ₹54,200, paid by Rahul', image_url: 'https://brain.go.example/img/villa-sol.jpg', message_id: 'm_0166' },
    { kind: 'needs_you', text: 'Scuba on Saturday? Go is asking you and Kabir', message_id: 'm_0149' },
  ],
};

/** The guide's facts example for Kabir, used for whoever is asked about. */
export const FIXED_FACTS = [
  { fact_id: 'f_kb_01', topic: 'drinks', text: "Doesn't drink", trip_id: 't_goa', message_id: null, said_at: '2026-10-05T03:40:00Z' },
  { fact_id: 'f_kb_02', topic: 'flights', text: 'Wants an aisle seat', trip_id: 't_goa', message_id: 'm_0141', said_at: '2026-10-05T07:05:00Z' },
  { fact_id: 'f_kb_03', topic: 'boats', text: 'Gets seasick on boats', trip_id: 't_goa', message_id: 'm_0188', said_at: '2026-10-05T10:20:00Z' },
];

const newRequestId = (): string => `rq_fake_${randomUUID()}`;

export function fakeGoBehaviour(link: Link, o: BehaviourOptions): Behaviour {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const cards = new Map<string, { kind: FakeCardKind; payerId: string }>();
  const taps = new Map<string, TapAnswer>();
  const bootId = randomBytes(4).toString('hex');
  let posted = 0;

  const inFiveMinutes = (): string => new Date(now().getTime() + 5 * 60_000).toISOString();
  const page = (kind: 'watch' | 'vault', query: Record<string, string>): string =>
    `${o.publicUrl}/fake/page/${kind}?${new URLSearchParams(query).toString()}`;

  /** Sends one request; a failure is logged and the script goes on, so the Server team sees every request kind. */
  const ask = async (method: string, params: object, via: WebSocket): Promise<Record<string, unknown> | null> => {
    try {
      return await link.request(method, params, { via });
    } catch (err) {
      log(`${method} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  /** Everything Go sends about the event goes back on `from`, the socket the event came on. */
  const answerMention = async (ev: MessageCreated, from: WebSocket): Promise<void> => {
    const msg = ev.data.message;
    const authorId = msg.author.kind === 'person' ? msg.author.person_id : undefined;
    link.notify('typing', { trip_id: ev.trip_id, on: true }, from);
    try {
      const read = TripSnapshot.safeParse(await ask('read_trip', { trip_id: ev.trip_id }, from));
      const trip = read.success ? read.data : undefined;
      const name = trip?.people.find((p) => p.person_id === authorId)?.name;
      const payerId = trip?.organizer_person_id ?? authorId ?? 'p_unknown';
      await ask('add_reaction', { request_id: newRequestId(), trip_id: ev.trip_id, message_id: msg.message_id, emoji: '✅' }, from);
      const kind = FAKE_CARD_KINDS[posted % FAKE_CARD_KINDS.length] ?? 'notice';
      posted += 1;
      const card = fakeCard(kind, { bootId, n: posted, payerId, publicUrl: o.publicUrl, now: now() });
      cards.set(card.card_id, { kind, payerId });
      const greeting = name ? `Hi ${name}, this` : 'This';
      await ask('post_message', {
        request_id: newRequestId(),
        trip_id: ev.trip_id,
        text: `${greeting} is the fake Go. Here is ${kind === 'options' ? 'an' : 'a'} ${kind} card to test with.`,
        reply_to: msg.message_id,
        ...(authorId ? { mentions: [authorId] } : {}),
        card,
      }, from);
    } finally {
      link.notify('typing', { trip_id: ev.trip_id, on: false }, from);
    }
  };

  const answerTap = (tap: Tap): TapAnswer => {
    const card = cards.get(tap.card_id);
    switch (tap.action_id) {
      case 'watch':
        return { result: 'open', url: page('watch', { card: tap.card_id }), expires_at: inFiveMinutes() };
      case 'approve':
        if (!card || card.kind !== 'pay') return { result: 'refused', toast: 'This payment is no longer waiting.' };
        if (tap.person_id !== card.payerId) return { result: 'refused', toast: 'Only the payer can approve this payment.' };
        return { result: 'open', url: page('vault', { card: tap.card_id, person: tap.person_id }), expires_at: inFiveMinutes() };
      case 'pick':
        return { result: 'done', toast: 'Noted. Go will reply in the room.' };
      case 'vote':
        return { result: 'done', toast: 'Go will put it to a vote.' };
      case 'stop':
        return { result: 'done', toast: 'Stopped.' };
      case 'decline':
        return { result: 'done', toast: 'Declined. Nothing was paid.' };
      default:
        return { result: 'refused', toast: 'The fake Go does not know this button.' };
    }
  };

  return {
    onEvent: async (ev, from) => {
      if (ev.type !== 'message.created') return;
      const m = ev.data.message;
      if (!m.mentions_go || m.author.kind === 'go' || m.withheld || m.deleted) return;
      await answerMention(ev, from);
    },
    handlers: {
      card_tap: async (tap: Tap) => {
        const first = taps.get(tap.tap_id);
        if (first) return first; // once per tap_id: a repeat gets the first answer back
        const answer = answerTap(tap);
        taps.set(tap.tap_id, answer);
        return answer;
      },
      catch_up: async () => FIXED_CATCH_UP,
      get_person: async (p: { person_id: string }) => ({ person_id: p.person_id, carry_over: false, facts: FIXED_FACTS }),
      update_person: async () => ({ ok: true }),
      delete_fact: async () => ({ ok: true }),
      forget_person: async () => ({ deleted_facts: 3, remaining_facts: 0 }),
      vault_link: async (p: { person_id: string; start?: string | null }) => ({
        url: page('vault', { person: p.person_id, start: p.start ?? 'home' }),
        expires_at: inFiveMinutes(),
      }),
    },
  };
}
