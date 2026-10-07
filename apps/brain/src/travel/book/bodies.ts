/**
 * What a page sent, as a recipe reads it. A body is JSON, a Next.js flight payload (the page's own "RSC: 1" answer:
 * one JSON value a line), or a Next.js page whose flight payload sits in its scripts. Whatever its form, the page's own
 * credentials in it (its apikey, deviceId, uuid, any token or cookie) are dropped before anything reads the body, so no
 * recipe, log or store ever holds them.
 */
import { TravelError } from '../mcp-travel.js';

export const BODY_FORMATS = ['json', 'rsc', 'next_html'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Keys that hold the page's own credentials: dropped wherever they are. */
const CREDENTIAL = /^(api[-_]?key|x[-_]api[-_]?key|device[-_]?id|uuid|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|cookie|set[-_]?cookie|secret|client[-_]?secret|password|session[-_]?id)$/i;

/** A value with every credential key left out, at any depth. */
export function withoutCredentials(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutCredentials);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !CREDENTIAL.test(k)).map(([k, x]) => [k, withoutCredentials(x)]));
  }
  return v;
}

/**
 * The JSON values in a flight payload: each line is "<id>:<value>", the value JSON, or a tag letter ("I", "HL") before
 * JSON; a text chunk is "<id>:T<length>,<text>". A string "$<id>" in a value stands for that line's value or text, and
 * reads as it. A line that is neither (hints) is left out.
 */
export function flightValues(text: string): unknown[] {
  const lines = new Map<string, unknown>();
  const order: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]+):([A-Z]{0,2})(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === 'T') {
      const comma = m[3]!.indexOf(',');
      if (comma >= 0) lines.set(m[1]!, m[3]!.slice(comma + 1));
      continue;
    }
    try {
      lines.set(m[1]!, JSON.parse(m[3]!));
      order.push(m[1]!);
    } catch {
      // not a JSON line
    }
  }
  const resolved = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const ref = /^\$([0-9a-f]+)$/.exec(v);
      return ref && lines.has(ref[1]!) && depth < 8 ? resolved(lines.get(ref[1]!), depth + 1) : v;
    }
    if (Array.isArray(v)) return v.map((x) => resolved(x, depth));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolved(x, depth)]));
    return v;
  };
  return order.map((id) => resolved(lines.get(id), 0));
}

/** The flight payload a Next.js page carries in its scripts: self.__next_f.push([1,"…"]) chunks, joined. */
export function flightOfPage(html: string): string {
  let text = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      text += JSON.parse(m[1]!) as string;
    } catch {
      // a chunk that doesn't read
    }
  }
  return text;
}

/** A body as a recipe reads it, its credentials gone. */
export function readBodyAs(text: string, format: BodyFormat, what: string): unknown {
  if (format === 'json') {
    try {
      return withoutCredentials(JSON.parse(text));
    } catch {
      throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
    }
  }
  const values = flightValues(format === 'rsc' ? text : flightOfPage(text));
  if (values.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
  return withoutCredentials(values);
}
