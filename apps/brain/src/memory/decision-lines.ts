/**
 * Go's open record lines that a vote settles ("Which villa: Casa Mareia, Villa Sol or The Palms?", "Who pays for the
 * villa?"). When Go writes an open line about a vote, it is linked to that decision by id: the line's proof carries the
 * vote's card, or the turn that wrote it put that card up or was woken by that vote. A line written while the vote is
 * open is done once the vote closes or is cancelled; one written after it closed (who pays) is done once the group sets
 * what to book (a mandate), or the vote is cancelled. Level-triggered: every decision and mandate event, and the
 * 5-minute sweep, mark done whatever is due, so a missed event or a restart never leaves a line in "needs you".
 *
 * An open question people raised in the chat before anyone opened the vote ("Candolim or Anjuna for the stay?") has no
 * vote in its proof: once the vote closes with a winner, a line it answers is linked to it too, and done with it.
 */
import type * as C from '@go/contract';
import type { Pool } from 'pg';
import type { DeskItem } from '../desk/desk.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import type { CheckedLine } from './checker.js';
import { lineRequestId, writeLine } from './record.js';

/** The vote a card is or asks about: a vote card, a mandate, and since rev 5 (R5) a shared thing's options card. */
const voteOf = (card: C.Card | null | undefined): string | null =>
  !card ? null : card.kind === 'vote' || card.kind === 'mandate' ? card.decision_id : card.kind === 'options' ? (card.decision_id ?? null) : null;

/** The one vote this open line is about, or null: none, or more than one. */
export function decisionOf(line: CheckedLine, pack: TripPack, turn?: { cards: readonly C.Card[]; wake: readonly DeskItem[] }): string | null {
  if (line.kind !== 'open' || line.lineId) return null;
  const ids = new Set<string>();
  const byId = new Map(pack.messages.map((m) => [m.message_id, m]));
  for (const p of line.proof) {
    const id = voteOf(byId.get(p.message_id)?.card);
    if (id) ids.add(id);
  }
  for (const card of turn?.cards ?? []) {
    const id = voteOf(card);
    if (id) ids.add(id);
  }
  for (const w of turn?.wake ?? []) {
    const id = (w.payload as { decisionId?: unknown } | null)?.decisionId;
    if (typeof id === 'string') ids.add(id);
  }
  // A vote this turn just opened may not be in the pack yet; its id is real either way (Go's own card, or the Server's).
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Links a line Go just wrote to its vote: done when the vote ends if the vote is open now, else when a mandate is set. */
export async function linkLine(pool: Pool, tripId: string, lineId: string, decisionId: string, pack: TripPack): Promise<void> {
  const d = pack.trip.decisions.find((x) => x.decision_id === decisionId);
  const closesOn = d && d.status !== 'open' ? 'mandate' : 'vote';
  await pool.query(
    `INSERT INTO line_decisions (trip_id, line_id, decision_id, closes_on) VALUES ($1, $2, $3, $4)
     ON CONFLICT (trip_id, line_id) DO NOTHING`,
    [tripId, lineId, decisionId, closesOn],
  );
}

function settled(d: C.Decision | undefined, closesOn: string): boolean {
  if (!d) return false;
  if (closesOn === 'vote') return d.status !== 'open';
  return d.status === 'cancelled' || (d.mandate !== null && d.mandate !== undefined);
}

/** A line's or a vote's words, lowercase, letters and digits only. */
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
/** Words that say nothing about what a question is about. */
const SMALL = new Set([
  'the', 'and', 'for', 'our', 'are', 'what', 'which', 'who', 'where', 'when', 'how', 'should', 'shall', 'will', 'would', 'can',
  'could', 'about', 'with', 'from', 'this', 'that', 'there', 'their', 'have', 'has', 'vote', 'pick', 'choose', 'between',
  'option', 'options', 'trip', 'group', 'everyone', 'all', 'you', 'not', 'yet', 'still', 'any', 'one', 'go',
]);
const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Whether an open line asks what this vote settled. Each option is known by its own words (those no other option has,
 * so "Villa Sol" by "sol", "Saturday 7 Nov" by "saturday"). A choice is answered when the line names two options, or one
 * and a word of the question ("Stay location: Candolim?" for "Where should we stay in Goa: Candolim or Anjuna?"); a
 * yes-or-no, when the line shares two words with the question. "Dinner at Candolim?" is not about the stay.
 */
export function answers(lineText: string, d: Pick<C.Decision, 'question' | 'kind' | 'options'>, place?: string): boolean {
  const line = wordsOf(lineText);
  // The trip's own place says nothing about which question it is: "in Goa" is in half of them.
  const where = new Set(wordsOf(place ?? ''));
  const labels = d.options.map((o) => wordsOf(o.label));
  const own = labels.map((ws, i) =>
    ws.filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !SMALL.has(w) && !labels.some((other, j) => j !== i && other.includes(w))),
  );
  const named = own.filter((ws) => ws.length > 0 && ws.some((w) => line.some((l) => sameWord(l, w)))).length;
  const optionWords = new Set(own.flat());
  const topic = wordsOf(d.question).filter((w) => w.length >= 3 && !SMALL.has(w) && !where.has(w) && !optionWords.has(w) && !/^\d+$/.test(w));
  const shared = new Set(topic.filter((w) => line.some((l) => sameWord(l, w)))).size;
  if (d.kind === 'yesno') return shared >= 2;
  // One option named in full, every word of its label, numbers too: they are all that tell "1 to 7 Dec" from "7 to 12
  // Dec". It answers the line when the line shares a word of the question ("Dates 7 to 12 Dec") or is only that option
  // ("South Goa"). Prod, 11 Oct: both stayed open in everyone's record after their votes closed.
  const whole = labels.filter((ws) => ws.length > 0 && ws.every((w) => line.includes(w)));
  const rest = line.filter((l) => !SMALL.has(l) && !where.has(l) && !whole.some((ws) => ws.includes(l)));
  if (whole.length === 1 && (shared >= 1 || rest.length === 0)) return true;
  return named >= 2 || (named >= 1 && shared >= 1);
}

/** Links the open lines a closed vote answers that nothing linked yet: written before it closed, still active. */
async function linkAnswered(pool: Pool, tripId: string, pack: TripPack): Promise<void> {
  const won = pack.trip.decisions.filter((d) => d.status === 'closed' && d.result_index !== null && d.result_index !== undefined);
  if (won.length === 0) return;
  const r = await pool.query<{ line_id: string; line: C.RecordLine }>(
    `SELECT rl.line_id, rl.line FROM record_lines rl
      WHERE rl.trip_id = $1 AND rl.status = 'active' AND rl.kind = 'open'
        AND NOT EXISTS (SELECT 1 FROM line_decisions ld WHERE ld.trip_id = rl.trip_id AND ld.line_id = rl.line_id)`,
    [tripId],
  );
  for (const row of r.rows) {
    const asked = Date.parse(row.line.created_at);
    const d = won.find((x) => (!x.closed_at || asked <= Date.parse(x.closed_at)) && answers(row.line.text, x, pack.trip.destination?.name));
    if (!d) continue;
    // Settled when the vote ended, as a line written while it was open is.
    await pool.query(
      `INSERT INTO line_decisions (trip_id, line_id, decision_id, closes_on) VALUES ($1, $2, $3, 'vote')
       ON CONFLICT (trip_id, line_id) DO NOTHING`,
      [tripId, row.line_id, d.decision_id],
    );
  }
}

/** Marks done every active linked line whose vote has settled it. Returns how many it marked. */
export async function settleDecisionLines(pool: Pool, link: ServerLink, tripId: string, pack: TripPack): Promise<number> {
  await linkAnswered(pool, tripId, pack);
  const r = await pool.query<{ line_id: string; decision_id: string; closes_on: string; line: C.RecordLine }>(
    `SELECT ld.line_id, ld.decision_id, ld.closes_on, rl.line
       FROM line_decisions ld
       JOIN record_lines rl ON rl.trip_id = ld.trip_id AND rl.line_id = ld.line_id
      WHERE ld.trip_id = $1 AND rl.status = 'active'`,
    [tripId],
  );
  let marked = 0;
  for (const row of r.rows) {
    const d = pack.trip.decisions.find((x) => x.decision_id === row.decision_id);
    const kind = row.line.kind;
    if (!settled(d, row.closes_on) || (kind !== 'agreed' && kind !== 'open' && kind !== 'doing')) continue;
    const done = doneOf({ ...row.line, kind });
    const out = await writeLine(pool, link, tripId, done, lineRequestId(done));
    if ('lineId' in out) marked += 1;
  }
  return marked;
}

/** A line of Go's as it is, marked done: the update that closes it and changes nothing else. */
function doneOf(line: C.RecordLine & { kind: CheckedLine['kind'] }): CheckedLine {
  return {
    kind: line.kind,
    text: line.text,
    personIds: line.person_ids,
    proof: line.proof.map((p) => ({ message_id: p.message_id, person_id: p.person_id ?? null })),
    lineId: line.line_id,
    status: 'done',
  };
}

/**
 * Go's open questions a new agreed or doing line settles: the ones the notes model names (settles), and, for an agreed
 * line, any whose question is among the line's own proof (the proposal the group said yes to). The Server, 6 Oct: open
 * lines were never closed, so a question the group had settled stayed in everyone's "needs you".
 */
export function settledBy(line: CheckedLine, named: readonly string[], record: readonly C.RecordLine[]): C.RecordLine[] {
  if (line.kind === 'open' || line.status === 'done') return [];
  const proof = new Set(line.proof.map((p) => p.message_id));
  return record.filter(
    (r) =>
      r.kind === 'open' && r.status === 'active' && r.source === 'go' && r.line_id !== line.lineId &&
      (named.includes(r.line_id) || (line.kind === 'agreed' && r.proof.some((p) => proof.has(p.message_id)))),
  );
}

/** Marks done each open question this line settles (settledBy). Returns how many it marked. */
export async function closeSettled(
  pool: Pool, link: ServerLink, tripId: string, line: CheckedLine, named: readonly string[], record: readonly C.RecordLine[],
): Promise<number> {
  let marked = 0;
  for (const r of settledBy(line, named, record)) {
    const done = doneOf({ ...r, kind: 'open' });
    const out = await writeLine(pool, link, tripId, done, lineRequestId(done));
    if ('lineId' in out) marked += 1;
  }
  return marked;
}
