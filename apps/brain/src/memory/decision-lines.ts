/**
 * Go's open record lines that a vote settles ("Which villa: Casa Mareia, Villa Sol or The Palms?", "Who pays for the
 * villa?"). When Go writes an open line about a vote, it is linked to that decision by id: the line's proof carries the
 * vote's card, or the turn that wrote it put that card up or was woken by that vote. A line written while the vote is
 * open is done once the vote closes or is cancelled; one written after it closed (who pays) is done once the group sets
 * what to book (a mandate), or the vote is cancelled. Level-triggered: every decision and mandate event, and the
 * 5-minute sweep, mark done whatever is due, so a missed event or a restart never leaves a line in "needs you".
 */
import type * as C from '@go/contract';
import type { Pool } from 'pg';
import type { DeskItem } from '../desk/desk.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import type { CheckedLine } from './checker.js';
import { lineRequestId, writeLine } from './record.js';

/** The one vote this open line is about, or null: none, or more than one. */
export function decisionOf(line: CheckedLine, pack: TripPack, turn?: { cards: readonly C.Card[]; wake: readonly DeskItem[] }): string | null {
  if (line.kind !== 'open' || line.lineId) return null;
  const ids = new Set<string>();
  const byId = new Map(pack.messages.map((m) => [m.message_id, m]));
  for (const p of line.proof) {
    const card = byId.get(p.message_id)?.card;
    if (card && (card.kind === 'vote' || card.kind === 'mandate')) ids.add(card.decision_id);
  }
  for (const card of turn?.cards ?? []) if (card.kind === 'vote' || card.kind === 'mandate') ids.add(card.decision_id);
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

/** Marks done every active linked line whose vote has settled it. Returns how many it marked. */
export async function settleDecisionLines(pool: Pool, link: ServerLink, tripId: string, pack: TripPack): Promise<number> {
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
    const done: CheckedLine = {
      kind,
      text: row.line.text,
      personIds: row.line.person_ids,
      proof: row.line.proof.map((p) => ({ message_id: p.message_id, person_id: p.person_id ?? null })),
      lineId: row.line_id,
      status: 'done',
    };
    const out = await writeLine(pool, link, tripId, done, lineRequestId(done));
    if ('lineId' in out) marked += 1;
  }
  return marked;
}
