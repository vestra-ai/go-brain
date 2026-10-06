import { describe, expect, it } from 'vitest';
import { goaFreshTrip } from '../goa.js';
import { SocketCallError } from '../server-socket.js';
import { addRecordLine, updateRecordLine } from '../state/records.js';
import { TripState } from '../state/trip-state.js';

function setUp() {
  let n = 0;
  const s = new TripState(goaFreshTrip(), { mint: (p) => `${p}${String(++n).padStart(4, '0')}`, now: () => new Date('2026-10-05T04:14:00Z') });
  s.created();
  const priya = s.say('p_priya', "Let's do North Goa, not South.").result;
  const arjun = s.say('p_arjun', 'Yes, North.').result;
  return { s, priya, arjun };
}

function err(fn: () => unknown): SocketCallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SocketCallError) return e;
    throw e;
  }
  throw new Error('it did not throw');
}

describe('record lines Go writes', () => {
  it('adds an agreed line by Go, with its proof', () => {
    const { s, priya, arjun } = setUp();
    const done = addRecordLine(s, {
      request_id: 'rq_l1', trip_id: 't_goa', kind: 'agreed', text: 'North Goa, not South',
      proof: [{ message_id: priya.message_id, person_id: 'p_priya' }, { message_id: arjun.message_id, person_id: 'p_arjun' }],
      person_ids: ['p_priya', 'p_arjun', 'p_rahul'],
    });
    expect(done.result).toEqual({ line_id: expect.any(String), seq: done.events[0]!.seq });
    expect(done.events[0]).toMatchObject({
      type: 'record.changed',
      data: { change: 'added', by: { kind: 'go' }, line: { kind: 'agreed', status: 'active', source: 'go', text: 'North Goa, not South' } },
    });
  });

  it('refuses an agreed line without proof, proof from outside the trip, and people outside the trip', () => {
    const { s, priya } = setUp();
    const base = { request_id: 'rq_l2', trip_id: 't_goa', text: 'Scuba on Saturday?', person_ids: ['p_meher'] };
    expect(err(() => addRecordLine(s, { ...base, kind: 'agreed', proof: [] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [{ message_id: 'm_nope' }] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [{ message_id: priya.message_id, person_id: 'p_stranger' }] })).code).toBe(422);
    expect(err(() => addRecordLine(s, { ...base, kind: 'open', proof: [], person_ids: ['p_stranger'] })).code).toBe(422);
    expect(addRecordLine(s, { ...base, kind: 'open', proof: [] }).events).toHaveLength(1);
  });

  it("updates only Go's lines that were not undone, and says done when the status becomes done", () => {
    const { s, priya } = setUp();
    const lineId = addRecordLine(s, { request_id: 'rq_l3', trip_id: 't_goa', kind: 'doing', text: 'Kabir books the airport cab', proof: [], person_ids: ['p_kabir'] }).result.line_id;
    const u = (extra: Record<string, unknown>) => ({ request_id: 'rq_u', trip_id: 't_goa', line_id: lineId, ...extra }) as never;
    expect(updateRecordLine(s, u({ text: 'Kabir books the cab for 9 pm' })).events[0]).toMatchObject({ data: { change: 'updated', line: { text: 'Kabir books the cab for 9 pm' } } });
    expect(err(() => updateRecordLine(s, u({}))).code).toBe(422);
    expect(err(() => updateRecordLine(s, u({ kind: 'agreed' }))).code).toBe(422);
    expect(updateRecordLine(s, u({ kind: 'agreed', proof: [{ message_id: priya.message_id }] })).events[0]).toMatchObject({ data: { line: { kind: 'agreed' } } });
    expect(updateRecordLine(s, u({ status: 'done' })).events[0]).toMatchObject({ data: { change: 'done', by: { kind: 'go' }, line: { status: 'done' } } });
    expect(err(() => updateRecordLine(s, u({ line_id: 'r_nope', text: 'x' }))).code).toBe(404);
    s.trip.record.push({
      line_id: 'r_dates', kind: 'decided', text: '6 to 9 Nov', status: 'active', proof: [], person_ids: [], source: 'vote',
      created_at: '2026-10-05T03:45:00Z', updated_at: '2026-10-05T03:45:00Z',
    });
    expect(err(() => updateRecordLine(s, u({ line_id: 'r_dates', text: 'x' }))).code).toBe(409);
    s.trip.record.find((l) => l.line_id === lineId)!.status = 'undone';
    expect(err(() => updateRecordLine(s, u({ text: 'again' }))).code).toBe(409);
  });
});
