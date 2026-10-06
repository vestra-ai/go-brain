// What the try room says to a visitor, in one place so the words guard (apps/brain/src/__tests__/words.test.ts) reads
// all of it.

/** What is real and what is not. TRY_SIMULATED_LINE replaces it without a new build. */
export const SIMULATED_LINE = "ixigo search, the trip's computer and payments are simulated in this demo; the model is real.";

/** Example messages under the message box: a tap puts one in the box. */
export const HINTS: readonly string[] = [
  '@Go find us flights from Delhi on the 12th',
  '@Go find a villa with a pool in North Goa',
  "@Go what's still open for this trip?",
  '@Go put the dates to a vote',
];

/** UTC midnight, when the daily counts start again, is 05:30 in India. */
export const DAILY_LIMIT_LINE = "This demo has reached today's limit. It resets at 05:30 IST.";

export const visitLimitLine = (turns: number): string =>
  `This visit has used its ${turns} turns with Go for today, so others can try it too. It resets at 05:30 IST.`;
export const SAY_FIRST = 'Say something first: the trip starts with the first message.';
export const tooManyTabs = (tabs: number): string => `This room is already open in ${tabs} tabs. Use one of those, or close one and reload this page.`;
export const ROOM_FULL = 'The room is full right now. Try again in a few minutes.';
export const SLOW_DOWN = 'That was a lot at once, so some of it was not sent. Try again more slowly.';

export const goLiveLine = (contract: string | null): string =>
  `Go is live: this room talks to the real Go${contract ? ` (contract ${contract})` : ''}.`;

export const GO_DOWN_LINE = 'Go is not answering right now. Try again in a minute.';

export const NOT_IN_YOUR_TRIP = "That isn't in your trip.";
export const PICK_A_PERSON = 'Pick someone in the trip first.';
export const TYPE_SOMETHING = 'Type a message first.';
export const TOO_LONG = (max: number): string => `Keep a message under ${max.toLocaleString('en-IN')} characters.`;
export const UNKNOWN_ACTION = "The room doesn't know that one.";

export const WRONG_PASSCODE = "That passcode isn't right.";
export const TOO_MANY_TRIES = 'Too many wrong tries. Wait a minute, then try again.';
