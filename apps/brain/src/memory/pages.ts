/**
 * A person's page is drawn from their facts, never written: one line per topic with its proof.
 * This trip's fact wins its topic; otherwise, only when the person turned carry-over on, the newest
 * fact on that topic from another trip fills it (a person has one current fact per topic). Only a fact about the
 * person carries: one about that trip alone (when they could leave, who came along, its stay area) stays there
 * (staging, 10 Oct: "Arjun can leave Thursday" and "Kabir's mom might join" showed up in the next trip).
 */
import type { Pool } from 'pg';
import { getCarryOver, type Audience } from './facts.js';

export async function drawPage(pool: Pool, tripId: string, personId: string, audience: Audience): Promise<string> {
  const carry = await getCarryOver(pool, personId);
  const r = await pool.query<{ trip_id: string; topic: string; text: string; message_id: string | null; audience: Audience; seq: number | null }>(
    `SELECT f.trip_id, f.topic, f.text, f.message_id, f.audience, m.seq
       FROM facts f
       LEFT JOIN messages m ON m.trip_id = f.trip_id AND m.message_id = f.message_id
      WHERE f.person_id = $1 AND f.superseded_by IS NULL
        AND (f.trip_id = $2 OR ($3::boolean AND f.scope = 'person'))
        AND ($4::text = 'go' OR f.audience = 'group')
      ORDER BY (f.trip_id = $2) DESC, f.said_at DESC, f.fact_id`,
    [personId, tripId, carry, audience],
  );
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of r.rows) {
    if (seen.has(row.topic)) continue;
    seen.add(row.topic);
    const proof =
      row.trip_id !== tripId ? '(earlier trip)' : row.message_id === null ? '(join answer)' : row.seq !== null ? `(#${row.seq})` : '(a message)';
    lines.push(`- ${row.topic}: ${row.text} ${proof}${row.audience === 'go' ? ' [only for Go]' : ''}`);
  }
  return lines.join('\n');
}
