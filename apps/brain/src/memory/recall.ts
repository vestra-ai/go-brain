/**
 * Recall: a word search over this trip's messages and facts, under 100 ms. The question's content words are
 * matched with English stemming ("paying" finds "pays") and by prefix, and with trigrams for romanised spellings
 * ("khana", "khaana"). A rare word counts for more than a common one, so "scooter" outweighs "want" in a chat full
 * of "I want ...". Facts rank first: they are the checked, short form of what someone said. Deleted messages, other
 * trips and a forgotten person's earlier words never come back.
 */
import type { Pool } from 'pg';
import { maskSecrets } from '../reflex/secrets.js';
import type { TripPack } from '../trips/pack.js';
import type { Audience } from './facts.js';

export interface RecallHit {
  text: string;
  messageId: string;
  seq: number;
}

/** At most this many hits: the composer reads them in its turn. */
export const RECALL_MAX = 5;

const STOP = new Set([
  'the', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'from', 'by', 'as', 'if', 'so', 'but', 'what', 'who', 'whom', 'which', 'when', 'where', 'why', 'how', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'should', 'have', 'has', 'had', 'you', 'he', 'she', 'we', 'they', 'it', 'its', 'me', 'my',
  'us', 'our', 'your', 'his', 'her', 'their', 'them', 'this', 'that', 'these', 'those', 'there', 'about', 'any', 'anyone',
  'someone', 'everyone', 'yet', 'not', 'no', 'too', 'very', 'also', 'just', 'said', 'say', 'says', 'tell', 'told', 'get',
  'gets', 'got', 'go', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'kya', 'kaun', 'kab', 'kahan', 'kaise', 'tha', 'thi', 'se',
  'mein', 'bhi', 'toh', 'na', 'nahi', 'ne', 'ye', 'wo', 'woh', 'aur', 'bhai', 'yaar', 'pls', 'please', 'again',
]);
// A few words people ask with that the answer rarely contains. They count half as much as the question's own words.
const EXPAND: Record<string, string[]> = {
  eat: ['food', 'veg', 'vegetarian', 'vegan', 'allergic', 'allergy', 'khana'],
  food: ['veg', 'vegetarian', 'vegan', 'allergic', 'allergy', 'khana'],
  drink: ['drinks', 'alcohol', 'daaru', 'beer'],
  pay: ['paid', 'payment', 'upi', 'share'],
  paid: ['pay', 'payment', 'upi', 'share'],
  owe: ['paid', 'pay', 'upi', 'share'],
  leave: ['leaving', 'nikal', 'after'],
  flight: ['flights', 'fly', 'lands'],
  seat: ['seats', 'aisle', 'window'],
  sick: ['seasick', 'motion'],
  early: ['before'],
  late: ['after'],
  birthday: ['bday'],
};
const EXPANDED_WEIGHT = 0.5;
/** A message by someone the question names ("What is Meher allergic to?"): about one more rare-ish word. */
const NAMED_BONUS = 2;
/** A trigram match alone (a romanised spelling) counts for less than a stemmed word match. */
const TRIGRAM_WEIGHT = 1;

interface Term {
  word: string;
  weight: number;
}

/** The question's content words, then each one's extra words, at most 16. Contractions drop their tails first. */
function queryTerms(question: string): Term[] {
  const words = question
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/'(s|re|ll|m|ve|d)\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  const out = new Map<string, number>();
  for (const w of words) {
    out.set(w, Math.max(out.get(w) ?? 0, 1));
    for (const x of EXPAND[w] ?? []) if (!out.has(x)) out.set(x, EXPANDED_WEIGHT);
  }
  return [...out].slice(0, 16).map(([word, weight]) => ({ word, weight }));
}

export function queryWords(question: string): string[] {
  return queryTerms(question).map((t) => t.word);
}

export async function recall(
  pool: Pool,
  pack: TripPack,
  forgotten: ReadonlyMap<string, number>,
  question: string,
  audience: Audience,
): Promise<RecallHit[]> {
  const terms = queryTerms(question);
  if (terms.length === 0) return [];
  const tripId = pack.trip.trip_id;
  const words = terms.map((t) => t.word);
  const own = terms.filter((t) => t.weight === 1).map((t) => t.word);
  const nameOf = new Map(pack.trip.people.map((p) => [p.person_id, p.name]));
  const named = pack.trip.people.filter((p) => words.includes((p.name.toLowerCase().split(/\s+/)[0] ?? '').trim())).map((p) => p.person_id);
  // Words are letters and digits only, so they cannot break to_tsquery.
  const tsq = words.map((w) => `${w}:*`).join(' | ');

  const facts = await pool.query<{ person_id: string; topic: string; text: string; message_id: string; seq: number; rank: number }>(
    `SELECT f.person_id, f.topic, f.text, f.message_id, m.seq,
            ts_rank(to_tsvector('english', f.topic || ' ' || f.text), to_tsquery('english', $2)) AS rank
       FROM facts f
       JOIN messages m ON m.trip_id = f.trip_id AND m.message_id = f.message_id AND m.deleted_at IS NULL
      WHERE f.trip_id = $1 AND f.superseded_by IS NULL AND ($4::text = 'go' OR f.audience = 'group')
        AND (to_tsvector('english', f.topic || ' ' || f.text) @@ to_tsquery('english', $2) OR f.person_id = ANY($3::text[]))
      ORDER BY rank DESC
      LIMIT 20`,
    [tripId, tsq, named, audience],
  );

  // Every message a word matches, weighted by how rare the word is in this trip (inverse document frequency), plus a
  // bonus when someone the question names wrote it. The same words said again (chat filler) count once, so they can
  // never fill the list ahead of the line that answers.
  const msgs = await pool.query<{ message_id: string; seq: number; person_id: string | null; text: string; lexemes: number; weight: number }>(
    `WITH q AS (
       SELECT u.word, u.weight, to_tsquery('english', u.word || ':*') AS tq
         FROM unnest($2::text[], $3::float8[]) AS u(word, weight)
     ),
     hits AS (
       SELECT m.message_id, q.word, q.weight
         FROM q JOIN messages m ON m.text_tsv_en @@ q.tq
        WHERE m.trip_id = $1 AND m.deleted_at IS NULL AND m.text IS NOT NULL
     ),
     df AS (SELECT word, count(*)::float8 AS n FROM hits GROUP BY word),
     scored AS (
       SELECT h.message_id, sum(h.weight * greatest(ln(($4::float8 + 1) / (df.n + 0.5)), 0.1)) AS weight
         FROM hits h JOIN df USING (word)
        GROUP BY h.message_id
     ),
     once AS (
       SELECT DISTINCT ON (lower(m.text)) m.message_id, m.seq, m.person_id, m.text, length(m.text_tsv_en) AS lexemes,
              s.weight + CASE WHEN m.person_id = ANY($5::text[]) THEN $6::float8 ELSE 0 END AS weight
         FROM scored s JOIN messages m ON m.trip_id = $1 AND m.message_id = s.message_id
        ORDER BY lower(m.text), s.weight + CASE WHEN m.person_id = ANY($5::text[]) THEN $6::float8 ELSE 0 END DESC, m.seq DESC
     )
     SELECT * FROM once ORDER BY weight DESC, lexemes, seq DESC LIMIT 40`,
    [tripId, words, terms.map((t) => t.weight), pack.messages.length, named, NAMED_BONUS],
  );
  // Romanised spellings the stemmer cannot join ("khana" and "khaana"): trigrams on the question's own words.
  const near = own.filter((w) => w.length >= 3);
  const fuzzy = near.length === 0
    ? { rows: [] as Array<{ message_id: string; seq: number; person_id: string | null; text: string; lexemes: number; sim: number }> }
    : await pool.query<{ message_id: string; seq: number; person_id: string | null; text: string; lexemes: number; sim: number }>(
        `SELECT * FROM (
           SELECT DISTINCT ON (lower(m.text)) m.message_id, m.seq, m.person_id, m.text, length(m.text_tsv_en) AS lexemes,
                  public.word_similarity(q.w, m.text) AS sim
             FROM unnest($2::text[]) AS q(w)
             JOIN messages m ON q.w OPERATOR(public.<%) m.text
            WHERE m.trip_id = $1 AND m.deleted_at IS NULL AND m.text IS NOT NULL
            ORDER BY lower(m.text), public.word_similarity(q.w, m.text) DESC, m.seq DESC
         ) once
         ORDER BY sim DESC, seq DESC
         LIMIT 40`,
        [tripId, near],
      );

  const best = new Map<string, { hit: RecallHit; score: number; lexemes: number; same: string }>();
  const put = (hit: RecallHit, score: number, lexemes: number, words: string): void => {
    const had = best.get(hit.messageId);
    const same = words.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!had || had.score < score) best.set(hit.messageId, { hit, score, lexemes, same });
  };
  // Facts come first, whatever a message scores.
  for (const f of facts.rows) {
    const score = 1_000 + Number(f.rank) + (named.includes(f.person_id) ? 0.5 : 0);
    put({ text: `${nameOf.get(f.person_id) ?? 'Someone'} (${f.topic}): ${f.text}`, messageId: f.message_id, seq: f.seq }, score, 0, f.text);
  }
  const forgottenMessage = (personId: string | null, seq: number): boolean => {
    if (!personId) return false;
    const upTo = forgotten.get(personId);
    return upTo !== undefined && seq <= upTo;
  };
  const messageHit = (m: { message_id: string; seq: number; person_id: string | null; text: string }): RecallHit => {
    const who = m.person_id ? (nameOf.get(m.person_id) ?? 'Someone') : 'Go';
    return { text: `${who}: ${maskSecrets(m.text).text.slice(0, 300)}`, messageId: m.message_id, seq: m.seq };
  };
  const bySimilar = new Map(fuzzy.rows.map((r) => [r.message_id, Number(r.sim)]));
  for (const m of msgs.rows) {
    if (forgottenMessage(m.person_id, m.seq)) continue;
    put(messageHit(m), Number(m.weight) + TRIGRAM_WEIGHT * (bySimilar.get(m.message_id) ?? 0) * 0.5, Number(m.lexemes), m.text);
  }
  for (const m of fuzzy.rows) {
    if (forgottenMessage(m.person_id, m.seq) || best.has(m.message_id)) continue;
    const bonus = m.person_id && named.includes(m.person_id) ? NAMED_BONUS : 0;
    put(messageHit(m), TRIGRAM_WEIGHT * Number(m.sim) + bonus, Number(m.lexemes), m.text);
  }
  // Ties go to the shorter message (a plain statement beats a long one that mentions the word), then the newer.
  // The same words said again (chat filler) come back once, so they never crowd out the line that answers.
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.lexemes - b.lexemes || b.hit.seq - a.hit.seq);
  const said = new Set<string>();
  const out: RecallHit[] = [];
  for (const x of ranked) {
    if (said.has(x.same)) continue;
    said.add(x.same);
    out.push(x.hit);
    if (out.length === RECALL_MAX) break;
  }
  return out;
}
