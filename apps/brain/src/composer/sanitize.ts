const RANGE = /(\d)\s*[–—]\s*(\d)/g;
const DASH = /\s*[—–]\s*/g;

/**
 * What every outgoing string passes before a person sees it: no em or en dashes (a dash between
 * words becomes a comma, and a number range written with a dash becomes a hyphen), and never the model's
 * or its maker's name.
 */
export function sanitize(text: string): string {
  return text
    .replace(RANGE, '$1-$2')
    .replace(DASH, ', ')
    .replace(/^[,\s]+/, '')
    .replace(/,\s*([,.!?])/g, '$1')
    .replace(/\bclaude\b/gi, 'Go')
    .replace(/\banthropic\b/gi, 'the Go team')
    .replace(/\b(?:sonnet|haiku|opus|fable)[\s-]*\d+(?:[.-]\d+)?\b/gi, 'Go')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const KEEP = /(_id|_ids|url|_at)$/;

/** sanitize() on every string inside a card, except ids, links and times. */
export function sanitizeDeep<T>(value: T, key = ''): T {
  if (typeof value === 'string') return (KEEP.test(key) ? value : sanitize(value)) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v, k)])) as T;
  }
  return value;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}
