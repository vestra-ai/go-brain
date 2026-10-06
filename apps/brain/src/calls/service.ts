// The call service: the stop window, dialing, the live card, the outcome in the room and the record, and
// failures. Starting a call needs no thinking, so the 30 second window lives in the calls table and this
// service's tick, not on the desk.
import { createHash, randomBytes } from 'node:crypto';
import type { CallCard } from '@go/contract';
import type { z } from 'zod';
import type { Switches } from '../admin/switches.js';
import type { CardTapParams, CardTapResult, Message } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { Schedule } from '../proactive/clock.js';
import { clip, plain } from '../proactive/words.js';
import type { Packs, TripPack } from '../trips/pack.js';
import type { EndReason } from './bridge.js';
import { CardUpdater } from './card-updater.js';
import {
  CALL_WINDOW_MS, CARD_GAP_MS, RING_TIMEOUT_S, TWILIO_TIME_LIMIT_S, findCallee, maskPhone, mediaUrl, statusUrl, type CallsConfig,
} from './config.js';
import type { CallBrief, ReportedOutcome } from './realtime.js';
import { saysStop } from './stop-words.js';
import type { CallLine, CallRow, CallStore } from './store.js';
import { streamTwiml, twilioOutcome, type TwilioClient } from './twilio.js';

export type CallCardIn = z.input<typeof CallCard>;
export const STOP_LINE = "Say stop in the next 30 seconds if you'd rather I didn't.";
export const ORPHAN_AFTER_MS = 15_000;
export const NO_MEDIA_AFTER_MS = 90_000;
export const CLOSE_OUT_AFTER_MS = 10_000;
/** A waiting call whose line never reached the room this long after it was asked for is called off. */
export const NOT_ANNOUNCED_AFTER_MS = 60_000;
const NOT_ON_A_CALL = /\b(card|cvv|otp|upi|pin|password|passcode|bank|account number|ifsc)\b/i;
const LONG_DIGITS = /\d[\d\s-]{10,}\d/;

type FailWhy = 'busy' | 'no_answer' | 'failed' | 'canceled';
const FAIL_OUTCOME: Readonly<Record<FailWhy, string>> = {
  busy: 'The line was busy.',
  no_answer: 'Nobody picked up.',
  failed: "Couldn't connect the call.",
  canceled: 'The call was cancelled before it connected.',
};
function failLine(business: string, why: string): string {
  switch (why) {
    case 'busy':
      return `${business}'s line was busy. Want me to try again in a bit?`;
    case 'no_answer':
      return `${business} didn't pick up. Want me to try again later?`;
    case 'canceled':
      return `The call to ${business} was cancelled before it connected.`;
    default:
      return `I couldn't get through to ${business}.`;
  }
}
function noOutcome(reason: string, stoppedBy: string | null): string {
  if (stoppedBy) return `Stopped by ${stoppedBy} before an answer.`;
  if (reason === 'stopped') return 'Stopped before an answer.';
  if (reason === 'cap') return 'The call ran out of time before an answer.';
  if (reason === 'dropped') return 'The call dropped before an answer.';
  return 'The call ended before an answer.';
}
const rid = (callId: string, step: string): string => `go_${callId}_${step}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A person's message after Go's call line that says stop (a bare "no" counts only as a reply to that line). */
function isStop(call: CallRow, msg: Message): boolean {
  if (msg.author.kind !== 'person' || call.announceSeq === null || msg.seq <= call.announceSeq) return false;
  return saysStop(msg.text, msg.reply_to != null && msg.reply_to === call.announceMessageId);
}

export function forWhom(pack: TripPack): string {
  const n = pack.trip.people.length;
  return n > 1 ? `a group of ${n} friends travelling together` : 'a traveller';
}

export interface CallRequest {
  /** From the turn's ctx.stableId('call'): a rerun of the same turn finds its own call and repeats nothing. */
  callId: string;
  business: string;
  phone?: string | undefined;
  goal: string;
  announce: string;
  factsAllowed: string[];
}
export type CallRequestResult = { ok: true; callId: string; dialAt: string } | { refused: string };

export interface CallServiceDeps {
  store: CallStore;
  link: ServerLink;
  packs: Pick<Packs, 'get'>;
  switches: Pick<Switches, 'get'>;
  config: CallsConfig;
  twilio: TwilioClient | null;
  now: () => Date;
  schedule: Schedule;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Live {
  row: CallRow;
  lines: CallLine[];
  outcome: ReportedOutcome | null;
  startedAt: Date;
  stoppedBy: string | null;
  updater: CardUpdater<CallCardIn>;
}

type CardState = 'dialing' | 'talking' | 'ended' | 'failed';

export class CallService {
  private readonly live = new Map<string, Live>();
  private ticking: Promise<void> | null = null;

  constructor(private readonly d: CallServiceDeps) {}

  mode(): 'off' | 'allowlist' {
    return this.d.switches.get('CALLS_MODE') === 'allowlist' ? 'allowlist' : 'off';
  }

  /** Names from the allowlist; numbers are never shown to the model. */
  callable(): string[] {
    return this.d.config.allowlist.flatMap((c) => (c.name ? [c.name] : []));
  }

  liveFor(tripId: string): Promise<CallRow | null> {
    return this.d.store.liveFor(tripId);
  }

  recentlyCancelled(tripId: string): Promise<CallRow | null> {
    return this.d.store.recentlyCancelled(tripId, new Date(this.d.now().getTime() - 120_000));
  }

  async request(tripId: string, pack: TripPack, r: CallRequest): Promise<CallRequestResult> {
    let row = await this.d.store.get(r.callId);
    if (row && row.tripId !== tripId) return { refused: 'That call belongs to another trip.' };
    if (!row) {
      if (this.mode() === 'off') return { refused: 'Calls are switched off right now.' };
      if (!this.d.twilio || this.d.config.missing.length > 0) return { refused: 'Calls are not set up yet.' };
      if ([r.goal, ...r.factsAllowed].some((t) => NOT_ON_A_CALL.test(t) || LONG_DIGITS.test(t))) {
        return { refused: 'Calls never pay or share card, bank, OTP or login details. Leave those out.' };
      }
      const callee = findCallee(this.d.config, { business: r.business, phone: r.phone });
      if (!callee) return { refused: `${r.business} is not on the list of numbers Go may call this week.` };
      if (await this.d.store.liveFor(tripId)) return { refused: 'Go is already on a call for this trip. One at a time.' };
      let asker: Message | null = null;
      for (const m of pack.messages) if (m.author.kind === 'person' && m.mentions_go && !m.deleted) asker = m;
      row = await this.d.store.create({
        callId: r.callId,
        tripId,
        business: clip(plain(r.business), 80),
        phone: callee.phone,
        goal: clip(plain(r.goal), 160),
        factsAllowed: r.factsAllowed.map((f) => clip(f, 200)),
        forWhom: forWhom(pack),
        askedByPersonId: asker && asker.author.kind === 'person' ? asker.author.person_id : null,
        askedMessageId: asker ? asker.message_id : null,
        cardId: `c_${r.callId}`,
        dialAt: new Date(this.d.now().getTime() + CALL_WINDOW_MS),
      });
    }
    if (row.state === 'waiting' && row.announceMessageId === null) {
      try {
        const posted = await this.d.link.request('post_message', {
          request_id: rid(row.callId, 'announce'),
          trip_id: tripId,
          text: clip(`${plain(r.announce)} ${STOP_LINE}`, 2000),
        });
        // The window starts once the line is in the room, however long posting it took.
        row = (await this.d.store.announced(row.callId, posted.message_id, posted.seq, new Date(this.d.now().getTime() + CALL_WINDOW_MS))) ?? row;
      } catch (err) {
        await this.d.store.cancel(row.callId, 'announce_failed', this.d.now());
        throw err;
      }
      this.d.log.info({ callId: row.callId, tripId, to: maskPhone(row.phone) }, 'calls: announced; dialing in 30 s unless someone says stop');
      this.d.schedule(() => {
        this.tick().catch((err: unknown) => this.d.log.warn({ err }, 'calls: tick failed'));
      }, Math.max(0, row.dialAt.getTime() - this.d.now().getTime()));
    }
    return { ok: true, callId: row.callId, dialAt: row.dialAt.toISOString() };
  }

  /**
   * In the window, a person's stop (or a bare "no" in reply to Go's line) cancels the call. A stop sent inside the
   * window that reaches Go only after dialing began (a late event) still stops the call: Go hangs up.
   */
  async onMessage(msg: Message, pack: TripPack): Promise<void> {
    if (msg.author.kind !== 'person') return;
    const call = await this.d.store.liveFor(pack.trip.trip_id);
    if (!call || !isStop(call, msg)) return;
    if (call.state === 'waiting') {
      await this.cancelFor(call, msg);
      return;
    }
    if (Date.parse(msg.sent_at) < call.dialAt.getTime()) await this.stopLive(call, msg.author.person_id);
  }

  /** Calls off a waiting call because of this person's stop, and says so once. */
  private async cancelFor(call: CallRow, msg: Message): Promise<void> {
    if (msg.author.kind !== 'person') return;
    const cancelled = await this.d.store.cancel(call.callId, `stopped_by:${msg.author.person_id}`, this.d.now());
    if (!cancelled) return;
    await this.d.link.request('post_message', {
      request_id: rid(call.callId, 'cancel'),
      trip_id: call.tripId,
      text: `Okay, I won't call ${call.business}.`,
      reply_to: msg.message_id,
    });
  }

  /** Dials what is due, closes calls a restart stranded, finishes close-outs. One pass at a time. */
  tick(): Promise<void> {
    if (!this.ticking) this.ticking = this.tickOnce().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const now = this.d.now();
    // dial_at is set to ask time + 30 s at create, so this is NOT_ANNOUNCED_AFTER_MS after the call was asked for.
    await this.d.store.cancelUnannounced(new Date(now.getTime() - (NOT_ANNOUNCED_AFTER_MS - CALL_WINDOW_MS)), now);
    for (const row of await this.d.store.dueToDial(now)) {
      // One call that cannot be dialed never holds up the others; it stays due for the next tick.
      await this.dial(row).catch((err: unknown) => this.d.log.warn({ err, callId: row.callId }, 'calls: dialing failed; trying again next tick'));
    }
    for (const row of await this.d.store.inCall()) {
      if (this.live.has(row.callId)) continue;
      if (row.state === 'talking' && row.startedAt && now.getTime() - row.startedAt.getTime() > ORPHAN_AFTER_MS) await this.finish(row.callId, 'dropped');
      else if (row.state === 'dialing' && now.getTime() - row.dialAt.getTime() > NO_MEDIA_AFTER_MS) await this.fail(row.callId, 'no_answer');
    }
    for (const row of await this.d.store.toCloseOut(new Date(now.getTime() - CLOSE_OUT_AFTER_MS))) await this.closeOut(row, null);
  }

  private async dial(due: CallRow): Promise<void> {
    const twilio = this.d.twilio;
    const publicUrl = this.d.config.publicUrl;
    const from = this.d.config.from;
    if (this.mode() === 'off' || !twilio || !publicUrl || !from) {
      const c = await this.d.store.cancel(due.callId, 'calls_off', this.d.now());
      if (c) {
        await this.d.link.request('post_message', {
          request_id: rid(c.callId, 'off'),
          trip_id: c.tripId,
          text: `Calls are switched off right now, so I didn't call ${c.business}.`,
        });
      }
      return;
    }
    // Last look before dialing: a stop in the room that the message hook missed still calls it off.
    const pack = await this.d.packs.get(due.tripId);
    const stop = pack.messages.find((m) => !m.deleted && isStop(due, m));
    if (stop) {
      await this.cancelFor(due, stop);
      return;
    }
    const row = await this.d.store.startDialing(due.callId);
    if (!row) return;
    const token = randomBytes(32).toString('base64url');
    const posted = await this.d.link.request('post_message', { request_id: rid(row.callId, 'card'), trip_id: row.tripId, card: this.card(row, { state: 'dialing' }) });
    await this.d.store.dialInfo(row.callId, { cardMessageId: posted.message_id, tokenHash: sha256(token) });
    try {
      const { sid } = await twilio.createCall({
        to: row.phone,
        from,
        twiml: streamTwiml({ url: mediaUrl(publicUrl, row.callId), token }),
        statusCallback: statusUrl(publicUrl, row.callId),
        timeLimitS: TWILIO_TIME_LIMIT_S,
        ringTimeoutS: RING_TIMEOUT_S,
      });
      await this.d.store.dialInfo(row.callId, { twilioSid: sid });
      this.d.log.info({ callId: row.callId, to: maskPhone(row.phone) }, 'calls: dialing');
    } catch (err) {
      this.d.log.warn({ err, callId: row.callId }, 'calls: Twilio refused the call');
      await this.fail(row.callId, 'failed');
    }
  }

  async claim(callId: string, token: string): Promise<CallBrief | null> {
    if (!token) return null;
    const row = await this.d.store.claimMedia(callId, sha256(token));
    return row ? { business: row.business, goal: row.goal, factsAllowed: row.factsAllowed, forWhom: row.forWhom } : null;
  }

  async talking(callId: string): Promise<void> {
    const now = this.d.now();
    const row = await this.d.store.talking(callId, now);
    if (!row) return;
    const updater = new CardUpdater<CallCardIn>((card) => this.replace(row.tripId, card), {
      now: this.d.now,
      schedule: this.d.schedule,
      minGapMs: CARD_GAP_MS,
      log: this.d.log,
    });
    this.live.set(callId, { row, lines: [], outcome: null, startedAt: now, stoppedBy: null, updater });
    updater.update(this.card(row, { state: 'talking', startedAt: now }));
  }

  /** Go's own lines only: the card never shows the business's words (Keshav's ruling; showing them needs his explicit OK). */
  line(callId: string, line: CallLine): void {
    if (line.who !== 'go') return;
    const live = this.live.get(callId);
    if (!live) return;
    const l: CallLine = { who: 'go', text: clip(plain(line.text), 500) };
    live.lines.push(l);
    if (live.lines.length > 300) live.lines.shift();
    live.updater.update(this.card(live.row, { state: 'talking', startedAt: live.startedAt, lastLine: l }));
  }

  outcome(callId: string, o: ReportedOutcome): void {
    const live = this.live.get(callId);
    if (live) live.outcome = o;
  }

  async ended(callId: string, reason: EndReason): Promise<void> {
    await this.finish(callId, reason);
  }

  async hangUp(callId: string): Promise<void> {
    const row = await this.d.store.get(callId);
    if (row?.twilioSid && this.d.twilio) await this.d.twilio.hangUp(row.twilioSid);
  }

  async stopTap(tap: CardTapParams): Promise<CardTapResult> {
    const row = await this.d.store.byCard(tap.trip_id, tap.card_id);
    if (!row || (row.state !== 'dialing' && row.state !== 'talking')) return { result: 'refused', toast: 'The call has already ended.' };
    // Answer the tap at once (3 s limit); hanging up and closing out run behind it.
    void this.stopLive(row, tap.person_id).catch((err: unknown) => this.d.log.warn({ err, callId: row.callId }, 'calls: stopping the call failed'));
    return { result: 'done', toast: 'Hanging up.' };
  }

  /** A person stopped a call that is dialing or talking: hang up, and close it out as stopped by them. */
  private async stopLive(row: CallRow, personId: string): Promise<void> {
    const pack = await this.d.packs.get(row.tripId);
    const name = pack.trip.people.find((p) => p.person_id === personId)?.name ?? 'someone';
    const live = this.live.get(row.callId);
    if (live) live.stoppedBy = name;
    await this.hangUp(row.callId);
    if (!live) await this.finish(row.callId, 'stopped');
  }

  async onTwilioStatus(callId: string, status: string): Promise<void> {
    const o = twilioOutcome(status);
    if (o === 'busy' || o === 'no_answer' || o === 'failed' || o === 'canceled') return this.fail(callId, o);
    if (o !== 'completed') return;
    const row = await this.d.store.get(callId);
    if (row?.state === 'talking') return this.finish(callId, 'hangup');
    if (row?.state === 'dialing') return this.fail(callId, 'no_answer');
  }

  async fail(callId: string, why: FailWhy): Promise<void> {
    if (this.live.has(callId)) return this.finish(callId, why);
    const row = await this.d.store.end(callId, { state: 'failed', at: this.d.now(), outcome: FAIL_OUTCOME[why], reported: false, record: null, transcript: [], reason: why });
    if (row) await this.closeOut(row, null);
  }

  private async finish(callId: string, reason: string): Promise<void> {
    const live = this.live.get(callId) ?? null;
    const o = live?.outcome ?? null;
    const why = live?.stoppedBy ? 'stopped' : reason;
    const row = await this.d.store.end(callId, {
      state: 'ended',
      at: this.d.now(),
      outcome: o ? clip(plain(o.outcome), 500) : noOutcome(why, live?.stoppedBy ?? null),
      reported: o !== null,
      record: o?.record ?? null,
      transcript: live?.lines ?? [],
      reason: why,
    });
    this.live.delete(callId);
    if (!row) return;
    if (why === 'dropped') await this.hangUp(callId).catch((err: unknown) => this.d.log.warn({ err, callId }, 'calls: hanging up a dropped call failed'));
    await this.closeOut(row, live?.updater ?? null);
  }

  /** The final card, the line in the room, the record line. Safe to repeat: every write has a fixed request id. */
  private async closeOut(row: CallRow, updater: CardUpdater<CallCardIn> | null): Promise<void> {
    const final = this.card(row, {
      state: row.state === 'failed' ? 'failed' : 'ended',
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastLine: row.transcript.at(-1) ?? null,
      outcome: row.outcome,
      transcript: row.transcript,
    });
    if (row.cardMessageId) {
      if (updater) await updater.final(final);
      else await this.replace(row.tripId, final);
    }
    let recordLineId: string | null = null;
    if (row.state === 'failed') {
      await this.d.link.request('post_message', { request_id: rid(row.callId, 'fail'), trip_id: row.tripId, text: failLine(row.business, row.endReason ?? 'failed') });
    } else if (row.reported && row.outcome) {
      const pack = await this.d.packs.get(row.tripId);
      const organizer = pack.trip.people.find((p) => p.person_id === pack.trip.organizer_person_id && !p.go_paused) ?? null;
      const ask = row.record?.kind === 'open' ? organizer : null;
      const asked = row.askedMessageId ? pack.messages.find((m) => m.message_id === row.askedMessageId && !m.deleted) : undefined;
      await this.d.link.request('post_message', {
        request_id: rid(row.callId, 'outcome'),
        trip_id: row.tripId,
        text: clip(ask ? `${row.outcome} ${ask.name}, want to decide on this?` : row.outcome, 2000),
        ...(asked ? { reply_to: asked.message_id } : {}),
        ...(ask ? { mentions: [ask.person_id] } : {}),
      });
      if (row.record && row.cardMessageId) {
        const line = await this.d.link.request('add_record_line', {
          request_id: rid(row.callId, 'record'),
          trip_id: row.tripId,
          kind: row.record.kind,
          text: clip(plain(row.record.text), 200),
          proof: [{ message_id: row.cardMessageId }],
          person_ids: ask ? [ask.person_id] : [],
        });
        recordLineId = line.line_id;
      }
    } else {
      const text = row.endReason === 'stopped'
        ? `Okay, I hung up on ${row.business}.`
        : `I called ${row.business} but didn't get an answer to that. Want me to try again?`;
      await this.d.link.request('post_message', { request_id: rid(row.callId, 'outcome'), trip_id: row.tripId, text });
    }
    await this.d.store.closedOut(row.callId, this.d.now(), recordLineId);
  }

  private card(row: CallRow, o: { state: CardState; startedAt?: Date | null; endedAt?: Date | null; lastLine?: CallLine | null; outcome?: string | null; transcript?: CallLine[] }): CallCardIn {
    const isLive = o.state === 'dialing' || o.state === 'talking';
    const fallback = o.state === 'ended' && o.outcome
      ? `Go called ${row.business}: ${o.outcome}`
      : o.state === 'failed' ? `Go couldn't get through to ${row.business}.` : `Go is calling ${row.business}: ${row.goal}`;
    return {
      card_id: row.cardId,
      kind: 'call',
      fallback_text: clip(fallback, 300),
      call_id: row.callId,
      business: row.business,
      goal: row.goal,
      state: o.state,
      ...(o.startedAt ? { started_at: o.startedAt.toISOString() } : {}),
      ...(o.endedAt ? { ended_at: o.endedAt.toISOString() } : {}),
      ...(o.lastLine ? { last_line: o.lastLine } : {}),
      ...(o.outcome ? { outcome: clip(o.outcome, 500) } : {}),
      ...(o.transcript && o.transcript.length > 0 ? { transcript: o.transcript.slice(-300) } : {}),
      ...(isLive ? { actions: [{ action_id: 'stop', label: 'Stop the call', style: 'secondary' as const }] } : {}),
    };
  }

  private async replace(tripId: string, card: CallCardIn): Promise<void> {
    await this.d.link.request('replace_card', { trip_id: tripId, card });
  }
}
