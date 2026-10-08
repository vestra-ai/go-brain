/**
 * The ixigo tool: any facts recipe in the book by its id, beyond the four searches (their own tools). Its description is
 * the book itself: each recipe's id, title, inputs and how people ask for it. The facts come back for the model to say
 * in its own words. A recipe that changes something on ixigo is not offered here: it waits for the group's yes.
 */
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../../composer/tools.js';
import { clip } from '../cards.js';
import { TravelError } from '../mcp-travel.js';
import { SEARCH_RECIPES } from '../recipes/backend.js';
import type { Book } from './book.js';
import type { Engine } from './engine.js';
import type { ResultsStore } from '../results.js';
import type { RecipeFile } from './format.js';

export interface IxigoToolDeps {
  book: Pick<Book, 'all'>;
  engine: Pick<Engine, 'answer'>;
  /** Go's saved search results: an option input ("r_ab12#2") is that option's own ixigo page. */
  results?: Pick<ResultsStore, 'get'>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the recipes run in the trip's browser. */
  live: () => boolean;
}

/** The recipes the tool offers: facts, open to anyone, changing nothing; never a search or a lookup. */
export function toolRecipes(book: Pick<Book, 'all'>): RecipeFile[] {
  const searches = new Set(Object.values(SEARCH_RECIPES));
  return book
    .all()
    .filter((r) => !searches.has(r.id) && r.answer.as === 'facts' && !r.changes_state && r.auth === 'none')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One recipe as the model reads it in the tool's description. */
function line(r: RecipeFile): string {
  const inputs = Object.entries(r.inputs)
    .filter(([, i]) => !i.value)
    .map(([name, i]) => `${name}${i.optional ? '?' : ''}${i.kind === 'option' ? ' (an option from search results, written results_id#n, like r_ab12#2)' : i.about ? ` (${i.about})` : ''}`)
    .join(', ');
  return `- ${r.id}: ${r.title}. Inputs: ${inputs || 'none'}. Asked as: "${r.asks.slice(0, 2).join('", "')}".`;
}

/** Go names a place only from ixigo's own data: what the room is told about the facts it gets. */
export const NAMES_ONLY_FROM_IXIGO =
  "Answer in your own words, from these facts, as the person asked: a line or two, or a short list if they asked for some. Name a cafe, restaurant, bar, beach or sight only if it is in these facts or someone in the group named it; never one from memory.";

const Value = z.union([z.string().min(1).max(120), z.number()]);

export function ixigoTool(d: IxigoToolDeps): QuickTool<{ recipe: string; inputs: Record<string, string | number> }> | null {
  const recipes = toolRecipes(d.book);
  if (recipes.length === 0) return null;
  const ids = recipes.map((r) => r.id) as [string, ...string[]];
  /** "r_ab12#2": option 2 of that saved search, in this trip; its own ixigo page, or null. */
  const optionPage = async (ref: string, tripId: string): Promise<string | null> => {
    const m = /^(\S+)#(\d{1,2})$/.exec(ref.trim());
    if (!m || !d.results) return null;
    const set = await d.results.get(tripId, m[1]!);
    return set?.options[Number(m[2]) - 1]?.sourceUrl ?? null;
  };
  return {
    name: 'ixigo',
    description:
      "Runs one of Go's ixigo.com recipes in the trip's browser and answers with what ixigo shows. Use it for what the " +
      `searches don't cover. The recipes:\n${recipes.map(line).join('\n')}`,
    input: z.object({
      recipe: z.enum(ids).describe('The recipe id'),
      inputs: z.record(z.string(), Value).describe('The recipe\'s inputs by name, places as the person said them, dates as YYYY-MM-DD'),
    }),
    timeoutMs: 15_000,
    async run(a, ctx: TurnCtx) {
      if (!d.live()) return { recipe: a.recipe, error: 'not_here', note: "Go's ixigo recipes run only when Go searches ixigo.com itself." };
      const recipe = recipes.find((r) => r.id === a.recipe);
      const given: Record<string, unknown> = { ...a.inputs };
      for (const [name, input] of Object.entries(recipe?.inputs ?? {})) {
        if (input.kind !== 'option' || given[name] === undefined) continue;
        const page = await optionPage(String(given[name]), ctx.tripId);
        if (!page) return { recipe: a.recipe, error: 'needs_more', note: `${name} is not an option in this trip's search results: give it as results_id#n, from a search.` };
        given[name] = page;
      }
      try {
        const answer = await d.engine.answer(a.recipe, given, { tripId: ctx.tripId });
        if (answer.as !== 'facts') return { recipe: a.recipe, error: 'refused', note: 'This recipe answers with options: use the search tools.' };
        if (answer.rows.length === 0) {
          return { recipe: a.recipe, title: answer.title, facts: [], note: 'ixigo has nothing for this. Say so in one line, and name no place from memory.' };
        }
        return { recipe: a.recipe, title: answer.title, checked_at: answer.checkedAt, source: answer.page, facts: answer.rows, tell_the_room: NAMES_ONLY_FROM_IXIGO };
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        if (err.code === 'pick_place') return { recipe: a.recipe, choose: err.message };
        return { recipe: a.recipe, error: err.code, note: clip(err.message, 200) };
      }
    },
  };
}
