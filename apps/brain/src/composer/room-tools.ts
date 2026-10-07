import * as C from '@go/contract';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Message } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import { reactOnce } from '../memory/reactions.js';
import { DEFAULT_TZ, localDay } from '../proactive/clock.js';
import type { OptionPlace } from '../travel/results.js';
import type { Travel } from '../travel/travel.js';
import type { TripPack } from '../trips/pack.js';
import { inlineData } from './fence.js';
import { CARD_LINE } from './rules.js';
import { clip } from './sanitize.js';
import { SAY_NOTHING, STAY_SILENT, type QuickTool } from './tools.js';

/** "#57", "57" or a message id. */
function findMessage(pack: TripPack, ref: string): Message | undefined {
  const n = /^#?(\d+)$/.exec(ref.trim());
  return n ? pack.messages.find((m) => m.seq === Number(n[1])) : pack.messages.find((m) => m.message_id === ref);
}

const codeOf = (e: unknown): number => (e instanceof SocketCallError ? e.code : 0);

const ReactInput = z.object({
  message_id: z.string().min(1).max(64).describe('The message number from the chat, like "#57".'),
  emoji: z.string().min(1).max(16),
});

/** The contract's DecisionOption, field for field (copied by shape so the tool's JSON schema has no $ref), with hints for the model. */
const VoteOption = z.object({
  ...C.DecisionOption.shape,
  option_ref: C.DecisionOption.shape.option_ref.describe(
    'The option_id of a search result this option came from, so the winner can be booked. Leave it out when no search found it.',
  ),
  price_minor: C.DecisionOption.shape.price_minor.describe('The price in paise (minor units), only from a check made in this turn.'),
  note: C.DecisionOption.shape.note.describe('One short line under the label, like "3 nights, pool".'),
});

/** The fields the model filled; null and missing ones are left out of the wire. */
function filledOnly<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

const OpenVoteInput = z.object({
  question: z.string().min(1).max(200),
  options: z.array(VoteOption).min(2).max(10),
  kind: z.enum(['choice', 'yesno']).optional().describe('choice (the default) or yesno.'),
  anonymous: z.boolean().optional().describe('true for a secret ballot, only when someone asks for a secret or anonymous vote. Leave it out otherwise.'),
  closes_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When the vote closes, an ISO time with its offset. Leave it out to close when everyone has voted.'),
});

const CloseVoteInput = z.object({
  decision_id: z.string().min(1).max(64).describe('The vote id from "right now", like d_stay.'),
});

const UpdateTripInput = z.object({
  title: z.string().min(1).max(80).optional(),
  destination: z.string().min(1).max(120).optional().describe('The place name, like "North Goa".'),
  dates: z.object({ start: z.iso.date(), end: z.iso.date() }).optional(),
  vibe: z.array(z.string().min(1).max(40)).max(12).optional(),
  stay: z.string().min(1).max(60).optional(),
});

const StaySilentInput = z.object({
  reason: z.string().min(1).max(200).describe('A few words for the log. Never shown to anyone.'),
});

/** Days said without a year mean the next ones: the same days this year, or next year when this year's have passed. */
export function nextDates(d: { start: string; end: string }, today: string): { start: string; end: string } {
  const year = Number(today.slice(0, 4));
  const shift = (`${year}${d.start.slice(4)}` >= today ? year : year + 1) - Number(d.start.slice(0, 4));
  const move = (day: string) => `${Number(day.slice(0, 4)) + shift}${day.slice(4)}`;
  return { start: move(d.start), end: move(d.end) };
}

/** The room's quick tools. None of them can pay, book or see a card: those are never composer tools in P1. */
/** Lowercase letters and digits only, so "Villa Sol," and "villa sol" compare equal. */
const plain = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** travel: brain.travel, read when a tool runs (the travel lane registers after this one). */
export function roomTools(o: { now: () => Date; pool: Pool; travel?: () => Travel | undefined }): QuickTool<any>[] {
  /** The winner of the latest closed vote whose winning option is of this kind, with the option's own data. */
  async function decided(pack: TripPack, kind: 'stay' | 'place'): Promise<OptionPlace | null> {
    const travel = o.travel?.();
    if (!travel?.placeOf) return null;
    const closed = pack.trip.decisions
      .filter((d) => d.status === 'closed' && d.result_index !== null && d.result_index !== undefined)
      .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
    for (const d of closed) {
      const ref = d.options[d.result_index!]?.option_ref;
      if (!ref) continue;
      const option = await travel.placeOf(ref);
      if (option?.kind === kind) return option;
    }
    return null;
  }

  const react: QuickTool<z.infer<typeof ReactInput>> = {
    name: 'react',
    description:
      'React to one message with an emoji: ✅ when you noted something, 👍 to agree, ❤️ or 😂 like a friend would. ' +
      'Quieter than a message, so prefer it when words are not needed.',
    input: ReactInput,
    async run(a, ctx) {
      const m = findMessage(ctx.pack, a.message_id);
      if (!m) return { ok: false, error: `There is no message ${a.message_id} in this trip.` };
      // The same path as the reflex's quiet ✅: Go's own record of the reactions it sent (go_reactions) and one request
      // id per message and emoji, so a reaction Go already holds, or is sending right now, is not sent again.
      const r = await reactOnce(o.pool, ctx.link, ctx.tripId, m, a.emoji);
      if (r === 'failed') return { ok: false, error: 'The reaction did not go through. Carry on without it.' };
      if (a.emoji === '✅') (ctx.outcome.noted ??= []).push(m.message_id);
      if (r === 'skipped') return { ok: true, note: 'Nothing to do: you already hold that reaction, or the message cannot take one.' };
      ctx.outcome.reactions += 1;
      return { ok: true };
    },
  };

  const openVote: QuickTool<z.infer<typeof OpenVoteInput>> = {
    name: 'open_vote',
    description:
      'Open a vote in the room, with 2 to 10 short options. The vote card goes out with your message: write your one ' +
      `short line in the same reply. ${CARD_LINE} Never open a second vote on a question that already has an open one. ` +
      'Set anonymous when someone asks for a secret or anonymous vote.',
    input: OpenVoteInput,
    endsTurn: true,
    async run(a, ctx) {
      if (a.closes_at && Date.parse(a.closes_at) <= o.now().getTime()) return { ok: false, error: 'closes_at must be in the future.' };
      const r = await ctx.link.request('open_vote', {
        request_id: ctx.stableId('go_vote'),
        trip_id: ctx.tripId,
        question: a.question,
        kind: a.kind ?? 'choice',
        anonymous: a.anonymous ?? false,
        // Every DecisionOption field the model filled goes through as it is: option_ref is how P5 finds the offer to book.
        options: a.options.map(filledOnly),
        ...(a.closes_at ? { closes_at: a.closes_at } : {}),
      });
      ctx.cards.push({ kind: 'vote', card_id: ctx.stableId('c_vote'), fallback_text: clip(`Vote: ${a.question}`, 300), decision_id: r.decision_id });
      return { ok: true, decision_id: r.decision_id, note: 'The vote card goes out with your message.' };
    },
  };

  const closeVote: QuickTool<z.infer<typeof CloseVoteInput>> = {
    name: 'close_vote',
    description: 'Close an open vote now and get the result. Use it when everyone who will vote has voted, or the group asks.',
    input: CloseVoteInput,
    async run(a, ctx) {
      try {
        const r = await ctx.link.request('close_vote', { request_id: ctx.stableId('go_close'), trip_id: ctx.tripId, decision_id: a.decision_id });
        const d = r.decision;
        const won = d.result_index != null ? d.options[d.result_index] : undefined;
        return {
          ok: true,
          winner: won ? inlineData(won.label) : null,
          tally: d.options.map((op, k) => `${inlineData(op.label)} ${d.tally[k] ?? 0}`),
          voted: d.voted,
          of: d.of,
        };
      } catch (e) {
        if (codeOf(e) === 409) return { ok: false, error: 'That vote is not open.' };
        if (codeOf(e) === 404) return { ok: false, error: 'There is no such vote in this trip.' };
        throw e;
      }
    },
  };

  const updateTrip: QuickTool<z.infer<typeof UpdateTripInput>> = {
    name: 'update_trip',
    description: "Change the trip's title, place, dates, vibe or the stay the group wants. Only when the group agreed or the organizer asked.",
    input: UpdateTripInput,
    async run(a, ctx) {
      const fields = {
        ...(a.title ? { title: a.title } : {}),
        ...(a.destination ? { destination: { name: a.destination } } : {}),
        ...(a.dates ? { dates: a.dates } : {}),
        ...(a.vibe ? { vibe: a.vibe } : {}),
        ...(a.stay ? { stay: a.stay } : {}),
      };
      if (Object.keys(fields).length === 0) return { ok: false, error: 'Nothing to change.' };
      // A stay or place a vote decided is saved from the winning option's own data, never from the model's words, and a
      // different one is refused: "Villa Sol, Assagao" for the Villa Sol in Anjuna the group voted for saves "Villa Sol, Anjuna".
      if (a.stay) {
        const won = await decided(ctx.pack, 'stay');
        if (won) {
          if (!` ${plain(a.stay)} `.includes(` ${plain(won.title)} `)) {
            return { ok: false, error: `The group voted for ${won.title}${won.area ? ` in ${won.area}` : ''}. Save that, or ask the group before changing the stay.`, tell_the_room: SAY_NOTHING };
          }
          fields.stay = clip(won.area ? `${won.title}, ${won.area}` : won.title, 60);
        }
      }
      if (a.destination) {
        const won = await decided(ctx.pack, 'place');
        if (won) {
          const name = won.place?.name ?? won.title;
          if (!` ${plain(a.destination)} `.includes(` ${plain(name)} `)) {
            return { ok: false, error: `The group voted for ${name}. Save that, or ask the group before changing the place.`, tell_the_room: SAY_NOTHING };
          }
          fields.destination = { name };
        }
      }
      if (a.dates && a.dates.start > a.dates.end) return { ok: false, error: 'The start date is after the end date.' };
      if (a.dates) {
        const tz = (await o.pool.query<{ tz: string }>('select tz from trips where trip_id = $1', [ctx.tripId])).rows[0]?.tz ?? DEFAULT_TZ;
        const today = localDay(o.now(), tz);
        // A trip under way keeps the start it already has; any other day before today is a guessed year.
        if (a.dates.end < today || (a.dates.start < today && a.dates.start !== ctx.pack.trip.dates?.start)) {
          const next = nextDates(a.dates, today);
          return {
            ok: false,
            error: `Those dates are before today (${today} where the trip is). Use this year or next: ${next.start} to ${next.end}, if that is what the group meant.`,
            tell_the_room: SAY_NOTHING,
          };
        }
      }
      await ctx.link.request('update_trip', { request_id: ctx.stableId('go_trip'), trip_id: ctx.tripId, ...fields });
      return { ok: true, changed: Object.keys(fields), ...(fields.stay ? { stay: fields.stay } : {}) };
    },
  };

  const staySilent: QuickTool<z.infer<typeof StaySilentInput>> = {
    name: STAY_SILENT,
    description: 'End your turn without a message. Call it when nothing needs words from you, also right after a reaction or an action.',
    input: StaySilentInput,
    async run(_args, ctx) {
      ctx.outcome.silent = true;
      return { ok: true };
    },
  };

  return [react, openVote, closeVote, updateTrip, staySilent];
}
