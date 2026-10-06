/**
 * What a job returns. The composer picks a kind ("stays", "answer"); Go sends that kind's JSON Schema as the job's
 * output_schema and reads the answer back leniently: options become a result set for an options card (prices only
 * as whole paise, images only https, offer ids only Go's own), anything else is a short summary.
 */
import { z } from 'zod';
import { clip } from '../travel/cards.js';
import { isFetchableImageUrl } from '../travel/images.js';
import type { OptionKind, ResultOption, ResultsStore } from '../travel/results.js';

export const RETURN_KINDS = ['stays', 'flights', 'trains', 'buses', 'places', 'food', 'activities', 'answer'] as const;
export type ReturnsKind = (typeof RETURN_KINDS)[number] | 'custom';
export const OPTION_KIND_FOR: Partial<Record<ReturnsKind, OptionKind>> = {
  stays: 'stay', flights: 'flight', trains: 'train', buses: 'bus', places: 'place', food: 'food', activities: 'activity',
};

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 400, description: 'Two plain sentences on what was found.' },
    options: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 80 },
          area: { type: 'string', maxLength: 80 },
          price_minor: { type: 'integer', minimum: 0, description: 'In paise: 12,800 rupees is 1280000.' },
          price_note: { type: 'string', maxLength: 40, description: 'What price_minor covers, e.g. "per night".' },
          total_paise: {
            type: ['integer', 'null'],
            minimum: 0,
            description: "The whole price in paise: the whole stay for a stay (search_stays gives it), every traveller's fare for a journey. null when you could not check it.",
          },
          highlights: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 40 } },
          rating: { type: 'number', minimum: 0, maximum: 5 },
          image_url: { type: 'string', description: 'An https image URL.' },
          offer_id: {
            type: ['string', 'null'],
            maxLength: 200,
            description: "The offer_id Go's search tools gave for this pick, copied exactly. null only for a pick found on the open web (give its source_url), or a place, restaurant or activity.",
          },
          source_url: { type: 'string', description: 'The https page it came from.' },
          why: { type: 'string', maxLength: 200, description: 'One sentence on why it fits.' },
        },
        required: ['title', 'offer_id', 'total_paise', 'highlights', 'why'],
      },
    },
  },
  required: ['summary', 'options'],
};

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 1500, description: 'The answer, in a few plain sentences.' },
    facts: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
  },
  required: ['summary'],
};

export function returnsSchema(kind: Exclude<ReturnsKind, 'custom'>): Record<string, unknown> {
  return kind === 'answer' ? ANSWER_SCHEMA : OPTIONS_SCHEMA;
}

const Returned = z.object({ summary: z.string().optional(), options: z.array(z.record(z.string(), z.unknown())).optional() });

function optionOf(kind: OptionKind, o: Record<string, unknown>): ResultOption | null {
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? clip(v, max) : null);
  const title = text(o.title, 80);
  if (!title) return null;
  const price = typeof o.price_minor === 'number' && Number.isInteger(o.price_minor) && o.price_minor >= 0 ? o.price_minor : null;
  const total = typeof o.total_paise === 'number' && Number.isInteger(o.total_paise) && o.total_paise >= 0 ? o.total_paise : null;
  const area = text(o.area, 120);
  const priceNote = text(o.price_note, 40);
  const why = text(o.why, 200);
  const image = typeof o.image_url === 'string' && isFetchableImageUrl(o.image_url) ? o.image_url : null;
  const source = typeof o.source_url === 'string' && o.source_url.startsWith('https://') ? o.source_url : null;
  const offer = typeof o.offer_id === 'string' && /^(fake|ixigo):[A-Za-z0-9._:-]{1,180}$/.test(o.offer_id) ? o.offer_id : null;
  const rating = typeof o.rating === 'number' && o.rating >= 0 && o.rating <= 5 ? o.rating : null;
  const highlights = Array.isArray(o.highlights)
    ? o.highlights.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => clip(h, 40)).slice(0, 4)
    : [];
  return {
    kind,
    title,
    highlights,
    facts: area ? { area } : {},
    ...(offer ? { offerId: offer } : {}),
    ...(price !== null ? { priceMinor: price } : {}),
    ...(total !== null ? { totalMinor: total } : {}),
    ...(price !== null || total !== null ? { currency: 'INR' } : {}),
    ...(priceNote ? { priceNote } : {}),
    ...(rating !== null ? { rating } : {}),
    ...(image ? { imageUrl: image } : {}),
    ...(source ? { sourceUrl: source } : {}),
    ...(why ? { why } : {}),
  };
}

/**
 * The answer a job wrote as JSON in its text instead of handing it in as data: the whole text, or one fenced block that
 * is the whole text. Only an object in the answer's shape (a summary or options) counts; anything else stays words.
 */
function answerInText(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const body = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed)?.[1] ?? trimmed;
  if (!body.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = Returned.safeParse(value);
  if (!parsed.success || (parsed.data.summary === undefined && parsed.data.options === undefined)) return null;
  return value as Record<string, unknown>;
}

/**
 * A job's answer, read back: the summary (or the job's text), and its options when the kind has them. With no data,
 * an answer in the text is read as the data would be (fromText says so).
 */
export function readReturned(kind: ReturnsKind, data: unknown, text: string | null): { summary: string | null; options: ResultOption[]; fromText: boolean } {
  const inText = data === null || data === undefined ? answerInText(text) : null;
  const parsed = Returned.safeParse(inText ?? data);
  const fromText = inText !== null;
  const summary = parsed.success && parsed.data.summary ? clip(parsed.data.summary, 1500) : text && !fromText ? clip(text, 1500) : null;
  const optionKind = OPTION_KIND_FOR[kind];
  if (!optionKind || !parsed.success || !parsed.data.options) return { summary, options: [], fromText };
  const options = parsed.data.options.map((o) => optionOf(optionKind, o)).filter((o): o is ResultOption => o !== null).slice(0, 5);
  return { summary, options, fromText };
}

/** The first highlight of a pick Go cannot book: it came from the open web, not from Go's search. */
export const FOUND_ON_WEB = 'Found on the web';
/** The kinds Go books through its travel layer; only their picks need an offer. */
const BOOKABLE: ReadonlySet<OptionKind> = new Set<OptionKind>(['stay', 'flight', 'train', 'bus']);

export type FindOffer = ResultsStore['findOffer'];

function fromWeb(p: ResultOption): ResultOption {
  const web: ResultOption = { ...p, highlights: [FOUND_ON_WEB, ...p.highlights.filter((h) => h !== FOUND_ON_WEB)].slice(0, 4), facts: { ...p.facts, found_on_web: true } };
  delete web.offerId;
  return web;
}

/**
 * A finished job's picks, checked against Go's own searches. A stay or journey pick whose offer id Go's own search showed in this trip
 * becomes that offer as Go checked it (title, prices, the whole-stay total, image, facts), keeping the job's reasons
 * (why, its highlights, the page it read). Every other stay or journey pick is "found on the web": no offer, so the
 * group can vote on it but P5 never books it. Places, food and activities are left as they are. checkedAt is the
 * oldest check behind the offers used (null when none was), so the card never claims a fresher price than Go has.
 */
export async function resolvePicks(
  tripId: string,
  optionKind: OptionKind,
  picks: ResultOption[],
  findOffer: FindOffer,
): Promise<{ options: ResultOption[]; checkedAt: string | null; fromWeb: number }> {
  if (!BOOKABLE.has(optionKind)) return { options: picks, checkedAt: null, fromWeb: 0 };
  let checkedAt: string | null = null;
  let web = 0;
  const options: ResultOption[] = [];
  for (const p of picks) {
    const found = p.offerId ? await findOffer(tripId, p.offerId) : null;
    if (!found || found.option.kind !== optionKind) {
      web += 1;
      options.push(fromWeb(p));
      continue;
    }
    if (checkedAt === null || found.checkedAt < checkedAt) checkedAt = found.checkedAt;
    options.push({
      ...found.option,
      highlights: p.highlights.length > 0 ? p.highlights : found.option.highlights,
      ...(p.why ? { why: p.why } : {}),
      ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
      ...(!found.option.imageUrl && p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    });
  }
  return { options, checkedAt, fromWeb: web };
}
