/**
 * The stay a line points at, for a stay's rooms or reviews started early (fast.ts): one of the stays on the trip's newest
 * stays card, by its place on the card ("the second one", "pehle wale") or by a word of its name only it has ("Palm
 * Grove"), or the only one there. Anything less plain is null, and the composer asks which.
 */
import type pg from 'pg';
import type { ResultsStore } from '../results.js';
import type { ShownStay } from './fast.js';

const ORDINALS: Array<[number, RegExp]> = [
  [1, /\b(first|1st|pehla|pehle|pehli|number 1|option 1)\b|#\s*1\b/i],
  [2, /\b(second|2nd|doosra|doosre|doosri|dusra|dusre|dusri|number 2|option 2)\b|#\s*2\b/i],
  [3, /\b(third|3rd|teesra|teesre|teesri|tisra|tisre|number 3|option 3)\b|#\s*3\b/i],
];

/** Words in many stays' names, which never tell one from another. */
const GENERIC = new Set([
  'villa', 'villas', 'hotel', 'hotels', 'resort', 'resorts', 'homestay', 'homestays', 'stay', 'stays', 'suite', 'suites', 'inn', 'cottage',
  'cottages', 'apartment', 'apartments', 'house', 'guest', 'guesthouse', 'beach', 'goa', 'north', 'south', 'with', 'pool', 'the', 'and',
  'residency', 'retreat', 'boutique', 'luxury', 'premium', 'room', 'rooms', 'private', 'grand', 'palace', 'spa',
]);

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));

/** Which of the card's stays (its n, 1 to 3) the line points at, or null when it is not plain. */
export function pickStay(text: string, stays: Array<{ n: number; title: string }>): number | null {
  const byPlace = ORDINALS.filter(([n, re]) => re.test(text) && stays.some((s) => s.n === n)).map(([n]) => n);
  const said = new Set(wordsOf(text));
  const byName = stays.filter((s) => wordsOf(s.title).some((w) => said.has(w))).map((s) => s.n);
  const found = new Set([...byPlace, ...byName]);
  if (found.size === 1) return [...found][0]!;
  if (found.size === 0 && stays.length === 1) return stays[0]!.n;
  return null;
}

/** The stay the line points at on the trip's newest stays card, as the ixigo tool takes it and as its page. */
export async function stayOnCard(pool: pg.Pool, results: Pick<ResultsStore, 'get'>, tripId: string, text: string): Promise<ShownStay | null> {
  const { rows: cards } = await pool.query<{ card_id: string; results_id: string }>(
    `select card_id, results_id from options_cards where trip_id = $1 and option_kind = 'stay' order by created_at desc limit 1`,
    [tripId],
  );
  const card = cards[0];
  if (!card) return null;
  const { rows: stays } = await pool.query<{ n: number; title: string; source_url: string | null }>(
    `select n, title, option->>'sourceUrl' as source_url from travel_offers where card_id = $1 order by n`,
    [card.card_id],
  );
  const n = pickStay(text, stays);
  const page = stays.find((s) => s.n === n)?.source_url;
  if (!page) return null;
  // The tool names a stay by its place in the search's results, not on the card.
  const set = await results.get(tripId, card.results_id);
  const k = set?.options.findIndex((o) => o.sourceUrl === page) ?? -1;
  return k >= 0 ? { ref: `${card.results_id}#${k + 1}`, page } : null;
}
