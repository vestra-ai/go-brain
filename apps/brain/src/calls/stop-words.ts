// "Stop" in the 30 seconds before Go dials, in English, Hinglish and Hindi. When unsure, stopping is the safe side.
const STOP = /\b(stop|ruko|rukk?o|ruk\s*jao|ruk\s*ja|band\s*karo|band\s*kar|mat\s*karo|mat\s*kar|rehne\s*do|rahne\s*do|chh?odo|cancel|don'?t\s+call|do\s+not\s+call|hold\s+on|wait)\b/i;
/**
 * The same in Devanagari: रुको, रुक जाओ, मत करो, मत कर, बंद करो, रहने दो, छोड़ो. JavaScript's \b only knows Latin
 * letters, so these match as they are, on text normalised to NFC (where ड़ is ड plus a nukta).
 */
const STOP_HINDI = /(रुको|रुक\s*जाओ|मत\s*करो|मत\s*कर|बंद\s*करो|रहने\s*दो|छोड़ो)/;
/** A bare "no" only counts as a reply to Go's call line. */
const NO = /\b(no|nahi|nahin|nai|na|mat)\b/i;
const NO_HINDI = /(^|[\s,.!?।])(नहीं|ना|मत)([\s,.!?।]|$)/;

export function saysStop(text: string | null | undefined, repliesToCallLine: boolean): boolean {
  if (!text) return false;
  const t = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’]/g, "'") // a phone keyboard's curly apostrophe: "don’t call"
    .replace(/non[\s-]?stop/g, ' ');
  return STOP.test(t) || STOP_HINDI.test(t) || (repliesToCallLine && (NO.test(t) || NO_HINDI.test(t)));
}
