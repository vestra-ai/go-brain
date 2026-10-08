/** Quick tools for the composer: read memory (trip, person, recall) and write one checked record line (record). */
import type { Pool } from 'pg';
import { z } from 'zod';
import { dataBlock, defuse, inlineData, oneLine, personName } from '../composer/fence.js';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import { checkLine } from './checker.js';
import { closeSettled, decisionOf, linkLine } from './decision-lines.js';
import { forgottenUpTo } from './facts.js';
import type { Memory } from './memory.js';
import { renderRecord } from './now.js';
import { mirrorSnapshot, recordLines, writeLine } from './record.js';

const TripInput = z.object({}).strict();
const PersonInput = z.object({ name: z.string().min(1).max(80) }).strict();
const RecallInput = z.object({ question: z.string().min(2).max(300) }).strict();
const RecordInput = z
  .object({
    kind: z.enum(['agreed', 'open', 'doing']),
    text: z.string().min(1).max(200),
    person_ids: z.array(z.string().min(1).max(64)).max(30),
    proof_message_ids: z.array(z.string().min(1).max(64)).min(1).max(10),
  })
  .strict();

export function memoryTools(d: { pool: Pool; memory: Memory }): QuickTool<any>[] {
  const trip: QuickTool<z.infer<typeof TripInput>> = {
    name: 'trip',
    description: 'The trip: title, place, dates, people and the trip record (what is decided, agreed, booked, open and who is doing what).',
    input: TripInput,
    async run(_args, ctx: TurnCtx) {
      const t = ctx.pack.trip;
      await mirrorSnapshot(d.pool, t);
      const record = renderRecord(await recordLines(d.pool, ctx.tripId), ctx.pack, { full: 30, short: 40 });
      return {
        title: t.title,
        status: t.status,
        destination: t.destination?.name ?? null,
        dates: t.dates ?? null,
        people: t.people.map((p) => ({ person_id: p.person_id, name: personName(p.name), organizer: p.person_id === t.organizer_person_id })),
        record: record ?? 'The record is empty.',
      };
    },
  };

  const person: QuickTool<z.infer<typeof PersonInput>> = {
    name: 'person',
    description: "What Go knows about one person in this trip, by name: one line per fact with the message it came from.",
    input: PersonInput,
    async run({ name }, ctx: TurnCtx) {
      const q = name.trim().toLowerCase();
      const people = ctx.pack.trip.people;
      const exact = people.filter((p) => p.name.toLowerCase() === q);
      const matches = exact.length ? exact : people.filter((p) => p.name.toLowerCase().startsWith(q));
      if (matches.length === 0) return { error: `No one called ${name} in this trip.` };
      if (matches.length > 1) return { error: `More than one person matches ${name}: ${matches.map((p) => p.name).join(', ')}.` };
      const p = matches[0]!;
      const page = await d.memory.page(ctx.tripId, p.person_id, 'go');
      return {
        person_id: p.person_id,
        name: personName(p.name),
        page: page ? dataBlock('facts', page.split('\n').map((l) => defuse(oneLine(l)))) : 'Go knows nothing about them yet.',
      };
    },
  };

  const recallTool: QuickTool<z.infer<typeof RecallInput>> = {
    name: 'recall',
    description: 'Search this trip\'s whole chat and saved facts by words, for things older than the chat you can see. Returns lines with their message numbers.',
    input: RecallInput,
    async run({ question }, ctx: TurnCtx) {
      const hits = await d.memory.recall(ctx.tripId, question, 'go');
      return { hits: hits.map((h) => ({ ...h, text: inlineData(h.text, 300) })) };
    },
  };

  const record: QuickTool<z.infer<typeof RecordInput>> = {
    name: 'record',
    description:
      'Add one line to the trip record: agreed (the group agreed in the chat), open (a question still to settle, person_ids = who is asked) or doing (someone said they will sort it). Give the message ids it came from. Go checks the proof; a thin agreement is saved as open.',
    input: RecordInput,
    // What a reply would say if the line were saved: never said when it wasn't (composer/sanitize.ts withoutRefused).
    claims: /\b(?:noted|logged|recorded)\b|\bdown as\b|\b(?:added|saved) (?:it |that |this )?(?:to|in) the (?:record|list)\b/i,
    async run(args, ctx: TurnCtx) {
      await mirrorSnapshot(d.pool, ctx.pack.trip);
      const env = { pack: ctx.pack, forgotten: await forgottenUpTo(d.pool, ctx.tripId), record: await recordLines(d.pool, ctx.tripId) };
      const c = checkLine({ kind: args.kind, text: args.text, person_ids: args.person_ids, proof: args.proof_message_ids }, env);
      if (!c.ok) {
        // Someone else's word never puts a job against a person's name ("note that Arjun is bringing the speaker", 8 Oct):
        // only their own does. Go asks them to confirm, and says nothing is noted until they do.
        const authors = new Set(
          args.proof_message_ids.flatMap((id) => {
            const m = ctx.pack.messages.find((x) => x.message_id === id);
            return m?.author.kind === 'person' ? [m.author.person_id] : [];
          }),
        );
        const others = args.kind === 'doing' ? ctx.pack.trip.people.filter((p) => args.person_ids.includes(p.person_id) && !authors.has(p.person_id)) : [];
        if (others.length > 0) {
          const names = others.map((p) => personName(p.name)).join(' and ');
          return {
            refused: c.reason,
            tell_the_room: `Only ${names} can put this against their own name. Ask ${names} in one line to confirm it, and don't say it is noted until they do.`,
          };
        }
        return { refused: c.reason, tell_the_room: SAY_NOTHING };
      }
      const out = await writeLine(d.pool, ctx.link, ctx.tripId, c.value, ctx.stableId('go_record'));
      if ('failed' in out) return { refused: `the Server said ${out.failed}`, tell_the_room: SAY_NOTHING };
      await closeSettled(d.pool, ctx.link, ctx.tripId, c.value, [], env.record);
      const vote = decisionOf(c.value, ctx.pack, { cards: ctx.cards, wake: ctx.wake });
      if (vote) await linkLine(d.pool, ctx.tripId, out.lineId, vote, ctx.pack);
      return { saved: out.lineId, kind: c.value.kind };
    },
  };

  return [trip, person, recallTool, record];
}
