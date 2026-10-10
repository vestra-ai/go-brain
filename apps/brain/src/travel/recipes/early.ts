/**
 * The early start: when a whole travel ask to Go lands, its search begins on intake, before the composer's turn, and
 * the turn starts at once instead of waiting 2 s for more lines. In every TRAVEL_MODE, so a search ask is one model call
 * wherever the list comes from: the right-now block hands the turn its answer. The composer's own search_* call later
 * joins the same search (the layer shares one in flight, and ixigo_web by recipe and slots). A follow-up line ("after
 * 6 pm") still reaches the turn, and its filter applies to the same list.
 *
 * Travel intent wakes the trip's computer (warmForTravel): a line Jev's question 10 is sure asks for a search, from
 * anyone, to Go or not, and the search this hook starts. Other lines never wake it. Flights answer with ixigo's link.
 *
 * The other ixigo asks Jev picks (a train's running status, its timetable, a waitlist's chance, a place's guide, the
 * offers, a shown stay's rooms or reviews, and more: fast.ts) start the same way where Go searches ixigo.com itself: their recipe
 * runs at once on the stage with its live card (book/tool.ts runOnStage), and the turn's right-now part hands over its facts
 * (now.ts earlyReadNow). The ixigo tool's call for the same read joins it and updates the same card (joinKey). Each acts only once its choice
 * is live (reflex/live-gate.ts LIVE_RECIPES); until then Jev's pick of one acts as none.
 */
import type { Switches } from '../../admin/switches.js';
import type { Message } from '../../door/methods.js';
import { isSearchChoice, type FastChoice } from '../../reflex/questions.js';
import type { ReflexRead } from '../../reflex/reflex.js';
import type { HookAnswer } from '../../trips/hooks.js';
import { plainlyNamesGo } from '../../trips/names-go.js';
import type { TripPack } from '../../trips/pack.js';
import type { EngineAnswer } from '../book/engine.js';
import type { Travel, TravelKind, TravelQuery, TravelSearch } from '../travel.js';
import { agreedDates, readTravelAsk } from './ask.js';
import { bankIn, OPTION_KINDS, readFastAsk, type ShownOption } from './fast.js';
import { RECIPE_TTL_MS } from './recipe.js';

export interface EarlyStartDeps {
  travel: () => Travel | undefined;
  switches: Pick<Switches, 'get'>;
  /** Today in the trip's time zone. */
  today: (tripId: string) => Promise<string>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Wakes the trip's computer for a search of this kind and holds it two minutes (travel/register.ts); absent in tests. */
  warmForTravel?: (tripId: string, kind: TravelKind | null) => void;
  /** Kinds never started early (the backend's LINK_ONLY_KINDS: flights, whose page is paced and else a link). */
  linkOnly?: (kind: TravelKind) => boolean;
  /** The book's recipes, for the asks beyond the searches (fast.ts). Absent, none of those start early. */
  recipes?: {
    has(id: string): boolean;
    /** Runs one on the stage, with its live card keyed by runKey. */
    run(id: string, given: Record<string, unknown>, o: { tripId: string; runKey: string }): Promise<EngineAnswer>;
    /** Reads one off the stage, with no card: its fastest speed (an offer's terms beside the list the room watched). */
    read?(id: string, given: Record<string, unknown>, o: { tripId: string }): Promise<EngineAnswer>;
  };
  /** The shown option a line points at, on the trip's newest card of its kind (option-on-card.ts). */
  optionFor?: (tripId: string, text: string, kind: 'stay' | 'flight') => Promise<ShownOption | null>;
  /**
   * The group's decided budget for the stay, per person, in paise, or null (register.ts, as the search tool takes it): a
   * stays read early takes ixigo's price bands by it, as the composer's search will, so both are one read.
   */
  stayBudget?: (tripId: string) => Promise<number | null>;
}

/** An ixigo read a message started on intake: a recipe beyond the searches (fast.ts). */
export interface EarlyRead {
  choice: FastChoice;
  recipe: string;
  /** Its inputs as the ixigo tool takes them, for a turn that calls the tool while it still runs (it joins the read). */
  asked: Record<string, string>;
  answer: Promise<EngineAnswer>;
  /** Its live card's key: the tool's call that joins the read updates this card. */
  runKey: string;
}

/** A search a message started on intake. */
export interface EarlySearch {
  kind: TravelKind;
  query: TravelQuery;
  search: Promise<TravelSearch>;
  /** A live card in the room shows the search (ixigo_web) and has already said "On it." */
  live: boolean;
}

export interface EarlyStart {
  /** The message hook: starts the search and says the turn is due now, or does nothing. */
  onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<HookAnswer | undefined>;
  /** The search this message started, while it is fresh (its recipe's ten minutes); null when it started none. */
  searchFor(tripId: string, messageId: string): EarlySearch | null;
  /** The ixigo read this message started, while it is fresh; null when it started none. */
  readFor(tripId: string, messageId: string): EarlyRead | null;
  /**
   * The card key of a read one of these messages started, when a call of this recipe with these inputs is that read:
   * the tool's call joins it, and updates its card instead of posting a second. Null for any other call.
   */
  joinKey(tripId: string, messageIds: string[], recipe: string, inputs: Record<string, string | number>): string | null;
  /** That read itself, for the tool's call that can take its answer (book/tool.ts: what the call adds only narrows it). */
  joined(tripId: string, messageIds: string[], recipe: string, inputs: Record<string, string | number>): EarlyRead | null;
  /**
   * The message asks for stays: Jev is sure of it, or its stays search began here. Its own search is the trip's one load
   * for it, whatever its place, so the stays head start (warm.ts) loads nothing beside it.
   */
  asksStays(tripId: string, messageId: string): boolean;
}

const KEPT_MAX = 200;

/** An offer's own terms page: its code, the least the booking must come to, the most it takes off, the days it works. */
export const OFFER_TERMS = 'offers.details';
/** How many of the offers an ask names a bank for get their terms read. */
export const TERMS_MAX = 3;

/** What an offer's terms add to its line on the list: none of its long text, which the ixigo tool gives in full. */
const TERMS_FIELDS = ['code', 'min_booking', 'max_off', 'valid_on', 'from', 'until', 'table', 'slabs'] as const;

/**
 * The list with the terms of the offers that fit the bank the ask names (exam, 10 Oct: "the ICICI offer" was answered
 * with no code, no minimum and no days, as the list has none of them): at most TERMS_MAX, each from its own terms page
 * (offers.list's "details", hotels.offers' "terms" link), read together. A page that doesn't load leaves its line as it was.
 */
export async function withTerms(list: EngineAnswer, bank: string, read: (offer: string) => Promise<EngineAnswer>): Promise<EngineAnswer> {
  if (list.as !== 'facts') return list;
  const key = bank.toLowerCase().replace(/\b(bank|credit cards?|debit cards?|cards?)\b/g, '').trim();
  const pageOf = (row: Record<string, unknown>): string | null => {
    const page = row['details'] ?? row['terms'];
    return typeof page === 'string' && page.trim() ? page : null;
  };
  const fits = (row: Record<string, unknown>): boolean =>
    key !== '' && `${String(row['bank'] ?? '')} ${String(row['offer'] ?? '')}`.toLowerCase().includes(key);
  const picked = list.rows.filter((row) => pageOf(row) && fits(row)).slice(0, TERMS_MAX);
  if (picked.length === 0) return list;
  const terms = new Map(
    await Promise.all(
      picked.map(async (row) => {
        const got = await read(pageOf(row)!).catch(() => null);
        const t = got?.as === 'facts' ? got.rows[0] : undefined;
        return [row, t ? Object.fromEntries(TERMS_FIELDS.flatMap((f): Array<[string, unknown]> => (t[f] !== undefined && t[f] !== null ? [[f, t[f]]] : []))) : null] as const;
      }),
    ),
  );
  return { ...list, rows: list.rows.map((row) => (terms.get(row) ? { ...row, ...terms.get(row)! } : row)) };
}

/** Whether an ask names all its search needs: the places and the date, or the stay's place and its two dates. */
const complete = (kind: TravelKind, q: TravelQuery): boolean =>
  kind === 'stays' ? !!((q.area ?? q.to) && q.checkIn && q.checkOut) : !!(q.from && q.to && q.date);

/** Keeps the newest entries of a map, oldest out first. */
function keep<T>(m: Map<string, T>, key: string, value: T): void {
  m.set(key, value);
  while (m.size > KEPT_MAX) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

export function createEarlyStart(d: EarlyStartDeps): EarlyStart {
  const started = new Map<string, EarlySearch & { at: number }>();
  const reads = new Map<string, EarlyRead & { at: number }>();
  const staysAsks = new Map<string, true>();

  /** An ixigo ask beyond the searches: its recipe runs now, where Go searches ixigo.com itself and the words give its slots. */
  async function startRead(choice: FastChoice, msg: Message & { text: string }, pack: TripPack, today: string): Promise<HookAnswer | undefined> {
    if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web' || !d.recipes) return undefined;
    const tripId = pack.trip.trip_id;
    const card = OPTION_KINDS[choice];
    const option = card ? ((await d.optionFor?.(tripId, msg.text, card)) ?? null) : null;
    const dates = pack.trip.dates ?? agreedDates(pack.trip.record, today);
    const ask = readFastAsk(choice, msg.text, { today, destination: pack.trip.destination?.name ?? null, dates, option });
    if (!ask || !d.recipes.has(ask.recipe)) return undefined;
    const runKey = `early:${msg.message_id}|${ask.recipe}`;
    const listed = d.recipes.run(ask.recipe, ask.given, { tripId, runKey });
    // An offers ask that names a bank: the fitting offers' terms too, read off the stage once the list is in.
    const bank = choice === 'offers' ? bankIn(msg.text) : null;
    const read = d.recipes.read;
    const answer = bank && read && d.recipes.has(OFFER_TERMS) ? listed.then((l) => withTerms(l, bank, (offer) => read(OFFER_TERMS, { offer }, { tripId }))) : listed;
    answer.catch((err: unknown) => {
      // A PNR's read never logs its error: the message could carry the number.
      d.log.warn({ ...(choice === 'pnr' ? {} : { err }), tripId, recipe: ask.recipe }, 'travel: an early ixigo read failed; the composer reads again');
    });
    keep(reads, `${tripId}:${msg.message_id}`, { choice, recipe: ask.recipe, asked: ask.asked, answer, runKey, at: d.now().getTime() });
    return { dueNow: true };
  }

  /**
   * The read one of these messages started that a call of this recipe with these inputs is: each input the read was
   * given, the same as words ("12051" and 12051, "Thivim" and "thivim"). A read whose inputs the tool never sees (a PNR's)
   * is joined by its recipe alone.
   */
  function joined(tripId: string, messageIds: string[], recipe: string, inputs: Record<string, string | number>): EarlyRead | null {
    const word = (v: unknown): string => String(v ?? '').trim().toLowerCase();
    for (const id of messageIds) {
      const r = readFor(tripId, id);
      if (r?.recipe === recipe && Object.entries(r.asked).every(([k, v]) => word(inputs[k]) === word(v))) return r;
    }
    return null;
  }

  function readFor(tripId: string, messageId: string): EarlyRead | null {
    const r = reads.get(`${tripId}:${messageId}`);
    if (!r || d.now().getTime() - r.at >= RECIPE_TTL_MS) return null;
    return { choice: r.choice, recipe: r.recipe, asked: r.asked, answer: r.answer, runKey: r.runKey };
  }

  return {
    async onRead(msg, read, pack) {
      const web = d.switches.get('TRAVEL_MODE') === 'ixigo_web';
      const tripId = pack.trip.trip_id;
      // Jev's question 10, when it is sure: its kind wins over the parser's; "none" (travel talk, not a search ask) starts
      // nothing. A sure kind is travel intent, whoever the line is to: the box wakes for the search or read that follows.
      const pick = read.recipe;
      const kind = pick?.sure && pick.value && isSearchChoice(pick.value) ? pick.value : null;
      const fast = pick?.sure && pick.value && !isSearchChoice(pick.value) ? pick.value : null;
      if (kind || fast) d.warmForTravel?.(tripId, kind);
      if (kind === 'stays') keep(staysAsks, `${tripId}:${msg.message_id}`, true);
      if (!msg.text) return undefined;
      const today = await d.today(tripId);
      // To Go: named plainly, or the quick read is sure it is for Go.
      if (!plainlyNamesGo(msg, pack) && !(read.forGo.sure && read.forGo.value === true)) return undefined;
      if (fast) return startRead(fast, { ...msg, text: msg.text }, pack, today);
      const travel = d.travel();
      if (!travel) return undefined;
      // Jev sure it is not a search ask: nothing starts. Unsure, the parser decides alone.
      if (pick?.sure && pick.value === null) return undefined;
      // The trip's dates; before they are set, the ones the group agreed in its record ("6 to 9 Nov").
      const dates = pack.trip.dates ?? agreedDates(pack.trip.record, today);
      // Jev sure of the kind, where Go searches ixigo.com itself: places as written, which ixigo's own box resolves (the
      // engine's lookup, kept answers first), so an ask from any city starts early (10 Oct: "from Bangalore" never did).
      const ask = readTravelAsk(msg.text, {
        today, destination: pack.trip.destination?.name ?? null, dates, ...(kind ? { kind, ...(web ? { asWritten: true } : {}) } : {}),
      });
      if (!ask) return undefined;
      // An ask missing a place or a date: the composer asks, as usual.
      if (!complete(ask.kind, ask.query)) return undefined;
      // A link answers at once: the turn starts now, with nothing to search early.
      if (web && d.linkOnly?.(ask.kind)) return { dueNow: true };
      // The parser found the ask without a sure kind from Jev: this search is the travel intent.
      if (!kind) d.warmForTravel?.(tripId, ask.kind);
      // A stays ask takes the budget the search tool will (tools.ts runSearch): its own a head, else the group's decided one.
      if (ask.kind === 'stays') {
        const budget = ask.query.maxShareMinor ?? (d.stayBudget ? await d.stayBudget(tripId).catch(() => null) : null);
        if (budget) ask.query.budgetMinor = budget;
      }
      if (ask.kind === 'stays') keep(staysAsks, `${tripId}:${msg.message_id}`, true);
      // Not awaited: the hooks run one after another, and nothing should wait on the page.
      const search = travel.search(ask.kind, ask.query, { tripId, messageId: msg.message_id });
      search.catch((err: unknown) => {
        d.log.warn({ err, tripId, kind: ask.kind }, 'travel: an early search failed; the composer searches again');
      });
      keep(started, `${tripId}:${msg.message_id}`, { ...ask, search, live: web, at: d.now().getTime() });
      return { dueNow: true };
    },
    searchFor(tripId, messageId) {
      const s = started.get(`${tripId}:${messageId}`);
      if (!s || d.now().getTime() - s.at >= RECIPE_TTL_MS) return null;
      return { kind: s.kind, query: s.query, search: s.search, live: s.live };
    },
    readFor,
    joinKey(tripId, messageIds, recipe, inputs) {
      return joined(tripId, messageIds, recipe, inputs)?.runKey ?? null;
    },
    joined,
    asksStays: (tripId, messageId) => staysAsks.has(`${tripId}:${messageId}`),
  };
}
