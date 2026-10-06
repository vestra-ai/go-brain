import type { Message } from '../door/methods.js';
import type { TripPack } from './pack.js';

// "Go" spoken to, not "go" the verb: at the start ("Go, find..." but not "go to the beach"),
// at the end after a comma ("thoughts, Go?"), after a greeting ("hey go"), or @go anywhere.
const STARTS = /^\s*@?go\b(?!\s+(?:to|for|and|out|back|ahead|home|there|on|in|with|get|see|eat)\b)/i;
const ENDS = /[,!?]\s*@?go\s*[?!.]*\s*$/i;
const CALLS = /\b(?:hey|hi|hello|ok|okay|thanks|thank you|bhai|yo|dear)\s+@?go\b/i;
const AT = /(^|\s)@go\b/i;

export function namesGoInText(text: string | null | undefined): boolean {
  if (!text) return false;
  return AT.test(text) || STARTS.test(text) || ENDS.test(text) || CALLS.test(text);
}

/** True when a message plainly names Go: the Server's mentions_go, a reply to Go, or Go spoken to in the text. */
export function plainlyNamesGo(m: Message, pack: TripPack): boolean {
  if (m.mentions_go || namesGoInText(m.text)) return true;
  if (!m.reply_to) return false;
  return pack.messages.find((x) => x.message_id === m.reply_to)?.author.kind === 'go';
}
