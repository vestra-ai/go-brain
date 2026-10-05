import { z } from 'zod';
import { HttpUrl, Id, IsoDateTime } from './common.js';

/**
 * The bodies of the calls go-server makes to go-brain (go-brain serves them under /v1), besides
 * events. These are questions that need an answer straight away, so go-brain answers within the
 * time limits in the guide.
 */

export const EventAccepted = z
  .object({
    accepted: z.literal(true),
    /** True when go-brain had already seen this event_id. Still a success. */
    duplicate: z.boolean(),
  })
  .meta({ id: 'EventAccepted' });

/** Someone tapped a button on a Go card. */
export const CardActionRequest = z
  .object({
    action_id: z.string().regex(/^[a-z][a-z_]{0,31}$/),
    person_id: Id,
    /** Set when the button was on one option of an options card. */
    option_id: Id.nullish(),
  })
  .meta({ id: 'CardActionRequest' });

/** Done. Show the toast, if any. Go follows up in the room. */
export const ActionDone = z.object({ result: z.literal('done'), toast: z.string().max(120).nullish() }).meta({ id: 'ActionDone' });
/** Open this page in the system browser sheet (the vault, or watching Go work). */
export const ActionOpen = z.object({ result: z.literal('open'), url: HttpUrl, expires_at: IsoDateTime }).meta({ id: 'ActionOpen' });
/** Not allowed or no longer possible. Show the toast. */
export const ActionRefused = z.object({ result: z.literal('refused'), toast: z.string().min(1).max(120) }).meta({ id: 'ActionRefused' });

export const CardActionResult = z
  .discriminatedUnion('result', [ActionDone, ActionOpen, ActionRefused])
  .meta({ id: 'CardActionResult', discriminator: { propertyName: 'result' } });

/** Someone opened the room after a while. What did they miss? */
export const CatchUpRequest = z.object({ person_id: Id, since: IsoDateTime }).meta({ id: 'CatchUpRequest' });
export const CatchUp = z
  .object({
    /** One sentence in Go's voice, or null when nothing much happened. */
    summary: z.string().max(200).nullish(),
    items: z
      .array(
        z.object({
          kind: z.enum(['decided', 'booked', 'needs_you', 'open', 'news']),
          text: z.string().min(1).max(140),
          image_url: HttpUrl.nullish(),
          /** Jump to this message when tapped. */
          message_id: Id.nullish(),
        }),
      )
      .max(5),
  })
  .meta({ id: 'CatchUp', description: 'For one person only. Shown above the room, never posted in it.' });

/** One thing Go knows about a person, with where it came from. */
export const Fact = z
  .object({
    fact_id: Id,
    /** What it is about, e.g. "food", "flights", "sleep". One current fact per topic per person. */
    topic: z.string().min(1).max(40),
    text: z.string().min(1).max(200),
    trip_id: Id,
    /** The message it came from. Null when it came from a join answer. */
    message_id: Id.nullish(),
    said_at: IsoDateTime,
  })
  .meta({ id: 'Fact' });

/** "What Go knows about you". */
export const PersonPage = z
  .object({
    person_id: Id,
    /** When on, what they told Go carries into their next trips. Off by default. */
    carry_over: z.boolean(),
    facts: z.array(Fact).max(500),
  })
  .meta({ id: 'PersonPage' });

export const UpdatePerson = z.object({ carry_over: z.boolean() }).meta({ id: 'UpdatePerson' });
export const Ok = z.object({ ok: z.literal(true) }).meta({ id: 'Ok' });

export const ForgetResult = z
  .object({
    deleted_facts: z.int().nonnegative(),
    /** Always 0: go-brain checks that nothing is left before it answers. */
    remaining_facts: z.literal(0),
  })
  .meta({ id: 'ForgetResult' });

/** A short-lived link to one of go-brain's pages, opened from the app's You screen. */
export const CreateLink = z
  .object({
    kind: z.enum(['vault']),
    person_id: Id,
    /** Which part of the vault to open. */
    start: z.enum(['home', 'add_card', 'add_login']).nullish(),
  })
  .meta({ id: 'CreateLink' });
export const Link = z.object({ url: HttpUrl, expires_at: IsoDateTime }).meta({ id: 'Link' });

export const Health = z.object({ ok: z.literal(true), contract: z.string() }).meta({ id: 'Health' });
