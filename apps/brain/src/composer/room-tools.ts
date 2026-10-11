import * as C from '@go/contract';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Message } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import { reactOnce } from '../memory/reactions.js';
import type { Travel } from '../travel/travel.js';
import type { TripPack } from '../trips/pack.js';
import { isSmallTalk } from '../reflex/small-talk.js';
import { saveTrip } from '../trips/save-trip.js';
import { inlineData } from './fence.js';
import { CARD_LINE } from './rules.js';
import { clip } from './sanitize.js';
import { CardLineArg, SAY_NOTHING, STAY_SILENT, type QuickTool, type TurnCtx } from './tools.js';

const GO_NAME = /(?:^|\s)@?go\b[\s,!.:]*/gi;
const THANKS = /^(?:thanks?|thank you|thx|ty|shukriya|dhanyavaad|cheers|great|cool|nice|perfect|awesome|sure|ok|okay)(?: (?:so much|a lot|bro|yaar|man|go))?$/;

/** "@Go thanks 🙏", "ok go 👍": thanks or small talk said to Go, which a reaction or nothing answers. "@Go" alone is not. */
function onlyThanks(text: string): boolean {
  const rest = text.replace(GO_NAME, ' ').trim();
  if (rest === '') return false;
  return isSmallTalk(rest) || THANKS.test(rest.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').trim().replace(/\s+/g, ' '));
}

/**
 * The message that asked Go directly and has no answer yet this turn, or null. It woke the turn naming Go, or the quick
 * read sure it is for Go, and says more than thanks or small talk; and the turn has no words or card for it yet, did not
 * note it (✅), and ran no tool that answers in the room by itself. stay_silent is refused once while there is one (EXAM,
 * 10 Oct: "@Go which bus drops closest to our villa?" and two more direct asks ended in silence).
 */
export function unansweredAsk(ctx: TurnCtx): Message | null {
  // A turn under limits (Go woke for itself) or one that posts no text has nothing to answer with.
  if (ctx.allowedTools !== undefined || ctx.mayPostText === false) return null;
  if (ctx.cards.length > 0 || ctx.lines.length > 0 || ctx.answered || ctx.toolAnswers || ctx.outcome.posts.length > 0) return null;
  for (const w of ctx.wake) {
    const p = w.payload as { messageId?: string; namesGo?: boolean; asksGo?: boolean } | null;
    if (w.kind !== 'message' || !(p?.namesGo || p?.asksGo)) continue;
    const id = p.messageId ?? w.ref;
    const m = ctx.pack.messages.find((x) => x.message_id === id);
    if (!m?.text || onlyThanks(m.text) || ctx.outcome.noted?.includes(m.message_id)) continue;
    return m;
  }
  return null;
}

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
  price_minor: C.DecisionOption.shape.price_minor.describe(
    "The price in paise (minor units), only from a check made in this turn. For a stay, the whole stay's price, never one night's.",
  ),
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
  line: CardLineArg,
});

const CloseVoteInput = z.object({
  decision_id: z.string().min(1).max(64).describe('The vote id from "right now", like d_stay.'),
});

const UpdateTripInput = z.object({
  title: z.string().min(1).max(80).optional(),
  destination: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Where the trip goes: a city or region, like "Goa". Never an area to stay in or a hotel: that is the stay.'),
  dates: z.object({ start: z.iso.date(), end: z.iso.date() }).optional(),
  vibe: z.array(z.string().min(1).max(40)).max(12).optional(),
  proof_message_ids: z
    .array(z.string().min(1).max(64))
    .max(10)
    .optional()
    .describe("For a title, place or dates: the people's own messages that decided it (the organizer's, or two people agreeing)."),
  decision_id: z.string().min(1).max(64).optional().describe('For a title, place or dates: the closed vote that decided it.'),
  stay: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe('Where the group stays, as it picked it: a vote\'s winner or a booked stay, like "Candolim" or "Villa Sol, Anjuna". Never a wish ("a villa with a pool"): that stays a preference.'),
});

const OfferRepliesInput = z.object({
  replies: z
    .array(
      z.object({
        label: z.string().min(1).max(40).describe('What the button says, a few words: "Beach", "North Goa", "Saturday".'),
        text: z.string().min(1).max(200).optional().describe('What a tap posts as their message, when it should say more than the label.'),
      }),
    )
    .min(2)
    .max(6),
});

const StaySilentInput = z.object({
  reason: z.string().min(1).max(200).describe('A few words for the log. Never shown to anyone.'),
});

// Days without a year: the trip's one writer (trips/save-trip.ts) works them out, for this tool and the notes pass.
export { nextDates } from '../trips/save-trip.js';

/** The room's quick tools. None of them can pay, book or see a card: those are never composer tools in P1. */
/** travel: brain.travel, read when a tool runs (the travel lane registers after this one). */
export function roomTools(o: { now: () => Date; pool: Pool; travel?: () => Travel | undefined }): QuickTool<any>[] {
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
      `Open a vote in the room, with 2 to 10 short options. The vote card goes out with the line you give it. ${CARD_LINE} ` +
      'Options already on an options card are never voted here: a card of shared things (stays, places) is its own vote already, Vote on each option, ' +
      'and a card of one goes to a vote with put_to_vote and the card_id. Only those votes are tied to the offers, so the winner can be booked. ' +
      'Never open a second vote on a question that already has an open one. ' +
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
      ctx.lines.push(a.line);
      return { ok: true, decision_id: r.decision_id, note: 'The vote card goes out with your line.' };
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
    description:
      "Change the trip's title, place, dates, vibe or the stay the group wants. A title, place or dates change only on the organizer's word, " +
      'two people agreeing in words (proof_message_ids), or a closed vote (decision_id). One person asking is a wish: offer a vote instead.',
    input: UpdateTripInput,
    async run(a, ctx) {
      // The trip's one writer: the checks (who decided it, a stay or place a vote decided, days before today) and the request are there.
      const { proof_message_ids: proof, decision_id: decisionId, ...change } = a;
      const r = await saveTrip(
        o,
        { link: ctx.link, tripId: ctx.tripId, pack: ctx.pack, requestId: () => ctx.stableId('go_trip') },
        { ...change, ...(proof ? { proof } : {}), ...(decisionId ? { decisionId } : {}) },
      );
      if (!r.ok && r.notDecided) {
        return {
          ok: false,
          error: r.error,
          tell_the_room:
            "Say in one short line that the organizer or the group decides that, and offer to put it to a vote (open_vote), or point at the vote already open on it. " +
            'Never say it changed, and never say who said or picked what unless their own message says it.',
        };
      }
      if (!r.ok) return { ok: false, error: r.error, ...(r.quiet ? { tell_the_room: SAY_NOTHING } : {}) };
      // The lines this turn woke for are noted: their ✅ stays, even when the reply ends on a next-step question (prod,
      // 11 Oct: "Goa" and "1 to 7 Dec" were saved, and their ✅ came off two seconds later with "What should I pull up first?").
      if (r.changed.length > 0) {
        for (const i of ctx.wake) {
          const id = (i.payload as { messageId?: string } | null)?.messageId ?? i.ref;
          if (i.kind === 'message' && ctx.pack.messages.some((m) => m.message_id === id && m.author.kind === 'person')) (ctx.outcome.noted ??= []).push(id);
        }
      }
      return { ok: true, changed: r.changed, ...(r.stay ? { stay: r.stay } : {}), ...(r.note ? { note: r.note } : {}) };
    },
  };

  /**
   * 1.1 quick replies (A3): the choices go under Go's message as buttons, and a tap comes back as the tapper's own
   * message, so the group answers with one tap instead of typing, and Go's words never list them.
   */
  const offerReplies: QuickTool<z.infer<typeof OfferRepliesInput>> = {
    name: 'offer_replies',
    description:
      'Put up to six tap-to-answer choices under your message, when you ask the group to pick between a few things ' +
      '(beach or mountains, Saturday or Sunday). A tap comes back as that person\'s own message. ' +
      'Ask the question in your words and never list the choices there: they show as buttons. Never places to go: ' +
      'those are a place card (the ixigo tool\'s plan.explore, then show_options).',
    input: OfferRepliesInput,
    async run(a, ctx) {
      ctx.quickReplies = a.replies.map((r) => ({ label: clip(r.label, 40), ...(r.text ? { text: clip(r.text, 200) } : {}) }));
      // Write the whole message now: words before this call are never shown, and a hello that asked "Which one should I
      // start with?" alone lost its hello (staging drill, 10 Oct).
      return {
        ok: true,
        shown: ctx.quickReplies.map((r) => r.label),
        tell_the_room:
          'Now write your whole message, everything you meant to say (what you wrote before this call is never shown), ' +
          'ending with the question in one short line. The choices show under it as buttons: do not list them.',
      };
    },
  };

  const staySilent: QuickTool<z.infer<typeof StaySilentInput>> = {
    name: STAY_SILENT,
    description:
      'End your turn without a message. Call it when nothing needs words from you, also right after a reaction or an action. ' +
      'Never when someone asked you something directly: answer them.',
    input: StaySilentInput,
    async run(_args, ctx) {
      // Refused once: a model that calls it again knows something this check can't (a person already answered).
      const ask = ctx.silenceRefused ? null : unansweredAsk(ctx);
      if (ask) {
        ctx.silenceRefused = true;
        const author = ask.author;
        const who = (author.kind === 'person' ? ctx.pack.trip.people.find((p) => p.person_id === author.person_id)?.name : null) ?? 'Someone';
        throw new Error(
          `${who} asked you directly (#${ask.seq}): never stay silent on it. Answer in this turn: do it with your tools, or ask the ` +
            "one thing you need (\"which villa? there's no vote yet\"), or do the nearest thing you can now and say what you did.",
        );
      }
      ctx.outcome.silent = true;
      return { ok: true };
    },
  };

  return [react, openVote, closeVote, updateTrip, offerReplies, staySilent];
}
