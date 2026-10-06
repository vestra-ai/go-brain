// post_notice and update_notice: Go's quick tools for a notice card. They enforce what the bar allowed,
// keep pins to the right people, never ping someone who paused Go, and label simulated news.
import { z } from 'zod';
import { SAY_NOTHING, type QuickTool, type TurnCtx } from '../composer/tools.js';
import { allowedByAnItem, rulesForTurn, simulatedIn } from './allowed.js';
import { proactiveOf, type ProactivePayload } from './payload.js';
import type { NoticeIn, ProactiveStore } from './store.js';
import { clip, plain } from './words.js';

export const SIMULATED_SOURCE = 'Simulated for the demo';

const PostNoticeArgs = z.object({
  tone: z.enum(['info', 'heads_up']),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(500),
  for_person_ids: z.array(z.string().min(1).max(64)).max(30).optional(),
  deadline_at: z.iso.datetime({ offset: true }).optional(),
  source_name: z.string().min(1).max(60).optional(),
});
type PostNoticeArgs = z.infer<typeof PostNoticeArgs>;

const UpdateNoticeArgs = z.object({
  card_id: z.string().min(1).max(64),
  tone: z.enum(['info', 'heads_up']).optional(),
  title: z.string().min(1).max(80).optional(),
  body: z.string().min(1).max(500).optional(),
});
type UpdateNoticeArgs = z.infer<typeof UpdateNoticeArgs>;

export interface NoticeToolDeps {
  store: ProactiveStore;
  now: () => Date;
  /** Called once per proactive item in the turn when a notice is queued (watches remember the card). */
  onPosted?: (p: ProactivePayload, cardId: string) => Promise<void>;
}

/** The people a simulated item in the wake names, or null when there is none or it names nobody. */
function simulatedPins(wake: TurnCtx['wake']): string[] | null {
  const ids = new Set<string>();
  for (const item of wake) {
    const p = proactiveOf(item);
    if (p?.candidate.simulated) for (const id of p.forPersonIds) ids.add(id);
  }
  return ids.size > 0 ? [...ids] : null;
}

const NOT_NOW = 'Not now: the bar for speaking up unprompted is not met for this. Use an allowed action or stay_silent.';
const ONE_NOTICE = 'This turn already posted its one notice. Put everything in that notice, or stay_silent.';
const NEWS_ONLY = 'A notice card is for news you bring on your own (a delay, a deadline, a clash). Answer in your message, or open a vote to ask the group.';
const refuse = (why: string) => ({ refused: why, tell_the_room: SAY_NOTHING });

export function noticeTools(deps: NoticeToolDeps): [QuickTool<PostNoticeArgs>, QuickTool<UpdateNoticeArgs>] {
  const post: QuickTool<PostNoticeArgs> = {
    name: 'post_notice',
    description:
      'Post a notice card: news worth knowing, or a heads-up (a deadline, a delay, a clash), that you bring on your own. Never to ask the group something: that is a vote. ' +
      'Set for_person_ids to pin it for just the people it concerns instead of the whole group.',
    input: PostNoticeArgs,
    // The card carries its own words: once it is up, the turn ends without another model call.
    endsTurn: true,
    async run(args: PostNoticeArgs, ctx: TurnCtx): Promise<unknown> {
      const rules = rulesForTurn(ctx.wake);
      if (rules && !rules.tools.includes('post_notice')) return refuse(NOT_NOW);
      // Notices are news Go brings unprompted: a turn only people (or taps, tasks, trip changes) woke answers in its
      // message, or asks with a vote. A turn a person woke along with a timer or a watch that allowed a notice may post it.
      if (!rules && !allowedByAnItem(ctx.wake, 'post_notice')) return refuse(NEWS_ONLY);
      // An unprompted turn spends one post of the budget: one notice, however many times the model asks.
      if (rules && ctx.cards.some((c) => (c as { kind?: unknown }).kind === 'notice')) return refuse(ONE_NOTICE);
      const reachable = new Set(ctx.pack.trip.people.filter((p) => !p.go_paused).map((p) => p.person_id));
      let pins = (args.for_person_ids ?? []).filter((id) => reachable.has(id));
      // Simulated news stays pinned to the people it names, even in a turn a person woke (no rules then).
      const pinOnlyFor = rules?.pinOnlyFor ?? simulatedPins(ctx.wake);
      if (pinOnlyFor) {
        const named = pinOnlyFor.filter((id) => reachable.has(id));
        pins = pins.filter((id) => named.includes(id));
        if (pins.length === 0) pins = named;
        if (pins.length === 0) return refuse('Nobody this concerns can be pinged right now.');
      }
      const title = clip(plain(args.title), 80);
      const body = clip(plain(args.body), 500);
      const source = simulatedIn(ctx.wake)
        ? { name: SIMULATED_SOURCE }
        : args.source_name ? { name: clip(plain(args.source_name), 60) } : null;
      const card: NoticeIn = {
        card_id: ctx.stableId('c_notice'),
        kind: 'notice',
        fallback_text: clip(`${title}. ${body}`, 300),
        tone: args.tone,
        title,
        body,
        checked_at: deps.now().toISOString(),
        ...(pins.length > 0 ? { for_person_ids: pins } : {}),
        ...(source ? { source } : {}),
        ...(args.deadline_at ? { deadline_at: args.deadline_at } : {}),
      };
      // The card rides with the turn's message (P1 posts ctx.cards after the text, with stable request ids).
      ctx.cards.push(card);
      await deps.store.saveNotice({ tripId: ctx.tripId, cardId: card.card_id, messageId: null, card });
      for (const item of ctx.wake) {
        const p = proactiveOf(item);
        if (p) await deps.onPosted?.(p, card.card_id);
      }
      return { posted: true, card_id: card.card_id, pinned_for: pins };
    },
  };

  const update: QuickTool<UpdateNoticeArgs> = {
    name: 'update_notice',
    description: 'Update a notice card Go posted earlier, in place (the delay grew, the deadline moved). Quieter than a new message.',
    input: UpdateNoticeArgs,
    async run(args: UpdateNoticeArgs, ctx: TurnCtx): Promise<unknown> {
      const rules = rulesForTurn(ctx.wake);
      if (rules && !rules.tools.includes('update_notice')) return refuse(NOT_NOW);
      const saved = await deps.store.notice(ctx.tripId, args.card_id);
      if (!saved) return refuse('Go has no notice card with that id in this trip.');
      // Someone who paused Go since the notice went out is no longer pinged by it.
      const reachable = new Set(ctx.pack.trip.people.filter((p) => !p.go_paused).map((p) => p.person_id));
      const pinned = saved.card.for_person_ids;
      const pins = pinned ? pinned.filter((id) => reachable.has(id)) : null;
      if (pinned && pinned.length > 0 && pins?.length === 0) return refuse('Nobody this notice is for can be pinged right now.');
      const title = args.title ? clip(plain(args.title), 80) : saved.card.title;
      const body = args.body ? clip(plain(args.body), 500) : saved.card.body;
      const card: NoticeIn = {
        ...saved.card,
        ...(pins ? { for_person_ids: pins } : {}),
        title,
        body,
        fallback_text: clip(`${title}. ${body}`, 300),
        checked_at: deps.now().toISOString(),
        ...(args.tone ? { tone: args.tone } : {}),
        ...(simulatedIn(ctx.wake) ? { source: { name: SIMULATED_SOURCE } } : {}),
      };
      await ctx.link.request('replace_card', { trip_id: ctx.tripId, card });
      await deps.store.saveNotice({ ...saved, card });
      return { updated: true, card_id: args.card_id };
    },
  };

  return [post, update];
}
