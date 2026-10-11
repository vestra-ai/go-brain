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

/**
 * A check the reply says it hasn't run, or offers to run, for what was asked (the exam re-run, 10 Oct: "I haven't run a
 * confirmation-chance check on any of them", "I can pull up the full terms if you want them"). Go runs it in the same
 * turn when a tool can. Narrow on purpose: only the reply's own words about a check it didn't do; an offer of something
 * else ("Want me to look at the return too?") is left alone.
 */
const DEFERRED = new RegExp(
  String.raw`\bi (?:haven't|have not|didn't|did not) (?:run|checked|check|looked (?:up|at|into)|pulled up)\b` +
    String.raw`|\bi can (?:pull up|check|look up|run|fetch)\b[^.?!\n]*\bif you(?:'d)? (?:want|like)\b`,
  'i',
);

export const defersACheck = (text: string): boolean => DEFERRED.test(text);

/** What the loop tells the model about a reply that left a check undone. */
export const DEFERRED_CHECK_NOTE =
  "Your reply above has not been posted yet. It says a check wasn't run, or offers to run one, for what they asked. If a " +
  "tool can run it (a waitlist's chance to confirm: the ixigo tool's trains.confirm_chance; an offer's terms: offers.details; " +
  'an option on a card: option.facts), run it now, in this turn, and answer from it. If none can, send the reply as it is.';

/** The note for a reply that promised a step or left a check undone; null for any other reply. */
export function undoneNote(text: string): string | null {
  if (promisesNextStep(text)) return NEXT_STEP_NOTE;
  return defersACheck(text) ? DEFERRED_CHECK_NOTE : null;
}
