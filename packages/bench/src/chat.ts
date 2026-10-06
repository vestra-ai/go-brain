/**
 * A recorded chat: one JSON line per message or change, in order, with labels a person wrote:
 * should Go post here, is a quiet reaction fine, what should recall find later.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const PersonId = z.string().regex(/^p_[a-z0-9_]{1,40}$/);
/** A person in the trip, or "go" for a line Go said in the original chat (kept for reading, skipped on replay). */
export const Speaker = z.union([PersonId, z.literal('go')]);
/** Should Go post a message after this line? "either" means both are fine. */
export const Speak = z.union([z.literal(true), z.literal(false), z.literal('either')]);
export type Speak = z.infer<typeof Speak>;

export const RecallProbe = z.object({
  question: z.string().min(3).max(200),
  /** Must appear in the recalled text, in any case. */
  answer: z.string().min(1).max(80),
  /** The chat line that proves the answer. At replay it becomes that message's number (seq). */
  line: z.int().nonnegative(),
});
export type RecallProbe = z.infer<typeof RecallProbe>;

/** What the reflex should say about a line. The fast bench uses these when no Jev recording exists. */
export const ReflexLabel = z.object({
  for_go: z.boolean().optional(),
  complete: z.boolean().optional(),
  size: z.enum(['quick', 'big']).optional(),
  fact: z.boolean().optional(),
  reaction: z.string().min(1).max(16).optional(),
});
export type ReflexLabel = z.infer<typeof ReflexLabel>;

const index = z.int().nonnegative();
/** Seconds since the chat started (chat time, never the wall clock). */
const at = z.number().nonnegative();

export const SayLine = z.object({
  i: index,
  at,
  kind: z.literal('say'),
  person: Speaker,
  text: z.string().min(1).max(4000),
  photo: z.object({ caption: z.string().min(1).max(500) }).optional(),
  reply_to: z.int().nonnegative().optional(),
  go_should_speak: Speak,
  /** A quiet reaction (✅) or a record line on this line is fine. Absent means it is not. */
  quiet_ok: z.boolean().optional(),
  /** Asked through Memory.recall once this line is in and Go is quiet. */
  recall: z.array(RecallProbe).min(1).max(10).optional(),
  reflex: ReflexLabel.optional(),
  /** Why the line is labelled the way it is, for reviewers. */
  note: z.string().max(200).optional(),
  /**
   * The message's number (seq) in the real trip it came from. P7's export-trip writes it, so hand labels and recall
   * probes follow their message when the file is exported again. A replay ignores it and numbers messages afresh.
   */
  seq: z.int().positive().optional(),
});
export const EditLine = z.object({ i: index, at, kind: z.literal('edit'), of: z.int().nonnegative(), text: z.string().min(1).max(4000) });
export const DeleteLine = z.object({ i: index, at, kind: z.literal('delete'), of: z.int().nonnegative() });
export const ReactLine = z.object({
  i: index, at, kind: z.literal('react'), of: z.int().nonnegative(), person: PersonId, emoji: z.string().min(1).max(16),
});
export const ChatLine = z.discriminatedUnion('kind', [SayLine, EditLine, DeleteLine, ReactLine]);
export type SayLine = z.infer<typeof SayLine>;
export type EditLine = z.infer<typeof EditLine>;
export type DeleteLine = z.infer<typeof DeleteLine>;
export type ReactLine = z.infer<typeof ReactLine>;
export type ChatLine = z.infer<typeof ChatLine>;

export interface Chat {
  name: string;
  lines: ChatLine[];
}

/** True when a line calls Go by name: "@Go ...", "Go, ...", "ok go, ...", "Go bhai ...". "let's go" is not a call. */
const ADDRESS_GO = /(^|[^a-z0-9_.])@go\b|^\s*(?:(?:hey|ok|oye|arre)\s+)?go\s*[,:!?]|\bgo\s+bhai\b/i;
export function addressesGo(text: string): boolean {
  return ADDRESS_GO.test(text);
}

/** Every rule a chat must keep that the schema alone cannot see. Returns the problems, empty when fine. */
export function checkChat(lines: ChatLine[]): string[] {
  const out: string[] = [];
  const deleted = new Set<number>();
  const isMessage = (n: number): boolean => lines[n]?.kind === 'say';
  lines.forEach((l, n) => {
    if (l.i !== n) out.push(`line ${n} says i=${l.i}`);
    const prev = lines[n - 1];
    if (prev !== undefined && l.at < prev.at) out.push(`line ${n} goes back in time`);
    const pointsAt = (of: number, what: string): void => {
      if (of >= n || !isMessage(of)) out.push(`line ${n}: ${what} ${of} is not an earlier message`);
      else if (deleted.has(of)) out.push(`line ${n}: ${what} ${of} was deleted`);
    };
    if (l.kind === 'say') {
      if (l.person === 'go' && l.go_should_speak !== 'either') out.push(`line ${n}: a line Go said must be "either"`);
      if (l.reply_to !== undefined) pointsAt(l.reply_to, 'reply_to');
      for (const p of l.recall ?? []) if (p.line >= n || !isMessage(p.line)) out.push(`line ${n}: recall proof ${p.line} is not an earlier message`);
    } else {
      pointsAt(l.of, l.kind);
      if (l.kind === 'delete') deleted.add(l.of);
    }
  });
  // A proof can never be a message deleted anywhere in the chat: recall must not find it.
  lines.forEach((l, n) => {
    if (l.kind === 'say') for (const p of l.recall ?? []) if (deleted.has(p.line)) out.push(`line ${n}: recall proof ${p.line} is deleted`);
  });
  return out;
}

export function parseChat(name: string, text: string): Chat {
  const lines: ChatLine[] = [];
  const rows = text.split('\n');
  rows.forEach((raw, n) => {
    const row = raw.trim();
    if (row === '') return;
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch (e) {
      throw new Error(`${name}:${n + 1}: not JSON (${(e as Error).message})`);
    }
    const parsed = ChatLine.safeParse(value);
    if (!parsed.success) throw new Error(`${name}:${n + 1}: ${z.prettifyError(parsed.error)}`);
    lines.push(parsed.data);
  });
  const problems = checkChat(lines);
  if (problems.length > 0) throw new Error(`${name}: ${problems.join('; ')}`);
  return { name, lines };
}

/** The chats folder, next to `src/` and `dist/` alike. */
export const CHATS_DIR = new URL('../chats/', import.meta.url);

export function loadChat(name: string): Chat {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`bad chat name: ${name}`);
  return parseChat(name, readFileSync(new URL(`${name}.jsonl`, CHATS_DIR), 'utf8'));
}

export interface ChatCounts {
  lines: number;
  messages: number;
  peopleMessages: number;
  goLines: number;
  edits: number;
  deletes: number;
  reactions: number;
  photos: number;
  asks: number;
  either: number;
  probes: number;
  people: string[];
}

export function chatCounts(chat: Chat): ChatCounts {
  const says = chat.lines.filter((l): l is SayLine => l.kind === 'say');
  const people = says.filter((l) => l.person !== 'go');
  return {
    lines: chat.lines.length,
    messages: says.length,
    peopleMessages: people.length,
    goLines: says.length - people.length,
    edits: chat.lines.filter((l) => l.kind === 'edit').length,
    deletes: chat.lines.filter((l) => l.kind === 'delete').length,
    reactions: chat.lines.filter((l) => l.kind === 'react').length,
    photos: says.filter((l) => l.photo !== undefined).length,
    asks: people.filter((l) => l.go_should_speak === true).length,
    either: people.filter((l) => l.go_should_speak === 'either').length,
    probes: says.reduce((n, l) => n + (l.recall?.length ?? 0), 0),
    people: [...new Set(people.map((l) => l.person))].sort(),
  };
}
