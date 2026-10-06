/** Test support for memory: seed P1's messages table, a fake ServerLink, a scripted side model. */
import type { Pool } from 'pg';
import type { Message } from '../../door/methods.js';
import type { ServerLink } from '../../door/server-link.js';

/** Writes messages the way P1's trip log stores them (one row per message, the whole message in payload). */
export async function seedMessages(pool: Pool, tripId: string, messages: Message[]): Promise<void> {
  const rows = messages.map((m) => ({
    message_id: m.message_id,
    seq: m.seq,
    updated_seq: m.updated_seq,
    person_id: m.author.kind === 'person' ? m.author.person_id : null,
    text: m.deleted ? null : (m.text ?? null),
    reply_to: m.reply_to ?? null,
    deleted_at: m.deleted ? '2026-10-06T00:00:00Z' : null,
    payload: m,
  }));
  await pool.query(
    `INSERT INTO messages (trip_id, message_id, seq, updated_seq, person_id, text, reply_to, deleted_at, payload)
     SELECT $1, x.message_id, x.seq, x.updated_seq, x.person_id, x.text, x.reply_to, x.deleted_at, x.payload
       FROM jsonb_to_recordset($2::jsonb)
         AS x(message_id text, seq int, updated_seq int, person_id text, text text, reply_to text, deleted_at timestamptz, payload jsonb)`,
    [tripId, JSON.stringify(rows)],
  );
}

export interface LinkCall {
  method: string;
  params: Record<string, unknown>;
}

/** Records every request; add_record_line answers a fresh line id. `fail` may throw for chosen calls. */
export function fakeLink(opts: { fail?: (method: string, params: Record<string, unknown>) => Error | null } = {}): ServerLink & { calls: LinkCall[] } {
  const calls: LinkCall[] = [];
  let seq = 1000;
  const link = {
    calls,
    isOpen: () => true,
    notify: () => {},
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const err = opts.fail?.(method, params);
      if (err) throw err;
      seq += 1;
      if (method === 'add_record_line') return { line_id: `r_${seq}`, seq };
      return { seq };
    },
  };
  return link as unknown as ServerLink & { calls: LinkCall[] };
}

/** A side model that answers from a script, one answer per call, and keeps every prompt. */
export function scriptedSide(answers: string[]) {
  const prompts: Array<{ purpose: string; system: string; user: string; maxTokens: number }> = [];
  return {
    prompts,
    async complete(req: { purpose: 'notes' | 'fold'; system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string> {
      prompts.push({ purpose: req.purpose, system: req.system, user: req.user, maxTokens: req.maxTokens });
      const next = answers.shift();
      if (next === undefined) throw new Error('the scripted side model has no answer left');
      return next;
    },
  };
}
