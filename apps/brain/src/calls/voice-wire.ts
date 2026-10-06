// The two voice models a call can use, behind one shape. A wire turns the bridge's few needs into the model's
// own events, and the model's events back into the few the bridge acts on. Neither wire turns on input
// transcription, and neither passes on the business's words: by design, Go hears the call only through the voice
// model, and the card shows Go's side. One wire per call: the Live wire keeps Go's words between events.
import { voiceKind, type VoiceKind } from './config.js';
import { REPORT_OUTCOME_TOOL, callInstructions, greeting, type CallBrief, type SessionSettings } from './realtime.js';

/** What the bridge reads from the voice model. */
export type VoiceEvent =
  | { kind: 'audio'; itemId: string; audio: string }
  | { kind: 'go_line'; text: string }
  | { kind: 'caller_started' }
  | { kind: 'report'; ref: string; args: unknown }
  | { kind: 'response_started'; id: string }
  | { kind: 'response_done'; id: string }
  | { kind: 'error'; error: unknown };

export interface VoiceWire {
  kind: VoiceKind;
  /** 'model': the model says when the caller starts talking. 'energy': it does not, so the bridge uses Twilio marks and loudness. */
  bargeIn: 'model' | 'energy';
  start(b: CallBrief, s: SessionSettings): object;
  appendAudio(audio: string): object;
  speakFirst(b: CallBrief): object[];
  truncate(itemId: string, playedMs: number): object[];
  /** Every report or hand-off gets an answer; `ok` says whether its outcome was read. */
  answerReport(ref: string, ok: boolean): object[];
  wrapUp(): object[];
  read(ev: Record<string, unknown>): VoiceEvent[];
  /** Go's last unfinished line, at the end of the call. */
  flush(): VoiceEvent[];
}

const NOTED = 'Noted. Now thank them and say goodbye.';

function field(ev: Record<string, unknown>, key: string): string {
  const v = ev[key];
  return typeof v === 'string' ? v : '';
}

function responseId(ev: Record<string, unknown>): string {
  const r = ev.response as { id?: unknown } | undefined;
  return typeof r?.id === 'string' ? r.id : '';
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** gpt-realtime-2.1 (the default): server voice activity detection, function tools, no input transcription. */
export function realtimeWire(): VoiceWire {
  return {
    kind: 'realtime',
    bargeIn: 'model',
    start: (b, s) => ({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: s.model,
        instructions: callInstructions(b, 'realtime'),
        output_modalities: ['audio'],
        audio: {
          // No `transcription` key, on purpose: voice activity detection needs none, and Go keeps no second ear.
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', silence_duration_ms: 500 } },
          output: { format: { type: 'audio/pcmu' }, voice: s.voice },
        },
        tools: [REPORT_OUTCOME_TOOL],
        tool_choice: 'auto',
      },
    }),
    appendAudio: (audio) => ({ type: 'input_audio_buffer.append', audio }),
    speakFirst: () => [{ type: 'response.create' }],
    truncate: (itemId, playedMs) => [{ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: playedMs }],
    answerReport: (ref, ok) => [
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ref, output: ok ? NOTED : 'That outcome could not be read. Call report_outcome again with a short outcome.' },
      },
      { type: 'response.create' },
    ],
    wrapUp: () => [
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Time is nearly up. Wrap up now: call report_outcome, then thank them and say goodbye.' }] },
      },
      { type: 'response.create' },
    ],
    read(ev) {
      switch (field(ev, 'type')) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          return [{ kind: 'audio', itemId: field(ev, 'item_id'), audio: field(ev, 'delta') }];
        case 'input_audio_buffer.speech_started':
          return [{ kind: 'caller_started' }];
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done': {
          const line = field(ev, 'transcript').trim();
          return line ? [{ kind: 'go_line', text: line }] : [];
        }
        case 'response.function_call_arguments.done':
          return field(ev, 'name') === 'report_outcome' ? [{ kind: 'report', ref: field(ev, 'call_id'), args: parseJson(field(ev, 'arguments')) }] : [];
        case 'response.created':
          return [{ kind: 'response_started', id: responseId(ev) }];
        case 'response.done':
          return [{ kind: 'response_done', id: responseId(ev) }];
        case 'error':
          return [{ kind: 'error', error: ev.error }];
        default:
          // Everything else, including a transcript of the business should an account ever send one: never kept.
          return [];
      }
    },
    flush: () => [],
  };
}

/** gpt-live-1 (the day-one A/B): no function tools (it hands off instead), no speech-started event, and its
 *  transcripts are its own. Event names are the ones Bash's live line uses; the socket URL is proven on day one. */
export function liveWire(): VoiceWire {
  let words = '';
  let lastLine = '';
  let n = 0;
  const eventId = (tag: string): string => {
    n += 1;
    return `go_${tag}_${n}`;
  };
  const endLine = (): VoiceEvent[] => {
    const line = words.replace(/\s+/g, ' ').trim();
    words = '';
    if (!line) return [];
    lastLine = line;
    return [{ kind: 'go_line', text: line }];
  };
  /** Go says the answer back as "So, ..." just before it hands off; that line, without the "So,", is the outcome. */
  const readBack = (): string => {
    if (!/^so\b/i.test(lastLine)) return '';
    const said = lastLine.replace(/^so\b[,\s]*/i, '');
    return said.charAt(0).toUpperCase() + said.slice(1);
  };
  return {
    kind: 'live',
    bargeIn: 'energy',
    start: (b, s) => ({
      type: 'session.start',
      session: {
        model: s.model,
        instructions: callInstructions(b, 'live'),
        audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: s.voice } },
        delegation: { type: 'client' },
        store: false,
      },
    }),
    appendAudio: (audio) => ({ type: 'session.input_audio.append', audio }),
    speakFirst: (b) => [{ type: 'session.commentary.append', event_id: eventId('hello'), delegation_id: null, content: greeting(b) }],
    truncate: () => [],
    answerReport: (ref, ok) => [
      {
        type: 'session.thinking.append',
        event_id: eventId('noted'),
        delegation_id: ref,
        content: ok ? NOTED : 'If you have the answer, say it back to them in one sentence that starts with "So," and hand off again. If not, carry on with the goal.',
      },
    ],
    wrapUp: () => [
      {
        type: 'session.instructions.append',
        event_id: eventId('wrap'),
        delegation_id: null,
        content: 'Time is nearly up. Wrap up now: say the answer back in one sentence that starts with "So,", hand off, then thank them and say goodbye.',
      },
    ],
    read(ev) {
      switch (field(ev, 'type')) {
        case 'session.output_audio.delta':
          return [{ kind: 'audio', itemId: 'live', audio: field(ev, 'delta') }];
        case 'session.output_transcript.delta':
          words += field(ev, 'delta');
          return [];
        case 'session.input_transcript.delta':
          // The business is talking, so Go's line is over. Their words themselves are never kept.
          return endLine();
        case 'session.delegation.created': {
          const d = ev.delegation as { id?: unknown; target?: unknown } | undefined;
          if (typeof d?.id !== 'string' || d.target !== 'client') return [];
          const line = endLine();
          return [...line, { kind: 'report', ref: d.id, args: { outcome: readBack(), answered: true, record: null } }];
        }
        case 'error':
          return [{ kind: 'error', error: ev.error }];
        default:
          return [];
      }
    },
    flush: endLine,
  };
}

export function wireFor(model: string): VoiceWire {
  return voiceKind(model) === 'live' ? liveWire() : realtimeWire();
}
