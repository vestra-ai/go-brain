/**
 * A next step a reply promises without taking it ("…, and I'll search the Mon 9 Nov return next": EXAM, 10 Oct, #18,
 * and it never did). Go takes it in the same turn, or asks instead. Narrow on purpose: a step tied to something later
 * ("I'll re-check the fare at booking", "I'll set it that way when the vote closes") is not one.
 */
const STEP = String.raw`(?:search|check|look(?:\s+(?:up|at|for|into))?|find|pull up|compare)`;
const PROMISED = new RegExp(
  String.raw`\b(?:i'll|i will)\s+(?:also\s+|then\s+)?${STEP}\b[^.?!\n]*\b(?:next|shortly|in a (?:sec|second|moment|bit|minute)|right after(?: this| that)?|after (?:this|that))\b` +
    String.raw`|\bnext,?\s+i(?:'ll| will)\s+${STEP}\b`,
  'i',
);

export const promisesNextStep = (text: string): boolean => PROMISED.test(text);

/** What the loop tells the model about a reply that promised a step it didn't take. */
export const NEXT_STEP_NOTE =
  "Your reply above has not been posted yet. It promises a next step (a search or a check) that you haven't taken. Take it " +
  'now, in this turn, with its tool, then write the one message to post; or, if it needs the group first, ask it as a ' +
  "question instead. Never promise a step you don't take.";
