/**
 * Finds card numbers, CVVs, one-time codes, PINs and passwords by code and hides them.
 * Jev never decides this (it cannot count digits). P1's intake runs maskSecrets on every message
 * before Go stores it; memory and the reflex run it again at each use, which changes nothing on
 * text already masked. Only masked text reaches Jev, the side model, facts, story lines, logs and
 * test fixtures. This file imports nothing, so it can be built before the rest of its lane.
 */
export type SecretKind = 'card' | 'cvv' | 'code' | 'password';
export interface Masked {
  text: string;
  kinds: SecretKind[];
}

export const CARD_HIDDEN = '[card number hidden]';
export const HIDDEN = '[hidden]';

export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A run of 13 to 16 digits is a card when it passes Luhn; a longer run when any 15 or 16 digit window does. */
function holdsCard(digits: string): boolean {
  if (digits.length < 13) return false;
  if (digits.length <= 19 && luhnOk(digits)) return true;
  if (digits.length <= 16) return false;
  for (const len of [16, 15]) {
    for (let i = 0; i + len <= digits.length; i += 1) {
      if (luhnOk(digits.slice(i, i + len))) return true;
    }
  }
  return false;
}

// 13 or more digits, with a hyphen, a dot or any number of spaces allowed between them.
const DIGIT_RUN = /(?<!\d)\d(?:(?:[.-]| +)?\d){12,}(?!\d)/g;
const CVV = /\b(cvv2?|cvc|security code)(\s*(?:is|hai|:|=|-)?\s*)(\d{3,4})\b/gi;
const CODE_AFTER = /\b(otp|one[- ]time (?:password|code)|verification code|login code|code|pin)(\s*(?:is|hai|:|=|-)?\s*)(\d{4,8})\b/gi;
const CODE_BEFORE = /\b(\d{4,8})(\s+(?:is|hai)\s+(?:the\s+|my\s+|mera\s+)?(?:otp|code|pin)\b)/gi;
const PASSWORD = /\b(password|passcode|passwd|pwd)(\s*(?:is|hai|:|=|-)\s*)(\S+)/gi;
// "pin code 403509" is a postal code and "promo code 2024" is a discount: not secrets.
const NOT_A_SECRET_BEFORE = /(pin|zip|postal|promo|coupon|discount|area)\s*$/i;

export function maskSecrets(input: string): Masked {
  const kinds = new Set<SecretKind>();
  let text = input.replace(DIGIT_RUN, (run: string) => {
    if (!holdsCard(run.replace(/[ .-]/g, ''))) return run;
    kinds.add('card');
    return CARD_HIDDEN;
  });
  text = text.replace(CVV, (_m: string, word: string, sep: string) => {
    kinds.add('cvv');
    return `${word}${sep}${HIDDEN}`;
  });
  text = text.replace(CODE_AFTER, (m: string, word: string, sep: string, _digits: string, offset: number, whole: string) => {
    if (NOT_A_SECRET_BEFORE.test(whole.slice(Math.max(0, offset - 12), offset))) return m;
    kinds.add('code');
    return `${word}${sep}${HIDDEN}`;
  });
  text = text.replace(CODE_BEFORE, (_m: string, _digits: string, rest: string) => {
    kinds.add('code');
    return `${HIDDEN}${rest}`;
  });
  text = text.replace(PASSWORD, (_m: string, word: string, sep: string) => {
    kinds.add('password');
    return `${word}${sep}${HIDDEN}`;
  });
  return { text, kinds: [...kinds] };
}

export function hasSecret(text: string): boolean {
  return maskSecrets(text).kinds.length > 0;
}

// The marks maskSecrets leaves, read back. A CVV or a password keeps its word in front of the mark;
// any other [hidden] was a one-time code or a PIN.
const CVV_MARK = /\b(?:cvv2?|cvc|security code)\s*(?:is|hai|:|=|-)?\s*\[hidden\]/gi;
const PASSWORD_MARK = /\b(?:password|passcode|passwd|pwd)\s*(?:is|hai|:|=|-)\s*\[hidden\]/gi;
const KIND_ORDER: readonly SecretKind[] = ['card', 'cvv', 'code', 'password'];

/**
 * Every kind of secret the text held: the ones still in it and the ones already hidden. The door masks
 * every message first, so the reflex (question 8, raise only) reads the marks to know a secret was typed.
 */
export function secretKinds(text: string): SecretKind[] {
  const found = new Set<SecretKind>(maskSecrets(text).kinds);
  if (text.includes(CARD_HIDDEN)) found.add('card');
  const cvvs = text.match(CVV_MARK)?.length ?? 0;
  const passwords = text.match(PASSWORD_MARK)?.length ?? 0;
  if (cvvs > 0) found.add('cvv');
  if (passwords > 0) found.add('password');
  if (text.split(HIDDEN).length - 1 > cvvs + passwords) found.add('code');
  return KIND_ORDER.filter((k) => found.has(k));
}
