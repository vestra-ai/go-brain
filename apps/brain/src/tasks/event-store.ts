/** What Go remembers about /v1 events: which it applied, where the events poll is up to, each stream's resume point. */
import type pg from 'pg';

export interface EventStore {
  /** True the first time an event id is seen. */
  markSeen(evtId: string, type: string): Promise<boolean>;
  unmarkSeen(evtId: string): Promise<void>;
  cursor(name: string): Promise<string | null>;
  setCursor(name: string, evtId: string): Promise<void>;
  lastSeq(conversationId: string): Promise<number | null>;
  /** Moves a resume point forward only. */
  setLastSeq(conversationId: string, seq: number): Promise<void>;
  /** Sets a resume point outright: after a 410, the conversation's head. */
  resetLastSeq(conversationId: string, seq: number): Promise<void>;
}

export function createEventStore(pool: pg.Pool, now: () => Date): EventStore {
  return {
    async markSeen(evtId, type) {
      const r = await pool.query('insert into v1_events_seen (evt_id, type, received_at) values ($1, $2, $3) on conflict (evt_id) do nothing', [evtId, type, now()]);
      return r.rowCount === 1;
    },
    async unmarkSeen(evtId) {
      await pool.query('delete from v1_events_seen where evt_id = $1', [evtId]);
    },
    async cursor(name) {
      const { rows } = await pool.query<{ evt_id: string }>('select evt_id from v1_cursor where name = $1', [name]);
      return rows[0]?.evt_id ?? null;
    },
    async setCursor(name, evtId) {
      await pool.query('insert into v1_cursor (name, evt_id, updated_at) values ($1, $2, $3) on conflict (name) do update set evt_id = excluded.evt_id, updated_at = excluded.updated_at', [name, evtId, now()]);
    },
    async lastSeq(conversationId) {
      const { rows } = await pool.query<{ last_seq: number }>('select last_seq from task_streams where conversation_id = $1', [conversationId]);
      return rows[0]?.last_seq ?? null;
    },
    async setLastSeq(conversationId, seq) {
      await pool.query(
        `insert into task_streams (conversation_id, last_seq, updated_at) values ($1, $2, $3)
         on conflict (conversation_id) do update set last_seq = greatest(task_streams.last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
        [conversationId, seq, now()],
      );
    },
    async resetLastSeq(conversationId, seq) {
      await pool.query(
        `insert into task_streams (conversation_id, last_seq, updated_at) values ($1, $2, $3)
         on conflict (conversation_id) do update set last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
        [conversationId, seq, now()],
      );
    },
  };
}
