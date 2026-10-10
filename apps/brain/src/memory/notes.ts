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
import { maskSecrets } from '../reflex/secrets.js';
import { partOfAskToGo } from '../trips/names-go.js';
import type { Travel } from '../travel/travel.js';
import type { Packs, TripPack } from '../trips/pack.js';
import { saveTrip, tripToday, type TripChange } from '../trips/save-trip.js';
import { checkFact, checkLine, type CheckedLine, type CheckEnv } from './checker.js';
import { closeSettled, decisionOf, linkLine } from './decision-lines.js';
import { forgottenUpTo, saveFact } from './facts.js';
import { chatLine } from '../composer/fence.js';
import { FENCE_RULE, fenceText, notesView, peopleLegend } from './fence.js';
import { reactOnce } from './reactions.js';
import { lineRequestId, mirrorLine, mirrorSnapshot, recordLines, writeLine } from './record.js';
import type { SideModel } from './side-model.js';

export const NOTES_RULES = [
  'You keep notes for Go, the AI member of a trip group chat. You read the new lines of the chat and propose two kinds of notes.',
  '1. facts: lasting things a person says about themselves that matter for planning the trip: food, drinks, when they can or cannot travel, seats, health, what they will not do. Never a budget, a price limit or any amount of money: budgets stay private to the trip, and the App asks them. Only from that person\'s own line, and never from a question or a request: "@Go is it hot in Goa in November?" or "how far is Thalassa from Anjuna" says nothing lasting about whoever asks it, not even an interest in the places it names. topic is one or two lowercase words such as food, drinks, leaving, arriving, seats, flights, boats, health, sleep, activities. text is short plain words without the name, such as "Vegetarian" or "Can\'t leave before 6 pm Friday". The trip\'s own plan (its dates, its place), said as the plan, is not a fact about whoever said it: it goes in the record, and a plan the group is weighing ("@Go we are thinking a trek on Sunday, good for all of us?") is never a fact either, not even an interest. A lasting lean shows in passing too: a complaint ("ugh 6 am flights again"), a rejection with its reason ("nah too far from the beach"), or a must ("sunset at the beach is a must"). Note it as the speaker\'s lean, starting Prefers, Dislikes or Wants ("Dislikes early flights", "Prefers stays near the beach", "Wants a beach sunset"), never as a rule. Give "this_trip": true for a fact that only holds for this trip (when they can leave or land this time, who comes along, this trip\'s stay area); a fact about the person (food, drinks, health, seats, a lasting lean) has none. A reaction on a line can show the reactor\'s lean (😍 on a beach photo, 👍 on a pool villa): note it for the person who reacted, with that line as the message and "reaction": true, as a lean starting Prefers, Likes, Dislikes or Wants ("Likes pool villas"). Never a rule, and never from Go\'s reactions.',
  '2. lines for the trip record: "agreed" when people agreed in the chat (proof: the proposal and the yes lines; put any line that disagrees in objections). The organizer\'s own line that states a plan point as settled ("Goa trip is happening!! 6 to 9 Nov", "We\'re doing North Goa") is agreed on its own, with that line as proof; one from the organizer that proposes or asks ("6 to 9 Nov?", "how about North Goa?") is open. "open" when a question about the plan is still unsettled among the group (person_ids: who is asked); a question put to Go is Go\'s to answer and is never open. "doing" when someone says they will sort something (person_ids: who said it); a request to Go is never a doing line, Go does it, and a payment someone made or a debt ("I paid 2400 for the cab", "Kabir owes me 500") is a money record Go keeps with record_expense, never a doing line. To change one of Go\'s own record lines, give its line_id; for a job that is finished add "status": "done". When an agreed or doing line settles one of Go\'s open questions in the record (the group agreed it, or someone took it on), give that open line\'s line_id in "settles": Go closes the question.',
  'Give "about": "dates" for a line about the trip\'s dates and "about": "place" for one about where the trip goes. Never open a line for something the trip\'s plan already has: with its dates set, "guys dates final karo" or "are we sure about the dates?" is answered by the plan, not an open question; with its place set, the same for the place. Only people agreeing to change them makes a line (agreed, with "trip").',
  'An agreed line that fixes the trip\'s dates or its place also gives them as "trip": {"dates": {"start": "2026-11-06", "end": "2026-11-09"}} or {"destination": "Kerala"}, or both, with full dates: days said without a year are the next ones after today. Only an agreed line gives "trip". The trip\'s place is where it goes, a city or region: an area inside it ("North Goa, not South", "Candolim", "Anjuna") is where to stay there, an agreed line in the record and never "trip".',
  'A line marked "to Go" is part of an ask to Go: Go answers it, so it is never an open line, and only a fact the person states in it is noted.',
  'Cite lines by their number (#142 is 142). Propose facts only from the new lines. Never propose anything from a [hidden] line. Never copy card numbers, codes or passwords. Do not repeat what the record already says.',
  FENCE_RULE,
  'Answer with one JSON object and nothing else, for example: {"facts":[{"person_id":"p_x","topic":"food","text":"Vegetarian","message":142}],"lines":[{"kind":"agreed","text":"North Goa, not South","person_ids":[],"proof":[122,124],"objections":[]}]}. Use empty lists when there is nothing to note.',
].join('\n');

export const NotesOutput = z.object({
  facts: z
    .array(
      z.object({
        person_id: z.string(), topic: z.string(), text: z.string(), message: z.int(), audience: z.enum(['group', 'go']).optional(),
        /** Only about this trip (when they can leave this time, who comes along, its stay area): never carried over. */
        this_trip: z.boolean().optional().catch(undefined),
        /** Read off the person's reaction on the line, not their words: a lean only (checker.ts). */
        reaction: z.boolean().optional().catch(undefined),
      }),
    )
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
        /** What part of the plan the line is about: an open line about dates or a place the trip already has is refused. */
        about: z.enum(['dates', 'place', 'other']).optional().catch(undefined),
        /** Go's open questions in the record this line settles: Go marks each done (decision-lines.ts closeSettled). */
        settles: z.array(z.string()).max(5).optional().catch(undefined),
        /** An agreed line's dates or place, for the trip itself; one that doesn't read is dropped, never the whole answer. */
        trip: z
          .object({ dates: z.object({ start: z.iso.date(), end: z.iso.date() }).optional(), destination: z.string().min(1).max(120).optional() })
          .optional()
          .catch(undefined),
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
  /** brain.travel, for a place a vote decided (the trip's writer checks it); read when a line is saved. */
  travel?: () => Travel | undefined;
}

const BATCH = 40;
const CONTEXT = 10;
const empty = (): NotesResult => ({ facts: 0, lines: 0, reacted: 0, refused: [] });

function promptFor(
  pack: TripPack, record: CheckEnv['record'], context: Message[], fresh: Message[], forgotten: ReadonlyMap<string, number>, today: string,
): string {
  const recordText = record.length
    ? record
        .filter((l) => l.status !== 'undone')
        .map((l) => `- ${fenceText(l.line_id)} [${l.kind}${l.source === 'go' ? ", Go's" : ''}${l.status === 'done' ? ', done' : ''}]: ${fenceText(maskSecrets(l.text).text)}`)
        .join('\n')
    : '(empty)';
  // A line marked "to Go" is part of an ask to Go (it names Go, or sits in the same person's burst that does): Go answers it.
  const view = notesView(pack, forgotten, (m) => partOfAskToGo(m, pack));
  const line = (m: Message) => chatLine(m, view);
  return [
    '<chat_data>',
    'People in the trip:',
    peopleLegend(pack),
    // The plan itself, so a question it already answers is never opened (the 9 Oct golden run: "Trip dates" opened for
    // all five on a trip set for 6 to 9 Nov).
    `The trip's plan now: dates ${pack.trip.dates ? `${pack.trip.dates.start} to ${pack.trip.dates.end} (set)` : 'not set'}; place ${pack.trip.destination ? `${fenceText(pack.trip.destination.name)} (set)` : 'not set'}.`,
    'The trip record now:',
    recordText,
    ...(context.length ? ['Earlier lines, for context only:', ...context.map(line)] : []),
    'New lines:',
    ...fresh.map(line),
    '</chat_data>',
    `Today where the trip is: ${today}.`,
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

  /**
   * An agreed line that fixes the trip's dates or place sets them on the trip too: the organizer's own settled line, or
   * the group's yes (the checker has passed it). Through the trip's one writer (update_trip, with its checks); what the
   * trip already holds is not sent again. Days read in the wrong year become the same days this year or next.
   */
  async function onTrip(tripId: string, pack: TripPack, line: CheckedLine, trip: { dates?: { start: string; end: string } | undefined; destination?: string | undefined }): Promise<string | null> {
    const now = pack.trip;
    const change: TripChange = {
      ...(trip.dates && !(now.dates?.start === trip.dates.start && now.dates.end === trip.dates.end) ? { dates: trip.dates } : {}),
      ...(trip.destination && now.destination?.name.toLowerCase() !== trip.destination.toLowerCase() ? { destination: trip.destination } : {}),
    };
    if (!change.dates && !change.destination) return null;
    const at = { link: d.link, tripId, pack, requestId: () => `go_trip_${lineRequestId(line).slice('go_line_'.length)}` };
    let saved = await saveTrip(d, at, change);
    if (!saved.ok && saved.next && change.dates) saved = await saveTrip(d, at, { ...change, dates: saved.next });
    return saved.ok ? null : `trip: ${saved.error}`;
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
        user: promptFor(pack, env.record, context, fresh, forgotten, await tripToday(d, tripId)),
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
        {
          person_id: f.person_id, topic: f.topic, text: f.text, message_id: m.message_id, ...(f.audience ? { audience: f.audience } : {}),
          ...(f.this_trip ? { this_trip: true } : {}), ...(f.reaction ? { reaction: true } : {}),
        },
        env,
      );
      if (!c.ok) {
        out.refused.push(`fact: ${c.reason}`);
        continue;
      }
      const saved = await saveFact(d.pool, { ...c.value, source: 'message' });
      if ('refused' in saved) {
        // The person asked Go to forget them while the model was reading.
        out.refused.push('fact: that person asked Go to forget this');
        continue;
      }
      out.facts += 1;
      // A lean read off a reaction is never a ✅ on the line: that line is someone else's words.
      if (saved.changed && !f.reaction) noted.add(m.message_id);
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
          ...(l.about ? { about: l.about } : {}),
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
      await closeSettled(d.pool, d.link, tripId, c.value, l.settles ?? [], env.record);
      if (c.value.kind === 'agreed' && l.trip) {
        const refused = await onTrip(tripId, pack, c.value, l.trip);
        if (refused) out.refused.push(refused);
      }
      const vote = decisionOf(c.value, pack);
      if (vote) await linkLine(d.pool, tripId, written.lineId, vote, pack);
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
