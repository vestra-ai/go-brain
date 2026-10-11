import { z } from 'zod';

/**
 * Ids are opaque strings. The Server mints trip, person, message, decision, booking, expense and
 * record line ids. Go mints card, task, call, approval-request and fact ids.
 */
export const Id = z.string().min(1).max(64);

/**
 * The trip's change number. The Server adds one for every change it makes to a trip (a message, a
 * reaction, a vote, a booking...) and stamps it on the event it sends. Go uses it to notice
 * a missed event: if it holds 41 and receives 43, it reads the trip again.
 */
export const Seq = z.int().positive();

/** Money is always a whole number in the smallest unit (paise for INR). Never a float. */
export const AmountMinor = z.int().nonnegative();
/** An amount that must be more than zero (a cap, a payment, an expense). */
export const PositiveAmountMinor = z.int().positive();
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. INR');

/** Times carry their offset. Send UTC with a Z when you can. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();

/** Links are http or https only, so nothing like javascript: can reach the App. */
export const HttpUrl = z.url({ protocol: /^https?$/ });
/** 1.3: a link that must be https: a page the App opens or frames (an option's ixigo page, Go's live view). */
export const HttpsUrl = z.url({ protocol: /^https$/ });
/** 1.1: a link the App opens: http or https, or go:// for one of the App's own screens (the guide's route table). */
export const AppUrl = z.url({ protocol: /^(https?|go)$/ });

/** One spending category system across the itinerary, bookings and the budget. */
export const Category = z
  .enum(['stay', 'food', 'getting_around', 'activities', 'other'])
  .meta({ id: 'Category', description: 'The spending category. The App colours: stay blue, food orange, getting around green, activities yellow.' });

/** Who did something: a person, Go, or the Server itself. */
export const Actor = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), person_id: Id }).meta({ id: 'PersonActor' }),
    z.object({ kind: z.literal('go') }).meta({ id: 'GoActor' }),
    z.object({ kind: z.literal('system') }).meta({ id: 'SystemActor' }),
  ])
  .meta({ id: 'Actor', discriminator: { propertyName: 'kind' }, description: 'Who did it: a person, Go, or the Server itself (system).' });
export type Actor = z.infer<typeof Actor>;

/** 10 Oct B3: a photo and what it shows ("Deluxe room", "Pool"), when the source says. */
export const Photo = z
  .object({ url: HttpUrl, label: z.string().min(1).max(40).nullish() })
  .meta({ id: 'Photo' });
export type Photo = z.infer<typeof Photo>;

/** A place, as Go found it. `place_id` is a Google Places id when Go has one. */
export const Place = z
  .object({
    name: z.string().min(1).max(120),
    place_id: z.string().max(256).nullish(),
    address: z.string().max(200).nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    photo_url: HttpUrl.nullish(),
    /** 10 Oct B3: more photos, labelled, first one first. photo_url stays the cover. */
    photos: z.array(Photo).max(12).nullish(),
    /** 1.1: the place's IANA time zone, e.g. "Asia/Kolkata", so times there read in local time. */
    timezone: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/, 'an IANA time zone, e.g. Asia/Kolkata').nullish(),
  })
  .meta({ id: 'Place' });
export type Place = z.infer<typeof Place>;

/** A flight, train, bus or cab leg. */
export const Journey = z
  .object({
    mode: z.enum(['flight', 'train', 'bus', 'cab']),
    /** Where it leaves from, e.g. { "name": "Delhi", "code": "DEL" }. */
    origin: z.object({ name: z.string().min(1).max(80), code: z.string().max(8).nullish() }),
    /** Where it arrives. */
    destination: z.object({ name: z.string().min(1).max(80), code: z.string().max(8).nullish() }),
    depart_at: IsoDateTime,
    arrive_at: IsoDateTime,
    carrier_name: z.string().max(60).nullish(),
    carrier_code: z.string().max(8).nullish(),
    /** Flight, train or bus number, e.g. 6E 2134. */
    number: z.string().max(20).nullish(),
    logo_url: HttpUrl.nullish(),
    stops: z.int().nonnegative().nullish(),
  })
  .meta({ id: 'Journey' });
export type Journey = z.infer<typeof Journey>;
