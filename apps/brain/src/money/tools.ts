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

type AskRun = (ctx: TurnCtx, o: { decisionId: string; optionRef: string; purpose: string }) => Promise<AskResult>;
type SetRun = (
  ctx: TurnCtx,
  o: { decisionId: string; choiceIndex: number; capMinor?: number; refundableOnly: boolean; payerPersonId: string },
) => Promise<{ cardId: string; capMinor: number; byMargin: boolean; note: string | null } | { refused: string; unbookable?: true; parked?: true }>;

export function askToPayTool(run: AskRun): QuickTool<AskToPayInput> {
  return {
    name: 'ask_to_pay',
    description:
      "Ask the payer to approve paying for what the group voted for. Works only after the vote closed, the mandate is set and the payer tapped Yes, book it; option_ref is the winning option's ref from the vote, exactly as Payments in right now gives it. It checks the live price, gets the Server's approval and puts a pay card the payer approves with Face ID. You never pay, never ask for card details and never offer another way to pay. If it refuses, say why in one short line.",
    input: AskToPayInput,
    async run(args, ctx) {
      // The vote option's option_ref goes in as is; askToPay resolves it to the travel offer.
      const r = await run(ctx, { decisionId: args.decision_id, optionRef: args.option_ref, purpose: args.purpose });
      if ('cardId' in r) return { pay_card: r.cardId, tell_the_room: 'Say in one short line that the pay card is up for the payer.' };
      return { refused: r.refused, tell_the_room: SAY_THE_REFUSAL };
    },
  };
}

export function setMandateTool(run: SetRun): QuickTool<SetMandateInput> {
  return {
    name: 'set_mandate',
    description:
      'After a choice vote closes, record what the group allows: the winning option, who pays (the organizer or the person the group named in the chat), whether only refundable rates are allowed, and cap_minor, the most to spend in paise, only when someone in the group said a number: "8k a head per night" is 8,000 rupees times the people times the nights, "8k a head" is 8,000 times the people, a plain "40k" is the total. When nobody said a clear number, leave cap_minor out: Go uses the price plus up to 10% and says so. Never invent a cap or a payer. The payer then taps Yes, book it on the card.',
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
              ? 'It waits on the trip\'s ixigo login, and Go carries on with it by itself once the login is in. Do what refused says, and never ask for a number or a code in the chat.'
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
