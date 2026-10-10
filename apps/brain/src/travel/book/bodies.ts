/**
 * What a page sent, as a recipe reads it. A body is JSON, a Next.js flight payload (the page's own "RSC: 1" answer:
 * one JSON value a line), a Next.js page whose flight payload sits in its scripts, an older Next.js page whose props
 * sit in its __NEXT_DATA__ script (ixigo's offers pages), or a plain server-rendered page with no data call at all,
 * read as its tables (html_tables: a train's schedule, running status, coach position, a station's or platform's page),
 * or a stream of server-sent events, read as the JSON on its data lines (sse: ixigo's flights search, one data line).
 * Whatever its form, the page's own credentials in it (its apikey, deviceId, uuid, any token or cookie) are dropped
 * before anything reads the body, so no recipe, log or store ever holds them.
 */
import { DomUtils, ElementType, parseDocument } from 'htmlparser2';
import { TravelError } from '../mcp-travel.js';

export const BODY_FORMATS = ['json', 'rsc', 'next_html', 'next_data', 'html_tables', 'sse'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Keys that hold the page's own credentials: dropped wherever they are. */
const CREDENTIAL = /^(api[-_]?key|x[-_]api[-_]?key|device[-_]?id|uuid|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|cookie|set[-_]?cookie|secret|client[-_]?secret|password|session[-_]?id|otpless\w*)$/i;

/** A value with every credential key left out, at any depth. */
export function withoutCredentials(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutCredentials);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !CREDENTIAL.test(k)).map(([k, x]) => [k, withoutCredentials(x)]));
  }
  return v;
}

/**
 * The JSON values in a flight payload: each row is "<id>:<value>", the value JSON, or a tag letter ("I", "HL") before
 * JSON, ending at a new line; a text chunk is "<id>:T<length>,<text>", its length in UTF-8 bytes and hex, and the next
 * row may follow it on the same line (ixigo's visa page: a country's ld+json text, then its requirements, 10 Oct). A
 * string "$<id>" in a value stands for that row's value or text, and reads as it. A line that is neither (hints) is left
 * out.
 */
export function flightValues(text: string): unknown[] {
  const lines = new Map<string, unknown>();
  const order: string[] = [];
  const ROW = /^([0-9a-f]+):([A-Z]{0,2})/;
  const rowAt = (at: number): boolean => at >= text.length || text[at] === '\n' || ROW.test(text.slice(at, at + 24));
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? text.length : nl;
    const m = ROW.exec(text.slice(i, Math.min(lineEnd, i + 24)));
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    const id = m[1]!;
    const start = i + m[0].length;
    if (m[2] === 'T') {
      const comma = text.indexOf(',', start);
      if (comma < 0 || comma > lineEnd) {
        i = lineEnd + 1;
        continue;
      }
      // The text by its length when the next row starts right after it, else up to the end of its line.
      const length = parseInt(text.slice(start, comma), 16);
      const byBytes = afterBytes(text, comma + 1, length);
      const byChars = comma + 1 + length;
      const end = byBytes >= 0 && rowAt(byBytes) ? byBytes : byChars <= text.length && rowAt(byChars) ? byChars : lineEnd;
      lines.set(id, text.slice(comma + 1, end));
      i = end < text.length && text[end] === '\n' ? end + 1 : end;
      continue;
    }
    try {
      lines.set(id, JSON.parse(text.slice(start, lineEnd)));
      order.push(id);
    } catch {
      // not a JSON line
    }
    i = lineEnd + 1;
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

/** Where a text of that many UTF-8 bytes, starting at from, ends (a flight payload counts a text chunk in bytes); -1
 *  when the payload ends first. */
function afterBytes(text: string, from: number, bytes: number): number {
  let at = from;
  let left = Number.isFinite(bytes) ? bytes : -1;
  while (left > 0 && at < text.length) {
    const code = text.codePointAt(at)!;
    left -= code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    at += code >= 0x10000 ? 2 : 1;
  }
  return left === 0 ? at : -1;
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

/** The JSON an older Next.js page carries in its <script id="__NEXT_DATA__">: its props, under props.pageProps. */
export function nextDataOfPage(html: string): string | null {
  return /<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? null;
}

/**
 * A plain page as html_tables reads it: its <title> and canonical address, every table's rows as the text of their
 * cells (the header row kept, as the first row), and every ld+json block, parsed. Tables keep the page's order, an
 * empty one too, so a recipe's tables[1] is the page's second table.
 */
export interface HtmlTables {
  title: string | null;
  canonical: string | null;
  tables: string[][][];
  ld: unknown[];
}

type DomElement = ReturnType<typeof DomUtils.getElementsByTagName>[number];
type DomNode = DomElement['children'][number];

/** The nearest element named name around el, or null. */
function closest(el: DomElement, name: string): DomElement | null {
  for (let p = el.parent; p; p = p.parent) {
    if (p.type === ElementType.Tag && p.name === name) return p;
  }
  return null;
}

/**
 * An element's text: each piece trimmed and joined by one space, never a script's or a style's. ixigo's cells hold each
 * piece in an element of its own with nothing between ("<div>Asalpur Jobner</div><div>37 km</div>"), which reads
 * "Asalpur Jobner 37 km", not "Asalpur Jobner37 km".
 */
function textOf(el: DomElement): string {
  const pieces: string[] = [];
  const walk = (n: DomNode): void => {
    if (n.type === ElementType.Text) {
      const t = n.data.replace(/\s+/g, ' ').trim();
      if (t) pieces.push(t);
    } else if (n.type === ElementType.Tag || n.type === ElementType.CDATA || n.type === ElementType.Root) {
      for (const c of n.children) walk(c);
    }
  };
  for (const c of el.children) walk(c);
  return pieces.join(' ');
}

/**
 * A plain page's title, canonical address, tables and ld+json, by a real HTML parser (htmlparser2), never by patterns.
 * A table's rows are the <tr>s whose nearest table is it, and a row's cells the <td>s and <th>s whose nearest row is it,
 * whatever wraps them: ixigo's schedule wraps each row in a <div>, and a table inside a cell keeps its own rows. A row
 * with no text at all (a spacer) is left out.
 */
export function htmlTablesOf(html: string): HtmlTables {
  const doc = parseDocument(html);
  const title = DomUtils.getElementsByTagName('title', doc, true, 1)[0];
  const canonical = DomUtils.findOne((el) => el.name === 'link' && /(^|\s)canonical(\s|$)/i.test(el.attribs['rel'] ?? ''), doc.children);
  const ld: unknown[] = [];
  for (const block of DomUtils.findAll((el) => el.name === 'script' && (el.attribs['type'] ?? '').trim().toLowerCase() === 'application/ld+json', doc.children)) {
    try {
      ld.push(JSON.parse(DomUtils.textContent(block)));
    } catch {
      // a block that doesn't read
    }
  }
  const tables = DomUtils.getElementsByTagName('table', doc, true).map((table) =>
    DomUtils.findAll((el) => el.name === 'tr' && closest(el, 'table') === table, table.children)
      .map((tr) => DomUtils.findAll((el) => (el.name === 'td' || el.name === 'th') && closest(el, 'tr') === tr, tr.children).map(textOf))
      .filter((row) => row.some((cell) => cell.length > 0)),
  );
  return { title: title ? textOf(title) || null : null, canonical: canonical?.attribs['href'] ?? null, tables, ld };
}

/**
 * The JSON values a server-sent event stream carries, one an event, in order. An event ends at a blank line, and its data
 * is its data lines joined by line breaks, as the stream format has it: a long value may come split over several lines
 * (staging, 10 Oct: a logged-in browser's flights read was refused where a logged-out one read). An event whose joined
 * data is not one value is read a line at a value, as a stream that sends one a line does; a line that is not JSON is
 * left out.
 */
export function eventValues(text: string): unknown[] {
  const values: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length === 0) continue;
    try {
      values.push(JSON.parse(data.join('\n')));
    } catch {
      for (const line of data) {
        try {
          values.push(JSON.parse(line));
        } catch {
          // a data line that is not JSON
        }
      }
    }
  }
  return values;
}

/** A body as a recipe reads it, its credentials gone. */
export function readBodyAs(text: string, format: BodyFormat, what: string): unknown {
  if (format === 'sse') {
    const values = eventValues(text);
    if (values.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
    return withoutCredentials(values);
  }
  if (format === 'html_tables') {
    const page = htmlTablesOf(text);
    if (page.tables.length === 0 && page.ld.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
    return withoutCredentials(page);
  }
  if (format === 'json' || format === 'next_data') {
    const json = format === 'json' ? text : nextDataOfPage(text);
    try {
      return withoutCredentials(JSON.parse(json ?? ''));
    } catch {
      throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
    }
  }
  const values = flightValues(format === 'rsc' ? text : flightOfPage(text));
  if (values.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
  return withoutCredentials(values);
}
