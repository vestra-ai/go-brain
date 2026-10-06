// Go's words in the room: no em dashes, never a model vendor's name, and people's text quoted as data.
const VENDOR = /\b(open\s?ai|chat\s?gpt|gpt[-\w.]*|anthropic|claude|gemini)\b/gi;

export function plain(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—―–]\s*/g, ', ')
    .replace(VENDOR, 'Go')
    .replace(/ {2,}/g, ' ')
    .replace(/ ,/g, ',')
    .trim();
}

/** Cuts to at most `max` UTF-16 units (what the contract's zod limits count), never inside an emoji. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** People's text inside Go's own prompt lines, as a JSON string: it cannot close the quote or pose as Go. */
export function quote(text: string, max = 120): string {
  return JSON.stringify(clip(text, max));
}

export function rupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
}

export function namesOf(ids: string[], people: ReadonlyArray<{ person_id: string; name: string }>): string {
  const names = ids.map((id) => people.find((p) => p.person_id === id)?.name ?? 'someone');
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] ?? 'someone';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? 'someone'}`;
}
