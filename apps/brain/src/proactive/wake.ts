// How something Go noticed reads in "why Go woke", and the "openings" block with this turn's rules.
import type { NowProvider } from '../composer/context.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import { rulesForTurn } from './allowed.js';
import { localWhen } from './clock.js';
import { fromPayload, proactiveOf } from './payload.js';
import type { Action, Candidate } from './policy.js';
import { namesOf, quote, rupees } from './words.js';

const H = 3600_000;

function inAbout(at: Date, now: Date): string {
  const h = Math.round((at.getTime() - now.getTime()) / H);
  if (h <= 1) return 'within the hour';
  if (h < 48) return `in about ${h} hours`;
  return `in about ${Math.round(h / 24)} days`;
}

/** How late, as a friend says it: "2 hours", "1 hour 30 minutes", "45 minutes". */
export function howLate(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h === 0 ? '' : h === 1 ? '1 hour' : `${h} hours`, m === 0 ? '' : m === 1 ? '1 minute' : `${m} minutes`].filter((x) => x !== '').join(' ');
}

function ago(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** What Go noticed, in plain words. People's text and names from the trip are quoted as data. */
export function describeNoticed(c: Candidate, pack: TripPack, tz: string, now: Date): string {
  const trip = pack.trip;
  const f = c.facts;
  const str = (k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const num = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
  const at = (k: string): Date | null => {
    const t = Date.parse(str(k));
    return Number.isNaN(t) ? null : new Date(t);
  };
  const who = (ids: string[]): string => namesOf(ids, trip.people);
  const decision = trip.decisions.find((d) => d.decision_id === str('decision_id'));
  const booking = trip.bookings.find((b) => b.booking_id === str('booking_id'));

  switch (c.topic) {
    case 'vote_closing': {
      const closes = at('closes_at');
      const when = closes ? ` closes ${localWhen(closes, tz)} (${inAbout(closes, now)})` : ' closes soon';
      const missing = c.personIds.length > 0
        ? ` Not voted yet: ${who(c.personIds)}.`
        : decision ? ` ${decision.of - decision.voted} people have not voted yet.` : '';
      return `The vote ${quote(decision?.question ?? 'on the table')}${when}.${missing}`;
    }
    case 'payer_waiting':
      return `${who(c.personIds)} has not tapped "Yes, book it" on ${quote(decision?.question ?? 'the vote')} for a day.`;
    case 'free_cancel': {
      const until = at('refundable_until');
      const money = booking ? ` After that the ${rupees(booking.amount_minor)} is not refunded.` : '';
      return `Free cancellation on ${quote(booking?.title ?? 'a booking')} ends ${until ? `${localWhen(until, tz)} (${inAbout(until, now)})` : 'soon'}.${money}`;
    }
    case 'travel_day':
      return `Tomorrow (${str('start')}) is travel day. The group may want the plan for the day: who leaves when, and what is booked.`;
    case 'settle_up': {
      // The Server's balances as they are now: a payback someone recorded and the one paid confirmed (1.1
      // settlement.recorded, which makes Go read the trip again) is gone from them, so that pair is never nudged.
      const open = trip.money.transfers.map((x) => `${who([x.from_person_id])} to ${who([x.to_person_id])} ${rupees(x.amount_minor)}`);
      return `The trip is over and ${open.length} payments are still open in settle-up: ${open.join('; ')}. Remind only these.`;
    }
    case 'flight_status': {
      // Facts use P4's status words (state, delayMinutes, expectedDepartAt); the demo's fire adds arriveAt and a note.
      const delay = num('delayMinutes');
      const cancelled = str('state') === 'cancelled';
      const late = !cancelled && delay !== null && delay > 0 ? howLate(delay) : null;
      const state = cancelled ? 'is cancelled' : late ? `is running ${late} late` : 'is back on time';
      const leaves = cancelled ? null : at('expectedDepartAt');
      const lands = cancelled ? null : at('arriveAt');
      const when = `${leaves ? `, now leaving ${localWhen(leaves, tz)}` : ''}${lands ? `, now landing ${localWhen(lands, tz)}` : ''}`;
      const checked = str('checkedAt') ? ` (checked ${ago(str('checkedAt'), now)})` : '';
      const note = str('note') ? ` Also: ${quote(str('note'), 200)}` : '';
      const concerns = c.personIds.length > 0 ? ` It concerns ${who(c.personIds)}.` : '';
      // How it reads: a friend's heads-up, what changes for them and the one next step, never a status alert (the
      // demo's 3:40 read "your flight is about 120 minutes behind… It may be worth moving the pickup later").
      const moves = lands
        ? ` (anything in the note set around the old time has to fit the new landing, ${localWhen(lands, tz)})`
        : late ? ` (anything in the note set around the old time moves by ${late} too)` : '';
      const how = c.personIds.length > 0
        ? ` Write it as a friend's heads-up to ${who(c.personIds)}: their name first, what changed in plain words${lands ? ' and when they now land' : ''}, then what it changes for them${moves}, and the one next step as a question with the new time, using only what the flight and the note say (for example "Want me to move your cab to 11 pm?"). Say hours, not minutes, and never "flight status" or "it may be worth".`
        : '';
      return `${quote(str('label') || 'A flight')} ${state}${when}${checked}.${note}${concerns}${how}`;
    }
    case 'pnr_status': {
      const what = str('label') ? ` ${quote(str('label'))}` : '';
      const state = str('state') === 'cancelled' ? 'is cancelled' : str('state') === 'confirmed' ? 'is now confirmed' : `is ${str('state') || 'changed'}`;
      const detail = str('detail') ? ` (${quote(str('detail'), 80)})` : '';
      const checked = str('checkedAt') ? ` (checked ${ago(str('checkedAt'), now)})` : '';
      const concerns = c.personIds.length > 0 ? ` It concerns ${who(c.personIds)}.` : '';
      return `The train ticket${what} ${state}${detail}${checked}.${concerns}`;
    }
    case 'chat':
      // A friend in the group chiming in, once, when it adds something real (Keshav: "whenever it can intervene it should").
      return (
        `Message #${num('seq') ?? '?'} may be a moment to chime in without being asked. Say one short line, in the group's own words and language, ` +
        'only when it adds something real: a question to the group that the trip already answers (answer it and offer to change it: ' +
        '"Dates are set: 6 to 9 Nov ✅. Want to change them?"); something someone needs that you will keep to (say so in a few words: ' +
        '"Veg noted, I\'ll skip seafood shacks"); a choice the group is ready to make (offer a vote: "3 of you said yes to Saudades. Want me to put it to a vote?"); ' +
        'or a search someone asked the group to run (offer to run it). The examples show the shape only: use what the trip and the chat say. ' +
        'Banter, a plan a person is already handling, or nothing new to add: call stay_silent.'
      );
    case 'vote_closed': {
      const winner = str('winner');
      return `The vote ${quote(str('question') || 'on the table')} closed${winner ? `; ${quote(winner)} won` : ' without a clear winner'}. The group may want the next step.`;
    }
    case 'booking_cancelled': {
      const by = str('by');
      return `${quote(str('title') || 'A booking')} was cancelled${by ? ` by ${who([by])}` : ''}.`;
    }
    case 'dates_clash':
      return `The trip dates are now ${str('start')} to ${str('end')}, but ${quote(str('title') || 'a booking')} starts ${str('starts_at').slice(0, 10)}${str('ends_at') ? ` and ends ${str('ends_at').slice(0, 10)}` : ''}.`;
    case 'recipe_watch': {
      // A watch the group asked for came true: what ixigo shows now, and its page.
      const asker = c.personIds.length > 0 ? who(c.personIds) : 'The group';
      const checked = str('checkedAt') ? ` (checked ${ago(str('checkedAt'), now)})` : '';
      const page = str('page') ? ` Its ixigo page: ${quote(str('page'), 300)}.` : '';
      return `${asker} asked Go to watch ixigo for ${quote(str('label') || 'this')}, and it came true${checked}: ${quote(str('what'), 400)}.${page} Tell them in one short message, naming who asked, and put it on a notice card (source ixigo).`;
    }
    case 'recipe_watch_stopped': {
      const asker = c.personIds.length > 0 ? who(c.personIds) : 'the group';
      return `Go could not check ixigo for ${quote(str('label') || 'the watch')} ${num('tries') ?? 6} times in a row, so it stopped watching. Tell ${asker} in one short line, and offer to watch again later.`;
    }
    default:
      return `Go noticed: ${quote(JSON.stringify(f), 300)}.`;
  }
}

const ACTION_WORDS: Readonly<Record<Action, string>> = {
  react: 'a quiet reaction (react)',
  record: 'a line in the trip record (record)',
  update_card: 'updating the notice Go posted earlier (update_notice)',
  pin: 'a notice card pinned only for the people it concerns (post_notice with for_person_ids)',
  message: 'one short message to the group',
};

export function renderWake(item: DeskItem, pack: TripPack, now: Date): string {
  const p = proactiveOf(item);
  if (!p) return 'Go noticed something, but its details could not be read. Call stay_silent.';
  const c = fromPayload(p.candidate);
  const lead = c.simulated ? 'Simulated for the demo. ' : '';
  const allowed = p.allowed.map((a) => ACTION_WORDS[a]).join('; ');
  const pin = p.allowed.includes('pin') && p.forPersonIds.length > 0
    ? ` Pin it only for ${namesOf(p.forPersonIds, pack.trip.people)}: for_person_ids ${JSON.stringify(p.forPersonIds)}.`
    : '';
  const notice = p.allowed.includes('update_card') && typeof c.facts.noticeCardId === 'string'
    ? ` The earlier notice is card_id ${JSON.stringify(c.facts.noticeCardId)}.`
    : '';
  const loud = p.allowed.includes('message') ? ' At most one short message.' : ' Do not post a message to everyone.';
  // A watch the group asked for is Go answering them, later: never "nobody asked".
  const why = c.asked === true ? 'Go is answering an ask from earlier' : 'Go noticed this itself, nobody asked';
  return `${lead}${why}: ${describeNoticed(c, pack, p.tz, now)} Allowed: ${allowed}.${pin}${notice}${loud} Suggest, never act.`;
}

export const OPENINGS_ORDER = 60;

export function openingsNow(): NowProvider {
  return {
    name: 'openings',
    order: OPENINGS_ORDER,
    async render(_tripId: string, wake: DeskItem[]): Promise<string | null> {
      if (!wake.some((i) => proactiveOf(i) !== null)) return null;
      const rules = rulesForTurn(wake);
      if (!rules) {
        return 'Someone in the group woke Go as well, so the normal rules apply. What Go noticed itself may ride along in the same short reply if it fits; never a separate message for it.';
      }
      return [
        'Go is speaking up on its own this turn. Rules for this turn:',
        `- Tools you may use: ${rules.tools.join(', ')}.`,
        rules.mayPostText ? '- You may post one short message.' : '- Do not post a text message.',
        '- Suggest, never act: offer ("Want me to move it?"). Never book, pay, cancel, start a task or call anyone on your own.',
        '- If nothing allowed fits, call stay_silent.',
      ].join('\n');
    },
  };
}
