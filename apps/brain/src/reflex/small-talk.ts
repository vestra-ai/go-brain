/**
 * Small talk, by code alone: a line that is only emoji, a laugh, an ok, or a greeting or sign-off ("gn 😴", "haha 😂",
 * "gm all ☀️", "👍"). Used only when Jev has no answer for a line (a timeout or an error): small talk then wakes no model,
 * while any other line still does, as it always has. The list is kept tight on purpose: "ok noted", "same" or "done 👍"
 * still wake when Jev is away, and a "?" keeps any line awake.
 */

const WORDS = new Set(['gn', 'gm', 'goodnight', 'goodmorning', 'night', 'morning', 'ok', 'okay', 'okk', 'kk', 'k', 'lol', 'lmao', 'brb', 'bye']);
const LAUGH = /^(?:(?:ha)+h?|(?:he)+h?)$/;
// "gm all", "gn guys", "morning everyone".
const TO_ALL = new Set(['all', 'guys', 'everyone', 'people']);
// Emoji with their joiners, skin tones and presentation marks, and the marks that end a line without asking anything.
const NOISE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[‍️.!,~]/gu;

const isWord = (w: string): boolean => WORDS.has(w) || (w.length >= 4 && LAUGH.test(w));

export function isSmallTalk(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/\bgood (night|morning)\b/g, 'good$1').replace(NOISE, ' ').trim();
  if (t === '') return true;
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  const [first, ...rest] = words;
  return first !== undefined && isWord(first) && rest.every((w) => isWord(w) || TO_ALL.has(w));
}
