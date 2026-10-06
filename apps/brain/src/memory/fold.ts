/**
 * The fold (spec §9 rules 4, 6 and 8). When a trip's chat passes the budget (about 60,000 tokens), while
 * the trip is quiet, the side model folds the oldest half, in whole 25-message chunks, into "the story so
 * far": short lines, each citing its message numbers, rewritten from the old story plus the next chunk.
 * Code checks every line (real references, no secrets, people tagged by id and by name). A deleted message
 * takes its story lines with it; a forget redacts every line about the person. Nothing is lost: every
 * message stays in the trip log and recall finds it.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Message } from '../door/methods.js';
import type { Log } from '../log.js';
import { messageText } from '../reflex/questions.js';
import { hasSecret } from '../reflex/secrets.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { cleanText } from './checker.js';
import { forgottenUpTo, withTx, type Db } from './facts.js';
import { chatLine, FENCE_RULE, fenceText, isForgotten, peopleLegend } from './fence.js';
import type { SideModel } from './side-model.js';

export const CHUNK = 25;
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/** The chat line as the composer renders it (`#seq Name: text`), used only to measure the budget. */
export function budgetLine(m: Message, pack: TripPack): string {
  const who =
    m.author.kind === 'go'
      ? 'Go'
      : m.author.kind === 'system'
        ? 'App'
        : (pack.trip.people.find((p) => p.person_id === (m.author as { person_id: string }).person_id)?.name ?? 'Someone');
  return `#${m.seq} ${who}: ${messageText(m)}`;
}

export interface StoryView {
  /** The story block to put before the chat, or null when the trip has not been folded. */
  story: string | null;
  /** The composer's chat starts at this change number (after the story, or later for one turn under the safety net). */
  chatFromSeq: number;
  foldedToSeq: number;
  /** Estimated tokens of the chat from chatFromSeq on. */
  tokens: number;
}
/** What P1's Context.setStory takes (master §6.3): the composer calls get(tripId) every turn. */
export interface StoryProvider {
  get(tripId: string): Promise<StoryView>;
}
export interface Fold extends StoryProvider {
  maybeFold(tripId: string): Promise<'folded' | 'not_needed' | 'busy' | 'failed'>;
  onDeleted(tripId: string, messageId: string): Promise<number>;
  /** Inside a transaction: deletes every story line about the person in these trips. */
  redactPerson(db: Db, personId: string, tripIds: string[], names: string[]): Promise<number>;
  storyMentions(db: Db, personId: string, tripIds: string[], names: string[]): Promise<number>;
}
export interface FoldDeps {
  pool: Pool;
  packs: Packs;
  side: SideModel;
  log: Log;
  now: () => Date;
  foldAtTokens: number;
  storyTokens: number;
  hardCapTokens: number;
}

export const FOLD_RULES = [
  'You keep "the story so far" for Go, the AI member of a trip group chat, so Go can remember a long chat without reading all of it.',
  'You get the current story and the next part of the chat. Write the new story: the old story plus what the next part adds, as short lines in plain words. Keep decisions and why, open questions and who is asked, who said they would do what, what each person cares about or cannot do, and money (who paid, who owes). Drop small talk. Merge lines that say the same thing; when two disagree, keep the newer.',
  'Every line cites the message numbers it comes from in refs (#142 is 142) and the person ids it is about in people. A line without refs is dropped. Never write anything from a [hidden] line. Never copy card numbers, codes or passwords. Keep the whole story under about 3,500 words.',
  FENCE_RULE,
  'Answer with one JSON object and nothing else, for example: {"lines":[{"text":"Picked North Goa over South","refs":[122,124],"people":["p_priya","p_arjun"]}]}',
].join('\n');

const StoryOut = z.object({
  lines: z
    .array(z.object({ text: z.string(), refs: z.array(z.int()).max(20).default([]), people: z.array(z.string()).max(30).default([]) }))
    .max(400),
});

interface StoryLine {
  idx: number;
  text: string;
  refs: number[];
  refIds: string[];
  people: string[];
}

export function mentionsName(text: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length < 2) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text.toLowerCase());
}

async function readStory(db: Db, tripId: string): Promise<{ foldNo: number; foldedToSeq: number; lines: StoryLine[] } | null> {
  const s = await db.query<{ fold_no: number; folded_to_seq: number }>('SELECT fold_no, folded_to_seq FROM stories WHERE trip_id = $1', [tripId]);
  const head = s.rows[0];
  if (!head) return null;
  const l = await db.query<{ idx: number; text: string; refs: number[]; ref_ids: string[]; people: string[] }>(
    'SELECT idx, text, refs, ref_ids, people FROM story_lines WHERE trip_id = $1 ORDER BY idx',
    [tripId],
  );
  return {
    foldNo: head.fold_no,
    foldedToSeq: head.folded_to_seq,
    lines: l.rows.map((r) => ({ idx: r.idx, text: r.text, refs: r.refs, refIds: r.ref_ids, people: r.people })),
  };
}

const storyLineText = (l: { text: string; refs: number[] }): string => `- ${fenceText(l.text)} (${l.refs.map((r) => `#${r}`).join(', ')})`;
const lockStory = (db: Db, tripId: string) => db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`story:${tripId}`]);

export function createFold(d: FoldDeps): Fold {
  const busy = new Set<string>();

  /** Lines about the person: tagged with them, citing a message they wrote, or naming them (full name or first name). */
  async function linesAbout(db: Db, personId: string, tripIds: string[], names: string[]) {
    const r = await db.query<{ trip_id: string; idx: number; text: string; people: string[]; cites: boolean }>(
      `SELECT s.trip_id, s.idx, s.text, s.people,
              EXISTS (SELECT 1 FROM messages m
                       WHERE m.trip_id = s.trip_id AND m.person_id = $2 AND m.message_id = ANY(s.ref_ids)) AS cites
         FROM story_lines s
        WHERE s.trip_id = ANY($1::text[])`,
      [tripIds, personId],
    );
    const said = [...new Set(names.flatMap((n) => [n, n.trim().split(/\s+/)[0] ?? '']))];
    return r.rows.filter((l) => l.cites || l.people.includes(personId) || said.some((n) => mentionsName(l.text, n)));
  }

  return {
    async get(tripId) {
      const pack = await d.packs.get(tripId);
      const story = await readStory(d.pool, tripId);
      const foldedToSeq = story?.foldedToSeq ?? 0;
      const unfolded = pack.messages.filter((m) => m.seq > foldedToSeq);
      const cost = unfolded.map((m) => estimateTokens(budgetLine(m, pack)));
      let tokens = cost.reduce((a, b) => a + b, 0);
      let start = 0;
      // Safety net: a burst over the hard cap before a fold is ready drops whole old chunks, for this turn only.
      while (tokens > d.hardCapTokens && start + CHUNK < unfolded.length) {
        for (let i = start; i < start + CHUNK; i += 1) tokens -= cost[i]!;
        start += CHUNK;
      }
      const chatFromSeq = start === 0 ? foldedToSeq + 1 : unfolded[start]!.seq;
      const text =
        story && story.lines.length
          ? [`The story so far (messages up to #${foldedToSeq}; recall finds any of them word for word):`, ...story.lines.map(storyLineText)].join('\n')
          : null;
      return { story: text, chatFromSeq, foldedToSeq, tokens };
    },

    async maybeFold(tripId) {
      if (busy.has(tripId)) return 'busy';
      busy.add(tripId);
      try {
        const pack = await d.packs.get(tripId);
        const old = await readStory(d.pool, tripId);
        const foldedTo = old?.foldedToSeq ?? 0;
        const unfolded = pack.messages.filter((m) => m.seq > foldedTo);
        const tokens = unfolded.reduce((n, m) => n + estimateTokens(budgetLine(m, pack)), 0);
        if (tokens < d.foldAtTokens || unfolded.length < CHUNK) return 'not_needed';
        const take = Math.max(CHUNK, Math.floor(unfolded.length / 2 / CHUNK) * CHUNK);
        const chunk = unfolded.slice(0, take);
        const lastSeq = chunk[chunk.length - 1]!.seq;
        const forgotten = await forgottenUpTo(d.pool, tripId);
        // What each message looked like when the fold read it, to catch an edit made while the model was writing.
        const readAt = new Map(pack.messages.map((m) => [m.message_id, m.updated_seq]));

        const user = [
          '<chat_data>',
          'People in the trip:',
          peopleLegend(pack),
          'The story so far:',
          old && old.lines.length ? old.lines.map(storyLineText).join('\n') : '(none yet)',
          'The next part of the chat:',
          ...chunk.map((m) => chatLine(m, pack, isForgotten(m, forgotten))),
          '</chat_data>',
          `Write the new story so far, covering everything up to #${lastSeq}.`,
        ].join('\n');
        let raw: string;
        try {
          raw = await d.side.complete({ purpose: 'fold', system: FOLD_RULES, user, maxTokens: 7_000, signal: AbortSignal.timeout(60_000) });
        } catch (err) {
          d.log.warn({ tripId, err: String(err) }, 'fold: side model failed');
          return 'failed';
        }
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        let parsed: z.infer<typeof StoryOut> | null = null;
        try {
          const r = start >= 0 && end > start ? StoryOut.safeParse(JSON.parse(raw.slice(start, end + 1))) : null;
          parsed = r && r.success ? r.data : null;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          d.log.warn({ tripId }, 'fold: output was not a valid story');
          return 'failed';
        }

        // Every reference must be a message the model was shown (old story or this chunk), not hidden.
        const refId = new Map<number, string>();
        for (const l of old?.lines ?? []) l.refs.forEach((r, i) => { const id = l.refIds[i]; if (id) refId.set(r, id); });
        for (const m of chunk) if (!isForgotten(m, forgotten)) refId.set(m.seq, m.message_id);
        const inTrip = new Set(pack.trip.people.map((p) => p.person_id));
        const checked: Array<Omit<StoryLine, 'idx'>> = [];
        for (const l of parsed.lines) {
          const text = cleanText(l.text, 400);
          if (!text || hasSecret(text)) continue;
          const refs = [...new Set(l.refs)].filter((r) => refId.has(r));
          if (refs.length === 0) continue;
          const people = new Set(l.people.filter((p) => inTrip.has(p)));
          for (const p of pack.trip.people) if (mentionsName(text, p.name)) people.add(p.person_id);
          checked.push({ text, refs, refIds: refs.map((r) => refId.get(r)!), people: [...people] });
        }
        // Keep the newest lines that fit the cap.
        const kept: typeof checked = [];
        let total = 0;
        for (let i = checked.length - 1; i >= 0; i -= 1) {
          const t = estimateTokens(storyLineText(checked[i]!));
          if (total + t > d.storyTokens) break;
          total += t;
          kept.unshift(checked[i]!);
        }
        if (kept.length === 0) return 'failed';

        try {
          await withTx(d.pool, async (c) => {
            await lockStory(c, tripId);
            // A forget that landed while the model was writing wins: drop this fold and try again later.
            const nowForgotten = await forgottenUpTo(c, tripId);
            for (const [p, s] of nowForgotten) if ((forgotten.get(p) ?? -1) < s) throw new Error('a person was forgotten during the fold');
            // A message deleted or edited while the model was writing takes its lines with it.
            const cited = await c.query<{ message_id: string; deleted: boolean; updated_seq: number }>(
              'SELECT message_id, deleted_at IS NOT NULL AS deleted, updated_seq FROM messages WHERE trip_id = $1 AND message_id = ANY($2::text[])',
              [tripId, [...new Set(kept.flatMap((l) => l.refIds))]],
            );
            const changed = new Set(
              cited.rows.filter((m) => m.deleted || m.updated_seq > (readAt.get(m.message_id) ?? Number.POSITIVE_INFINITY)).map((m) => m.message_id),
            );
            const lines = kept.filter((l) => !l.refIds.some((id) => changed.has(id)));
            if (lines.length === 0) throw new Error('every line cites a message that changed during the fold');
            total = lines.reduce((n, l) => n + estimateTokens(storyLineText(l)), 0);
            await c.query('DELETE FROM story_lines WHERE trip_id = $1', [tripId]);
            for (const [idx, l] of lines.entries()) {
              await c.query('INSERT INTO story_lines (trip_id, idx, text, refs, ref_ids, people) VALUES ($1, $2, $3, $4, $5, $6)', [
                tripId, idx, l.text, l.refs, l.refIds, l.people,
              ]);
            }
            await c.query(
              `INSERT INTO stories (trip_id, fold_no, folded_to_seq, tokens, created_at) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (trip_id) DO UPDATE
                 SET fold_no = EXCLUDED.fold_no, folded_to_seq = EXCLUDED.folded_to_seq, tokens = EXCLUDED.tokens, created_at = EXCLUDED.created_at`,
              [tripId, (old?.foldNo ?? 0) + 1, lastSeq, total, d.now()],
            );
          });
        } catch (err) {
          d.log.warn({ tripId, err: String(err) }, 'fold: not saved');
          return 'failed';
        }
        d.log.info({ tripId, foldedTo: lastSeq, lines: kept.length, storyTok: total }, 'fold: saved');
        return 'folded';
      } finally {
        busy.delete(tripId);
      }
    },

    async onDeleted(tripId, messageId) {
      const r = await withTx(d.pool, async (c) => {
        await lockStory(c, tripId);
        return c.query('DELETE FROM story_lines WHERE trip_id = $1 AND $2 = ANY(ref_ids)', [tripId, messageId]);
      });
      return r.rowCount ?? 0;
    },

    async redactPerson(db, personId, tripIds, names) {
      for (const t of tripIds) await lockStory(db, t);
      const hits = await linesAbout(db, personId, tripIds, names);
      for (const h of hits) await db.query('DELETE FROM story_lines WHERE trip_id = $1 AND idx = $2', [h.trip_id, h.idx]);
      return hits.length;
    },

    async storyMentions(db, personId, tripIds, names) {
      return (await linesAbout(db, personId, tripIds, names)).length;
    },
  };
}
