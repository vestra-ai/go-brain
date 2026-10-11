/**
 * Two "right now" blocks for the composer's prompt (spec §9 rule 7): the trip record (open and doing
 * lines in full, settled lines short) and the pages of the people in the current conversation only.
 * Each stays under about 1,500 tokens.
 */
import type * as C from '@go/contract';
import type { Pool } from 'pg';
import type { NowProvider } from '../composer/context.js';
import { dataBlock, defuse, inlineData, oneLine, personName } from '../composer/fence.js';
import type { DeskItem } from '../desk/desk.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { Memory } from './memory.js';
import { mirrorSnapshot, recordLines } from './record.js';

const MAX_CHARS = 6_000; // about 1,500 tokens
const limit = (s: string): string => (s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS - 20).trimEnd()}\n(more left out)`);
const newestFirst = (a: C.RecordLine, b: C.RecordLine) => Date.parse(b.updated_at) - Date.parse(a.updated_at);
const KIND_WORD: Record<C.RecordLine['kind'], string> = { decided: 'Decided', agreed: 'Agreed', booked: 'Booked', open: 'Open', doing: 'Doing' };

export function renderRecord(lines: C.RecordLine[], pack: TripPack, caps = { full: 15, short: 20 }): string | null {
  const nameOf = (id: string) => personName(pack.trip.people.find((p) => p.person_id === id)?.name ?? 'someone');
  const seqOf = (id: string) => pack.messages.find((m) => m.message_id === id)?.seq;
  const active = lines.filter((l) => l.status === 'active');
  const full = active
    .filter((l) => l.kind === 'open' || l.kind === 'doing')
    .sort(newestFirst)
    .slice(0, caps.full)
    .map((l) => {
      const who = l.person_ids.map(nameOf).join(', ') || 'the group';
      const due = l.due_at ? `, by ${l.due_at.slice(0, 10)}` : '';
      const refs = l.proof.map((p) => seqOf(p.message_id)).filter((s): s is number => s !== undefined).map((s) => `#${s}`).join(', ');
      // The line's words came from people: fenced as data. Names, dates and message numbers are Go's own.
      return `${KIND_WORD[l.kind]}: ${inlineData(l.text, 200)} (${l.kind === 'open' ? 'asking' : 'on it'}: ${who}${due}${refs ? `; ${refs}` : ''})`;
    });
  // An agreed line backed by part of the group, without the organizer, is only leaning: Go must never call it decided
  // (the 10 Oct live proof: "Saudades is locked in" on 3 of 5, no vote). Everyone, or the organizer, makes it agreed.
  const people = pack.trip.people.length;
  const leaning = (l: C.RecordLine): boolean =>
    l.kind === 'agreed' && l.person_ids.length > 0 && l.person_ids.length < people && !l.person_ids.includes(pack.trip.organizer_person_id);
  // A vote's result keeps its id, so the closed vote is cited when it changes the trip (update_trip decision_id): the 7 to 0
  // rename had closed long before anyone asked Go for it (Varkala, 11 Oct).
  const short = active
    .filter((l) => l.kind === 'agreed' || l.kind === 'decided' || l.kind === 'booked')
    .sort(newestFirst)
    .slice(0, caps.short)
    .map((l) => (leaning(l)
      ? `Leaning (${l.person_ids.length} of ${people}: ${l.person_ids.map(nameOf).join(', ')}; not decided): ${inlineData(l.text, 200)}`
      : `${KIND_WORD[l.kind]}: ${inlineData(l.text, 200)}${l.kind === 'decided' && l.decision_id ? ` (vote ${l.decision_id})` : ''}`));
  if (full.length === 0 && short.length === 0) return null;
  return limit(['The trip record:', ...full, ...short].join('\n'));
}

/** Who is in the conversation: the people Go woke for, then the authors and mentions of the last 12 messages. */
export function conversationPeople(pack: TripPack, wake: DeskItem[], max = 6): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id) && pack.trip.people.some((p) => p.person_id === id)) ids.push(id);
  };
  const woke = wake.flatMap((w) => pack.messages.filter((m) => m.message_id === w.ref));
  for (const m of [...woke, ...pack.messages.slice(-12).reverse()]) {
    if (m.author.kind === 'person') add(m.author.person_id);
    for (const id of m.mentions) add(id);
  }
  return ids.slice(0, max);
}

export function recordNow(d: { pool: Pool; packs: Packs }): NowProvider {
  return {
    name: 'record',
    order: 20,
    async render(tripId) {
      const pack = await d.packs.get(tripId);
      await mirrorSnapshot(d.pool, pack.trip);
      return renderRecord(await recordLines(d.pool, tripId), pack);
    },
  };
}

export function peopleNow(d: { memory: Memory; packs: Packs }): NowProvider {
  return {
    name: 'people',
    order: 22,
    async render(tripId, wake) {
      const pack = await d.packs.get(tripId);
      const blocks: string[] = [];
      for (const id of conversationPeople(pack, wake)) {
        const page = await d.memory.page(tripId, id, 'go');
        if (!page) continue;
        const name = personName(pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone');
        blocks.push(`${name}:\n${dataBlock('facts', page.split('\n').slice(0, 10).map((l) => defuse(oneLine(l))))}`);
      }
      if (blocks.length === 0) return null;
      return limit(['What Go knows about the people talking (drawn from facts; #n is the message it came from):', ...blocks].join('\n'));
    },
  };
}
