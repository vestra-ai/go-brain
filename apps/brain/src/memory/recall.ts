/**
 * Recall: a word search over this trip's messages and facts, under 100 ms. The question's content words are
 * matched with English stemming ("paying" finds "pays") and by prefix, and with trigrams for romanised spellings
 * ("khana", "khaana"). A rare word counts for more than a common one, so "scooter" outweighs "want" in a chat full
 * of "I want ...". The best answer comes first, a fact or a message alike. A fact comes back with the words and number
 * of the message it was said in, and the numbers of earlier messages on its topic, so the answer keeps its proof; on
 * a tie the fact wins. Someone the question names brings at most two of their facts that match no word. Deleted
 * messages, other trips and a forgotten person's earlier words never come back.
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
/** A fact over a message that scores the same: the checked, short form wins a tie. */
const FACT_EDGE = 0.5;
/** Facts of someone the question names that match no word of it: some context, never a crowd. */
const OTHER_FACTS_MAX = 2;
/** The earlier messages on a fact's topic it names, newest first. */
const EARLIER_MAX = 3;
/** How much of a fact's source message comes with it. */
const SAID_MAX = 200;

interface Term {
  word: string;
  weight: number;
}

/** A candidate answer; a fact keeps what its proof needs. */
interface Ranked {
  hit: RecallHit;
  score: number;
  lexemes: number;
  same: string;
  fact?: { personId: string; topic: string; said: string; other: boolean };
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
  const facts = await pool.query<{ person_id: string; topic: string; text: string; message_id: string; seq: number; said: string | null; words: string[] }>(
    `SELECT * FROM (
       SELECT f.person_id, f.topic, f.text, f.message_id, m.seq, m.text AS said,
              ARRAY(SELECT u.word FROM unnest($2::text[]) AS u(word)
                     WHERE to_tsvector('english', f.topic || ' ' || f.text) @@ to_tsquery('english', u.word || ':*')) AS words
         FROM facts f
         JOIN messages m ON m.trip_id = f.trip_id AND m.message_id = f.message_id AND m.deleted_at IS NULL
        WHERE f.trip_id = $1 AND f.superseded_by IS NULL AND ($4::text = 'go' OR f.audience = 'group')
     ) c
     WHERE cardinality(c.words) > 0 OR c.person_id = ANY($3::text[])`,
    [tripId, words, named, audience],
  );
  // How many messages each word matches, so a fact's words weigh what they weigh in the chat.
  const df = await pool.query<{ word: string; n: number }>(
    `SELECT u.word, count(m.message_id)::float8 AS n
       FROM unnest($2::text[]) AS u(word)
       LEFT JOIN messages m ON m.trip_id = $1 AND m.deleted_at IS NULL AND m.text IS NOT NULL
                           AND m.text_tsv_en @@ to_tsquery('english', u.word || ':*')
      GROUP BY u.word`,
    [tripId, words],
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

  const best = new Map<string, Ranked>();
  const put = (hit: RecallHit, score: number, lexemes: number, words: string): void => {
    const had = best.get(hit.messageId);
    const same = words.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!had || had.score < score) best.set(hit.messageId, { hit, score, lexemes, same });
  };
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
  // A fact takes its message's place, with that message's words. It scores what its own words score (weighed like a
  // message's), or what its message scored when that is more, plus the fact's edge. A fact that matches no word and
  // whose message matched none either is one of the named person's other facts: it scores the name alone.
  const idf = new Map(df.rows.map((r) => [r.word, Math.max(Math.log((pack.messages.length + 1) / (Number(r.n) + 0.5)), 0.1)]));
  const weightOf = new Map(terms.map((t) => [t.word, t.weight]));
  const messageScore = new Map([...best].map(([id, x]) => [id, x.score]));
  for (const f of facts.rows) {
    if (forgottenMessage(f.person_id, f.seq)) continue;
    const isNamed = named.includes(f.person_id);
    const own = f.words.reduce((s, w) => s + (weightOf.get(w) ?? 0) * (idf.get(w) ?? 0.1), 0) + (isNamed ? NAMED_BONUS : 0);
    const base = messageScore.get(f.message_id);
    const other = f.words.length === 0 && base === undefined;
    const score = other ? (isNamed ? NAMED_BONUS : 0) : Math.max(f.words.length > 0 ? own : 0, base ?? 0) + FACT_EDGE;
    const had = best.get(f.message_id);
    if (had?.fact && had.score >= score) continue;
    best.set(f.message_id, {
      hit: { text: `${nameOf.get(f.person_id) ?? 'Someone'} (${f.topic}): ${f.text}`, messageId: f.message_id, seq: f.seq },
      score,
      lexemes: 0,
      same: f.text.toLowerCase().replace(/\s+/g, ' ').trim(),
      fact: { personId: f.person_id, topic: f.topic, said: f.said ? maskSecrets(f.said).text.slice(0, SAID_MAX) : '', other },
    });
  }
  // Ties go to the shorter message (a plain statement beats a long one that mentions the word), then the newer.
  // The same words said again (chat filler) come back once, so they never crowd out the line that answers.
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.lexemes - b.lexemes || b.hit.seq - a.hit.seq);
  const said = new Set<string>();
  const out: Ranked[] = [];
  let others = 0;
  for (const x of ranked) {
    if (said.has(x.same)) continue;
    if (x.fact?.other) {
      if (others === OTHER_FACTS_MAX) continue;
      others += 1;
    }
    said.add(x.same);
    out.push(x);
    if (out.length === RECALL_MAX) break;
  }

  // The proof: each fact names the message it was said in, with its words, and the earlier messages on its topic
  // (a newer fact on a topic replaces the older one, whose message still says it first).
  const shown = out.flatMap((x) => (x.fact ? [`${x.fact.personId}:${x.fact.topic}`] : []));
  const earlier = new Map<string, number[]>();
  if (shown.length > 0) {
    const r = await pool.query<{ person_id: string; topic: string; seq: number }>(
      `SELECT f.person_id, f.topic, m.seq FROM facts f
         JOIN messages m ON m.trip_id = f.trip_id AND m.message_id = f.message_id AND m.deleted_at IS NULL
        WHERE f.trip_id = $1 AND f.superseded_by IS NOT NULL AND ($3::text = 'go' OR f.audience = 'group')
          AND f.person_id || ':' || f.topic = ANY($2::text[])`,
      [tripId, shown, audience],
    );
    for (const row of r.rows) {
      if (forgottenMessage(row.person_id, row.seq)) continue;
      const key = `${row.person_id}:${row.topic}`;
      earlier.set(key, [...(earlier.get(key) ?? []), row.seq]);
    }
  }
  return out.map((x) => {
    if (!x.fact) return x.hit;
    const who = nameOf.get(x.fact.personId) ?? 'Someone';
    const before = [...new Set(earlier.get(`${x.fact.personId}:${x.fact.topic}`) ?? [])]
      .filter((s) => s < x.hit.seq)
      .sort((a, b) => b - a)
      .slice(0, EARLIER_MAX);
    const proof = [
      x.fact.said ? `#${x.hit.seq} ${who}: ${x.fact.said}` : `#${x.hit.seq}`,
      ...(before.length ? [`earlier on this topic: ${before.map((s) => `#${s}`).join(', ')}`] : []),
    ].join('; ');
    return { ...x.hit, text: `${x.hit.text} (${proof})` };
  });
}
