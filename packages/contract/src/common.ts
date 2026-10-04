import { z } from 'zod';

/** Ids are opaque strings minted by go-server (trips, members, messages, decisions...). */
export const Id = z.string().min(1).max(64);

/** Money is always an integer in minor units (paise for INR), never a float. */
export const AmountMinor = z.int().nonnegative();
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. INR');

export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();
