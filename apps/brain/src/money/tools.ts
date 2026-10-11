import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { AskResult } from './ask.js';

/** A refusal in the money flow is the group's to hear, in Go's words. */
const SAY_THE_REFUSAL = 'Say this in your own short words. Never offer another way to pay.';

/**
 * Only the vote, the winning option as the vote names it, and the purpose. There is no payer and no card here: the payer
 * comes from the mandate. option_ref is the vote option's own reference (an options card's option_id), not a travel offer id.
 */
export const AskToPayInput = z.strictObject({
  decision_id: z.string().min(1).max(64),
  option_ref: z.string().min(1).max(200),
  purpose: z.string().min(1).max(200),
  /** The payer says the pay card didn't show up, or they declined it by mistake: the waiting one is cancelled, a fresh one sent. */
  again: z.boolean().optional(),
});
export type AskToPayInput = z.infer<typeof AskToPayInput>;

export const SetMandateInput = z.strictObject({
  decision_id: z.string().min(1).max(64),
  choice_index: z.int().nonnegative(),
  /** Left out when nobody said a clear number: Go then uses the price plus up to 10% and says so. */
  cap_minor: z.int().positive().optional(),
  refundable_only: z.boolean(),
  payer_person_id: z.string().min(1).max(64),
});
export type SetMandateInput = z.infer<typeof SetMandateInput>;

/** The ask, and how to let it finish on its own (its card posted by money itself) once the tool stops waiting. */
type AskRun = (ctx: TurnCtx, o: { decisionId: string; optionRef: string; purpose: string; again: boolean }) => { asking: Promise<AskResult>; letGo(): void };

/**
 * The longest ask_to_pay waits in the turn, inside the composer's 8 s for a tool: past it, the ask goes on and money posts
 * the pay card itself (inTurn), and the room hears it is on its way, never that it is up (prod, 10 Oct 21:05Z).
 */
export const IN_TURN_PAY_MS = 6_000;
const STILL_ASKING = Symbol('still asking');
type SetRun = (
  ctx: TurnCtx,
  o: { decisionId: string; choiceIndex: number; capMinor?: number; refundableOnly: boolean; payerPersonId: string },
) => Promise<{ cardId: string; capMinor: number; byMargin: boolean; note: string | null } | { refused: string; unbookable?: true; parked?: true; claim?: true }>;

export function askToPayTool(run: AskRun, o: { waitMs?: number } = {}): QuickTool<AskToPayInput> {
  return {
    name: 'ask_to_pay',
    description:
      "Ask the payer to approve paying for what the group voted for. Works only after the vote closed, the mandate is set and the payer tapped Yes, book it; option_ref is the winning option's ref from the vote, exactly as Payments in right now gives it. It checks the live price, gets the Server's approval and puts a pay card the payer approves with Face ID. When the payer says the pay card didn't show up, or that they declined it by mistake, call it with again: true: the waiting one is cancelled and a fresh one sent. You never pay, never ask for card details and never offer another way to pay. If it refuses, say why in one short line.",
    input: AskToPayInput,
    async run(args, ctx) {
      // The vote option's option_ref goes in as is; askToPay resolves it to the travel offer.
      const { asking, letGo } = run(ctx, { decisionId: args.decision_id, optionRef: args.option_ref, purpose: args.purpose, again: args.again === true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([asking, new Promise<typeof STILL_ASKING>((res) => (timer = setTimeout(() => res(STILL_ASKING), o.waitMs ?? IN_TURN_PAY_MS)))])
        .finally(() => clearTimeout(timer));
      if (r === STILL_ASKING) {
        letGo();
        return {
          pay_card: 'on its way',
          tell_the_room: 'Say in one short line that the pay card is on its way and shows up here in a moment. Never say it is up already, and never tell anyone to open Go: they are in it.',
        };
      }
      if ('cardId' in r) return { pay_card: r.cardId, tell_the_room: 'Say in one short line that the pay card is up for the payer, here in the chat.' };
      return { refused: r.refused, tell_the_room: SAY_THE_REFUSAL };
    },
  };
}

export function setMandateTool(run: SetRun): QuickTool<SetMandateInput> {
  return {
    name: 'set_mandate',
    description:
      'After a choice vote closes, record what the group allows: the winning option, who pays (for a stay, only the person who took it with I\'ll book it on Go\'s card, or who asks you to book it themselves: their ask is their claim; never pick the payer), whether only refundable rates are allowed, and cap_minor, the most to spend in paise, only when someone in the group said a number: "8k a head per night" is 8,000 rupees times the people times the nights, "8k a head" is 8,000 times the people, a plain "40k" is the total. When nobody said a clear number, leave cap_minor out: Go uses the price plus up to 10% and says so. Never invent a cap or a payer. The payer then taps Yes, book it on the card.',
    input: SetMandateInput,
    async run(args, ctx) {
      const r = await run(ctx, {
        decisionId: args.decision_id,
        choiceIndex: args.choice_index,
        ...(args.cap_minor !== undefined ? { capMinor: args.cap_minor } : {}),
        refundableOnly: args.refundable_only,
        payerPersonId: args.payer_person_id,
      });
      if (!('cardId' in r)) {
        return {
          refused: r.refused,
          tell_the_room: r.unbookable
            ? 'Say this in one short line, before anything about who pays: there is nothing to set up for paying for this option.'
            : r.parked
              ? 'It waits on the trip\'s ixigo login, whose card is already up asking for it, and Go carries on with it by itself once the login is in. ' +
                'Do what refused says: never ask for the login again, and never ask for a number or a code in the chat.'
              : r.claim
                ? 'The I\'ll book it card is up with your message. Say in one short line that whoever taps it books for everyone. Never pick who pays.'
                : SAY_THE_REFUSAL,
        };
      }
      return {
        mandate_card: r.cardId,
        tell_the_room: r.note
          ? `Say in one short line: ${r.note} Then that the payer taps Yes, book it.`
          : 'Say in one short line what was set and that the payer taps Yes, book it.',
      };
    },
  };
}
