/** Every reaction Go sends (the reflex, the notes pass, the composer's react tool): at most one per message and emoji, with a request_id derived from them. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Message } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import type { ServerLink } from '../door/server-link.js';

/** The same trip, message and emoji always give the same request_id, so a retry after a crash is done once. */
export function reactionRequestId(tripId: string, messageId: string, emoji: string): string {
  return `go_react_${createHash('sha256').update(`${tripId}|${messageId}|${emoji}`).digest('hex').slice(0, 24)}`;
}

type Outcome = 'sent' | 'skipped' | 'failed';

/** Reactions being sent right now in this process, by request id: a second caller for the same one waits for the first. */
const inflight = new Map<string, Promise<Outcome>>();

export function reactOnce(pool: Pool, link: ServerLink, tripId: string, message: Message, emoji: string): Promise<Outcome> {
  const key = reactionRequestId(tripId, message.message_id, emoji);
  const running = inflight.get(key);
  if (running) return running.then((r) => (r === 'sent' ? 'skipped' : r));
  const p = sendOnce(pool, link, tripId, message, emoji).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function sendOnce(pool: Pool, link: ServerLink, tripId: string, message: Message, emoji: string): Promise<Outcome> {
  if (message.author.kind !== 'person' || message.deleted || message.withheld) return 'skipped';
  if (message.reactions.some((r) => r.person_id == null && r.emoji === emoji)) return 'skipped';
  await pool.query(
    `INSERT INTO go_reactions (trip_id, message_id, emoji, request_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (trip_id, message_id, emoji) DO NOTHING`,
    [tripId, message.message_id, emoji, reactionRequestId(tripId, message.message_id, emoji)],
  );
  const row = (
    await pool.query<{ request_id: string; done_at: Date | null }>(
      'SELECT request_id, done_at FROM go_reactions WHERE trip_id = $1 AND message_id = $2 AND emoji = $3',
      [tripId, message.message_id, emoji],
    )
  ).rows[0]!;
  if (row.done_at) return 'skipped';
  const markDone = () =>
    pool.query('UPDATE go_reactions SET done_at = now() WHERE trip_id = $1 AND message_id = $2 AND emoji = $3', [tripId, message.message_id, emoji]);
  try {
    await link.request('add_reaction', { request_id: row.request_id, trip_id: tripId, message_id: message.message_id, emoji });
  } catch (err) {
    // 409: already reacted or the message was deleted; 404 and 422: nothing to retry.
    if (err instanceof SocketCallError && [404, 409, 422].includes(err.code)) {
      await markDone();
      return 'skipped';
    }
    return 'failed';
  }
  await markDone();
  return 'sent';
}
