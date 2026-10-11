/**
 * Who a turn's ask is from, and whether it is for them alone. "Book my flights" is the asker's own; only "everyone's
 * flights", "our flights" or "for us" fans out to the trip (p2's re-audit of Keshav's Varkala trip, 11 Oct: his "Book my
 * flights" searched for all five, and fifteen people who never asked got "I couldn't load your flights").
 */
import type { TurnCtx } from '../composer/tools.js';

const MINE = /\b(?:my|mine|myself)\b|\bfor me\b/i;
const OURS = /\b(?:our|ours|us|we|everyone|everyone's|everybody|everybody's|each of us|all of us)\b/i;

/** An ask for the asker's own: "my", "mine" or "for me", and nothing that names the group. */
export const asksForOwn = (text: string): boolean => MINE.test(text) && !OURS.test(text);

/** The person whose message woke the turn, and whether they asked for their own; null when no person's message did. */
export function askedBy(ctx: Pick<TurnCtx, 'wake' | 'pack'>): { personId: string; own: boolean } | null {
  for (const item of ctx.wake) {
    if (item.kind !== 'message') continue;
    const id = (item.payload as { messageId?: string } | null)?.messageId ?? item.ref;
    const m = ctx.pack?.messages.find((x) => x.message_id === id);
    if (m?.author.kind === 'person') return { personId: m.author.person_id, own: asksForOwn(m.text ?? '') };
  }
  return null;
}
