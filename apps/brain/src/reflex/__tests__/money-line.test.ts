import { describe, expect, it } from 'vitest';
import { looksLikeMoney, saysMoneyMoved } from '../money-line.js';

describe('looksLikeMoney: a line that always reaches the model', () => {
  it.each([
    // The final drill's lines.
    'I paid 3,200 for the cab',
    'Rahul owes me 1,500',
    'paid something for the snacks',
    // Each verb, in its forms.
    'I owe Kabir for the tickets',
    'Arjun owed me for the cab',
    'still owing Priya for the boat',
    'spent a lot on snacks today',
    'gave Meher the cash for the boat',
    'transferred my share just now',
    'reimbursed Priya for the snacks',
    "I UPI'd Rahul my share",
    'UPI kar diya Rahul ko',
    'maine apna share bhej diya 🙌',
    'maine paise bhej diye',
    'Rahul ne de diya',
    'paise bheja hai check karo',
    'mujhe Priya ko dena hai',
    'Arjun se lena hai abhi',
    'udhaar hai mera tujhpe',
    // Amounts that are plainly money.
    '₹500 for parking',
    'rs 450 the auto',
    '500 rupees for the entry',
    'the villa costs 54k total',
    'about 2 lakh for everything',
    // The bench chats' own money lines.
    'agreed then, villa under 8k a head per night, final',
  ])('%s', (text) => {
    expect(looksLikeMoney(text)).toBe(true);
    expect(saysMoneyMoved(text) || /\d/.test(text)).toBe(true);
  });

  it.each([
    // Talk about who will pay: nothing moved and no amount, so nothing to record or ask about (goa-300 and goa-50).
    "Who's paying the villa advance? I can put it on my card",
    "Who's paying the villa advance? I can put it on my card and we settle later",
    'yes Rahul pays the advance, we UPI him',
    "yes Rahul pays, we'll UPI him",
    "Kabir you're not drinking right? So we split the bar bill only 4 ways",
    'do we need cash or is UPI fine everywhere?',
    'kitna paisa lagega total roughly?',
    'I pay for the fuel, you get dinner',
    // Other words that only look like money.
    'pay attention guys, the flight is at 6',
    'payday is on the 30th 🎉',
    'PayPal is down again lol',
    'is the airport transfer included?',
    "we're 5 people",
    "I'm veg btw",
    'my flight lands at 9:40 pm on Friday',
    "North for sure, I'm in",
    'payment page is slow lol',
    'see you at 6',
    '',
  ])('not money: %s', (text) => {
    expect(looksLikeMoney(text)).toBe(false);
  });

  it('reads no text as not money', () => {
    expect(looksLikeMoney(null)).toBe(false);
    expect(saysMoneyMoved(null)).toBe(false);
  });
});

describe('saysMoneyMoved: a line for record_expense, not a price or a budget', () => {
  it('is true where money moved or is owed, and false for an amount alone', () => {
    expect(saysMoneyMoved('I paid 3,200 for the cab')).toBe(true);
    expect(saysMoneyMoved('Rahul owes me 1,500')).toBe(true);
    expect(saysMoneyMoved('maine paise bhej diye')).toBe(true);
    expect(saysMoneyMoved('agreed then, villa under 8k a head per night, final')).toBe(false);
    expect(saysMoneyMoved('the villa costs 54k total')).toBe(false);
  });
});
