// call_business: the composer's quick tool for a phone call. It only posts Go's line and starts the 30 s
// window; the call service does the rest.
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../composer/tools.js';
import type { CallService } from './service.js';

export const CallBusinessArgs = z.object({
  business: z.string().min(1).max(80),
  phone: z.string().min(5).max(32).optional(),
  goal: z.string().min(1).max(160),
  announce: z.string().min(1).max(300),
  facts_allowed: z.array(z.string().min(1).max(200)).max(10).default([]),
});
export type CallBusinessArgs = z.infer<typeof CallBusinessArgs>;

export function callTool(service: CallService): QuickTool<CallBusinessArgs> {
  return {
    name: 'call_business',
    description:
      'Phone a business for the group (a hotel about check-in, a cab about a pickup) and talk to them live. Only names under "Go can phone" work. Write announce as one short line saying who you will call and why; Go adds the 30 second stop notice and calls if nobody says stop. facts_allowed lists the only things the call may share. Never use it to pay. Afterwards, say nothing more about the call this turn.',
    input: CallBusinessArgs,
    async run(args: CallBusinessArgs, ctx: TurnCtx): Promise<unknown> {
      const r = await service.request(ctx.tripId, ctx.pack, {
        callId: ctx.stableId('call'),
        business: args.business,
        phone: args.phone,
        goal: args.goal,
        announce: args.announce,
        factsAllowed: args.facts_allowed,
      });
      if ('refused' in r) return { refused: r.refused, tell_the_room: 'Say this in your own short words.' };
      return { ok: true, call_id: r.callId, note: 'Posted the call line. Say nothing more about the call now: end the turn with no text.' };
    },
  };
}
