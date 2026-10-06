// The call row and its state changes. Each change is one conditional update, so racing paths end a call once.
import type pg from 'pg';

export type CallState = 'waiting' | 'cancelled' | 'dialing' | 'talking' | 'ended' | 'failed';
export interface CallLine { who: 'go' | 'them'; text: string }
export interface RecordAsk { kind: 'agreed' | 'open'; text: string }

export interface CallRow {
  callId: string;
  tripId: string;
  business: string;
  phone: string;
  goal: string;
  factsAllowed: string[];
  forWhom: string;
  state: CallState;
  askedByPersonId: string | null;
  askedMessageId: string | null;
  announceMessageId: string | null;
  announceSeq: number | null;
  cardId: string;
  cardMessageId: string | null;
  dialAt: Date;
  twilioSid: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: string | null;
  reported: boolean;
  record: RecordAsk | null;
  transcript: CallLine[];
  endReason: string | null;
  recordLineId: string | null;
  closedOutAt: Date | null;
}

export interface NewCall {
  callId: string;
  tripId: string;
  business: string;
  phone: string;
  goal: string;
  factsAllowed: string[];
  forWhom: string;
  askedByPersonId: string | null;
  askedMessageId: string | null;
  cardId: string;
  dialAt: Date;
}

type Row = {
  call_id: string; trip_id: string; business: string; phone: string; goal: string; facts_allowed: string[]; for_whom: string;
  state: CallState; asked_by_person_id: string | null; asked_message_id: string | null; announce_message_id: string | null;
  announce_seq: number | null; card_id: string; card_message_id: string | null; dial_at: Date; twilio_sid: string | null;
  started_at: Date | null; ended_at: Date | null; outcome: string | null; reported: boolean; record: RecordAsk | null;
  transcript: CallLine[]; end_reason: string | null; record_line_id: string | null; closed_out_at: Date | null;
};

const toRow = (r: Row): CallRow => ({
  callId: r.call_id, tripId: r.trip_id, business: r.business, phone: r.phone, goal: r.goal, factsAllowed: r.facts_allowed,
  forWhom: r.for_whom, state: r.state, askedByPersonId: r.asked_by_person_id, askedMessageId: r.asked_message_id,
  announceMessageId: r.announce_message_id, announceSeq: r.announce_seq, cardId: r.card_id, cardMessageId: r.card_message_id,
  dialAt: r.dial_at, twilioSid: r.twilio_sid, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
  reported: r.reported, record: r.record, transcript: r.transcript, endReason: r.end_reason, recordLineId: r.record_line_id,
  closedOutAt: r.closed_out_at,
});

export class CallStore {
  constructor(private readonly pool: pg.Pool) {}

  private async one(sql: string, params: unknown[]): Promise<CallRow | null> {
    const r = await this.pool.query<Row>(sql, params);
    const row = r.rows[0];
    return row ? toRow(row) : null;
  }

  private async many(sql: string, params: unknown[]): Promise<CallRow[]> {
    return (await this.pool.query<Row>(sql, params)).rows.map(toRow);
  }

  async create(c: NewCall): Promise<CallRow> {
    const row = await this.one(
      `insert into calls (call_id, trip_id, business, phone, goal, facts_allowed, for_whom, state, asked_by_person_id, asked_message_id, card_id, dial_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'waiting', $8, $9, $10, $11) returning *`,
      [c.callId, c.tripId, c.business, c.phone, c.goal, c.factsAllowed, c.forWhom, c.askedByPersonId, c.askedMessageId, c.cardId, c.dialAt],
    );
    if (!row) throw new Error('calls: insert returned nothing');
    return row;
  }

  get(callId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where call_id = $1`, [callId]);
  }

  byCard(tripId: string, cardId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and card_id = $2`, [tripId, cardId]);
  }

  liveFor(tripId: string): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and state in ('waiting', 'dialing', 'talking') order by created_at desc limit 1`, [tripId]);
  }

  recentlyCancelled(tripId: string, since: Date): Promise<CallRow | null> {
    return this.one(`select * from calls where trip_id = $1 and state = 'cancelled' and ended_at >= $2 order by ended_at desc limit 1`, [tripId, since]);
  }

  /** Go's line is in the room: the 30 s window starts now, so `dialAt` is set here, never at create. */
  announced(callId: string, messageId: string, seq: number, dialAt: Date): Promise<CallRow | null> {
    return this.one(
      `update calls set announce_message_id = $2, announce_seq = $3, dial_at = $4 where call_id = $1 and state = 'waiting' returning *`,
      [callId, messageId, seq, dialAt],
    );
  }

  /** Waiting calls whose line never reached the room (a crash before the announce): called off, never dialed. */
  cancelUnannounced(dialAtBefore: Date, at: Date): Promise<CallRow[]> {
    return this.many(
      `update calls set state = 'cancelled', end_reason = 'not_announced', ended_at = $2
       where state = 'waiting' and announce_seq is null and dial_at < $1 returning *`,
      [dialAtBefore, at],
    );
  }

  cancel(callId: string, reason: string, at: Date): Promise<CallRow | null> {
    return this.one(`update calls set state = 'cancelled', end_reason = $2, ended_at = $3 where call_id = $1 and state = 'waiting' returning *`, [callId, reason, at]);
  }

  dueToDial(now: Date): Promise<CallRow[]> {
    return this.many(`select * from calls where state = 'waiting' and announce_seq is not null and dial_at <= $1 order by dial_at`, [now]);
  }

  startDialing(callId: string): Promise<CallRow | null> {
    return this.one(`update calls set state = 'dialing' where call_id = $1 and state = 'waiting' returning *`, [callId]);
  }

  async dialInfo(callId: string, o: { cardMessageId?: string; tokenHash?: string; twilioSid?: string }): Promise<void> {
    await this.pool.query(
      `update calls set card_message_id = coalesce($2, card_message_id), media_token_hash = coalesce($3, media_token_hash),
         twilio_sid = coalesce($4, twilio_sid) where call_id = $1`,
      [callId, o.cardMessageId ?? null, o.tokenHash ?? null, o.twilioSid ?? null],
    );
  }

  /** The media socket's one-use token: right hash, not used, call still live. */
  claimMedia(callId: string, tokenHash: string): Promise<CallRow | null> {
    return this.one(
      `update calls set media_token_used = true
       where call_id = $1 and media_token_hash = $2 and not media_token_used and state in ('dialing', 'talking') returning *`,
      [callId, tokenHash],
    );
  }

  talking(callId: string, at: Date): Promise<CallRow | null> {
    return this.one(`update calls set state = 'talking', started_at = coalesce(started_at, $2) where call_id = $1 and state = 'dialing' returning *`, [callId, at]);
  }

  end(callId: string, o: { state: 'ended' | 'failed'; at: Date; outcome: string; reported: boolean; record: RecordAsk | null; transcript: CallLine[]; reason: string }): Promise<CallRow | null> {
    return this.one(
      `update calls set state = $2, ended_at = $3, outcome = $4, reported = $5, record = $6, transcript = $7, end_reason = $8
       where call_id = $1 and state in ('dialing', 'talking') returning *`,
      [callId, o.state, o.at, o.outcome, o.reported, o.record ? JSON.stringify(o.record) : null, JSON.stringify(o.transcript), o.reason],
    );
  }

  inCall(): Promise<CallRow[]> {
    return this.many(`select * from calls where state in ('dialing', 'talking') order by dial_at`, []);
  }

  toCloseOut(before: Date): Promise<CallRow[]> {
    return this.many(`select * from calls where state in ('ended', 'failed') and closed_out_at is null and ended_at < $1 order by ended_at`, [before]);
  }

  async closedOut(callId: string, at: Date, recordLineId: string | null): Promise<void> {
    await this.pool.query(`update calls set closed_out_at = $2, record_line_id = coalesce($3, record_line_id) where call_id = $1`, [callId, at, recordLineId]);
  }
}
