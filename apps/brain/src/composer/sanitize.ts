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

// Go reads the chat as "#57 Priya: ...", so the model may cite message numbers, which mean nothing to people.
// A reference is "#" and digits on its own: not inside a word or a link ("page#21"), not before a letter ("#3B").
const REF = String.raw`(?<![\w/#])#(\d{1,6})(?!\w)`;
const REF_LIST = String.raw`${REF}(?:\s*(?:,|and|&)\s*${REF})*`;
/** "#4" after one of these words is a real number: a gate, a room, a house. */
const REAL_NUMBER = String.raw`(?:room|gate|platform|seat|house|flat|unit|no|number|table|berth|coach|villa|suite|plot|shop|stall|counter|terminal|pier|jetty|bay)\.?`;
const IN_BRACKETS = new RegExp(String.raw`\s*\(\s*(?:(?:in|at|see|from|per)\s+)?(?:messages?\s+)?${REF_LIST}\s*\)`, 'gi');
const AFTER_WORD = new RegExp(String.raw`\s+(?:in|at|see|from|per)\s+(?:messages?\s+)?${REF_LIST}`, 'gi');
// Bare, but never one that starts in the middle of a list, or after a word that makes it a real number.
const BARE = new RegExp(String.raw`(?<!\b${REAL_NUMBER}\s*)(?<!#\d+\s*(?:,|and|&)\s*)\s*${REF_LIST}`, 'gi');

/**
 * Takes the message numbers out of Go's words, and says which were cited, in order: "(#21, #34)", "in #6", a bare
 * "#21". Only the text of a message, never a card, where "House #12" is an address.
 */
export function stripMessageRefs(text: string): { text: string; refs: number[] } {
  const refs: number[] = [];
  const cut = (match: string): string => {
    for (const m of match.matchAll(/#(\d+)/g)) refs.push(Number(m[1]));
    return '';
  };
  const cutOut = text.replace(IN_BRACKETS, cut).replace(AFTER_WORD, cut).replace(BARE, cut);
  // Text that cited nothing is left exactly as it was.
  if (refs.length === 0) return { text, refs };
  const out = cutOut
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/,([.!?])/g, '$1')
    .trim();
  return { text: out, refs: [...new Set(refs)] };
}

// Go's own ids: a card, vote, turn, task, call or results id ("c_opt_turn_01M4…_1", "r_fr3169bw…", "gt_ab12cd"), that
// is letters, an underscore and a body with a digit in it; a field name that holds one ("card_id"); a bare ULID. Not a
// piece of a link, a path, an email address or a file name ("rahul_1@…", "plan_2.pdf").
const ID = String.raw`[A-Za-z][A-Za-z0-9]{0,11}_[A-Za-z0-9_]*\d[A-Za-z0-9_]*|[a-z]+(?:_[a-z]+)*_ids?|[0-9A-HJKMNP-TV-Z]{26}`;
const IDS = new RegExp(String.raw`(?<![\w./=?&#%@:-])(?:${ID})(?![\w@-])(?!\.\w)`, 'g');
const LINK = /https?:\/\/\S+/g;

/**
 * Takes Go's internal ids out of words people read, the last line of defence at the post: "I'll put the most recent
 * villa options card (c_opt_turn_01M4…) to a vote" loses the id and its brackets. Links are left as they are.
 */
export function stripIds(text: string): string {
  let cut = false;
  const outside = (part: string): string =>
    part.replace(IDS, () => {
      cut = true;
      return '';
    });
  let out = '';
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    out += outside(text.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  out += outside(text.slice(at));
  // Text with no id in it is left exactly as it was.
  if (!cut) return text;
  return out
    .replace(/\s*\(\s*\)|\s*\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/,([.!?])/g, '$1')
    .trim();
}

const KEEP = /(^id|_id|_ids|url|_at)$/;

/** sanitize() and stripIds() on every string inside a card, except ids, links and times. */
export function sanitizeDeep<T>(value: T, key = ''): T {
  if (typeof value === 'string') return (KEEP.test(key) ? value : sanitize(stripIds(value))) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v, k)])) as T;
  }
  return value;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}
