import { describe, expect, it } from 'vitest';
import { looksLikeMoney } from '../money-line.js';

describe('looksLikeMoney: a line that always reaches the model', () => {
  it.each([
    // The final drill's lines.
    'I paid 3,200 for the cab',
    'Rahul owes me 1,500',
    'paid something for the snacks',
    // Each verb.
    'I pay for the fuel, you get dinner',
    'I owe Kabir for the tickets',
    'spent a lot on snacks today',
    'gave Meher the cash for the boat',
    'transferred my share just now',
    'maine apna share bhej diya 🙌',
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
  ])('%s', (text) => {
    expect(looksLikeMoney(text)).toBe(true);
  });

  it.each([
    "we're 5 people",
    "I'm veg btw",
    'my flight lands at 9:40 pm on Friday',
    'North for sure, I\'m in',
    'payment page is slow lol',
    'see you at 6',
    '',
  ])('not money: %s', (text) => {
    expect(looksLikeMoney(text)).toBe(false);
  });

  it('reads no text as not money', () => {
    expect(looksLikeMoney(null)).toBe(false);
  });
});
