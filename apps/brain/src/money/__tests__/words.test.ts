import { describe, expect, it } from 'vitest';
import { bookedLine, categoryFor, clip, declinedLine, failedLine, money, plain, refusalWords, shortDate, TOASTS, type RefusalCode } from '../words.js';

const CODES: RefusalCode[] = [
  'decision_not_found', 'decision_not_closed', 'no_mandate', 'payer_declined', 'payer_has_not_confirmed', 'currency_mismatch',
  'over_cap', 'not_refundable', 'approval_outstanding', 'no_vote', 'wrong_offer', 'not_bookable', 'not_bookable_yet', 'already_paid', 'no_travel',
  'hold_failed', 'rail_not_ready', 'vault_refused', 'server_down', 'closed',
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

  it('points to See on ixigo on the card for group flights, trains and buses, which Go does not book this week (master §9 "Cut now"), never a link', () => {
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'IndiGo 6E 2134', kind: 'flight', link: 'https://www.ixigo.com/flights/6e-2134' })).toEqual({
      text: "I can't book flights for the whole group yet. Each of you can book on ixigo: See on ixigo on its card opens it there.",
      say: true,
    });
    // No link from the travel layer: just the first sentence.
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'Rajdhani 12432', kind: 'train' }).text).toBe("I can't book trains for the whole group yet.");
    expect(refusalWords('not_bookable_yet', { payer: 'Rahul', what: 'Volvo sleeper', kind: 'bus' }).text).toBe("I can't book buses for the whole group yet.");
  });

  it('says what happened after a payment in one short line', () => {
    expect(bookedLine({ title: 'Villa Sol, 3 nights', payer: 'Rahul', amount: '₹54,200', people: 5 })).toBe(
      'Booked Villa Sol, 3 nights! Rahul paid ₹54,200, split between all 5.',
    );
    // A stay from ixigo.com, booked on Go's test rail only: the receipt says so, and never claims an ixigo booking.
    expect(bookedLine({ title: 'Saudades Homestays, 3 nights', payer: 'Rahul', amount: '₹47,682', people: 5, simulated: true })).toBe(
      "Booked (simulated): Saudades Homestays, 3 nights. Rahul's test payment of ₹47,682, split between all 5; nothing was booked on ixigo.",
    );
    expect(failedLine({ payer: 'Rahul', what: 'Villa Sol', reason: 'card_declined' })).toBe(
      "Rahul, the payment for Villa Sol didn't go through (the bank declined the card). Nothing was charged. Want to try again?",
    );
    expect(declinedLine('Villa Sol')).toBe('Holding off on Villa Sol for now.');
    expect(TOASTS.notPayer('Rahul')).toBe('Only Rahul can approve this payment.');
  });
});
