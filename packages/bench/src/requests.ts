/** What Go sent to the model: the exact request bodies in order, and how big each part of each prompt was. */
import { createHash } from 'node:crypto';

export type Block = Record<string, unknown>;

export interface MessageBody {
  model: string;
  system?: string | Block[];
  tools?: Block[];
  messages: Array<{ role: 'user' | 'assistant'; content: string | Block[] }>;
  thinking?: unknown;
  [key: string]: unknown;
}

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface RecordedRequest {
  n: number;
  role: 'composer' | 'side';
  /** A copy of the body exactly as Go sent it. */
  body: MessageBody;
  /** Wall clock (Date.now()) when Go sent it. */
  realMs: number;
  /** Chat time in seconds: the `at` of the newest line delivered when Go sent it. */
  simS: number;
  firstTokenMs?: number;
  doneMs?: number;
  usage?: ProviderUsage;
  /** The tools the model asked for in its answer (live runs record it; the next request shows it too, but a turn's last call has none). */
  toolsOut?: string[];
  error?: string;
}

export class RequestLog {
  readonly requests: RecordedRequest[] = [];
  constructor(readonly composerModel: string) {}
  add(body: MessageBody, realMs: number, simS: number): RecordedRequest {
    const r: RecordedRequest = { n: this.requests.length, role: body.model === this.composerModel ? 'composer' : 'side', body: structuredClone(body), realMs, simS };
    this.requests.push(r);
    return r;
  }
}

export type Part = 'tools' | 'system' | 'chat' | 'now' | 'rounds';

export interface Position {
  part: Part;
  /** Hash of everything up to and including this block. */
  hash: string;
  bytes: number;
  tokens: number;
  breakpoint: boolean;
  ttlS: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so equal content always gives equal bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function withoutCacheControl(b: Block): Block {
  const { cache_control: _cacheControl, ...rest } = b;
  return rest;
}

const blocksOf = (content: string | Block[]): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

export function positions(body: MessageBody): Position[] {
  const out: Position[] = [];
  let h = sha(`model:${body.model}`);
  const push = (part: Part, block: Block): void => {
    const cc = block['cache_control'] as { ttl?: unknown } | null | undefined;
    const c = canonical(withoutCacheControl(block));
    h = sha(`${h}\n${c}`);
    const bytes = Buffer.byteLength(c, 'utf8');
    out.push({ part, hash: h, bytes, tokens: Math.ceil(bytes / 4), breakpoint: cc !== undefined && cc !== null, ttlS: cc?.ttl === '1h' ? 3600 : 300 });
  };
  for (const t of body.tools ?? []) push('tools', t);
  for (const b of body.system === undefined ? [] : blocksOf(body.system)) push('system', b);
  // Thinking settings change the cache for messages, never for tools and system.
  h = sha(`${h}\nsettings:${canonical({ thinking: body.thinking ?? null })}`);
  body.messages.forEach((m, k) => {
    h = sha(`${h}\nrole:${m.role}`);
    const blocks = blocksOf(m.content);
    let lastBreakpoint = -1;
    // The chat ends at its one-hour marker. The rolling five-minute marker on the newest block marks the round, not the chat.
    if (k === 0) blocks.forEach((b, j) => { if ((b['cache_control'] as { ttl?: unknown } | null | undefined)?.ttl === '1h') lastBreakpoint = j; });
    blocks.forEach((b, j) => push(k > 0 ? 'rounds' : j <= lastBreakpoint ? 'chat' : 'now', b));
  });
  return out;
}

export interface PromptParts {
  tools: number;
  system: number;
  chat: number;
  now: number;
  rounds: number;
  total: number;
  chatBlocks: number;
  /** Hash of tools and system together. */
  rules: string | null;
}

export function promptParts(body: MessageBody): PromptParts {
  const ps = positions(body);
  const sum = (p: Part): number => ps.filter((x) => x.part === p).reduce((s, x) => s + x.tokens, 0);
  const chat = ps.filter((x) => x.part === 'chat');
  const rules = ps.filter((x) => x.part === 'tools' || x.part === 'system');
  return {
    tools: sum('tools'), system: sum('system'), chat: sum('chat'), now: sum('now'), rounds: sum('rounds'),
    total: ps.reduce((s, x) => s + x.tokens, 0),
    chatBlocks: chat.length,
    rules: rules[rules.length - 1]?.hash ?? null,
  };
}
