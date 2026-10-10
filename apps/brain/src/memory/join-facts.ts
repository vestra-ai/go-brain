/**
 * Join answers (where they travel from, the earliest they can leave, "anything Go should know") become
 * facts with no message, as the guide says. A person's own words in the chat win over a join answer on
 * the same topic; a join answer someone cleared is deleted.
 */
import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { hasSecret } from '../reflex/secrets.js';
import { cleanText } from './checker.js';
import { currentFacts, deleteFactChain, saveFact, type FactScope } from './facts.js';

const KNOW_TOPICS: Array<[RegExp, string]> = [
  [/\b(veg|vegetarian|vegan|jain|non[- ]?veg|allerg\w*|nuts?|gluten|lactose|eat|khana|spicy)\b/i, 'food'],
  [/\b(drink|drinks|alcohol|beer|sharab|daaru|teetotal)\b/i, 'drinks'],
  [/\b(seat|aisle|window)\b/i, 'seats'],
  [/\b(flight|flights|fly|flying)\b/i, 'flights'],
  [/\b(land|lands|landing|arriv\w*)\b/i, 'arriving'],
  [/\b(birthday|bday)\b/i, 'birthday'],
  [/\b(sleep|snore|neend)\b/i, 'sleep'],
  [/\b(swim|sea|boat|boats|seasick)\b/i, 'water'],
];

const TRIP_TOPICS: ReadonlySet<string> = new Set(['leaving', 'arriving']);

export function joinFacts(p: C.Person): Array<{ topic: string; text: string; scope: FactScope }> {
  const out: Array<{ topic: string; text: string; scope: FactScope }> = [];
  const used = new Set<string>();
  // When they can leave or land is this trip's answer, never their next trip's; the rest is about them.
  const add = (topic: string, raw: string, scope: FactScope = TRIP_TOPICS.has(topic) ? 'trip' : 'person'): void => {
    const text = cleanText(raw, 200);
    if (!text || hasSecret(text)) return;
    let t = topic;
    for (let i = 2; used.has(t); i += 1) t = `${topic}_${i}`;
    used.add(t);
    out.push({ topic: t, text, scope });
  };
  if (p.from_city) add('from', `From ${p.from_city}`);
  if (p.earliest_leave) add('leaving', `Can leave ${p.earliest_leave}`);
  p.know.forEach((k, i) => add(KNOW_TOPICS.find(([re]) => re.test(k))?.[1] ?? `note_${i + 1}`, k));
  return out;
}

export async function syncJoinFacts(pool: Pool, tripId: string, person: C.Person): Promise<void> {
  const want = joinFacts(person);
  const current = await currentFacts(pool, { personId: person.person_id, tripId });
  const byTopic = new Map(current.map((f) => [f.topic, f]));
  for (const w of want) {
    const had = byTopic.get(w.topic);
    if (had && had.source !== 'join') continue; // the person's own words win
    await saveFact(pool, {
      personId: person.person_id, tripId, topic: w.topic, text: w.text, messageId: null,
      saidAt: new Date(person.joined_at), audience: 'group', source: 'join', scope: w.scope,
    });
  }
  const wanted = new Set(want.map((w) => w.topic));
  // A cleared answer takes its whole history with it, so no older answer comes back as current.
  for (const f of current) if (f.source === 'join' && !wanted.has(f.topic)) await deleteFactChain(pool, person.person_id, f.factId);
}
