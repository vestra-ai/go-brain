import { describe, expect, it } from 'vitest';
import { bookedLine, categoryFor, clip, declinedLine, failedLine, money, plain, refusalWords, shortDate, TOASTS, type RefusalCode } from '../words.js';

const CODES: RefusalCode[] = [
  'decision_not_found', 'decision_not_closed', 'no_mandate', 'payer_declined', 'payer_has_not_confirmed', 'currency_mismatch',
  'over_cap', 'not_refundable', 'approval_outstanding', 'no_vote', 'wrong_offer', 'not_bookable', 'not_bookable_yet', 'already_paid', 'no_travel',
  'hold_failed', 'rail_not_ready', 'vault_refused', 'server_down', 'closed', 'not_in_trip', 'already_booked',
];

describe('money words', () => {
  it('writes rupees the Indian way, paise only when there are any', () => {
    expect(money(5420000, 'INR')).toBe('₹54,200');
    expect(money(1084000, 'INR')).toBe('₹10,840');
    expect(money(5420050, 'INR')).toBe('₹54,200.50');
    expect(money(150000000, 'INR')).toBe('₹15,00,000');
  });

  it('writes a short date in India time', () => {
    expect(shortDate('2026-11-01T18:29:59Z')).toBe('1 Nov');
  });

  // Keshav, 11 Oct: "make it a proper travel agent… why this whining": no offer to phone (calls are off), no "book on
  // ixigo yourself", no "ask me again".
  it('never pushes the work back: no phoning, no booking it yourself, no asking again', () => {
    const say = (code: RefusalCode, extra: { link?: string; kind?: string } = {}) => refusalWords(code, { payer: 'Rahul', what: 'Villa Sol', ...extra }).text;
    expect(say('not_bookable')).toBe('I found this one on the web, so it can\'t be booked through me. Want the closest ones on ixigo, which I can book?');
    expect(say('server_down')).toBe("I couldn't reach the trip just now, so nothing was charged. Want me to try again now?");
    for (const code of CODES) expect(say(code, { link: 'https://www.ixigo.com/x', kind: 'train' })).not.toMatch(/call them|yourself|ask me again/i);
  });

  it('takes em dashes out and cuts long text', () => {
    expect(plain('Villa Sol \u2014 3 nights, 6\u20139 Nov')).toBe('Villa Sol, 3 nights, 6 to 9 Nov');
    expect(clip('a'.repeat(130), 120)).toHaveLength(120);
  });

  it('maps every booking kind to a spending category', () => {
    expect(categoryFor('stay')).toBe('stay');
    expect(categoryFor('flight')).toBe('getting_around');
    expect(categoryFor('cab')).toBe('getting_around');
    expect(categoryFor('table')).toBe('food');
    expect(categoryFor('activity')).toBe('activities');
    expect(categoryFor('other')).toBe('other');
  });

  it('has a plain line for every refusal, without em dashes or card details', () => {
    for (const code of CODES) {
      const said = refusalWords(code, { payer: 'Rahul', what: 'Villa Sol', amount: '₹56,400', cap: '₹55,000' });
      expect(said.text.length, code).toBeGreaterThan(10);
      expect(said.text, code).not.toMatch(/\u2014|card number|cvv/i);
    }
    expect(refusalWords('over_cap', { payer: 'Rahul', what: 'Villa Sol', amount: '₹56,400', cap: '₹55,000' }).text).toBe(
      'Villa Sol is now ₹56,400, above the ₹55,000 the group allowed. Raise the cap or pick another option?',
    );
    expect(refusalWords('decision_not_found', { payer: 'Rahul', what: 'it' }).say).toBe(false);
  });

  it('points to View on ixigo in the details on the card for group flights, trains and buses, which Go does not book this week (master §9 "Cut now"), never a link', () => {
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'IndiGo 6E 2134', kind: 'flight', link: 'https://www.ixigo.com/flights/6e-2134' })).toEqual({
      text: "I can't book flights for the whole group yet. View on ixigo, in its details on its card, opens each one set up for you.",
      say: true,
    });
    // No link from the travel layer: just the first sentence.
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'Rajdhani 12432', kind: 'train' }).text).toBe("I can't book trains for the whole group yet.");
    // Where Go books each person's own flight (BOOKING), a group flight says how theirs is booked, never "book on ixigo".
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'IndiGo 6E 2134', kind: 'flight', link: 'https://www.ixigo.com/flights/6e-2134', own: true }).text).toBe(
      "Flights are each person's own, so there's no one payment for the group: each of you taps I'll take this on your own flights card, and I book it.",
    );
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'Volvo sleeper', kind: 'bus' }).text).toBe("I can't book buses for the whole group yet.");
  });

  it('says what happened after a payment in one short line, never the money, which the Server posts itself', () => {
    expect(bookedLine({ title: 'Villa Sol, 3 nights' })).toBe('Booked Villa Sol, 3 nights!');
    // A stay from ixigo.com, booked on Go's test rail only: the receipt says so, and never claims an ixigo booking.
    expect(bookedLine({ title: 'Saudades Homestays, 3 nights', simulated: true })).toBe(
      'Booked (simulated): Saudades Homestays, 3 nights. A test payment only; nothing was booked on ixigo.',
    );
    expect(failedLine({ payer: 'Rahul', what: 'Villa Sol', reason: 'card_declined' })).toBe(
      "Rahul, the payment for Villa Sol didn't go through (the bank declined the card). Nothing was charged. Want to try again?",
    );
    expect(declinedLine('Villa Sol')).toBe('Holding off on Villa Sol for now.');
    expect(TOASTS.notPayer('Rahul')).toBe('Only Rahul can approve this payment.');
  });
});
