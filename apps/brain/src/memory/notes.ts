/**
 * The notes pass (spec §7 step 4, §11 "Saving"): a small model reads the chat lines Go has not read yet
 * and proposes facts and record lines as JSON; code checks every proposal against its proof; a quiet ✅
 * marks what was noted. It runs after Go posts, after the trip goes quiet, or at once when Jev is sure a
 * message holds a fact. It never sits on the reply path.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Message } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { Log } from '../log.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { checkFact, checkLine, type CheckEnv } from './checker.js';
import { forgottenUpTo, saveFact } from './facts.js';
import { chatLine, FENCE_RULE, isForgotten, peopleLegend } from './fence.js';
import { reactOnce } from './reactions.js';
import { lineRequestId, mirrorLine, mirrorSnapshot, recordLines, writeLine } from './record.js';
import type { SideModel } from './side-model.js';

export const NOTES_RULES = [
  'You keep notes for Go, the AI member of a trip group chat. You read the new lines of the chat and propose two kinds of notes.',
  '1. facts: lasting things a person says about themselves that matter for planning the trip: food, drinks, when they can or cannot travel, seats, health, money limits they say openly, what they will not do. Only from that person\'s own line. topic is one or two lowercase words such as food, drinks, leaving, arriving, seats, flights, boats, health, budget, sleep, activities. text is short plain words without the name, such as "Vegetarian" or "Can\'t leave before 6 pm Friday".',
  '2. lines for the trip record: "agreed" when people agreed in the chat (proof: the proposal and the yes lines; put any line that disagrees in objections), "open" when a question about the plan is still unsettled (person_ids: who is asked), "doing" when someone says they will sort something (person_ids: who said it). To change one of Go\'s own record lines, give its line_id; for a job that is finished add "status": "done".',
  'Cite lines by their number (#142 is 142). Propose facts only from the new lines. Never propose anything from a [hidden] line. Never copy card numbers, codes or passwords. Do not repeat what the record already says.',
  FENCE_RULE,
  'Answer with one JSON object and nothing else, for example: {"facts":[{"person_id":"p_x","topic":"food","text":"Vegetarian","message":142}],"lines":[{"kind":"agreed","text":"North Goa, not South","person_ids":[],"proof":[122,124],"objections":[]}]}. Use empty lists when there is nothing to note.',
].join('\n');

export const NotesOutput = z.object({
  facts: z
    .array(z.object({ person_id: z.string(), topic: z.string(), text: z.string(), message: z.int(), audience: z.enum(['group', 'go']).optional() }))
    .max(20)
    .default([]),
  lines: z
    .array(
      z.object({
        kind: z.enum(['agreed', 'open', 'doing']),
        text: z.string(),
        person_ids: z.array(z.string()).max(30).default([]),
        proof: z.array(z.int()).max(10).default([]),
        objections: z.array(z.int()).max(10).default([]),
        due_at: z.string().optional(),
        line_id: z.string().optional(),
        status: z.literal('done').optional(),
      }),
    )
    .max(10)
    .default([]),
});
export type NotesOutput = z.infer<typeof NotesOutput>;

export function parseNotes(raw: string): NotesOutput | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = NotesOutput.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface NotesResult {
  facts: number;
  lines: number;
  reacted: number;
  refused: string[];
  skipped?: 'nothing_new' | 'model_error' | 'bad_output';
  /** More than one batch of new lines was waiting. */
  more?: boolean;
}
export interface NotesDeps {
  pool: Pool;
  packs: Packs;
  link: ServerLink;
  side: SideModel;
  log: Log;
  now: () => Date;
}

const BATCH = 40;
const CONTEXT = 10;
const empty = (): NotesResult => ({ facts: 0, lines: 0, reacted: 0, refused: [] });

function promptFor(pack: TripPack, record: CheckEnv['record'], context: Message[], fresh: Message[], forgotten: ReadonlyMap<string, number>): string {
  const recordText = record.length
    ? record
        .filter((l) => l.status !== 'undone')
        .map((l) => `- ${l.line_id} [${l.kind}${l.source === 'go' ? ", Go's" : ''}${l.status === 'done' ? ', done' : ''}]: ${l.text}`)
        .join('\n')
    : '(empty)';
  const line = (m: Message) => chatLine(m, pack, isForgotten(m, forgotten));
  return [
    '<chat_data>',
    'People in the trip:',
    peopleLegend(pack),
    'The trip record now:',
    recordText.replace(/</g, '‹').replace(/>/g, '›'),
    ...(context.length ? ['Earlier lines, for context only:', ...context.map(line)] : []),
    'New lines:',
    ...fresh.map(line),
    '</chat_data>',
    `Propose notes for the new lines (#${fresh[0]!.seq} to #${fresh[fresh.length - 1]!.seq}).`,
  ].join('\n');
}

export function createNotes(d: NotesDeps): { run(tripId: string, opts?: { only?: string[] }): Promise<NotesResult> } {
  const running = new Map<string, Promise<NotesResult>>();

  async function readCursor(tripId: string): Promise<number> {
    const r = await d.pool.query<{ seq: number }>('SELECT seq FROM notes_cursor WHERE trip_id = $1', [tripId]);
    return r.rows[0]?.seq ?? 0;
  }
  async function advance(tripId: string, seq: number): Promise<void> {
    await d.pool.query(
      `INSERT INTO notes_cursor (trip_id, seq, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (trip_id) DO UPDATE SET seq = GREATEST(notes_cursor.seq, EXCLUDED.seq), updated_at = now()`,
      [tripId, seq],
    );
  }

  async function once(tripId: string, only: string[] | undefined): Promise<NotesResult> {
    const pack = await d.packs.get(tripId);
    const visible = pack.messages.filter((m) => !m.deleted && !m.withheld);
    const cursor = only ? 0 : await readCursor(tripId);
    const waiting = only ? visible.filter((m) => only.includes(m.message_id)) : visible.filter((m) => m.seq > cursor);
    const fresh = waiting.slice(0, BATCH);
    if (!fresh.some((m) => m.author.kind === 'person')) {
      if (!only && fresh.length) await advance(tripId, fresh[fresh.length - 1]!.seq);
      return { ...empty(), skipped: 'nothing_new' };
    }
    const firstSeq = fresh[0]!.seq;
    const context = visible.filter((m) => m.seq < firstSeq).slice(-CONTEXT);
    const forgotten = await forgottenUpTo(d.pool, tripId);
    await mirrorSnapshot(d.pool, pack.trip);
    const env: CheckEnv = { pack, forgotten, record: await recordLines(d.pool, tripId) };

    let raw: string;
    try {
      raw = await d.side.complete({
        purpose: 'notes',
        system: NOTES_RULES,
        user: promptFor(pack, env.record, context, fresh, forgotten),
        maxTokens: 1_500,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      d.log.warn({ tripId, err: String(err) }, 'notes pass: side model failed');
      return { ...empty(), skipped: 'model_error' };
    }
    const lastSeq = fresh[fresh.length - 1]!.seq;
    const parsed = parseNotes(raw);
    if (!parsed) {
      d.log.warn({ tripId }, 'notes pass: output was not valid JSON notes');
      if (!only) await advance(tripId, lastSeq);
      return { ...empty(), skipped: 'bad_output' };
    }

    const bySeq = new Map(visible.map((m) => [m.seq, m]));
    const freshSeqs = new Set(fresh.map((m) => m.seq));
    const shownSeqs = new Set([...context, ...fresh].map((m) => m.seq));
    const noted = new Set<string>();
    const out = empty();

    for (const f of parsed.facts) {
      const m = freshSeqs.has(f.message) ? bySeq.get(f.message) : undefined;
      if (!m) {
        out.refused.push('fact: not one of the new lines');
        continue;
      }
      const c = checkFact(
        { person_id: f.person_id, topic: f.topic, text: f.text, message_id: m.message_id, ...(f.audience ? { audience: f.audience } : {}) },
        env,
      );
      if (!c.ok) {
        out.refused.push(`fact: ${c.reason}`);
        continue;
      }
      const saved = await saveFact(d.pool, { ...c.value, source: 'message' });
      out.facts += 1;
      if (saved.changed) noted.add(m.message_id);
    }

    for (const l of parsed.lines) {
      if (l.proof.length === 0 || !l.proof.every((s) => shownSeqs.has(s)) || !l.proof.some((s) => freshSeqs.has(s))) {
        out.refused.push('line: proof outside the lines shown');
        continue;
      }
      const c = checkLine(
        {
          kind: l.kind,
          text: l.text,
          person_ids: l.person_ids,
          proof: l.proof.map((s) => bySeq.get(s)!.message_id),
          objections: l.objections.flatMap((s) => {
            const m = bySeq.get(s);
            return m ? [m.message_id] : [];
          }),
          ...(l.due_at ? { due_at: l.due_at } : {}),
          ...(l.line_id ? { line_id: l.line_id } : {}),
          ...(l.status ? { status: l.status } : {}),
        },
        env,
      );
      if (!c.ok) {
        out.refused.push(`line: ${c.reason}`);
        continue;
      }
      const written = await writeLine(d.pool, d.link, tripId, c.value, lineRequestId(c.value));
      if ('failed' in written) {
        out.refused.push(`line: the Server said ${written.failed}`);
        continue;
      }
      out.lines += 1;
      if (!c.value.lineId) {
        // Keep a provisional copy until record.changed arrives (seq 0 loses to any real event),
        // so the next pass sees the line and does not write it again.
        const at = d.now().toISOString();
        const provisional = {
          line_id: written.lineId, kind: c.value.kind, text: c.value.text, status: 'active' as const, proof: c.value.proof,
          person_ids: c.value.personIds, source: 'go' as const, created_at: at, updated_at: at,
        };
        await mirrorLine(d.pool, tripId, provisional, 0);
        env.record = [...env.record, provisional];
        const first = c.value.proof.find((p) => p.person_id !== null);
        if (first) noted.add(first.message_id);
      }
    }

    for (const id of noted) {
      const m = visible.find((x) => x.message_id === id);
      if (m && (await reactOnce(d.pool, d.link, tripId, m, '✅')) === 'sent') out.reacted += 1;
    }
    if (!only) await advance(tripId, lastSeq);
    if (out.refused.length) d.log.info({ tripId, refused: out.refused.length, reasons: out.refused.slice(0, 5) }, 'notes pass refused proposals');
    if (waiting.length > BATCH) out.more = true;
    return out;
  }

  async function runAll(tripId: string, only: string[] | undefined): Promise<NotesResult> {
    let res = await once(tripId, only);
    // A long backlog (after a restart, say) is read 40 lines at a time, at most five batches per run.
    for (let i = 0; i < 4 && res.more && !only; i += 1) res = await once(tripId, undefined);
    return res;
  }

  return {
    run(tripId, opts = {}) {
      const prev = running.get(tripId) ?? Promise.resolve(empty());
      const next = prev.then(
        () => runAll(tripId, opts.only),
        () => runAll(tripId, opts.only),
      );
      running.set(tripId, next);
      const clear = () => {
        if (running.get(tripId) === next) running.delete(tripId);
      };
      next.then(clear, clear);
      return next;
    },
  };
}
