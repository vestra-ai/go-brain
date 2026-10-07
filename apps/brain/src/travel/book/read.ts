/**
 * A recipe's answer from what its page sent: the rows (read.rows, from one captured call), the other calls it reads
 * (read.also, bound by name), and each row as an option (answer.each). Every option is checked: one that doesn't check out
 * is dropped, never half read, and a page where nothing reads is refused.
 */
import { z } from 'zod';
import { TravelError } from '../mcp-travel.js';
import { bodiesFor, type Capture, type RecipeOption } from '../recipes/recipe.js';
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
  place: z.object({ name: z.string().min(1).max(120), address: z.string().max(200).optional(), lat: z.number().optional(), lng: z.number().optional() }).optional(),
  imageUrl: z.url().optional(),
  rating: z.number().min(0).max(5).optional(),
  highlights: z.array(z.string().min(1).max(80)).max(4),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  sourceUrl: z.url(),
});

/** One response body a recipe reads, by its capture's match. */
function body(captures: Capture[], match: string, required: boolean, what: string): unknown {
  const raw = bodiesFor(captures, match);
  if (raw.length === 0) {
    if (required) throw new TravelError('refused', `ixigo's page did not send ${what}.`);
    return undefined;
  }
  try {
    // A call that came back more than once (pages 1 and 2) reads as the list of its bodies.
    return raw.length === 1 ? JSON.parse(raw[0]!) : raw.map((b) => JSON.parse(b));
  } catch {
    throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
  }
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
): Promise<RecipeOption[]> {
  if (!recipe.read || recipe.answer.as !== 'options') throw new Error(`${recipe.id} has no options to read`);
  const what = recipe.title.toLowerCase();
  const rowsBody = body(captures, recipe.read.rows.from, true, what);
  const bindings: Record<string, unknown> = { ...extra, inputs, page };
  for (const [name, also] of Object.entries(recipe.read.also ?? {})) {
    const b = body(captures, also.from, false, name);
    bindings[name] = b === undefined ? undefined : await evaluate(also.value, b, bindings);
  }
  const listed = await evaluate(recipe.read.rows.list, rowsBody, bindings);
  let rows: unknown[] = Array.isArray(listed) ? listed : listed === undefined ? [] : [listed];
  if (recipe.read.rows.unique) {
    const seen = new Set<string>();
    const kept: unknown[] = [];
    for (const row of rows) {
      const key = JSON.stringify(await evaluate(recipe.read.rows.unique, row, bindings) ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(row);
    }
    rows = kept;
  }
  const out: RecipeOption[] = [];
  for (const row of rows) {
    let made: unknown;
    try {
      made = await evaluate(recipe.answer.each, row, bindings);
    } catch {
      continue;
    }
    for (const o of Array.isArray(made) ? made : made === undefined ? [] : [made]) {
      const checked = Option.safeParse(o);
      if (checked.success) out.push({ kind: recipe.answer.kind, ...checked.data } as RecipeOption);
    }
  }
  if (rows.length > 0 && out.length === 0) throw new TravelError('refused', `ixigo answered ${what} in a shape Go does not read.`);
  if (!recipe.answer.keep) return out;
  const kept: RecipeOption[] = [];
  for (const o of out) if ((await evaluate(recipe.answer.keep, o, bindings)) === true) kept.push(o);
  return kept;
}
