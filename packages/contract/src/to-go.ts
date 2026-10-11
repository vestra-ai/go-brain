import { z } from 'zod';
import { AppUrl, HttpUrl, Id, IsoDateTime, Place } from './common.js';

/**
 * Your requests: what the Server asks Go over the socket. Events tell Go what happened;
 * the rest are questions that need an answer straight away, within the time limits in the guide.
 */

export const EventAccepted = z
  .object({
    accepted: z.literal(true),
    /** True when Go had already seen this event_id. Still a success. */
    duplicate: z.boolean(),
  })
  .meta({ id: 'EventAccepted' });

/** Someone tapped a button on a Go card. */
export const CardTap = z
  .object({
    /** The Server's id for this tap. Go acts on each tap once, even if it arrives twice (a resend after a reconnect, or a double tap). */
    tap_id: Id,
    trip_id: Id,
    card_id: Id,
    action_id: z.string().regex(/^[a-z][a-z_]{0,31}$/),
    person_id: Id,
    /** Set when the button was on one option of an options card. */
    option_id: Id.nullish(),
    /** 1.1: what the tapper chose on the button's sheet: one way or the round trip, on an option with both prices (sent with pick). */
    payload: z.object({ trip: z.enum(['oneway', 'round']) }).meta({ id: 'CardTapPayload' }).nullish(),
  })
  .meta({ id: 'CardTap' });

/** Done. Show the toast, if any. Go follows up in the room. */
export const ActionDone = z.object({ result: z.literal('done'), toast: z.string().max(120).nullish() }).meta({ id: 'ActionDone' });
/**
 * Open this page in the system browser sheet (the vault, or watching Go work). 1.1: or one of the App's own screens,
 * by a go:// link from the guide's route table, which the App opens in place.
 */
export const ActionOpen = z.object({ result: z.literal('open'), url: AppUrl, expires_at: IsoDateTime }).meta({ id: 'ActionOpen' });
/** Not allowed or no longer possible. Show the toast. */
export const ActionRefused = z.object({ result: z.literal('refused'), toast: z.string().min(1).max(120) }).meta({ id: 'ActionRefused' });

export const CardActionResult = z
  .discriminatedUnion('result', [ActionDone, ActionOpen, ActionRefused])
  .meta({ id: 'CardActionResult', discriminator: { propertyName: 'result' } });

/** Someone opened the room after a while. What did they miss? */
export const CatchUpRequest = z.object({ trip_id: Id, person_id: Id, since: IsoDateTime }).meta({ id: 'CatchUpRequest' });
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

export const GetPerson = z.object({ person_id: Id }).meta({ id: 'GetPerson' });
export const UpdatePerson = z.object({ person_id: Id, carry_over: z.boolean() }).meta({ id: 'UpdatePerson' });
export const DeleteFact = z.object({ person_id: Id, fact_id: Id }).meta({ id: 'DeleteFact' });
/** Forget me. With trip_id: what Go learned in that trip. Without: everything, in every trip. */
export const ForgetPerson = z.object({ person_id: Id, trip_id: Id.nullish() }).meta({ id: 'ForgetPerson' });
export const Ok = z.object({ ok: z.literal(true) }).meta({ id: 'Ok' });

export const ForgetResult = z
  .object({
    deleted_facts: z.int().nonnegative(),
    /** Always 0: Go checks that nothing is left before it answers. */
    remaining_facts: z.literal(0),
  })
  .meta({ id: 'ForgetResult' });

/** A short-lived link to one of Go's pages, opened from the App's You screen. */
export const CreateLink = z
  .object({
    kind: z.enum(['vault']),
    person_id: Id,
    /** Which part of the vault to open. 1.1 adds add_documents (Go answers "not available yet" in 1.1). */
    start: z.enum(['home', 'add_card', 'add_login', 'add_documents']).nullish(),
    /** 1.1: what the link is for: the trip, and what the documents are for. */
    context: z.object({ trip_id: Id, purpose: z.enum(['visa']).nullish() }).meta({ id: 'LinkContext' }).nullish(),
    /**
     * 1.3 (rev 5 R8): where the App opens it. sheet (the default): the system browser sheet. embedded: inside the App, where
     * the page allows framing only by the App's origins and posts { type: "go-vault", status: "saved" | "cancelled" |
     * "failed" } to its parent when done. embedded is for start home only: card and login entry stay in the sheet, and Go
     * answers any other start embedded with 409 conflict.
     */
    display: z.enum(['sheet', 'embedded']).nullish(),
  })
  .meta({ id: 'CreateLink' });
export const Link = z.object({ url: HttpUrl, expires_at: IsoDateTime }).meta({ id: 'Link' });

export const Health = z.object({ ok: z.literal(true), contract: z.string() }).meta({ id: 'Health' });

/** 1.3 (rev 5 R6): what a place is like, for the ideas on the home screen. The Server asks at most once a day per idea. */
export const PlaceInfoRequest = z
  .object({ name: z.string().min(1).max(120), from_city: z.string().min(1).max(120).nullish() })
  .meta({ id: 'PlaceInfoRequest' });
export const PlaceInfo = z
  .object({
    /** The place with its photos (6 to 12 when Go has them) and where it is. */
    place: Place,
    /** One short line, e.g. "High-altitude road trip". */
    tag: z.string().min(1).max(80).nullish(),
    /** The usual way there from from_city, and how long it takes. */
    travel: z
      .object({ mode: z.enum(['flight', 'train', 'bus', 'cab', 'drive']), duration_minutes: z.int().positive() })
      .meta({ id: 'PlaceTravel' })
      .nullish(),
    /** The best months to go, 1 to 12. */
    best_months: z.array(z.int().min(1).max(12)).max(12).nullish(),
    /** Absent or true: the whole answer. false: partial (photos still coming): don't keep it, and ask again later. */
    complete: z.boolean().nullish(),
  })
  .meta({ id: 'PlaceInfo' });

/** 1.3 (rev 5 R9): asked when a person opens an option's Details. The Server keeps the answer an hour per option. */
export const GetOptionDetails = z
  .object({ trip_id: Id, card_id: Id, option_id: Id, person_id: Id })
  .meta({ id: 'GetOptionDetails' });
