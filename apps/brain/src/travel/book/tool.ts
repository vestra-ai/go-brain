/**
 * The ixigo tool: any facts recipe in the book by its id, beyond the four searches (their own tools). Its description is
 * the book itself, one short line a recipe (its id, its inputs and what it answers), so it stays cheap as the book grows:
 * it rides in every composer call, and it is the same bytes on every turn, so the prompt cache holds it. How people ask
 * for a recipe (its asks) is for Jev and the tests, not here; a call that goes wrong answers with the recipe's inputs in
 * full. The facts come back for the model to say in its own words. A recipe that changes something on ixigo is not
 * offered here: it waits for the group's yes.
 */
import { z } from 'zod';
import type { QuickTool, TurnCtx } from '../../composer/tools.js';
import { buildIxigoLinkCard, clip, formatInr } from '../cards.js';
import { TravelError } from '../mcp-travel.js';
import type { LiveSearch } from '../live-search.js';
import { CARD_DELAY_MS, LINK_FALLBACK, SEARCH_RECIPES, shownAfter } from '../recipes/backend.js';
import { withoutPhotos } from '../photos.js';
import type { Book } from './book.js';
import type { Engine, EngineAnswer } from './engine.js';
import type { ResultOption, ResultsStore } from '../results.js';
import type { RecipeFile } from './format.js';

export interface IxigoToolDeps {
  book: Pick<Book, 'all'>;
  engine: Pick<Engine, 'answer'>;
  /** Go's saved search results and cards: an option input ("r_ab12#2", or "c_opt_x#1" off a card) is that option's own ixigo page. */
  results?: Pick<ResultsStore, 'get'> & Partial<Pick<ResultsStore, 'card' | 'offer'>>;
  /**
   * "Where should we go" as its own card (the Server team's rev 5, R2): the explorer's places (plan.explore) saved as
   * results of kind place (places-card.ts), their results_id for show_options. Absent, the places are facts alone.
   */
  placesOf?: (tripId: string, rows: Array<Record<string, unknown>>, checkedAt: string) => Promise<string | null>;
  /** Whether Go searches ixigo.com itself now (TRAVEL_MODE ixigo_web): the recipes run in the trip's browser. */
  live: () => boolean;
  /**
   * The live card for a run (live-search.ts): with it the run is watched, so its page opens on the stage where the room
   * sees it, and the card shows it; posted only once the run outlasts CARD_DELAY_MS (a kept answer posts nothing).
   */
  card?: (tripId: string, o: { runKey: string; recipe: string }) => LiveSearch;
  cardDelayMs?: number;
  /**
   * The read the early start began for a message this turn woke for, when this call is that read (its recipe, and each
   * input the read was given): the call joins it, on its card. Its answer is the call's too when the call adds only
   * inputs that narrow the same list (offers.list's bank): one read for the turn, never a second page (exam, 10 Oct).
   */
  joined?: (ctx: TurnCtx, recipe: string, inputs: Record<string, string | number>) => { runKey: string; asked: Record<string, string>; answer: Promise<EngineAnswer> } | null;
}

/**
 * The recipes the tool offers: facts or a link, changing nothing; never a search, its link or a lookup. One on the trip's
 * ixigo login (auth: login, the account's own bookings) runs once the trip is logged in: the engine asks first.
 */
export function toolRecipes(book: Pick<Book, 'all'>): RecipeFile[] {
  const searches = new Set([...Object.values(SEARCH_RECIPES), ...Object.values(LINK_FALLBACK)]);
  return book
    .all()
    .filter((r) => !searches.has(r.id) && (r.answer.as === 'facts' || r.answer.as === 'link') && !r.changes_state)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A recipe's inputs the model gives (not the ones worked out from the others), by name. */
const givenInputs = (r: RecipeFile) => Object.entries(r.inputs).filter(([, i]) => !i.value);

/** A title's first clause: "Places to visit and things to do in a destination, its best time to go, …" says "Places to visit and things to do in a destination". */
const firstClause = (title: string): string => title.split(/,\s|\s\(|;\s|:\s/)[0]!.replace(/\.$/, '');

/**
 * One recipe as the model reads it in the tool's description: "- plan.explore (origin, month, theme?): Where to go from a
 * city in a month. theme: one of ixigo's themes: …". Inputs marked ? are optional, # an option from search results. A
 * choice's values are said, since the model can't guess them; any other input's details come with an answer that went
 * wrong.
 */
function line(r: RecipeFile): string {
  const inputs = givenInputs(r).map(([name, i]) => `${name}${i.kind === 'option' ? '#' : ''}${i.optional ? '?' : ''}`).join(', ');
  const choices = givenInputs(r).filter(([, i]) => i.kind === 'choice' && i.about).map(([name, i]) => ` ${name}: ${i.about!.replace(/\s+/g, ' ').trim()}.`);
  return `- ${r.id}${inputs ? ` (${inputs})` : ''}: ${firstClause(r.title)}.${choices.join('')}`;
}

/** The tool's description: the recipes in id order, a blank line between sections, the same bytes on every turn. */
export function bookLines(recipes: RecipeFile[]): string {
  const out: string[] = [];
  let section: string | null = null;
  for (const r of recipes) {
    const s = r.id.split('.')[0]!;
    if (section !== null && s !== section) out.push('');
    section = s;
    out.push(line(r));
  }
  return out.join('\n');
}

/** How an option input is written, as an answer that went wrong says it in full. */
const OPTION_INPUT = "an option from search results, written results_id#n, like r_ab12#2, or an options card's id#n for its option n, like c_opt_ab12#1";

/** A recipe's inputs in full, for the model to call it again after an answer that went wrong. */
const inputsOf = (r: RecipeFile | undefined): Record<string, string> =>
  Object.fromEntries(
    (r ? givenInputs(r) : []).map(([name, i]) => [
      name,
      `${i.optional ? 'optional; ' : ''}${i.kind === 'option' ? OPTION_INPUT : (i.about ?? i.kind).replace(/\s+/g, ' ').trim()}`,
    ]),
  );

/**
 * The tool's own entry besides the book's recipes: what ixigo showed for one option when Go read it, kept with its saved
 * search (its fare, Lock Price, refundability, seats, times), opening no page (the exam, 10 Oct: "can we lock the price
 * while we vote?" was answered "I can't", with each flight's Lock Price already read and kept).
 */
export const KEPT = 'option.facts';
const KEPT_LINE =
  `- ${KEPT} (option#): Can we lock its price, is it refundable, how many seats are left: what ixigo showed for one option ` +
  'on a card or in search results when Go read it (Lock Price, refundability, fare, seats, times), with when. It opens no page.';

/** What the room is told with an option's kept facts: ixigo's, as of when Go read them. */
export const KEPT_FACTS_SAY =
  "Answer from these facts, as ixigo showed them when Go read them (checked_at): a line or two, saying how long ago when it matters (a price, seats left). For what they don't hold, or a price right now, run that option's own recipe or search again; never answer it from memory.";

/** An option's kept facts as one row: ixigo's own details, with its price and times as the card says them. */
function keptRow(o: ResultOption): Record<string, unknown> {
  return withoutPhotos({
    ...o.facts,
    title: o.title,
    ...(o.priceMinor !== undefined ? { price: `${formatInr(o.priceMinor)}${o.priceNote ? ` ${o.priceNote}` : ''}` } : {}),
    ...(o.totalMinor !== undefined ? { total: formatInr(o.totalMinor) } : {}),
    ...(o.journey ? { leaves: o.journey.depart_at, arrives: o.journey.arrive_at } : {}),
    ...(o.refundableUntil ? { refundable_until: o.refundableUntil } : {}),
    ...(o.rating !== undefined ? { rating: o.rating } : {}),
    ...(o.highlights.length > 0 ? { highlights: o.highlights } : {}),
  });
}

/** Go names a venue only from ixigo's own data (a well-known place also from what it knows): what the room is told about the facts it gets. */
export const NAMES_ONLY_FROM_IXIGO =
  "Answer in your own words, from these facts, as the person asked: a line or two, or a short list if they asked for some. Name a cafe, restaurant, bar, beach shack, club or shop only if it is in these facts or someone in the group named it, never one from memory, and never say why you can or can't name one. Well-known places (beaches, forts, falls, markets) you may name from what you know too. When these facts don't match the ask exactly (another area, another kind of place), offer the nearest ones in them, with no word about what ixigo doesn't have.";

/** What the model is told with the explorer's places saved for a card (rev 5 R2): a card, never a list in words. */
export const PLACES_CARD =
  "These places are saved as results_id: put the best up to three for the ask on a card with show_options (this results_id, a short title) and one short line that carries on, never a list of them in words. Each shows ixigo's estimate a person for the trip: say no other price.";

/** What the room is told with a link recipe's card (a PNR's: the person checks it on ixigo's page themselves). */
export const LINK_ON_IXIGO =
  "Say in one short line that the card opens ixigo's page, to check it there on their own phone. Never write a number they gave (a PNR), and never guess what the page will say.";

/**
 * The trip's ixigo account's own bookings (an auth: login recipe): said from its facts alone. They carry no name, PNR or
 * id (the recipes never read one), and none comes from anywhere else.
 */
export const FROM_THE_ACCOUNT =
  "Answer from these facts only, as the person asked: a line or two. Never a traveller's name, an email, a phone number, a PNR or a booking id, and never a booking that isn't in these facts.";

/** The live card's words for a run on the trip's ixigo account: "Checking ixigo: the trip's bookings". */
export const ACCOUNT_CARD = "The trip's bookings";

/** What the model is told when the trip's ixigo account has no booking for an account recipe's ask: never one from what it knows. */
export const NOTHING_ON_THE_ACCOUNT = "The trip's ixigo account has no booking for this. Say so in one short line, and never guess one.";

/** What the model is told when ixigo has nothing for a recipe's ask. */
export const NOTHING_ON_IXIGO =
  "ixigo has nothing for this. Answer from what you know, as a well-travelled friend would, with no word about ixigo: well-known places (beaches, forts, falls, markets) by name with a short reason; a cafe, restaurant, bar, beach shack, club or shop never from memory, so for those talk about the area.";

/**
 * A facts recipe run as a person watches it: on the stage, with its live card once it outlasts the card delay (a kept
 * answer posts none). The ixigo tool's runs and the early start's (travel/recipes/early.ts) both come here.
 */
export async function runOnStage(
  d: Pick<IxigoToolDeps, 'engine' | 'card' | 'cardDelayMs'>,
  tripId: string,
  runKey: string,
  recipe: Pick<RecipeFile, 'id' | 'title'> & { auth?: RecipeFile['auth'] },
  given: Record<string, unknown>,
): Promise<EngineAnswer> {
  const make = d.card;
  // The trip account's own page never shows on the stage (engine.ts): its card says what Go checked, and no more.
  const label = recipe.auth === 'login' ? ACCOUNT_CARD : recipe.title;
  const live = make ? shownAfter(d.cardDelayMs ?? CARD_DELAY_MS, () => make(tripId, { runKey, recipe: label })) : null;
  try {
    const answer = await d.engine.answer(recipe.id, given, { tripId, ...(live ? { onProgress: live.progress } : {}) });
    if (live) {
      live.progress({ type: 'extracted', count: answer.as === 'facts' ? answer.rows.length : 0 });
      await live.finish(answer.as === 'facts');
    }
    return answer;
  } catch (err) {
    if (live) await live.finish(false);
    throw err;
  }
}

const Value = z.union([z.string().min(1).max(120), z.number()]);

export function ixigoTool(d: IxigoToolDeps): QuickTool<{ recipe: string; inputs: Record<string, string | number> }> | null {
  const recipes = toolRecipes(d.book);
  if (recipes.length === 0) return null;
  // The tool's own option.facts first, then the book's: a tuple with one at least, as z.enum takes it.
  const ids: [string, ...string[]] = [KEPT, ...recipes.map((r) => r.id)];
  /**
   * "r_ab12#2": option 2 of that saved search, in this trip; "c_opt_ab12#1": option 1 on that options card, as the room
   * sees it numbered (the chat shows each card's options by number). Its own ixigo page, or null.
   */
  const optionPage = async (ref: string, tripId: string): Promise<string | null> => {
    const m = /^(\S+)#(\d{1,2})$/.exec(ref.trim());
    if (!m || !d.results) return null;
    const n = Number(m[2]);
    const set = await d.results.get(tripId, m[1]!);
    if (set) return set.options[n - 1]?.sourceUrl ?? null;
    const card = d.results.card ? await d.results.card(tripId, m[1]!) : null;
    const optionId = card?.card.options[n - 1]?.option_id;
    const offer = optionId && d.results.offer ? await d.results.offer(optionId) : null;
    return offer?.sourceUrl ?? null;
  };
  /** The same two ways to name an option, to its kept read: the option as its search saved it, and when ixigo showed it. */
  const optionOf = async (ref: string, tripId: string): Promise<{ option: ResultOption; checkedAt: string } | null> => {
    const m = /^(\S+)#(\d{1,2})$/.exec(ref.trim());
    const results = d.results;
    if (!m || !results) return null;
    const fromSet = async (resultsId: string, n: number) => {
      const set = await results.get(tripId, resultsId);
      const option = set?.options[n - 1];
      return set && option ? { option, checkedAt: set.checkedAt } : null;
    };
    const saved = await fromSet(m[1]!, Number(m[2]));
    if (saved) return saved;
    const card = results.card ? await results.card(tripId, m[1]!) : null;
    const optionId = card?.card.options[Number(m[2]) - 1]?.option_id;
    const offer = optionId && results.offer ? await results.offer(optionId) : null;
    return offer ? fromSet(offer.resultsId, offer.n) : null;
  };
  return {
    name: 'ixigo',
    description:
      "Runs one of Go's ixigo.com recipes in the trip's browser and answers with what ixigo shows, for what the searches " +
      "don't cover. A line a recipe: its id, its inputs (? optional, # an option from this trip's search results, written " +
      `results_id#n like r_ab12#2, or an options card's id#n as the chat numbers its options, like c_opt_ab12#1) and what it answers. ` +
      `Each id is a value of this tool's recipe field, never a tool of its own: call ixigo with {"recipe": "<its id>", "inputs": {…}}.\n${bookLines(recipes)}\n\n${KEPT_LINE}`,
    input: z.object({
      recipe: z.enum(ids).describe('The recipe id'),
      inputs: z.record(z.string(), Value).describe('The recipe\'s inputs by name, places as the person said them, dates as YYYY-MM-DD'),
    }),
    timeoutMs: 15_000,
    misnamed(name) {
      // "hotels.rooms_placeholder" (10 Oct drill): a recipe's id called as a tool, with or without more after it.
      const norm = (s: string): string => s.toLowerCase().replace(/_/g, '.');
      if (norm(name) === KEPT) return `There is no tool named ${name}: ${KEPT} is a recipe of the ixigo tool. Call ixigo with {"recipe": "${KEPT}", "inputs": {"option": "${OPTION_INPUT}"}}.`;
      const r = recipes.filter((x) => norm(name) === norm(x.id) || norm(name).startsWith(`${norm(x.id)}.`)).sort((x, y) => y.id.length - x.id.length)[0];
      if (!r) return undefined;
      return `There is no tool named ${name}: ${r.id} is a recipe of the ixigo tool. Call ixigo with {"recipe": "${r.id}", "inputs": ${JSON.stringify(inputsOf(r))}}.`;
    },
    async run(a, ctx: TurnCtx) {
      // An option's kept facts are Go's own read: no page opens, so they answer whether or not Go searches ixigo.com now.
      if (a.recipe === KEPT) {
        const kept = a.inputs['option'] !== undefined ? await optionOf(String(a.inputs['option']), ctx.tripId) : null;
        if (!kept) return { recipe: KEPT, error: 'needs_more', note: "option is not an option in this trip's search results: give it as results_id#n from a search, or card_id#n off an options card in the chat.", inputs: { option: OPTION_INPUT } };
        return { recipe: KEPT, title: kept.option.title, checked_at: kept.checkedAt, facts: [keptRow(kept.option)], tell_the_room: KEPT_FACTS_SAY };
      }
      if (!d.live()) return { recipe: a.recipe, error: 'not_here', note: "Go's ixigo recipes run only when Go searches ixigo.com itself." };
      const recipe = recipes.find((r) => r.id === a.recipe);
      // A link takes its own inputs only: a PNR the model passes anyway never reaches the engine, the card or a log.
      const link = recipe?.answer.as === 'link';
      const given: Record<string, unknown> = recipe && link ? Object.fromEntries(Object.entries(a.inputs).filter(([k]) => k in recipe.inputs)) : { ...a.inputs };
      for (const [name, input] of Object.entries(recipe?.inputs ?? {})) {
        if (input.kind !== 'option' || given[name] === undefined) continue;
        const page = await optionPage(String(given[name]), ctx.tripId);
        if (!page) return { recipe: a.recipe, error: 'needs_more', note: `${name} is not an option in this trip's search results: give it as results_id#n from a search, or card_id#n off an options card in the chat.`, inputs: inputsOf(recipe) };
        given[name] = page;
      }
      const early = d.joined?.(ctx, a.recipe, a.inputs) ?? null;
      const runKey = early?.runKey ?? `${ctx.turnId ?? ''}|${a.recipe}|${JSON.stringify(given)}`;
      // What the call adds to the early read: inputs that only narrow its list take its answer (a read that failed is
      // read again); any other is a read of its own.
      const added = early ? Object.keys(a.inputs).filter((k) => !(k in early.asked)) : [];
      const takes = early !== null && recipe !== undefined && !link && added.every((k) => recipe.inputs[k]?.narrows === true);
      try {
        const shared = takes ? await early.answer.catch(() => null) : null;
        // A link opens no page on the stage: it is a card.
        const answer = shared ?? (recipe && !link ? await runOnStage(d, ctx.tripId, runKey, recipe, given) : await d.engine.answer(a.recipe, given, { tripId: ctx.tripId }));
        const wider = shared && added.length > 0 ? { note: `Read for ${JSON.stringify(early!.asked)}: keep only what fits ${added.map((k) => `${k} ${a.inputs[k]}`).join(', ')}.` } : {};
        if (answer.as === 'link') {
          ctx.cards.push(buildIxigoLinkCard({ cardId: ctx.stableId('c_link'), title: answer.title, url: answer.link }));
          return { recipe: a.recipe, link: answer.link, note: 'The card with the link goes out with your message.', tell_the_room: LINK_ON_IXIGO };
        }
        if (answer.as !== 'facts') return { recipe: a.recipe, error: 'refused', note: 'This recipe answers with options: use the search tools.' };
        // The account's own bookings are its facts alone: none is ever answered from what the model knows.
        const account = recipe?.auth === 'login';
        if (answer.rows.length === 0) {
          return { recipe: a.recipe, title: answer.title, facts: [], note: account ? NOTHING_ON_THE_ACCOUNT : NOTHING_ON_IXIGO };
        }
        // "Where should we go": the places on a card of their own (rev 5 R2), never only words.
        const places = a.recipe === 'plan.explore' && d.placesOf ? await d.placesOf(ctx.tripId, answer.rows, answer.checkedAt).catch(() => null) : null;
        const note = [...('note' in wider ? [wider.note] : []), ...(places ? [PLACES_CARD] : [])];
        return {
          recipe: a.recipe, title: answer.title, checked_at: answer.checkedAt, source: answer.page, facts: answer.rows.map(withoutPhotos),
          ...(places ? { results_id: places } : {}), ...(note.length ? { note: note.join(' ') } : {}), tell_the_room: account ? FROM_THE_ACCOUNT : NAMES_ONLY_FROM_IXIGO,
        };
      } catch (err) {
        if (!(err instanceof TravelError)) throw err;
        if (err.code === 'pick_place') return { recipe: a.recipe, choose: err.message };
        // The description says each input's name only: an answer that went wrong says them in full, to call again with.
        return { recipe: a.recipe, error: err.code, note: clip(err.message, 200), inputs: inputsOf(recipe) };
      }
    },
  };
}
