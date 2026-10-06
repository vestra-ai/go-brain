// Trip record lines Go writes (agreed, open, doing), with the rules in docs/guide/04-gos-requests.md.
// Decided and booked lines come only from votes and bookings; Go never undoes a line.
import type * as C from '@go/contract';
import { fail, type Change, type Params, type RecordLine, type TripState } from './trip-state.js';

type Proof = RecordLine['proof'][number];

function checkProof(s: TripState, proof: readonly Proof[]): void {
  proof.forEach((p, i) => {
    s.messageIn(p.message_id, `proof[${i}].message_id`);
    if (p.person_id != null) s.person(p.person_id, `proof[${i}].person_id`);
  });
}

export function addRecordLine(s: TripState, p: Params<typeof C.AddRecordLine>): Change<{ line_id: string; seq: number }> {
  if (p.kind === 'agreed' && p.proof.length === 0) throw fail('invalid', 'proof: an agreed line needs at least one message');
  checkProof(s, p.proof);
  s.people(p.person_ids, 'person_ids');
  const at = s.now().toISOString();
  const line: RecordLine = {
    line_id: s.mint('r_'),
    kind: p.kind,
    text: p.text,
    status: 'active',
    proof: p.proof,
    person_ids: p.person_ids,
    ...(p.due_at != null ? { due_at: p.due_at } : {}),
    source: 'go',
    created_at: at,
    updated_at: at,
  };
  s.trip.record.push(line);
  const ev = s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'go' } });
  return { result: { line_id: line.line_id, seq: ev.seq }, events: [ev] };
}

export function updateRecordLine(s: TripState, p: Params<typeof C.UpdateRecordLine>): Change<{ seq: number }> {
  const line = s.trip.record.find((l) => l.line_id === p.line_id);
  if (!line) throw fail('not_found', `line ${p.line_id} is not in this trip`);
  if (line.source !== 'go') throw fail('conflict', `line ${p.line_id} is not Go's to change`);
  if (line.status === 'undone') throw fail('conflict', `line ${p.line_id} was undone: add a new line instead`);
  if (p.kind == null && p.text == null && p.status == null && p.proof == null && p.person_ids == null && p.due_at == null) {
    throw fail('invalid', 'send at least one field to change besides request_id, trip_id and line_id');
  }
  if (p.proof != null) checkProof(s, p.proof);
  if (p.person_ids != null) s.people(p.person_ids, 'person_ids');
  const kind = p.kind ?? line.kind;
  const proof = p.proof ?? line.proof;
  if (kind === 'agreed' && proof.length === 0) throw fail('invalid', 'proof: an agreed line needs at least one message');
  if (p.kind != null) line.kind = p.kind;
  if (p.text != null) line.text = p.text;
  if (p.status != null) line.status = p.status;
  if (p.proof != null) line.proof = p.proof;
  if (p.person_ids != null) line.person_ids = p.person_ids;
  if (p.due_at != null) line.due_at = p.due_at;
  line.updated_at = s.now().toISOString();
  const ev = s.bump('record.changed', { line: structuredClone(line), change: p.status === 'done' ? 'done' : 'updated', by: { kind: 'go' } });
  return { result: { seq: ev.seq }, events: [ev] };
}
