// "Stop" in the 30 seconds before Go dials, in English and Hinglish. When unsure, stopping is the safe side.
const STOP = /\b(stop|ruko|rukk?o|ruk\s*jao|ruk\s*ja|band\s*karo|band\s*kar|mat\s*karo|mat\s*kar|cancel|don'?t\s+call|do\s+not\s+call|hold\s+on|wait)\b/i;
/** A bare "no" only counts as a reply to Go's call line. */
const NO = /\b(no|nahi|nahin|nai|na|mat)\b/i;

export function saysStop(text: string | null | undefined, repliesToCallLine: boolean): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/non[\s-]?stop/g, ' ');
  return STOP.test(t) || (repliesToCallLine && NO.test(t));
}
