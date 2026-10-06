/**
 * The trip record: the Server holds it; Go keeps a copy by change number (from trip.created,
 * record.changed and fresh snapshots) and writes its own agreed, open and doing lines through the
 * socket. Each write is stored first with its request_id (crash-safe, never minted at random), so a
 * retry after a crash is done once and a line already sent is never sent again.
 */
import { createHash } from 'node:crypto';
import type * as C from '@go/contract';
import type { Pool } from 'pg';
import type { ToServerParams, Trip } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import type { ServerLink } from '../door/server-link.js';
import { normLine, type CheckedLine } from './checker.js';
import type { Db } from './facts.js';

export async function mirrorLine(db: Db, tripId: string, line: C.RecordLine, seq: number): Promise<void> {
  await db.query(
    `INSERT INTO record_lines (trip_id, line_id, seq, line, kind, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (trip_id, line_id) DO UPDATE
       SET seq = EXCLUDED.seq, line = EXCLUDED.line, kind = EXCLUDED.kind, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
       WHERE record_lines.seq <= EXCLUDED.seq`,
    [tripId, line.line_id, seq, JSON.stringify(line), line.kind, line.status, line.updated_at],
  );
}

/** Every line of a snapshot in one statement; a line already newer in the copy stays. */
export async function mirrorSnapshot(db: Db, trip: Trip): Promise<void> {
  if (trip.record.length === 0) return;
  await db.query(
    `INSERT INTO record_lines (trip_id, line_id, seq, line, kind, status, updated_at)
     SELECT $1, x->>'line_id', $2, x, x->>'kind', x->>'status', (x->>'updated_at')::timestamptz
       FROM jsonb_array_elements($3::jsonb) AS x
     ON CONFLICT (trip_id, line_id) DO UPDATE
       SET seq = EXCLUDED.seq, line = EXCLUDED.line, kind = EXCLUDED.kind, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
       WHERE record_lines.seq <= EXCLUDED.seq`,
    [trip.trip_id, trip.seq, JSON.stringify(trip.record)],
  );
}

export async function recordLines(db: Db, tripId: string): Promise<C.RecordLine[]> {
  const r = await db.query<{ line: C.RecordLine }>(
    `SELECT line FROM record_lines WHERE trip_id = $1 ORDER BY (line->>'created_at'), line_id`,
    [tripId],
  );
  return r.rows.map((x) => x.line);
}

type AddParams = Omit<ToServerParams<'add_record_line'>, 'request_id'>;
type UpdateParams = Omit<ToServerParams<'update_record_line'>, 'request_id'>;
export type WriteOutcome = { lineId: string } | { failed: string };

/** Same words, kind, proof and target: same key, so the same line is never sent twice. */
export function writeKey(line: CheckedLine): string {
  const proofIds = line.proof.map((p) => p.message_id).sort();
  return createHash('sha256')
    .update(JSON.stringify([line.lineId ?? '', line.kind, normLine(line.text), proofIds, line.status ?? '']))
    .digest('hex')
    .slice(0, 40);
}

function paramsFor(tripId: string, line: CheckedLine): { method: 'add_record_line'; params: AddParams } | { method: 'update_record_line'; params: UpdateParams } {
  const common = {
    trip_id: tripId,
    kind: line.kind,
    text: line.text,
    proof: line.proof,
    person_ids: line.personIds,
    ...(line.dueAt ? { due_at: line.dueAt } : {}),
  };
  if (line.lineId) {
    return { method: 'update_record_line', params: { ...common, line_id: line.lineId, ...(line.status ? { status: line.status } : {}) } };
  }
  return { method: 'add_record_line', params: common };
}

/** The request_id for a line written outside a turn (the notes pass): derived from the line, so a retry repeats it. */
export function lineRequestId(line: CheckedLine): string {
  return `go_line_${writeKey(line).slice(0, 24)}`;
}

/** An update that leaves a line's words, kind, status and due time as they are now: it would change nothing anyone sees. */
async function changesNothing(pool: Pool, tripId: string, lineId: string, line: CheckedLine): Promise<boolean> {
  const r = await pool.query<{ line: C.RecordLine }>('SELECT line FROM record_lines WHERE trip_id = $1 AND line_id = $2', [tripId, lineId]);
  const now = r.rows[0]?.line;
  if (!now) return false;
  return now.text === line.text && now.kind === line.kind && now.status === (line.status ?? now.status) && (line.dueAt === undefined || line.dueAt === now.due_at);
}

/**
 * Sends the line once. `requestId` comes from the caller: ctx.stableId('go_record') inside a turn,
 * lineRequestId(line) outside one. If this line was already planned, the stored request_id wins. An update that
 * would change nothing is not sent at all, so the Server writes nothing and nobody gets a record.changed for it.
 */
export async function writeLine(pool: Pool, link: ServerLink, tripId: string, line: CheckedLine, requestId: string): Promise<WriteOutcome> {
  if (line.lineId && (await changesNothing(pool, tripId, line.lineId, line))) return { lineId: line.lineId };
  const key = writeKey(line);
  const planned = paramsFor(tripId, line);
  await pool.query(
    `INSERT INTO record_writes (trip_id, write_key, request_id, method, params) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (trip_id, write_key) DO NOTHING`,
    [tripId, key, requestId, planned.method, JSON.stringify(planned.params)],
  );
  const row = (
    await pool.query<{ request_id: string; line_id: string | null; done_at: Date | null; error: string | null }>(
      'SELECT request_id, line_id, done_at, error FROM record_writes WHERE trip_id = $1 AND write_key = $2',
      [tripId, key],
    )
  ).rows[0]!;
  if (row.done_at) return row.error ? { failed: row.error.split(' ')[0]! } : { lineId: row.line_id! };

  try {
    let lineId: string;
    if (planned.method === 'add_record_line') {
      const res = await link.request('add_record_line', { ...planned.params, request_id: row.request_id });
      lineId = res.line_id;
    } else {
      await link.request('update_record_line', { ...planned.params, request_id: row.request_id });
      lineId = planned.params.line_id;
    }
    await pool.query('UPDATE record_writes SET done_at = now(), line_id = $3 WHERE trip_id = $1 AND write_key = $2', [tripId, key, lineId]);
    return { lineId };
  } catch (err) {
    // 404, 409 and 422 are final ("read the trip and decide again"); anything else is retried later with the same request_id.
    if (err instanceof SocketCallError && [404, 409, 422].includes(err.code)) {
      await pool.query('UPDATE record_writes SET done_at = now(), error = $3 WHERE trip_id = $1 AND write_key = $2', [
        tripId, key, `${err.code} ${err.message}`.slice(0, 200),
      ]);
      return { failed: String(err.code) };
    }
    throw err;
  }
}
