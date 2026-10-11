/**
 * The option a line points at, for an ask about one shown option started early (fast.ts: a stay's rooms or reviews, a
 * flight's fare): one of the options on the trip's newest card of that kind, by its place on the card ("the second
 * one", "pehle wale") or by a word of its name only it has ("Palm Grove", "Akasa"), or the only one there. Anything less
 * plain is null, and the composer asks which.
 */
import type pg from 'pg';
import { MORE_CARD, type ResultsStore } from '../results.js';
import type { ShownOption } from './fast.js';

const ORDINALS: Array<[number, RegExp]> = [
  [1, /\b(first|1st|pehla|pehle|pehli|number 1|option 1)\b|#\s*1\b/i],
  [2, /\b(second|2nd|doosra|doosre|doosri|dusra|dusre|dusri|number 2|option 2)\b|#\s*2\b/i],
  [3, /\b(third|3rd|teesra|teesre|teesri|tisra|tisre|number 3|option 3)\b|#\s*3\b/i],
];

/** Words in many options' names, which never tell one from another. */
const GENERIC = new Set([
  'villa', 'villas', 'hotel', 'hotels', 'resort', 'resorts', 'homestay', 'homestays', 'stay', 'stays', 'suite', 'suites', 'cottage',
  'cottages', 'apartment', 'apartments', 'house', 'guest', 'guesthouse', 'beach', 'north', 'south', 'with', 'pool', 'residency',
  'retreat', 'boutique', 'luxury', 'premium', 'room', 'rooms', 'private', 'grand', 'palace', 'flight', 'flights', 'airlines',
  'airways', 'nonstop', 'direct',
]);

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));

/** Which of the card's options (its n, 1 to 3) the line points at, or null when it is not plain. */
export function pickOption(text: string, options: Array<{ n: number; title: string }>): number | null {
  const byPlace = ORDINALS.filter(([n, re]) => re.test(text) && options.some((o) => o.n === n)).map(([n]) => n);
  const said = new Set(wordsOf(text));
  const byName = options.filter((o) => wordsOf(o.title).some((w) => said.has(w))).map((o) => o.n);
  const found = new Set([...byPlace, ...byName]);
  if (found.size === 1) return [...found][0]!;
  if (found.size === 0 && options.length === 1) return options[0]!.n;
  return null;
}

/** The option the line points at on the trip's newest card of this kind, as the ixigo tool takes it and as its page. */
export async function optionOnCard(
  pool: pg.Pool,
  results: Pick<ResultsStore, 'get'>,
  tripId: string,
  text: string,
  kind: 'stay' | 'flight',
): Promise<ShownOption | null> {
  const { rows: cards } = await pool.query<{ card_id: string; results_id: string }>(
    // A "See more" card is more of the card before it, never the newest card itself.
    'select card_id, results_id from options_cards where trip_id = $1 and option_kind = $2 and not starts_with(card_id, $3) order by created_at desc limit 1',
    [tripId, kind, `${MORE_CARD}_`],
  );
  const card = cards[0];
  if (!card) return null;
  const { rows: options } = await pool.query<{ n: number; title: string; source_url: string | null }>(
    `select n, title, option->>'sourceUrl' as source_url from travel_offers where card_id = $1 order by n`,
    [card.card_id],
  );
  const n = pickOption(text, options);
  const page = options.find((o) => o.n === n)?.source_url;
  if (!page) return null;
  // The tool names an option by its place in the search's results, not on the card.
  const set = await results.get(tripId, card.results_id);
  const k = set?.options.findIndex((o) => o.sourceUrl === page) ?? -1;
  return k >= 0 ? { ref: `${card.results_id}#${k + 1}`, page } : null;
}
