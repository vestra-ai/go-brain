/**
 * A recipe file, as the loader checks it: one thing a person can do on ixigo.com, as data. The format is
 * docs/design/ixigo-recipes.md, "The recipe book". Expressions (read, answer, templates) are JSONata (expr.ts).
 */
import { z } from 'zod';
import { BODY_FORMATS } from './bodies.js';

const Id = z.string().regex(/^[a-z]+(\.[a-z][a-z0-9_]*)+$/, 'an id is section.capability, in lower case');
const Expr = z.string().min(1);
/** A path on www.ixigo.com, as a template: "/buses/bus_search/{from.name}/{from.id}/…". */
const SitePath = z
  .string()
  .refine((t) => /^\/[^\s]*$/.test(t.replace(/\{[^{}]*\}/g, '')), 'a page or call is a path on www.ixigo.com, starting with /');

/** Strict: a key the format doesn't know is refused, so an unquoted "about: the city, area or region" in a YAML flow
 *  map (cut at its comma into "about: the city" and a stray key) fails the check instead of reaching the model cut. */
export const Input = z.strictObject({
  /** option: one of Go's search results, which the ixigo tool gives the recipe as that option's own ixigo page. */
  kind: z.enum(['place', 'date', 'count', 'choice', 'text', 'money', 'option']),
  /** A place's lookup recipe: ixigo's own search box for it. */
  lookup: Id.optional(),
  optional: z.boolean().default(false),
  /** A value worked out from the other inputs and the trip ($trip), when the person gave none. */
  value: Expr.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** choice: the values the page offers, not a list of ours. */
  from_page: z.boolean().optional(),
  /** What the input is, for the model that fills it. */
  about: z.string().optional(),
});
export type Input = z.infer<typeof Input>;

const CaptureObject = z.object({
  match: z.string().min(1),
  required: z.boolean().default(true),
  min_count: z.int().positive().optional(),
  max_count: z.int().positive().optional(),
  max_bytes: z.int().positive().optional(),
});
/** A call the page makes that the fetch keeps: its match alone, or with its counts and size. */
export const Capture = z.union([z.string().min(1).transform((match) => CaptureObject.parse({ match })), CaptureObject]);

/** optional: a control that may not be there (a popup shown once a day), skipped instead of failing. */
const Step = z.union([
  z.object({ op: z.literal('click'), role: z.string().optional(), name: z.string().optional(), text: z.string().optional(), optional: z.boolean().optional() }),
  /** Into the box with that role and name, or, with neither, into the box that has the focus (ixigo's flight From box). */
  z.object({ op: z.literal('type'), role: z.string().optional(), name: z.string().optional(), text: z.string().min(1), submit: z.boolean().optional(), optional: z.boolean().optional() }),
  z.object({ op: z.literal('scroll'), times: z.int().positive() }),
  z.object({ op: z.literal('wait_for'), match: z.string().min(1) }),
]);
export type Step = z.infer<typeof Step>;

/** How the page is fetched when `when` holds (a whole state's stays take two pages): its own capture, steps and time. */
const Fetch = z.object({
  when: Expr,
  capture: z.array(Capture).optional(),
  /** Steps on the page after it opens (a popup's close, a scroll for page 2). */
  steps: z.array(Step).optional(),
  timeout_ms: z.int().positive().max(20_000).optional(),
  /** How long after the data is in Bash takes its last picture, when the page draws its cards by then. */
  settle_ms: z.int().positive().max(5_000).optional(),
});

/** How a lookup's suggestions read: each entry's name, second line, "All …" mark, country, and the place kept. */
const Suggestions = z.object({
  /** The words a suggestion call was made for, from its URL: the query parameter's name. */
  words_param: z.string().min(1),
  list: Expr,
  name: Expr,
  line: Expr.optional(),
  all: Expr.optional(),
  country: Expr.optional(),
  /** Entries that are not places to search (a property, a landmark). */
  skip: Expr.optional(),
  /** What Go keeps for the place, and what other recipes read as {from.code}, {place.locationId}… */
  place: Expr,
  /** The place's own name, which the pick compares with the words (a stay's city, an airport's city). */
  place_name: Expr.optional(),
});

export const Answer = z.discriminatedUnion('as', [
  /** Options for the options card: each row becomes one or more options of this kind. */
  z.object({ as: z.literal('options'), kind: z.enum(['stay', 'flight', 'train', 'bus']), each: Expr, keep: Expr.optional() }),
  /** A card that opens the page, with what was asked set on it. */
  z.object({ as: z.literal('link'), title: z.string().min(1), who: Expr.optional() }),
  /** Facts Go says in its own words: each row as a plain object, at most max of them. */
  z.object({ as: z.literal('facts'), title: z.string().min(1), each: Expr, max: z.int().positive().max(50).default(20) }),
  /** A lookup: ixigo's suggestions for the words, which the engine picks from. */
  z.object({ as: z.literal('places'), suggestions: Suggestions }),
]);
export type Answer = z.infer<typeof Answer>;

export const RecipeFile = z
  .object({
    id: Id,
    title: z.string().min(1),
    asks: z.array(z.string().min(1)).min(1),
    inputs: z.record(z.string().regex(/^[a-z][a-z_]*$/), Input).default({}),
    auth: z.enum(['none', 'login']).default('none'),
    changes_state: z.boolean().default(false),
    /** A lookup: the kind of search whose places it resolves, kept in travel_places under that kind. */
    keeps: z.enum(['flights', 'trains', 'buses', 'stays']).optional(),
    /** A search page on ixigo with a box (lookups): the steps that type the words, per end of the search. */
    box: z.object({ page: SitePath, type: z.partialRecord(z.enum(['from', 'to', 'place']), z.array(Step)) }).optional(),
    page: SitePath.optional(),
    /**
     * The fast speed: the page's own call, made from the trip's warm ixigo tab (Bash's page_fetch): a path on ixigo, or a
     * full https address on a site the deployment allows. Its answer reads with `read`, its format as given here.
     */
    fast: z
      .object({
        url: z.string().regex(/^(\/|https:\/\/)/, 'a fast call is a path on ixigo or a full https address'),
        method: z.enum(['GET', 'POST']).default('GET'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
        format: z.enum(BODY_FORMATS).default('json'),
      })
      .optional(),
    capture: z.array(Capture).optional(),
    fetch: z.array(Fetch).optional(),
    /** The person's conditions ixigo filters on itself, each as the page's own code or param ({pool: "'FL_HF_29'"}); the
     *  ones the person set are bound as $conditions. Go's own filters still check every option. */
    conditions: z.record(z.string(), Expr).optional(),
    /** Values worked out once from the inputs and $conditions, bound by name for the page, fetch and answer. */
    let: z.record(z.string().regex(/^[a-z][a-z_]*$/), Expr).optional(),
    /** What the answer reads: the rows, from one captured call; other calls by name. */
    read: z
      .object({
        /** unique: a row's key, when a call came back more than once (pages 1 and 2) and a row may repeat. */
        /** format: json, or a Next.js flight payload (rsc), a Next.js page with one in its scripts (next_html), or an older
         *  Next.js page with its props in its __NEXT_DATA__ script (next_data). */
        rows: z.object({ from: z.string().min(1), format: z.enum(BODY_FORMATS).default('json'), list: Expr, unique: Expr.optional() }),
        also: z
          .record(z.string().regex(/^[a-z][a-z_]*$/), z.object({ from: z.string().min(1), format: z.enum(BODY_FORMATS).default('json'), value: Expr }))
          .optional(),
      })
      .optional(),
    answer: Answer,
    ttl_minutes: z.int().positive().max(60).default(10),
    measured: z.record(z.string(), z.number().nullable()).optional(),
    samples: z.record(z.string(), z.string()).optional(),
    notes: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    const path = (p: string | undefined): boolean => !!p && /(^|\/)payments(\/|$)/i.test(p);
    if (path(r.page) || r.capture?.some((c) => path(c.match)) || path(r.box?.page) || path(r.fast?.url)) {
      ctx.addIssue({ code: 'custom', message: 'no recipe may open or read anything under /payments/' });
    }
    if ((r.answer.as === 'options' || r.answer.as === 'facts') && !(r.page && r.capture && r.read)) {
      ctx.addIssue({ code: 'custom', message: `a${r.answer.as === 'options' ? 'n options' : ' facts'} answer needs page, capture and read` });
    }
    if (r.answer.as === 'places' && !(r.box && r.capture && r.keeps)) ctx.addIssue({ code: 'custom', message: 'a lookup needs box, capture and keeps' });
    if (r.answer.as === 'link' && !r.page) ctx.addIssue({ code: 'custom', message: 'a link answer needs page' });
    for (const [name, input] of Object.entries(r.inputs)) {
      if (input.kind === 'place' && !input.lookup) ctx.addIssue({ code: 'custom', message: `input ${name}: a place needs its lookup` });
    }
  });
export type RecipeFile = z.infer<typeof RecipeFile>;
