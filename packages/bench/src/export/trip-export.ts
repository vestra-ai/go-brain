/**
 * A trip's chat from Go's database as a bench recording (P3's chat format). People's text and Go's lines only: no fact,
 * page or record line is read, deleted and withheld messages are left out, and every text passes the secrets screen
 * once more on the way out (it was screened on the way in, and nothing here can undo that). Labels written by hand are
 * kept by message number (`seq` on each line), so the file can be exported again every evening without losing them.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '@go/contract';
import { maskSecrets } from '@go/brain/dist/reflex/secrets.js';
import type pg from 'pg';
import { addressesGo } from '../chat.js';

export const NEW_LINE_NOTE = 'new: label by hand';

/** Where the real trip's export goes by default: a folder git ignores, because it holds real people's words. */
export const PRIVATE_EXPORT = fileURLToPath(new URL('../../chats/private/real-trip.jsonl', import.meta.url));

/** --out read from the directory pnpm was started in, else the private default. */
export function exportPath(out: string | undefined, cwd: string): string {
  return out ? resolve(cwd, out) : PRIVATE_EXPORT;
}
const BENCH_PERSON = /^p_[a-z0-9_]{1,40}$/;
/** The labels a person writes by hand on a line; recall probes are moved separately. */
const LABELS = ['go_should_speak', 'quiet_ok', 'reflex', 'note'] as const;

/** Bench person ids are p_ and lowercase; any other id becomes the same short hash every time. */
export function benchPersonId(id: string): string {
  return BENCH_PERSON.test(id) ? id : `p_${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

interface Row {
  message_id: string;
  seq: number;
  person_id: string | null;
  text: string | null;
  reply_to: string | null;
  deleted_at: Date | null;
  payload: Message;
}
interface Probe {
  question: string;
  answer: string;
  line: number;
}
type Photo = Extract<Message['attachments'][number], { kind: 'photo' }>;

export interface TripExport {
  lines: string[];
  /** People's lines whose hand labels were kept. */
  kept: number;
  /** People's lines new since the last export, to label by hand. */
  added: number;
  /** Deleted, withheld, system or empty messages, left out. */
  skipped: number;
  droppedProbes: string[];
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const screen = (s: string): string => maskSecrets(s).text.trim();

/** The labelled file as it is now: each line by its message number, and each line number's message number. */
function readPrior(text: string | null): { bySeq: Map<number, Record<string, unknown>>; seqOfLine: Map<number, number> } {
  const bySeq = new Map<number, Record<string, unknown>>();
  const seqOfLine = new Map<number, number>();
  if (text === null) return { bySeq, seqOfLine };
  text.split('\n').forEach((raw, n) => {
    const row = raw.trim();
    if (row === '') return;
    let v: unknown;
    try {
      v = JSON.parse(row);
    } catch {
      throw new Error(`the existing file's line ${n + 1} is not JSON`);
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const seq = o['seq'];
    const i = o['i'];
    if (typeof seq === 'number' && typeof i === 'number') {
      bySeq.set(seq, o);
      seqOfLine.set(i, seq);
    }
  });
  return { bySeq, seqOfLine };
}

export async function exportTrip(pool: pg.Pool, tripId: string, existing: string | null): Promise<TripExport> {
  const prior = readPrior(existing);
  const { rows } = await pool.query<Row>(
    'select message_id, seq, person_id, text, reply_to, deleted_at, payload from messages where trip_id = $1 order by seq',
    [tripId],
  );
  const out: Array<Record<string, unknown>> = [];
  const lineOfMessage = new Map<string, number>();
  const lineOfSeq = new Map<number, number>();
  const droppedProbes: string[] = [];
  let kept = 0;
  let added = 0;
  let skipped = 0;
  let start: number | null = null;
  let lastAt = 0;

  for (const r of rows) {
    const m = r.payload;
    const isGo = m.author.kind === 'go';
    const personId = m.author.kind === 'person' ? (r.person_id ?? m.author.person_id) : null;
    if (r.deleted_at !== null || m.deleted || m.withheld || (!isGo && personId === null)) {
      skipped += 1;
      continue;
    }
    const caption = m.attachments.find((a): a is Photo => a.kind === 'photo')?.caption ?? null;
    const raw = isGo ? (r.text ?? m.card?.fallback_text ?? null) : (r.text ?? caption);
    const text = raw === null ? '' : clip(screen(raw), 4000);
    if (text === '') {
      skipped += 1;
      continue;
    }
    const sentMs = Date.parse(m.sent_at);
    start ??= sentMs;
    const at = Math.max(lastAt, Math.round((sentMs - start) / 100) / 10);
    lastAt = at;

    const i = out.length;
    const line: Record<string, unknown> = { i, at, kind: 'say', person: isGo ? 'go' : benchPersonId(personId ?? ''), text, seq: r.seq };
    if (!isGo && caption) {
      const shown = clip(screen(caption), 500);
      if (shown !== '') line['photo'] = { caption: shown };
    }
    const replyLine = r.reply_to === null ? undefined : lineOfMessage.get(r.reply_to);
    if (replyLine !== undefined) line['reply_to'] = replyLine;

    if (isGo) {
      line['go_should_speak'] = 'either';
    } else {
      const p = prior.bySeq.get(r.seq);
      if (p) {
        kept += 1;
        for (const k of LABELS) if (p[k] !== undefined) line[k] = p[k];
        line['go_should_speak'] ??= addressesGo(text) ? true : 'either';
        const probes = Array.isArray(p['recall']) ? (p['recall'] as Probe[]) : [];
        const moved = probes.flatMap((probe) => {
          const proofSeq = prior.seqOfLine.get(probe.line);
          const to = proofSeq === undefined ? undefined : lineOfSeq.get(proofSeq);
          if (to === undefined) {
            droppedProbes.push(`seq ${r.seq}: "${probe.question}" (its proof message is gone)`);
            return [];
          }
          return [{ ...probe, line: to }];
        });
        if (moved.length > 0) line['recall'] = moved;
      } else {
        added += 1;
        line['go_should_speak'] = addressesGo(text) ? true : 'either';
        line['note'] = NEW_LINE_NOTE;
      }
    }
    out.push(line);
    lineOfMessage.set(r.message_id, i);
    lineOfSeq.set(r.seq, i);
  }
  return { lines: out.map((l) => JSON.stringify(l)), kept, added, skipped, droppedProbes };
}
