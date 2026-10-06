/**
 * The scripted policy model: the composer's model in the fast bench. It answers only when a line it
 * has not seen yet calls Go (or says hello to an empty chat) and otherwise calls stay_silent. Side
 * passes get the fold's story or a plain "nothing to add". It records every body and reports usage
 * from the cache estimate, so Go's turns rows carry the same numbers the bench computes.
 */
import { CacheEstimator } from './cache-estimate.js';
import { addressesGo } from './chat.js';
import { RequestLog, type Block, type MessageBody, type ProviderUsage, type RecordedRequest } from './requests.js';

export const LINE_RE = /^#(\d+) ([^:\n]{1,80}): (.*)$/gm;
/** How P1's prompt names Go's own lines. */
export const GO_NAME = 'Go (you)';
const REPLY_PREFIX = /^\(reply to #\d+\)\s*/;
export const POLICY_REPLY = 'On it! Checking now.';
export const POLICY_GREETING = "Hi all, I'm Go. Tell me what you need for the trip.";
export const SIDE_REPLY = 'Nothing to add.';
const STORY_LINE = 'The group kept planning the Goa trip in these messages.';

const textsOf = (content: string | Block[]): string[] =>
  typeof content === 'string' ? [content] : content.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? ''));

/** The `#seq Name: text` lines in every user message, in order, with a leading "(reply to #N)" dropped. */
export function chatLinesIn(body: MessageBody): Array<{ seq: number; name: string; text: string }> {
  const out: Array<{ seq: number; name: string; text: string }> = [];
  for (const m of body.messages) {
    if (m.role !== 'user') continue;
    for (const t of textsOf(m.content)) for (const x of t.matchAll(LINE_RE)) out.push({ seq: Number(x[1]), name: x[2] ?? '', text: (x[3] ?? '').replace(REPLY_PREFIX, '') });
  }
  return out;
}

const systemText = (body: MessageBody): string => (body.system === undefined ? '' : textsOf(body.system).join('\n'));

/** The fold's answer (P2's FOLD_RULES): one story line citing the first and last message numbers it was shown. */
export function storyReply(body: MessageBody): string {
  const user = body.messages.filter((m) => m.role === 'user').flatMap((m) => textsOf(m.content)).join('\n');
  const seqs = [...user.matchAll(/#(\d+)\b/g)].map((x) => Number(x[1]));
  const first = seqs[0];
  const last = seqs[seqs.length - 1];
  const refs = first === undefined || last === undefined ? [] : [...new Set([first, last])];
  return JSON.stringify({ lines: [{ text: STORY_LINE, refs, people: [] }] });
}

export interface FakeUsage extends ProviderUsage {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation: null;
  inference_geo: null;
  server_tool_use: null;
  service_tier: 'standard';
}
export interface FakeMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Block[];
  stop_reason: 'end_turn' | 'tool_use';
  stop_sequence: null;
  stop_details: null;
  container: null;
  usage: FakeUsage;
}
export interface FakeStream extends AsyncIterable<Record<string, unknown>> {
  finalMessage(): Promise<FakeMessage>;
  abort(): void;
}
export interface FakeClient {
  messages: {
    stream(body: MessageBody, opts?: { signal?: AbortSignal }): FakeStream;
    create(body: MessageBody, opts?: { signal?: AbortSignal }): Promise<FakeMessage>;
  };
}
export type Decision = { kind: 'text'; text: string } | { kind: 'silent' };

export interface PolicyOptions {
  composerModel: string;
  /** Chat time in seconds, for the cache estimate's TTL. */
  simNow: () => number;
  /** Wait before the first event, to try Go with a slower model. Default 0. */
  firstTokenDelayMs?: number;
}

function streamEvents(m: FakeMessage): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } },
  ];
  m.content.forEach((b, index) => {
    if (b['type'] === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b['text'] } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { ...b, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b['input'] ?? {}) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: m.stop_reason, stop_sequence: null, stop_details: null, container: null },
    usage: {
      input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens,
      cache_read_input_tokens: m.usage.cache_read_input_tokens, cache_creation_input_tokens: m.usage.cache_creation_input_tokens, server_tool_use: null,
    },
  });
  events.push({ type: 'message_stop' });
  return events;
}

export class PolicyModel {
  readonly log: RequestLog;
  readonly client: FakeClient;
  private readonly composerCache = new CacheEstimator();
  private readonly sideCache = new CacheEstimator();
  private lastSeenSeq = 0;
  private firstRounds = 0;

  constructor(private readonly o: PolicyOptions) {
    this.log = new RequestLog(o.composerModel);
    this.client = {
      messages: {
        stream: (body, opts) => this.stream(body, opts),
        create: async (body) => {
          const { rec, message } = this.answer(body);
          rec.firstTokenMs = Date.now();
          rec.doneMs = rec.firstTokenMs;
          rec.usage = message.usage;
          return message;
        },
      },
    };
  }

  decide(body: MessageBody, role: RecordedRequest['role']): Decision {
    if (role === 'side') return { kind: 'text', text: /the story so far/i.test(systemText(body)) ? storyReply(body) : SIDE_REPLY };
    const last = body.messages[body.messages.length - 1];
    if (last !== undefined && typeof last.content !== 'string' && last.content.some((b) => b['type'] === 'tool_result')) return { kind: 'silent' };
    const lines = chatLinesIn(body).filter((l) => l.name !== GO_NAME);
    const fresh = lines.filter((l) => l.seq > this.lastSeenSeq);
    for (const l of fresh) this.lastSeenSeq = Math.max(this.lastSeenSeq, l.seq);
    // P1's pre-post check: Go was already answering, and P1 posts the newest text.
    if (body.messages.length > 1) return { kind: 'text', text: POLICY_REPLY };
    const isFirst = this.firstRounds === 0;
    this.firstRounds++;
    if (isFirst && lines.length === 0) return { kind: 'text', text: POLICY_GREETING };
    return fresh.some((l) => addressesGo(l.text)) ? { kind: 'text', text: POLICY_REPLY } : { kind: 'silent' };
  }

  private answer(body: MessageBody): { rec: RecordedRequest; message: FakeMessage } {
    const rec = this.log.add(body, Date.now(), this.o.simNow());
    const decision = this.decide(body, rec.role);
    const est = (rec.role === 'composer' ? this.composerCache : this.sideCache).estimate(body, rec.simS);
    const usage: FakeUsage = {
      input_tokens: est.totalTokens - est.readTokens - est.writeTokens,
      output_tokens: decision.kind === 'text' ? Math.ceil(Buffer.byteLength(decision.text, 'utf8') / 4) : 5,
      cache_read_input_tokens: est.readTokens,
      cache_creation_input_tokens: est.writeTokens,
      cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: 'standard',
    };
    const content: Block[] = decision.kind === 'text'
      ? [{ type: 'text', text: decision.text, citations: null }]
      : [{ type: 'tool_use', id: `toolu_bench_${rec.n}`, name: 'stay_silent', input: {} }];
    return {
      rec,
      message: {
        id: `msg_bench_${rec.n}`, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: decision.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, stop_details: null, container: null, usage,
      },
    };
  }

  private stream(body: MessageBody, opts?: { signal?: AbortSignal }): FakeStream {
    const { rec, message } = this.answer(body);
    const events = streamEvents(message);
    const delayMs = this.o.firstTokenDelayMs ?? 0;
    const finish = (): void => {
      rec.firstTokenMs ??= Date.now();
      rec.doneMs ??= Date.now();
      rec.usage = message.usage;
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const ev of events) {
          if (opts?.signal?.aborted === true) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
          }
          if (ev['type'] === 'content_block_delta' && rec.firstTokenMs === undefined) rec.firstTokenMs = Date.now();
          yield ev;
        }
        finish();
      },
      async finalMessage() {
        finish();
        return message;
      },
      abort() {},
    };
  }
}
