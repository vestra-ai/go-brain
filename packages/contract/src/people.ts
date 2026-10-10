import { z } from 'zod';
import { AmountMinor, Currency, HttpUrl, Id, IsoDateTime, PositiveAmountMinor } from './common.js';

/**
 * A person in a trip. `person_id` is the Server's id for the human and stays the same across every
 * trip they join, so Go can recognise them next time (if they allow it). There is no separate
 * per-trip member id.
 *
 * Go never receives contact details (phone, email) or anyone's own budget answer.
 */
export const Person = z
  .object({
    person_id: Id,
    name: z.string().min(1).max(80),
    photo_url: HttpUrl.nullish(),
    role: z.enum(['organizer', 'member']),
    joined_at: IsoDateTime,
    /** Where they travel from, in their words or a city chip, e.g. "Delhi". */
    from_city: z.string().max(60).nullish(),
    /** The earliest they can leave, in their words or a chip, e.g. "Fri after 6 pm". */
    earliest_leave: z.string().max(60).nullish(),
    /** Their "anything Go should know" answers, as plain words. The group can see these. */
    know: z.array(z.string().min(1).max(80)).max(20),
    /** True when they have a UPI id saved, so friends can pay them back. The id itself stays in the Server. */
    has_upi: z.boolean(),
    /**
     * True when they paused Go. While paused, the Server still sends their messages (so the change
     * numbers stay in order) but with `withheld: true` and no words or attachments.
     */
    go_paused: z.boolean(),
  })
  .meta({ id: 'Person' });
export type Person = z.infer<typeof Person>;

/** A spending band. `max_minor` is null for an open top band such as "25k+". */
export const BudgetBand = z
  .object({ min_minor: AmountMinor, max_minor: AmountMinor.nullish(), currency: Currency })
  .meta({ id: 'BudgetBand' });
export type BudgetBand = z.infer<typeof BudgetBand>;

/**
 * The trip's budget as Go may see it: only the lowest band anyone picked, and how many have
 * answered. Never who picked what, so Go cannot let it slip.
 *
 * 1.1 (10 Oct): people no longer answer privately. A trip has one optional budget per person, the
 * group's, set in the App or by Go (`update_trip.budget_per_person_minor`). When it is set,
 * `per_person_minor` has it, and the rest reads as everyone answering that one amount.
 */
export const BudgetSummary = z
  .object({
    /** Per person, stay plus food, flights separate. Null until someone answers. */
    lowest: BudgetBand.nullish(),
    answered: z.int().nonnegative(),
    of: z.int().nonnegative(),
    /** 1.1: the group's budget per person, in the trip's currency. Absent when none is set. */
    per_person_minor: PositiveAmountMinor.nullish(),
  })
  .meta({ id: 'BudgetSummary' });
