// Robust LLM-JSON extraction.
//
// Live bug (R1): Haiku frequently returns a valid JSON value (array/object)
// FOLLOWED by explanation prose, e.g. `[]\n\nThere are no claims ...`. A bare
// `JSON.parse(text.replace(fences).trim())` throws "Unexpected non-whitespace
// character after JSON at position N" on every such response, silently degrading
// the curator/wiki to []. It can also be PRECEDED by prose ("Here you go: [...]").
//
// extractJsonValue finds the FIRST balanced top-level JSON value (array or object)
// embedded anywhere in the text — tolerating leading AND trailing prose — and
// parses just that substring. It NEVER throws; on no-value-found or parse-failure
// it returns undefined so callers can degrade-safe (return []/'' as before).
//
// Pure + dependency-free (root-safe) so both the server services and the kernel
// can share it.

/** Strip a single leading ```json / ``` fence and its trailing ``` fence. */
function stripFences(text: string): string {
  return text.replace(/^```json?\n?|\n?```$/g, '').trim();
}

/**
 * Scan from `start` (which must point at '[' or '{') and return the index just
 * PAST the matching balanced close, or -1 if the value never balances. Accounts
 * for string literals (so brackets inside strings do not affect depth) and
 * backslash escapes inside strings.
 */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extract and parse the FIRST balanced top-level JSON value (array `[...]` or
 * object `{...}`) from `text`, tolerating leading prose and trailing prose.
 *
 * - Strips ```json / ``` fences first.
 * - Finds the earliest '[' or '{', matches its balanced close (string/escape
 *   aware), and JSON.parses that substring.
 * - Returns the parsed value, or `undefined` if no value is found or it fails to
 *   parse. NEVER throws.
 */
export function extractJsonValue(text: string): unknown | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = stripFences(text);
  if (!cleaned) return undefined;

  const firstArr = cleaned.indexOf('[');
  const firstObj = cleaned.indexOf('{');
  let start: number;
  if (firstArr === -1 && firstObj === -1) return undefined;
  if (firstArr === -1) start = firstObj;
  else if (firstObj === -1) start = firstArr;
  else start = Math.min(firstArr, firstObj);

  const end = findBalancedEnd(cleaned, start);
  if (end === -1) return undefined;

  const candidate = cleaned.slice(start, end);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
