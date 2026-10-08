import type * as C from '@go/contract';
import type { Message, TripEvent } from '../door/methods.js';
import type { TripPack } from './pack.js';

type Reaction = Message['reactions'][number];
const sameReaction = (a: Reaction, b: Reaction): boolean => a.emoji === b.emoji && (a.person_id ?? null) === (b.person_id ?? null);

function upsertBy<T>(list: T[], same: (x: T) => boolean, item: T): void {
  const i = list.findIndex(same);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

/** Puts a message in the pack in seq order; a deleted message leaves it. */
export function upsertMessage(pack: TripPack, m: Message): void {
  const i = pack.messages.findIndex((x) => x.message_id === m.message_id);
  if (m.deleted) {
    if (i >= 0) pack.messages.splice(i, 1);
    return;
  }
  if (i >= 0) {
    pack.messages[i] = m;
    return;
  }
  pack.messages.push(m);
  const n = pack.messages.length;
  if (n > 1 && (pack.messages[n - 2]?.seq ?? 0) > m.seq) pack.messages.sort((a, b) => a.seq - b.seq);
}

/**
 * Applies one event to a pack. 'reread' means the event says something changed without the new
 * values (trip.updated, bookings, expenses, or a vote Go has not seen), so the caller reads the trip.
 */
export function applyEvent(pack: TripPack, ev: TripEvent): 'ok' | 'reread' {
  const t = pack.trip;
  const decision = (id: string): C.Decision | undefined => t.decisions.find((d) => d.decision_id === id);
  switch (ev.type) {
    case 'trip.created':
      pack.trip = ev.data.trip;
      break;
    case 'message.created':
    case 'message.edited':
      upsertMessage(pack, ev.data.message);
      break;
    case 'message.deleted': {
      const id = ev.data.message_id;
      pack.messages = pack.messages.filter((m) => m.message_id !== id);
      break;
    }
    case 'reaction.added': {
      const data = ev.data;
      const m = pack.messages.find((x) => x.message_id === data.message_id);
      if (m && !m.reactions.some((r) => sameReaction(r, data.reaction))) m.reactions.push(data.reaction);
      break;
    }
    case 'reaction.removed': {
      const data = ev.data;
      const m = pack.messages.find((x) => x.message_id === data.message_id);
      if (m) m.reactions = m.reactions.filter((r) => !sameReaction(r, data.reaction));
      break;
    }
    case 'person.joined': {
      const p = ev.data.person;
      t.people = [...t.people.filter((x) => x.person_id !== p.person_id), p];
      break;
    }
    case 'person.updated': {
      const p = ev.data.person;
      t.people = t.people.map((x) => (x.person_id === p.person_id ? p : x));
      break;
    }
    case 'person.left': {
      const id = ev.data.person_id;
      t.people = t.people.filter((x) => x.person_id !== id);
      break;
    }
    case 'decision.opened':
    case 'decision.closed': {
      const d = ev.data.decision;
      upsertBy(t.decisions, (x) => x.decision_id === d.decision_id, d);
      break;
    }
    case 'decision.voted': {
      const data = ev.data;
      const d = decision(data.decision_id);
      if (!d) return 'reread';
      d.voted = data.voted;
      d.of = data.of;
      d.tally = data.tally;
      const pid = data.person_id;
      const idx = data.option_index;
      if (!d.anonymous && pid != null && idx != null) {
        d.votes = [...(d.votes ?? []).filter((v) => v.person_id !== pid), { person_id: pid, option_index: idx }];
      } else if (!d.anonymous && pid != null && (data.flexible || data.retracted)) {
        // 1.1: "I'm flexible" or a vote taken back: whatever they picked before is no longer their vote.
        d.votes = (d.votes ?? []).filter((v) => v.person_id !== pid);
      }
      // 1.1: the event carries no flexible_count, and a flexible vote names no pick: the Server's decision has both.
      if (data.flexible || data.retracted) return 'reread';
      break;
    }
    case 'decision.cancelled': {
      const d = decision(ev.data.decision_id);
      if (!d) return 'reread';
      d.status = 'cancelled';
      break;
    }
    case 'mandate.set': {
      const d = decision(ev.data.decision_id);
      if (!d) return 'reread';
      d.mandate = ev.data.mandate;
      break;
    }
    case 'mandate.confirmed':
    case 'mandate.declined': {
      const d = decision(ev.data.decision_id);
      if (!d?.mandate) return 'reread';
      if (ev.type === 'mandate.confirmed') {
        d.mandate.confirmed_at = ev.occurred_at;
        d.mandate.declined_at = null;
      } else {
        d.mandate.declined_at = ev.occurred_at;
        d.mandate.confirmed_at = null;
      }
      break;
    }
    case 'record.changed': {
      const line = ev.data.line;
      upsertBy(t.record, (x) => x.line_id === line.line_id, line);
      break;
    }
    case 'trip.updated':
    case 'booking.changed':
    case 'expense.changed':
    // 1.1: a payback moves the money, which the Server works out: read it.
    case 'settlement.recorded':
      return 'reread';
  }
  pack.seq = Math.max(pack.seq, ev.seq);
  pack.trip.seq = Math.max(pack.trip.seq, ev.seq);
  return 'ok';
}
