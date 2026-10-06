// The live call: Twilio's media socket on one side, the voice model on the other. μ-law audio passes through
// untouched both ways. Go's own lines become the card's transcript; the model's report ends the call politely;
// the cap ends it regardless. Nothing here transcribes the business or keeps their words (Keshav's ruling).
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import type { Schedule } from '../proactive/clock.js';
import { ReportedOutcome, type CallBrief, type SessionSettings } from './realtime.js';
import type { CallLine } from './store.js';
import { wireFor, type VoiceEvent } from './voice-wire.js';

export type EndReason = 'hangup' | 'cap' | 'error';

export interface BridgeHooks {
  /** The call is connected; false when the call row could not move to talking (it was stopped or ended meanwhile). */
  talking(callId: string): Promise<boolean>;
  /** Go's own lines only. */
  line(callId: string, line: CallLine): void;
  outcome(callId: string, o: ReportedOutcome): void;
  ended(callId: string, reason: EndReason): Promise<void>;
}

export interface BridgeDeps {
  /** Checks the one-use token; null refuses the connection. */
  claim(callId: string, token: string): Promise<CallBrief | null>;
  openVoice(): WebSocket;
  hangUp(callId: string): Promise<void>;
  hooks: BridgeHooks;
  schedule: Schedule;
  capMs: number;
  /** The voice model (it picks the wire) and its voice. */
  session: SessionSettings;
  log: { warn(obj: object, msg: string): void };
}

export const GREET_AFTER_MS = 4_000;
export const WRAP_UP_BEFORE_MS = 20_000;
export const HANG_UP_AFTER_GOODBYE_MS = 2_500;
export const HANG_UP_AFTER_REPORT_MS = 15_000;
/** Barge-in without a speech event (gpt-live-1): this loud for this many 20 ms frames while Go's audio plays. Tuned on day one. */
export const BARGE_IN_LEVEL = 1_500;
export const BARGE_IN_FRAMES = 3;
/** Twilio sends `start` right after connecting; a media socket with no valid one by then is closed. */
export const START_WITHIN_MS = 10_000;

const TwilioFrame = z.object({
  event: z.string(),
  start: z
    .object({ streamSid: z.string(), callSid: z.string().optional(), customParameters: z.record(z.string(), z.string()).optional() })
    .optional(),
  media: z.object({ payload: z.string(), timestamp: z.union([z.string(), z.number()]).optional() }).optional(),
  mark: z.object({ name: z.string() }).optional(),
});

/** One G.711 μ-law byte as a 16-bit sample. */
function linear(u: number): number {
  const x = ~u & 0xff;
  const magnitude = ((((x & 0x0f) << 3) + 0x84) << ((x >> 4) & 0x07)) - 0x84;
  return x & 0x80 ? -magnitude : magnitude;
}

/** How loud one Twilio frame is: the root mean square of its samples, 0 for silence. */
export function frameLevel(payload: string): number {
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (const b of bytes) {
    const s = linear(b);
    sum += s * s;
  }
  return Math.sqrt(sum / bytes.length);
}

export interface BridgeHandle {
  /** Settles once the call is closed out, or the media socket was refused or dropped. */
  closed: Promise<void>;
}

export function attachBridge(twilio: WebSocket, callId: string, d: BridgeDeps): BridgeHandle {
  let markClosed = (): void => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const wire = wireFor(d.session.model);
  let rt: WebSocket | null = null;
  let streamSid = '';
  let started = false;
  let ended = false;
  let hangingUp = false;
  let latestTs = 0;
  let responseStartTs: number | null = null;
  let lastItem: string | null = null;
  let heardThem = false;
  let goSpoke = false;
  let reported = false;
  let goodbyeId: string | null = null;
  // Barge-in by loudness (an 'energy' wire): Go's audio chunks sent to Twilio and not yet played.
  const playing = new Set<string>();
  let marks = 0;
  let loudFrames = 0;
  let spokeAfterReport = false;
  let goodbye: (() => void) | null = null;
  const cancels: Array<() => void> = [];

  const toTwilio = (frame: object): void => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(frame));
  };
  const toModel = (event: object): void => {
    if (rt && rt.readyState === WebSocket.OPEN) rt.send(JSON.stringify(event));
  };
  const toModelAll = (events: object[]): void => {
    for (const event of events) toModel(event);
  };
  const cancelGoodbye = (): void => {
    goodbye?.();
    goodbye = null;
  };

  async function end(reason: EndReason): Promise<void> {
    if (ended) return;
    ended = true;
    try {
      for (const cancel of cancels) cancel();
      cancelGoodbye();
      if (started) {
        for (const e of wire.flush()) if (e.kind === 'go_line') d.hooks.line(callId, { who: 'go', text: e.text });
      }
      if (rt && rt.readyState !== WebSocket.CLOSED) rt.close();
      if (twilio.readyState === WebSocket.OPEN) twilio.close();
      if (started) await d.hooks.ended(callId, reason);
    } finally {
      markClosed();
    }
  }
  const finish = (reason: EndReason): void => {
    end(reason).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: closing the call failed'));
  };
  const hangUp = (reason: EndReason): void => {
    if (hangingUp) return;
    hangingUp = true;
    d.hangUp(callId).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: hanging up failed'));
    finish(reason);
  };

  /** After the report, once Twilio has played every chunk of the goodbye, hang up shortly after (energy wires). */
  function afterPlayed(): void {
    if (!reported || !spokeAfterReport || playing.size > 0 || goodbye) return;
    goodbye = d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_GOODBYE_MS);
  }

  /** No speech event (gpt-live-1): a short run of loud frames from the business while Go's audio still plays clears it. */
  function listen(payload: string): void {
    loudFrames = frameLevel(payload) >= BARGE_IN_LEVEL ? loudFrames + 1 : 0;
    if (loudFrames < BARGE_IN_FRAMES) return;
    loudFrames = 0;
    heardThem = true;
    if (playing.size === 0) return;
    playing.clear();
    toTwilio({ event: 'clear', streamSid });
  }

  function onVoice(e: VoiceEvent): void {
    switch (e.kind) {
      case 'audio': {
        if (e.itemId !== lastItem) {
          lastItem = e.itemId;
          responseStartTs = latestTs;
        }
        goSpoke = true;
        toTwilio({ event: 'media', streamSid, media: { payload: e.audio } });
        if (wire.bargeIn === 'energy') {
          marks += 1;
          const name = `go_${marks}`;
          playing.add(name);
          toTwilio({ event: 'mark', streamSid, mark: { name } });
          if (reported) {
            spokeAfterReport = true;
            cancelGoodbye();
          }
        }
        return;
      }
      case 'caller_started':
        heardThem = true;
        if (lastItem !== null && responseStartTs !== null) {
          toTwilio({ event: 'clear', streamSid });
          toModelAll(wire.truncate(lastItem, Math.max(0, latestTs - responseStartTs)));
        }
        lastItem = null;
        responseStartTs = null;
        return;
      case 'go_line':
        d.hooks.line(callId, { who: 'go', text: e.text });
        return;
      case 'report': {
        if (reported) {
          toModelAll(wire.answerReport(e.ref, true));
          return;
        }
        const parsed = ReportedOutcome.safeParse(e.args);
        toModelAll(wire.answerReport(e.ref, parsed.success));
        if (!parsed.success) return;
        reported = true;
        d.hooks.outcome(callId, parsed.data);
        cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_REPORT_MS));
        return;
      }
      case 'response_started':
        if (reported && goodbyeId === null) goodbyeId = e.id;
        return;
      case 'response_done':
        if (goodbyeId !== null && e.id === goodbyeId) cancels.push(d.schedule(() => hangUp('hangup'), HANG_UP_AFTER_GOODBYE_MS));
        return;
      case 'error':
        d.log.warn({ callId, error: e.error }, 'calls: the voice model reported an error');
        return;
    }
  }

  function openModel(brief: CallBrief): void {
    const socket = d.openVoice();
    rt = socket;
    socket.on('open', () => toModel(wire.start(brief, d.session)));
    socket.on('message', (data: RawData) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      for (const e of wire.read(ev)) onVoice(e);
    });
    socket.on('close', () => {
      if (!ended) hangUp('error');
    });
    socket.on('error', (err: Error) => d.log.warn({ err, callId }, 'calls: voice model socket error'));
  }

  async function onTwilio(data: RawData): Promise<void> {
    let frame: z.infer<typeof TwilioFrame>;
    try {
      frame = TwilioFrame.parse(JSON.parse(data.toString()));
    } catch {
      return;
    }
    if (frame.event === 'start' && frame.start && !started) {
      const brief = await d.claim(callId, frame.start.customParameters?.token ?? '');
      if (!brief) {
        twilio.close(1008, 'refused');
        return;
      }
      if (ended) {
        // Twilio dropped while the token was checked: the claimed call ends here, with no voice model opened.
        await d.hooks.ended(callId, 'hangup');
        return;
      }
      started = true;
      cancelStart();
      streamSid = frame.start.streamSid;
      const moved = await d.hooks.talking(callId);
      if (ended) return; // Twilio dropped meanwhile: end() has already closed the call
      if (!moved) {
        // The call was stopped or ended while it connected: never open the voice model.
        hangUp('hangup');
        return;
      }
      openModel(brief);
      cancels.push(d.schedule(() => {
        if (!heardThem && !goSpoke) toModelAll(wire.speakFirst(brief));
      }, GREET_AFTER_MS));
      cancels.push(d.schedule(() => toModelAll(wire.wrapUp()), d.capMs - WRAP_UP_BEFORE_MS));
      cancels.push(d.schedule(() => hangUp('cap'), d.capMs));
      return;
    }
    if (!started) return;
    if (frame.event === 'media' && frame.media) {
      if (frame.media.timestamp !== undefined) latestTs = Number(frame.media.timestamp);
      toModel(wire.appendAudio(frame.media.payload));
      if (wire.bargeIn === 'energy') listen(frame.media.payload);
      return;
    }
    if (frame.event === 'mark' && frame.mark) {
      playing.delete(frame.mark.name);
      afterPlayed();
      return;
    }
    if (frame.event === 'stop') finish('hangup');
  }

  const cancelStart = d.schedule(() => {
    if (!started && !ended) twilio.close(1008, 'no start');
  }, START_WITHIN_MS);
  cancels.push(cancelStart);
  twilio.on('message', (data: RawData) => {
    onTwilio(data).catch((err: unknown) => d.log.warn({ err, callId }, 'calls: media frame failed'));
  });
  twilio.on('close', () => finish('hangup'));
  twilio.on('error', (err: Error) => d.log.warn({ err, callId }, 'calls: media socket error'));
  return { closed };
}
