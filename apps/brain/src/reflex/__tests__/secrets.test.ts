import { describe, expect, it } from 'vitest';
import { CARD_HIDDEN, HIDDEN, hasSecret, luhnOk, maskSecrets, secretKinds } from '../secrets.js';

describe('luhnOk', () => {
  it('accepts test cards and rejects near misses and non-digits', () => {
    expect(luhnOk('4111111111111111')).toBe(true);
    expect(luhnOk('5555555555554444')).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(luhnOk('')).toBe(false);
    expect(luhnOk('abc')).toBe(false);
  });
});

describe('maskSecrets', () => {
  it('hides a card number that passes the Luhn check, with spaces, hyphens or none', () => {
    for (const card of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '5555 5555 5555 4444']) {
      const out = maskSecrets(`mera card ${card} use kar`);
      expect(out.text).toBe(`mera card ${CARD_HIDDEN} use kar`);
      expect(out.kinds).toEqual(['card']);
    }
  });

  it('hides a card number written with dots or more than one space between the groups', () => {
    for (const card of ['4111.1111.1111.1111', '4111  1111  1111  1111', '5555   5555 5555   4444', '4111.1111 1111-1111']) {
      const out = maskSecrets(`card ${card} le lo`);
      expect(out.text).toBe(`card ${CARD_HIDDEN} le lo`);
      expect(out.kinds).toEqual(['card']);
    }
    expect(maskSecrets('order 4111.1111.1111.1112').kinds).toEqual([]);
  });

  it('hides a card inside a longer digit run', () => {
    expect(maskSecrets('1 4111 1111 1111 1111').text).toBe(CARD_HIDDEN);
  });

  it('leaves a 16 digit run that fails the Luhn check', () => {
    expect(maskSecrets('order 4111 1111 1111 1112')).toEqual({ text: 'order 4111 1111 1111 1112', kinds: [] });
  });

  it('hides CVVs, one-time codes, PINs and passwords, in English and Hinglish', () => {
    expect(maskSecrets('cvv 123 hai').text).toBe('cvv [hidden] hai');
    expect(maskSecrets('OTP hai 482913').text).toBe('OTP hai [hidden]');
    expect(maskSecrets('482913 is the OTP').text).toBe('[hidden] is the OTP');
    expect(maskSecrets('bhai OTP 7731 aaya hai').text).toBe('bhai OTP [hidden] aaya hai');
    expect(maskSecrets('my pin is 4321').text).toBe('my pin is [hidden]');
    expect(maskSecrets('wifi password is goa@123').text).toBe('wifi password is [hidden]');
    expect(maskSecrets('pwd: hunter2').text).toBe('pwd: [hidden]');
  });

  it('reports every kind it found, once each', () => {
    const out = maskSecrets('mera card 4111111111111111 cvv 123 hai');
    expect(out.text).toBe(`mera card ${CARD_HIDDEN} cvv [hidden] hai`);
    expect(out.kinds).toEqual(['card', 'cvv']);
  });

  it('leaves prices, flights, phone numbers, PNRs, postal codes, promo codes and dates alone', () => {
    for (const plain of [
      '₹54,200 per head',
      'flight 6E 2134 at 18:40',
      'call me on 98765 43210',
      '+91 98765 43210',
      'PNR 4ABC12',
      'pin code 403509',
      'promo code 2024',
      'dates 6-9 Nov',
    ]) {
      expect(maskSecrets(plain)).toEqual({ text: plain, kinds: [] });
    }
  });

  it('catches the card in a steering message', () => {
    const out = maskSecrets('Go bhai Rahul ka card 4111 1111 1111 1111 use kar');
    expect(out.text).toBe(`Go bhai Rahul ka card ${CARD_HIDDEN} use kar`);
    expect(hasSecret('Go bhai Rahul ka card 4111 1111 1111 1111 use kar')).toBe(true);
    expect(hasSecret('Go bhai book kar de')).toBe(false);
  });
});

describe('masking at the door, then again (P1 intake first, P2 at each use)', () => {
  it('changes nothing the second time, and reads back what the first time hid', () => {
    for (const raw of ['mera card 4111 1111 1111 1111 cvv 123 hai', 'OTP hai 482913', 'pwd: hunter2', 'my pin is 4321', 'pin code 403509']) {
      const once = maskSecrets(raw).text;
      expect(maskSecrets(once).text).toBe(once);
      expect(secretKinds(once)).toEqual(maskSecrets(raw).kinds);
    }
  });

  it('finds secrets that are still there and the marks of ones already hidden', () => {
    expect(secretKinds('mera card 4111111111111111 cvv 123 hai')).toEqual(['card', 'cvv']);
    expect(secretKinds(`mera card ${CARD_HIDDEN} cvv ${HIDDEN} hai`)).toEqual(['card', 'cvv']);
    expect(secretKinds(`OTP hai ${HIDDEN}`)).toEqual(['code']);
    expect(secretKinds(`wifi password is ${HIDDEN}`)).toEqual(['password']);
    expect(secretKinds('Go bhai book kar de')).toEqual([]);
  });
});
