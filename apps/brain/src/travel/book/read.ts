/**
 * A recipe's answer from what its page sent: the rows (read.rows, from one captured call), the other calls it reads
 * (read.also, bound by name), and each row as an option or a row of facts (answer.each). Every option is checked: one
 * that doesn't check out is dropped, never half read, and a page where nothing reads is refused. The page's own
 * credentials in a body are dropped before anything reads it (bodies.ts).
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import { bodiesFor, matches, type Capture, type RecipeOption } from '../recipes/recipe.js';
import { eventValues, readBodyAs, type BodyFormat } from './bodies.js';
import { evaluate } from './expr.js';
import type { RecipeFile } from './format.js';

const Place = z.object({ name: z.string().min(1).max(120), code: z.string().max(10).optional() });
const Option = z.object({
  title: z.string().min(1).max(160),
  subtitle: z.string().max(160).optional(),
  priceMinor: z.int().positive(),
  totalMinor: z.int().positive().optional(),
  currency: z.string().length(3),
  priceNote: z.string().min(1).max(60),
  journey: z
    .object({
      mode: z.enum(['flight', 'train', 'bus']),
      origin: Place,
      destination: Place,
      depart_at: z.iso.datetime({ offset: true }),
      arrive_at: z.iso.datetime({ offset: true }),
      carrier_name: z.string().max(60).optional(),
      carrier_code: z.string().max(3).optional(),
      number: z.string().max(20).optional(),
      stops: z.int().nonnegative().optional(),
    })
    .optional(),
  place: z
    .object({ name: z.string().min(1).max(120), address: z.string().max(200).optional(), lat: z.number().optional(), lng: z.number().optional(), timezone: z.string().max(64).optional() })
    .optional(),
  imageUrl: z.url().optional(),
  imageUrls: z.array(z.url()).max(10).optional(),
  amenities: z.array(z.string().min(1).max(80)).max(12).optional(),
  rating: z.number().min(0).max(5).optional(),
  highlights: z.array(z.string().min(1).max(80)).max(4),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  sourceUrl: z.url(),
});

/** ixigo sends a detail it doesn't have as null: a null is the same as missing, so it is left out before the check. */
function withoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(withoutNulls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)]));
  return v;
}

/**
 * Which of the reader's checks a page's captures failed, from the captures themselves, for the log when a read is refused
 * (staging, 10 Oct 02:53Z: a flights read was refused with nothing to say why): the rows' call never came (not_sent),
 * came but never 2xx (status), came 2xx but cut at its cap (truncated), or came whole and still read as no row (shape).
 */
export function unreadBecause(recipe: RecipeFile, captures: Capture[]): 'not_sent' | 'status' | 'truncated' | 'shape' {
  const from = recipe.read?.rows.from;
  if (!from) return 'shape';
  const sent = captures.filter((c) => matches(from, c.url));
  if (sent.length === 0) return 'not_sent';
  const ok = sent.filter((c) => c.status >= 200 && c.status < 300);
  if (ok.length === 0) return 'status';
  return bodiesFor(ok, from).length === 0 ? 'truncated' : 'shape';
}

/**
 * For a shape refusal, what the reader made of the body, in counts only: a stream's events with data and the values that
 * parsed, and the rows its list found. Rows found and none read is a row's fields; no rows is the list's path; no values is
 * the body's form.
 */
export async function shapeOf(recipe: RecipeFile, captures: Capture[], bindings: Record<string, unknown> = {}): Promise<{ events?: number; values: number; rows: number }> {
  const read = recipe.read;
  if (!read) return { values: 0, rows: 0 };
  const raw = bodiesFor(captures, read.rows.from, read.rows.format === 'sse');
  let events: number | undefined;
  const values: unknown[] = [];
  for (const text of raw) {
    if (read.rows.format === 'sse') {
      events = (events ?? 0) + text.split(/\r?\n\r?\n/).filter((e) => /^data:/m.test(e)).length;
      values.push(...eventValues(text));
    } else {
      try {
        values.push(readBodyAs(text, read.rows.format, 'it'));
      } catch {
        // a body in no form the reader takes: no value
      }
    }
  }
  let rows = 0;
  try {
    const listed = await readPath(read.rows.list, read.rows.format === 'sse' ? values : values.length === 1 ? values[0] : values, bindings);
    rows = Array.isArray(listed) ? listed.length : listed === undefined ? 0 : 1;
  } catch {
    rows = 0;
  }
  return { ...(events !== undefined ? { events } : {}), values: values.length, rows };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** An object's values that are objects or lists: what a wrapper holds. */
const held = (v: unknown): unknown[] => (isObject(v) ? Object.values(v).filter((x) => isObject(x) || Array.isArray(x)) : []);
const nothingRead = (v: unknown): boolean =>
  v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);

/**
 * The body without what a logged-in or personalised answer may wrap it in, for a reader whose path finds nothing in it as
 * it is: each object value of an object (a "response", a "payload", a second "data"), and for a list (a stream's events,
 * a call's two pages) every item's, as one list; two levels down. (Staging, 10 Oct: a logged-in browser's flights answer
 * came in a shape the logged-out reader refused; the next personalised shape is anyone's guess.)
 */
export function unwrapped(body: unknown, depth = 2): unknown[] {
  const out: unknown[] = [];
  let level: unknown[] = [body];
  for (let i = 0; i < depth && level.length > 0; i++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (Array.isArray(v)) {
        const items = v.flatMap(held);
        if (items.length > 0) next.push(items);
      } else {
        next.push(...held(v));
      }
    }
    out.push(...next);
    level = next;
  }
  return out;
}

/**
 * A reader's path on a body, or, when it finds nothing there, on the body unwrapped (unwrapped), the first that finds
 * something: the logged-out shape first, always.
 */
export async function readPath(path: string, body: unknown, bindings: Record<string, unknown> = {}): Promise<unknown> {
  const found = await evaluate(path, body, bindings);
  if (!nothingRead(found)) return found;
  for (const inner of unwrapped(body)) {
    let got: unknown;
    try {
      got = await evaluate(path, inner, bindings);
    } catch {
      continue;
    }
    if (!nothingRead(got)) return got;
  }
  return found;
}

/** One response body a recipe reads, by its capture's match. */
function body(captures: Capture[], match: string, format: BodyFormat, required: boolean, what: string): unknown {
  const raw = bodiesFor(captures, match, format === 'sse');
  if (raw.length === 0) {
    if (required) throw new TravelError('refused', `ixigo's page did not send ${what}.`);
    return undefined;
  }
  // A call that came back more than once (pages 1 and 2) reads as the list of its bodies.
  return raw.length === 1 ? readBodyAs(raw[0]!, format, what) : raw.map((b) => readBodyAs(b, format, what));
}

/** The rows a recipe's page holds, and what its answer reads besides them. */
async function rowsOf(recipe: RecipeFile, captures: Capture[], bindings: Record<string, unknown>): Promise<unknown[]> {
  const read = recipe.read!;
  const what = recipe.title.toLowerCase();
  const rowsBody = body(captures, read.rows.from, read.rows.format, true, what);
  for (const [name, also] of Object.entries(read.also ?? {})) {
    // What the answer reads besides its rows is extra: one the page sent in a shape Go doesn't read (a train page without
    // its data input) is left out, and the rows still answer.
    let b: unknown;
    try {
      b = body(captures, also.from, also.format, false, name);
    } catch {
      b = undefined;
    }
    bindings[name] = b === undefined ? undefined : await readPath(also.value, b, bindings);
  }
  const listed = await readPath(read.rows.list, rowsBody, bindings);
  let rows: unknown[] = Array.isArray(listed) ? listed : listed === undefined ? [] : [listed];
  if (read.rows.unique) {
    // One row a key, the last copy winning, in the order keys first came: a stream's later snapshot carries a revised fare.
    const byKey = new Map<string, unknown>();
    for (const row of rows) byKey.set(JSON.stringify(await evaluate(read.rows.unique, row, bindings) ?? null), row);
    rows = [...byKey.values()];
  }
  if (read.rows.where) {
    // The site's filters applied by Go, for a site whose call holds every row whatever the page's filters (flights).
    const where = read.rows.where;
    const keep: unknown[] = [];
    for (const row of rows) if ((await evaluate(where, row, bindings)) === true) keep.push(row);
    rows = keep;
  }
  return rows;
}

/**
 * A row of facts as Go may say it: plain values, short text, short lists, nothing else. A list's entries may be small
 * objects of plain values (a photo's url and label, 10 Oct B3), never anything deeper.
 */
function plainFacts(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && depth < 2) return v.slice(0, 40).map((x) => plainFacts(x, depth + 1)).filter((x) => x !== undefined);
  if (v && typeof v === 'object' && depth < 3) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainFacts(x, depth + 1)]).filter(([, x]) => x !== undefined));
  }
  return undefined;
}

/** The facts a page holds, as the recipe reads them: at most the recipe's max rows. */
export async function readFacts(recipe: RecipeFile, captures: Capture[], inputs: Record<string, unknown>, page: string, extra: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  if (!recipe.read || recipe.answer.as !== 'facts') throw new Error(`${recipe.id} has no facts to read`);
  const bindings: Record<string, unknown> = { ...extra, inputs, page };
  const rows = await rowsOf(recipe, captures, bindings);
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (out.length >= recipe.answer.max) break;
    let made: unknown;
    try {
      made = await evaluate(recipe.answer.each, row, bindings);
    } catch (err) {
      if (err instanceof TravelError) throw err;
      continue;
    }
    const plain = plainFacts(withoutNulls(made));
    if (plain && typeof plain === 'object' && !Array.isArray(plain) && Object.keys(plain).length > 0) out.push(plain as Record<string, unknown>);
  }
  if (rows.length > 0 && out.length === 0) throw new TravelError('refused', `ixigo answered ${recipe.title.toLowerCase()} in a shape Go does not read.`);
  return out;
}

/**
 * The options a page's calls hold, as the recipe reads them. bindings: the recipe's own values ($conditions and its let),
 * besides $inputs and $page.
 */
export async function readOptions(
  recipe: RecipeFile,
  captures: Capture[],
  inputs: Record<string, unknown>,
  page: string,
  extra: Record<string, unknown> = {},
  /** The recipe's notes about the whole list, as they read, go here (answer.notes). */
  notes?: string[],
): Promise<RecipeOption[]> {
  if (!recipe.read || recipe.answer.as !== 'options') throw new Error(`${recipe.id} has no options to read`);
  const what = recipe.title.toLowerCase();
  const bindings: Record<string, unknown> = { ...extra, inputs, page };
  const rows = await rowsOf(recipe, captures, bindings);
  const out: RecipeOption[] = [];
  for (const row of rows) {
    let made: unknown;
    try {
      made = await evaluate(recipe.answer.each, row, bindings);
    } catch (err) {
      // A row that doesn't read is skipped; a run past the limits fails as a whole.
      if (err instanceof TravelError) throw err;
      continue;
    }
    for (const o of Array.isArray(made) ? made : made === undefined ? [] : [made]) {
      const checked = Option.safeParse(withoutNulls(o));
      if (checked.success) out.push({ kind: recipe.answer.kind, ...checked.data } as RecipeOption);
    }
  }
  if (rows.length > 0 && out.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
  for (const n of notes ? (recipe.answer.notes ?? []) : []) {
    const said = await evaluate(n, null, bindings).catch(() => undefined);
    if (typeof said === 'string' && said.trim()) notes!.push(said.trim().slice(0, 400));
  }
  if (!recipe.answer.keep) return out;
  const kept: RecipeOption[] = [];
  for (const o of out) if ((await evaluate(recipe.answer.keep, o, bindings)) === true) kept.push(o);
  return kept;
}
