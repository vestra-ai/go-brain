import type * as C from '@go/contract';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { SocketCallError } from '../../door/rpc.js';
import { goaTrip } from '../../reflex/goa.fixture.js';
import type { CheckedLine } from '../checker.js';
import { lineRequestId, mirrorLine, mirrorSnapshot, recordLines, writeLine } from '../record.js';
import { fakeLink } from './test-kit.js';

let db: { pool: Pool; drop: () => Promise<void> };
beforeAll(async () => { db = await withSchema(); });
afterAll(async () => { await db.drop(); });

const line = (over: Partial<C.RecordLine>): C.RecordLine => ({
  line_id: 'r_north', kind: 'agreed', text: 'North Goa, not South', status: 'active',
  proof: [{ message_id: 'm_0122', person_id: 'p_priya' }], person_ids: ['p_priya', 'p_arjun'], source: 'go',
  created_at: '2026-10-05T04:14:00Z', updated_at: '2026-10-05T04:14:00Z', ...over,
});
const agreed: CheckedLine = {
  kind: 'agreed', text: 'North Goa, not South', personIds: ['p_priya', 'p_arjun'],
  proof: [{ message_id: 'm_0122', person_id: 'p_priya' }, { message_id: 'm_0124', person_id: 'p_arjun' }],
};

describe('the record mirror', () => {
  it('keeps the newest version of a line by change number', async () => {
    await mirrorLine(db.pool, 't_m1', line({}), 51);
    await mirrorLine(db.pool, 't_m1', line({ status: 'undone', updated_at: '2026-10-05T05:00:00Z' }), 60);
    await mirrorLine(db.pool, 't_m1', line({ status: 'active' }), 55);
    expect((await recordLines(db.pool, 't_m1')).map((l) => l.status)).toEqual(['undone']);
  });

  it('takes a snapshot\'s lines, and never lets an older snapshot undo a newer event', async () => {
    const trip = goaTrip({ trip_id: 't_m2', seq: 113, record: [line({}), line({ line_id: 'r_scuba', kind: 'open', text: 'Scuba on Saturday?' })] });
    await mirrorLine(db.pool, 't_m2', line({ status: 'done' }), 120);
    await mirrorSnapshot(db.pool, trip);
    const lines = await recordLines(db.pool, 't_m2');
    expect(lines.map((l) => [l.line_id, l.status])).toEqual([['r_north', 'done'], ['r_scuba', 'active']]);
  });
});

describe('writeLine', () => {
  it('adds a line once, reusing the same request_id after a failure', async () => {
    let failOnce = true;
    const link = fakeLink({
      fail: () => {
        if (!failOnce) return null;
        failOnce = false;
        return new Error('socket timeout');
      },
    });
    await expect(writeLine(db.pool, link, 't_w1', agreed, lineRequestId(agreed))).rejects.toThrow('socket timeout');
    const ok = await writeLine(db.pool, link, 't_w1', agreed, lineRequestId(agreed));
    expect(ok).toMatchObject({ lineId: expect.stringMatching(/^r_/) });
    const again = await writeLine(db.pool, link, 't_w1', agreed, lineRequestId(agreed));
    expect(again).toEqual(ok);
    expect(link.calls).toHaveLength(2);
    expect(link.calls[0]!.params.request_id).toBe(link.calls[1]!.params.request_id);
    expect(link.calls[0]!.params.request_id).toBe(lineRequestId(agreed));
    expect(lineRequestId(agreed)).toMatch(/^go_line_[0-9a-f]{24}$/);
    expect(link.calls[1]).toMatchObject({
      method: 'add_record_line',
      params: { trip_id: 't_w1', kind: 'agreed', text: 'North Goa, not South', person_ids: ['p_priya', 'p_arjun'], proof: agreed.proof },
    });
  });

  it('treats 409, 404 and 422 as final', async () => {
    const link = fakeLink({ fail: () => new SocketCallError(409, 'line undone', 'conflict') });
    expect(await writeLine(db.pool, link, 't_w2', agreed, lineRequestId(agreed))).toEqual({ failed: '409' });
    expect(await writeLine(db.pool, link, 't_w2', agreed, lineRequestId(agreed))).toEqual({ failed: '409' });
    expect(link.calls).toHaveLength(1);
  });

  it('updates one of Go\'s lines, marking it done', async () => {
    const link = fakeLink();
    const done = { ...agreed, kind: 'doing' as const, text: 'Kabir books the airport cab', lineId: 'r_cab', status: 'done' as const };
    const out = await writeLine(db.pool, link, 't_w3', done, lineRequestId(done));
    expect(out).toEqual({ lineId: 'r_cab' });
    expect(link.calls[0]).toMatchObject({ method: 'update_record_line', params: { line_id: 'r_cab', status: 'done', kind: 'doing' } });
  });
});
