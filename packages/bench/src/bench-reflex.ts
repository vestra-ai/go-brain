/**
 * The reflex in the bench. The fast bench answers from recorded Jev reads when a recording exists,
 * else from the chat's hand labels. The live bench wraps the real reflex and records what it said.
 * Both count reads, so the replay knows when Go has read each message.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Brain } from '@go/brain/dist/app.js';
import { isSmallTalk } from '@go/brain/dist/reflex/small-talk.js';
import { CHATS_DIR, type Chat, type ChatLine, type ReflexLabel, type SayLine } from './chat.js';

export type Reflex = Brain['reflex'];
export type ReflexRead = Awaited<ReturnType<Reflex['read']>>;
export type ReflexMessage = Parameters<Reflex['read']>[0];
type ReflexCtx = Parameters<Reflex['read']>[1];

const yes = <T>(value: T): { value: T; sure: true } => ({ value, sure: true });
const unsure = (): { value: null; sure: false } => ({ value: null, sure: false });

export function allUnsure(): ReflexRead {
  return {
    forGo: unsure(), complete: unsure(), size: unsure(), taskId: unsure(), fact: unsure(),
    recordKind: unsure(), reaction: unsure(), risky: unsure(), opening: unsure(),
  };
}

/**
 * What Jev should say about a line, from its labels. Speak true or false means sure; "either" means unsure. Questions 1's
 * banter and 11 (actionable): a quiet line that is bare small talk is banter with nothing for Go; a line Go should speak
 * on is actionable; any other line is unsure, so it wakes the turn, which decides (Go jumps in on most lines).
 */
export function labelRead(line: SayLine): ReflexRead {
  const l: ReflexLabel = line.reflex ?? {};
  const speak = line.go_should_speak;
  const banter = speak === false && isSmallTalk(line.text);
  return {
    banter: banter ? yes(true) : unsure(),
    actionable: speak === true ? yes(true) : banter ? yes(false) : unsure(),
    forGo: l.for_go !== undefined ? yes(l.for_go) : speak === 'either' ? unsure() : yes(speak),
    complete: yes(l.complete ?? true),
    size: l.size !== undefined ? yes(l.size) : unsure(),
    taskId: unsure(),
    fact: l.fact === true ? yes(true) : unsure(),
    recordKind: unsure(),
    reaction: l.reaction !== undefined ? yes(l.reaction) : unsure(),
    risky: unsure(),
    opening: unsure(),
  };
}

export function messageKey(msg: ReflexMessage): string {
  const who = msg.author.kind === 'person' ? msg.author.person_id : msg.author.kind;
  return `${who}\u0000${msg.text ?? ''}`;
}
export function lineKey(line: SayLine): string {
  return `${line.person}\u0000${line.text}`;
}

export interface CountingReflex {
  read: Reflex['read'];
  /** How many times each message (person and text) was read. */
  readonly reads: Map<string, number>;
}

export class BenchReflex implements CountingReflex {
  readonly reads = new Map<string, number>();
  private readonly answers = new Map<string, ReflexRead>();

  constructor(lines: readonly ChatLine[], recorded?: ReadonlyMap<number, ReflexRead>) {
    for (const l of lines) {
      if (l.kind !== 'say' || l.person === 'go') continue;
      const key = lineKey(l);
      // A read recorded before questions 1's banter and 11 existed takes theirs from the labels.
      const label = labelRead(l);
      const r = recorded?.get(l.i);
      if (!this.answers.has(key)) this.answers.set(key, r ? { banter: label.banter, actionable: label.actionable, ...r } : label);
    }
  }

  // An arrow, so it works however the intake calls it.
  read = async (msg: ReflexMessage, _ctx: ReflexCtx): Promise<ReflexRead> => {
    const key = messageKey(msg);
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return this.answers.get(key) ?? allUnsure();
  };
}

export function countingReflex(inner: Reflex): CountingReflex & { recorded: Map<string, ReflexRead> } {
  const reads = new Map<string, number>();
  const recorded = new Map<string, ReflexRead>();
  return {
    reads,
    recorded,
    read: async (msg, ctx) => {
      const r = await inner.read(msg, ctx);
      const key = messageKey(msg);
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (!recorded.has(key)) recorded.set(key, r);
      return r;
    },
  };
}

/** chats/<name>.jev.json: what real Jev said about each line, written by the live bench. */
export interface JevRecording {
  jev_model: string;
  recorded_at: string;
  reads: Record<string, ReflexRead>;
}

const recordingUrl = (name: string): URL => new URL(`${name}.jev.json`, CHATS_DIR);

function isRead(v: unknown): v is ReflexRead {
  if (v === null || typeof v !== 'object') return false;
  return Object.keys(allUnsure()).every((k) => {
    const s = (v as Record<string, unknown>)[k];
    return s !== null && typeof s === 'object' && typeof (s as { sure?: unknown }).sure === 'boolean';
  });
}

export function loadRecording(name: string): Map<number, ReflexRead> | null {
  const url = recordingUrl(name);
  if (!existsSync(url)) return null;
  const raw = JSON.parse(readFileSync(url, 'utf8')) as JevRecording;
  const out = new Map<number, ReflexRead>();
  for (const [k, v] of Object.entries(raw.reads)) {
    if (!isRead(v)) throw new Error(`${name}.jev.json: line ${k} is not a reflex read`);
    out.set(Number(k), v);
  }
  return out;
}

export function recordingFor(chat: Chat, recorded: ReadonlyMap<string, ReflexRead>, jevModel: string, recordedAt: string): JevRecording {
  const reads: Record<string, ReflexRead> = {};
  for (const l of chat.lines) {
    if (l.kind !== 'say' || l.person === 'go') continue;
    const r = recorded.get(lineKey(l));
    if (r !== undefined) reads[String(l.i)] = r;
  }
  return { jev_model: jevModel, recorded_at: recordedAt, reads };
}

export function writeRecording(name: string, rec: JevRecording): void {
  writeFileSync(recordingUrl(name), `${JSON.stringify(rec, null, 1)}\n`);
}
