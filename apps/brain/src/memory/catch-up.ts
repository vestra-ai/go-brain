/**
 * Catch-up (spec §6, the guide's catch_up): what one person missed, shown above the room for them only.
 * Code finds the candidates (what needs them always comes first); when more than five remain, Jev ranks
 * the rest with one noul per update in one call (1,000 ms), and code orders by kind if Jev is down.
 * The summary is written by code, so it never names anything that did not happen.
 */
import * as C from '@go/contract';
import type { Pool } from 'pg';
import type { ToGoHandler } from '../door/handlers.js';
import type { JevClient, JevQuestion, JevResult } from '../reflex/jev.js';
import type { Log } from '../log.js';
import { FENCE } from '../reflex/questions.js';
import { noulP } from '../reflex/read.js';
import { maskSecrets } from '../reflex/secrets.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { mirrorSnapshot, recordLines } from './record.js';

export type CatchKind = 'decided' | 'booked' | 'needs_you' | 'open' | 'news';
export interface CatchItem {
  kind: CatchKind;
  text: string;
  imageUrl?: string;
  messageId?: string;
  /** When it happened, in ms, for ordering. */
  at: number;
  /** Needs this person: always shown first. */
  must: boolean;
}

const MAX_ITEMS = 5;
/** Jev's share of catch-up's 3 s: past it, the ranking is code order, even if the client does not keep its own deadline. */
const RANK_DEADLINE_MS = 1_000;
const KIND_ORDER: Record<CatchKind, number> = { needs_you: 0, decided: 1, booked: 2, open: 3, news: 4 };

function cut(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 3).trimEnd()}...`;
}
function item(kind: CatchKind, text: string, at: number, must: boolean, messageId?: string, imageUrl?: string | null): CatchItem {
  return {
    kind,
    text: cut(maskSecrets(text).text, 140),
    at,
    must,
    ...(messageId ? { messageId } : {}),
    ...(imageUrl && C.HttpUrl.safeParse(imageUrl).success ? { imageUrl } : {}),
  };
}

export function candidates(pack: TripPack, lines: C.RecordLine[], personId: string, since: Date): CatchItem[] {
  const t0 = since.getTime();
  const out: CatchItem[] = [];
  const nameOf = (id: string) => pack.trip.people.find((p) => p.person_id === id)?.name ?? 'Someone';
  const cardMsg = (pred: (c: C.Card) => boolean) => pack.messages.find((m) => m.card != null && pred(m.card))?.message_id;
  /** Who wrote a proof message: its own person_id, else its author in the pack; null for Go's, or one not here. */
  const authorOf = (p: C.RecordLine['proof'][number] | undefined): string | null => {
    if (!p) return null;
    if (p.person_id) return p.person_id;
    const m = pack.messages.find((x) => x.message_id === p.message_id);
    return m?.author.kind === 'person' ? m.author.person_id : null;
  };

  for (const l of lines) {
    const at = Date.parse(l.updated_at);
    if (!(at > t0) || l.status === 'undone') continue;
    const proof = l.proof[0]?.message_id;
    const mine = l.person_ids.includes(personId);
    if (l.kind === 'decided' && l.status === 'active') {
      const vote = l.decision_id ? cardMsg((c) => c.kind === 'vote' && c.decision_id === l.decision_id) : undefined;
      out.push(item('decided', `Decided: ${l.text}`, at, false, vote ?? proof));
    } else if (l.kind === 'booked' && l.status === 'active') {
      const booking = pack.trip.bookings.find((b) => b.booking_id === l.booking_id);
      const ticket = l.booking_id ? cardMsg((c) => c.kind === 'ticket' && c.booking_id === l.booking_id) : undefined;
      out.push(item('booked', `Booked: ${l.text}`, at, false, ticket ?? proof, booking?.image_url ?? null));
    } else if (l.kind === 'open' && l.status === 'active') {
      // The person's own question is never Go asking them, whoever the line names (the Server team, 10 Oct: catch-up
      // listed people's own asks under "Go is asking you"). Only what Go or others asked them needs them.
      if (authorOf(l.proof[0]) === personId) out.push(item('open', `You asked: ${l.text}`, at, false, proof));
      else out.push(mine ? item('needs_you', `Go is asking you: ${l.text}`, at, true, proof) : item('open', `Still open: ${l.text}`, at, false, proof));
    } else if (l.kind === 'doing') {
      if (l.status === 'done') out.push(item('news', `Done: ${l.text}`, at, false, proof));
      else out.push(mine ? item('needs_you', `You said you would sort: ${l.text}`, at, true, proof) : item('news', l.text, at, false, proof));
    } else if (l.kind === 'agreed' && l.status === 'active') {
      out.push(item('news', `Agreed: ${l.text}`, at, false, proof));
    }
  }

  for (const d of pack.trip.decisions) {
    if (d.status !== 'open' || d.anonymous || !d.votes) continue;
    if (d.votes.some((v) => v.person_id === personId)) continue;
    const vote = cardMsg((c) => c.kind === 'vote' && c.decision_id === d.decision_id);
    out.push(item('needs_you', `Vote: ${d.question}`, Date.parse(d.opened_at), true, vote));
  }

  for (const m of pack.messages) {
    const at = Date.parse(m.sent_at);
    if (!(at > t0) || m.deleted || m.withheld) continue;
    if (m.author.kind === 'go' && m.card?.for_person_ids?.includes(personId) && m.card.kind !== 'vote') {
      out.push(item('needs_you', m.card.fallback_text, at, true, m.message_id));
    } else if (m.author.kind === 'person' && m.author.person_id !== personId && m.mentions.includes(personId) && m.text) {
      out.push(item('needs_you', `${nameOf(m.author.person_id)} mentioned you: ${m.text}`, at, true, m.message_id));
    }
  }
  return out;
}

export function summaryOf(items: CatchItem[]): string | null {
  if (items.length === 0) return null;
  const count = (k: CatchKind) => items.filter((i) => i.kind === k).length;
  const decided = count('decided');
  const booked = count('booked');
  const needs = count('needs_you');
  const parts: string[] = [];
  if (decided) parts.push(`the group decided ${decided === 1 ? '1 thing' : `${decided} things`}`);
  if (booked) parts.push(`${booked === 1 ? '1 booking' : `${booked} bookings`} went through`);
  let s = parts.length ? `While you were away, ${parts.join(' and ')}.` : 'While you were away, the plan moved on.';
  if (needs) s += ` ${needs === 1 ? '1 thing needs' : `${needs} things need`} you.`;
  return cut(s, 200);
}

/** One noul per update; the updates ride in the state under minted keys, never inside a question. */
export function rankQuestions(personName: string, items: CatchItem[]): { state: unknown; questions: Record<string, JevQuestion> } {
  const updates: Record<string, string> = {};
  const questions: Record<string, JevQuestion> = {};
  items.forEach((it, i) => {
    updates[`u${i}`] = it.text;
    questions[`rank_u${i}`] = {
      type: 'noul',
      instructions: `${FENCE} The update under key u${i} in updates is worth showing first to the person who was away: it changes the trip plan, settles something, or touches them.`,
      criteria: {
        true: 'A decision, a booking, a payment, a change of date or place, or something about them.',
        false: 'A small detail, small talk, or something that changes nothing for them.',
      },
    };
  });
  return { state: { person: personName.slice(0, 40), updates }, questions };
}

/** Jev's answer, or a timeout at the deadline whatever the client does. */
async function askWithin(jev: Pick<JevClient, 'ask'>, req: Parameters<JevClient['ask']>[0]): Promise<JevResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<JevResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, fault: 'timeout', totalMs: req.deadlineMs }), req.deadlineMs + 50);
  });
  try {
    return await Promise.race([jev.ask(req), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function catchUpHandler(d: {
  pool: Pool;
  packs: Packs;
  jev: Pick<JevClient, 'ask'>;
  log: Log;
  /** False while the REFLEX_LIVE switch says "off": no Jev call at all, code order. */
  jevOn?: () => boolean;
}): ToGoHandler<'catch_up'> {
  return async ({ trip_id, person_id, since }) => {
    const pack = await d.packs.get(trip_id);
    await mirrorSnapshot(d.pool, pack.trip);
    const all = candidates(pack, await recordLines(d.pool, trip_id), person_id, new Date(since));
    const must = all.filter((i) => i.must).sort((a, b) => b.at - a.at);
    let rest = all.filter((i) => !i.must).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at - a.at);
    if (must.length < MAX_ITEMS && must.length + rest.length > MAX_ITEMS && rest.length > 1 && (d.jevOn?.() ?? true)) {
      const name = pack.trip.people.find((p) => p.person_id === person_id)?.name ?? 'Someone';
      const { state, questions } = rankQuestions(name, rest);
      const res = await askWithin(d.jev, { state, questions, deadlineMs: RANK_DEADLINE_MS });
      if (res.ok) {
        const p = rest.map((_, i) => noulP(res.answers, `rank_u${i}`));
        const score = (i: number) => (Number.isFinite(p[i]) ? p[i]! : -1);
        rest = rest.map((it, i) => ({ it, i })).sort((a, b) => score(b.i) - score(a.i) || a.i - b.i).map((x) => x.it);
      } else {
        d.log.warn({ tripId: trip_id, fault: res.fault }, 'catch-up ranking fell back to code order');
      }
    }
    const chosen = [...must, ...rest].slice(0, MAX_ITEMS);
    return C.CatchUp.parse({
      summary: summaryOf(chosen),
      items: chosen.map((i) => ({
        kind: i.kind,
        text: i.text,
        ...(i.imageUrl ? { image_url: i.imageUrl } : {}),
        ...(i.messageId ? { message_id: i.messageId } : {}),
      })),
    });
  };
}
