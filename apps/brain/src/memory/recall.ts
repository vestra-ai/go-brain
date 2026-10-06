/**
 * Recall: a word search over this trip's messages and facts, about 50 to 100 ms. Deleted messages,
 * other trips and a forgotten person's earlier words never come back. Facts rank first: they are the
 * checked, short form of what someone said.
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

const STOP = new Set([
  'the', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'what', 'who',
  'whom', 'which', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'you',
  'he', 'she', 'we', 'they', 'it', 'me', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that', 'these', 'those',
  'there', 'about', 'any', 'anyone', 'someone', 'yet', 'not', 'no', 'go', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'kya',
  'kaun', 'kab', 'kahan', 'kaise', 'tha', 'thi', 'se', 'mein', 'bhi', 'toh', 'na', 'nahi', 'ne', 'ye', 'wo', 'woh', 'aur',
  'bhai', 'yaar', 'pls', 'please', 'again',
]);
// A few words people ask with that the answer rarely contains.
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
};

export function queryWords(question: string): string[] {
  const words = question.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (const x of EXPAND[w] ?? []) out.add(x);
  }
  return [...out].slice(0, 16);
}

export async function recall(
  pool: Pool,
  pack: TripPack,
  forgotten: ReadonlyMap<string, number>,
  question: string,
  audience: Audience,
): Promise<RecallHit[]> {
  const words = queryWords(question);
  if (words.length === 0) return [];
  const tripId = pack.trip.trip_id;
  const nameOf = new Map(pack.trip.people.map((p) => [p.person_id, p.name]));
  const named = pack.trip.people.filter((p) => words.includes((p.name.toLowerCase().split(/\s+/)[0] ?? '').trim())).map((p) => p.person_id);
  // Words are letters and digits only, so the query string cannot break to_tsquery.
  const tsq = words.map((w) => `${w}:*`).join(' | ');

  const facts = await pool.query<{ person_id: string; topic: string; text: string; message_id: string; seq: number; rank: number }>(
    `SELECT f.person_id, f.topic, f.text, f.message_id, m.seq, ts_rank(f.text_tsv, to_tsquery('simple', $2)) AS rank
       FROM facts f
       JOIN messages m ON m.trip_id = f.trip_id AND m.message_id = f.message_id AND m.deleted_at IS NULL
      WHERE f.trip_id = $1 AND f.superseded_by IS NULL AND ($4::text = 'go' OR f.audience = 'group')
        AND (f.text_tsv @@ to_tsquery('simple', $2) OR f.person_id = ANY($3::text[]))
      ORDER BY rank DESC
      LIMIT 20`,
    [tripId, tsq, named, audience],
  );
  const msgs = await pool.query<{ message_id: string; seq: number; person_id: string | null; text: string; rank: number; sim: number }>(
    `SELECT m.message_id, m.seq, m.person_id, m.text,
            ts_rank(m.text_tsv, to_tsquery('simple', $2)) AS rank,
            (SELECT coalesce(max(public.word_similarity(w, m.text)), 0) FROM unnest($3::text[]) AS w) AS sim
       FROM messages m
      WHERE m.trip_id = $1 AND m.deleted_at IS NULL AND m.text IS NOT NULL
        AND (m.text_tsv @@ to_tsquery('simple', $2)
             OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS w WHERE w OPERATOR(public.<%) m.text))
      ORDER BY rank DESC, m.seq DESC
      LIMIT 40`,
    [tripId, tsq, words],
  );

  const best = new Map<string, { hit: RecallHit; score: number }>();
  const put = (hit: RecallHit, score: number): void => {
    const had = best.get(hit.messageId);
    if (!had || had.score < score) best.set(hit.messageId, { hit, score });
  };
  for (const f of facts.rows) {
    const score = 1 + Number(f.rank) + (named.includes(f.person_id) ? 0.5 : 0);
    put({ text: `${nameOf.get(f.person_id) ?? 'Someone'} (${f.topic}): ${f.text}`, messageId: f.message_id, seq: f.seq }, score);
  }
  for (const m of msgs.rows) {
    if (m.person_id) {
      const upTo = forgotten.get(m.person_id);
      if (upTo !== undefined && m.seq <= upTo) continue;
    }
    const who = m.person_id ? (nameOf.get(m.person_id) ?? 'Someone') : 'Go';
    const score = Number(m.rank) + Number(m.sim) * 0.5 + (m.person_id && named.includes(m.person_id) ? 0.3 : 0);
    put({ text: `${who}: ${maskSecrets(m.text).text.slice(0, 300)}`, messageId: m.message_id, seq: m.seq }, score);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.hit.seq - a.hit.seq)
    .slice(0, 8)
    .map((x) => x.hit);
}
