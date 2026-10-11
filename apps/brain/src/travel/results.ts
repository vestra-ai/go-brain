/**
 * Result sets (what a search or a finished job found, as checked), the options cards Go posted from them, and the
 * offers on those cards. An option_id on a card, and a vote option's option_ref, both name a row here.
 */
import type pg from 'pg';
import { MORE_OPTIONS, type Journey, type Place } from '@go/contract';
import type { OptionsCardT } from './cards.js';
import { mintId } from './ids.js';
import type { StoredOffer, TravelOption } from './travel.js';

export type OptionKind = OptionsCardT['option_kind'];

export interface ResultOption {
  /** Set when the option can be booked through Go (it came from Go's travel search). */
  offerId?: string;
  kind: OptionKind;
  title: string;
  subtitle?: string;
  priceMinor?: number;
  currency?: string;
  priceNote?: string;
  totalMinor?: number;
  journey?: Journey;
  place?: Place;
  imageUrl?: string;
  imageUrls?: string[];
  amenities?: string[];
  logoUrl?: string;
  rating?: number;
  highlights: string[];
  refundableUntil?: string;
  facts: Record<string, string | number | boolean>;
  sourceUrl?: string;
  why?: string;
}

export interface ResultSet {
  resultsId: string;
  tripId: string;
  optionKind: OptionKind;
  source: 'search' | 'task';
  query: Record<string, unknown>;
  options: ResultOption[];
  checkedAt: string;
  /** The results page the search read on ixigo.com, where the whole list is: "See all on ixigo" opens it. */
  page?: string | null;
  /**
   * ixigo has more of this search than the set holds: a stays list whose one page read was full. "See more" reads its next
   * page once the set's own are all shown (taps.ts), and the set then holds both.
   */
  siteMore?: boolean;
}

/** What a card's option may gain after the card went up (results.setOptionFields): a bus's line its drops (bus-drops.ts) too. */
export type OptionFields = Partial<Pick<OptionsCardT['options'][number], 'photos' | 'room_types' | 'price_min_minor' | 'price_max_minor' | 'subtitle' | 'place' | 'details' | 'image_url'>>;

export interface OptionsCardRow {
  cardId: string;
  tripId: string;
  resultsId: string;
  title: string;
  optionKind: OptionKind;
  card: OptionsCardT;
  /** A vote's decision_id, "pending:<key>" while one is being opened, or null. */
  decisionId: string | null;
  /** Who opened the vote: a turn id or a tap id. The same key again is a rerun, not a second vote. */
  voteKey: string | null;
}

/**
 * The prefix of a "See more" card's id (taps.ts, rev 5 R4): more of a card already up, never the trip's newest card of its
 * kind for what reads that (topPick, recipes/option-on-card.ts).
 */
export const MORE_CARD = 'c_more';

/** A stay's own page on ixigo.com: its hotel id, whatever token a read gave its address (web-stays.ts DETAILS). */
const STAY_PAGE = /^https:\/\/www\.ixigo\.com\/hotels\/(\d+)\/details\?/;

/**
 * An option as "See more" tells it from the others: a stay on ixigo by its hotel (a second read of the same page gives
 * its address a new token), else its own page, else its name and when it leaves.
 */
export const optionKey = (o: ResultOption): string => {
  const hotel = o.sourceUrl ? STAY_PAGE.exec(o.sourceUrl)?.[1] : undefined;
  return hotel ? `hotel:${hotel}` : (o.sourceUrl ?? `${o.title}|${o.journey?.depart_at ?? ''}`);
};

/** A page's address without its query: a stay's /hotels/<id>/details, a train's /trains/<number>, a bus's #operator@time. */
function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}${u.hash}`;
  } catch {
    return null;
  }
}
const titleKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The option a page shows, among one search's options: its exact address first, then the same page with another query.
 * Flights share their search page, so several on one page are told apart by the title; still several, or none, is null.
 */
export function optionOnPage(options: readonly ResultOption[], sourceUrl: string, title: string): ResultOption | null {
  const key = pageKey(sourceUrl);
  const ways: Array<(o: ResultOption) => boolean> = [
    (o) => o.sourceUrl === sourceUrl,
    (o) => key !== null && !!o.sourceUrl && pageKey(o.sourceUrl) === key,
  ];
  for (const same of ways) {
    const hits = options.filter(same);
    if (hits.length === 1) return hits[0]!;
    const named = hits.filter((o) => titleKey(o.title) === titleKey(title));
    if (named.length === 1) return named[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}

/** A search's options that no card has shown yet (shown: results.shownFrom), by their numbers in the search. */
export function unseenNumbers(set: Pick<ResultSet, 'options'>, shown: ResultOption[]): number[] {
  const seen = new Set(shown.map(optionKey));
  return set.options.flatMap((o, i) => (seen.has(optionKey(o)) ? [] : [i + 1]));
}

export interface ResultsStore {
  save(s: Omit<ResultSet, 'resultsId'> & { resultsId?: string }): Promise<ResultSet>;
  get(tripId: string, resultsId: string): Promise<ResultSet | null>;
  /**
   * ixigo's next page of a search, read for "See more": its new options after the set's own, the query it was read with,
   * and whether ixigo has more still. The set as kept now, or null when the trip has no such set.
   */
  extend(tripId: string, resultsId: string, next: { options: ResultOption[]; query: Record<string, unknown>; siteMore: boolean }): Promise<ResultSet | null>;
  /**
   * The offer as Go's own search last showed it in this trip (the composer's search, or the trip's computer's through
   * Go's MCP server), with that check's time; null when no search of this trip showed it. A job's answer is never a source.
   */
  findOffer(tripId: string, offerId: string): Promise<{ option: ResultOption; checkedAt: string } | null>;
  /**
   * The option a page on ixigo.com shows, as Go's own search of this trip last read it there (optionOnPage), with that
   * check's time: how a job's pick read off ixigo.com, which has no offer id, finds Go's option. Null when none did.
   */
  findBySource(tripId: string, kind: OptionKind, sourceUrl: string, title: string): Promise<{ option: ResultOption; checkedAt: string } | null>;
  /** The trip and the check-in or departure day of the newest search that showed this offer. */
  searchedFor(offerId: string): Promise<{ tripId: string; day: string | null } | null>;
  saveCard(
    row: Pick<OptionsCardRow, 'cardId' | 'tripId' | 'resultsId' | 'title' | 'optionKind' | 'card'>,
    picks: Array<{ optionId: string; n: number; option: ResultOption }>,
    checkedAt: string,
  ): Promise<void>;
  card(tripId: string, cardId: string): Promise<OptionsCardRow | null>;
  /**
   * More of one option on a card Go put up, read after it went up (the top pick's own page: its labelled photos, the Server
   * team's 10 Oct B3, and its rooms, B4), nothing else on the card changed: the card as kept now, or null when the trip
   * has no such card or the card no such option.
   */
  setOptionFields(tripId: string, cardId: string, optionId: string, fields: OptionFields): Promise<OptionsCardT | null>;
  /** True when the card had no vote, or this same key had already claimed it. */
  claimVote(cardId: string, key: string): Promise<boolean>;
  setDecision(cardId: string, decisionId: string): Promise<void>;
  /**
   * A card that is its vote (rev 5 R5): its vote set on its row and in the card itself, which a replace_card resends, with
   * "See more" as its one button while its search has more to show (more), else none. The card as kept now.
   */
  setCardDecision(tripId: string, cardId: string, decisionId: string, more: boolean): Promise<OptionsCardT | null>;
  releaseVote(cardId: string, key: string): Promise<void>;
  /** The votes opened on the trip's other cards of this kind of option, by their decision ids, but those this key opened. */
  votesOfKind(tripId: string, kind: OptionKind, exceptCardId: string, exceptKey: string): Promise<string[]>;
  /** A card that never went up ("See more" that failed before its options joined the vote): gone, its options unshown again. */
  dropCard(tripId: string, cardId: string): Promise<void>;
  /**
   * Every option of a search that a card has shown, as the search gave it: what "See more" never shows again. personId:
   * only the cards that person sees too (a ticket's See more is theirs alone, so each person has their own next ten).
   */
  shownFrom(tripId: string, resultsId: string, personId?: string): Promise<ResultOption[]>;
  /** A card's "See more" taken off (its search has nothing more after all), the rest as it was: the card as kept now. */
  dropMore(tripId: string, cardId: string): Promise<OptionsCardT | null>;
  offer(optionId: string): Promise<StoredOffer | null>;
  offersOnCard(cardId: string): Promise<StoredOffer[]>;
  /** Each option on a card as its search gave it (its facts, its night and its whole stay), by its option id. */
  optionsOnCard(cardId: string): Promise<Map<string, ResultOption>>;
  /** An option as its search gave it (its journey, facts and page), by its option id. */
  optionOf(optionId: string): Promise<ResultOption | null>;
  /** A card as it shows now (a person's own card after their pick: their option alone), kept as replace_card sends it. */
  replaceCard(tripId: string, card: OptionsCardT): Promise<void>;
  /** The option's own name, place and area (a stay's), as the search gave them: what Go saves when a vote picked it. */
  placeOf(optionId: string): Promise<OptionPlace | null>;
  /** The top pick on the trip's latest card of this kind of option (a stay), as placeOf gives it; null with no such card. */
  topPick(tripId: string, kind: string): Promise<OptionPlace | null>;
}

export interface OptionPlace {
  kind: string;
  title: string;
  /** lat and lng when the search gave them (ixigo's stays do). */
  place: { name: string; address: string | null; lat?: number; lng?: number } | null;
  area: string | null;
}

function placeOfRow(r: { kind: string; title: string; option: ResultOption }): OptionPlace {
  const area = r.option.facts['area'];
  const p = r.option.place;
  return {
    kind: r.kind, title: r.title,
    place: p
      ? { name: p.name, address: p.address ?? null, ...(typeof p.lat === 'number' && typeof p.lng === 'number' ? { lat: p.lat, lng: p.lng } : {}) }
      : null,
    area: typeof area === 'string' ? area : null,
  };
}

export function toResultOption(o: TravelOption): ResultOption {
  const { offerId, kind, ...rest } = o;
  return { ...rest, ...(offerId ? { offerId } : {}), kind };
}

interface OfferDbRow {
  option_id: string; trip_id: string; card_id: string; results_id: string; n: number; offer_id: string | null; kind: string; title: string;
  price_minor: string | null; total_minor: string | null; currency: string | null; price_note: string | null; checked_at: Date; source_url: string | null;
}

const OFFER_COLUMNS =
  "option_id, trip_id, card_id, results_id, n, offer_id, kind, title, price_minor, total_minor, currency, price_note, checked_at, option->>'sourceUrl' as source_url";

function offerOf(r: OfferDbRow): StoredOffer {
  return {
    optionId: r.option_id, tripId: r.trip_id, cardId: r.card_id, resultsId: r.results_id, n: r.n, offerId: r.offer_id, kind: r.kind, title: r.title,
    priceMinor: r.price_minor === null ? null : Number(r.price_minor), totalMinor: r.total_minor === null ? null : Number(r.total_minor),
    currency: r.currency, priceNote: r.price_note, checkedAt: r.checked_at.toISOString(), sourceUrl: r.source_url,
  };
}

interface SetDbRow {
  results_id: string; trip_id: string; option_kind: OptionKind; source: 'search' | 'task'; query: Record<string, unknown>; options: ResultOption[];
  checked_at: Date; page: string | null; site_more: boolean;
}

const SET_COLUMNS = 'results_id, trip_id, option_kind, source, query, options, checked_at, page, site_more';

function setOf(r: SetDbRow): ResultSet {
  return {
    resultsId: r.results_id, tripId: r.trip_id, optionKind: r.option_kind, source: r.source, query: r.query, options: r.options, checkedAt: r.checked_at.toISOString(),
    ...(r.page ? { page: r.page } : {}),
    ...(r.site_more ? { siteMore: true } : {}),
  };
}

export function createResultsStore(pool: pg.Pool): ResultsStore {
  return {
    async save(s) {
      const set: ResultSet = { ...s, resultsId: s.resultsId ?? mintId('r') };
      await pool.query(
        `insert into travel_results (results_id, trip_id, option_kind, source, query, options, checked_at, page, site_more)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (results_id) do nothing`,
        [set.resultsId, set.tripId, set.optionKind, set.source, JSON.stringify(set.query), JSON.stringify(set.options), set.checkedAt, set.page ?? null, set.siteMore === true],
      );
      return set;
    },

    async get(tripId, resultsId) {
      const { rows } = await pool.query<SetDbRow>(`select ${SET_COLUMNS} from travel_results where trip_id = $1 and results_id = $2`, [tripId, resultsId]);
      return rows[0] ? setOf(rows[0]) : null;
    },

    async extend(tripId, resultsId, next) {
      const { rows } = await pool.query<SetDbRow>(
        `update travel_results set options = options || $3::jsonb, query = $4, site_more = $5 where trip_id = $1 and results_id = $2 returning ${SET_COLUMNS}`,
        [tripId, resultsId, JSON.stringify(next.options), JSON.stringify(next.query), next.siteMore],
      );
      return rows[0] ? setOf(rows[0]) : null;
    },

    async findOffer(tripId, offerId) {
      const { rows } = await pool.query<{ options: ResultOption[]; checked_at: Date }>(
        `select options, checked_at from travel_results
          where trip_id = $1 and source = 'search' and options @> $2::jsonb
          order by checked_at desc, created_at desc limit 1`,
        [tripId, JSON.stringify([{ offerId }])],
      );
      const r = rows[0];
      const option = r?.options.find((o) => o.offerId === offerId);
      return r && option ? { option, checkedAt: r.checked_at.toISOString() } : null;
    },

    async findBySource(tripId, kind, sourceUrl, title) {
      // The trip's newest searches of this kind first: the option as Go read it last.
      const { rows } = await pool.query<{ options: ResultOption[]; checked_at: Date }>(
        `select options, checked_at from travel_results
          where trip_id = $1 and source = 'search' and option_kind = $2
          order by checked_at desc, created_at desc limit 20`,
        [tripId, kind],
      );
      for (const r of rows) {
        const option = optionOnPage(r.options, sourceUrl, title);
        if (option) return { option, checkedAt: r.checked_at.toISOString() };
      }
      return null;
    },

    async searchedFor(offerId) {
      const { rows } = await pool.query<{ trip_id: string; day: string | null }>(
        `select trip_id, coalesce(query->>'checkIn', query->>'date') as day from travel_results
          where source = 'search' and options @> $1::jsonb
          order by checked_at desc, created_at desc limit 1`,
        [JSON.stringify([{ offerId }])],
      );
      const r = rows[0];
      return r ? { tripId: r.trip_id, day: r.day } : null;
    },

    async saveCard(row, picks, checkedAt) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into options_cards (card_id, trip_id, results_id, title, option_kind, card) values ($1, $2, $3, $4, $5, $6)
           on conflict (card_id) do nothing`,
          [row.cardId, row.tripId, row.resultsId, row.title, row.optionKind, JSON.stringify(row.card)],
        );
        for (const p of picks) {
          await client.query(
            `insert into travel_offers (option_id, trip_id, card_id, results_id, n, offer_id, kind, title, price_minor, total_minor, currency, price_note, option, checked_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict (option_id) do nothing`,
            [
              p.optionId, row.tripId, row.cardId, row.resultsId, p.n, p.option.offerId ?? null, p.option.kind, p.option.title,
              p.option.priceMinor ?? null, p.option.totalMinor ?? null,
              p.option.priceMinor !== undefined || p.option.totalMinor !== undefined ? (p.option.currency ?? 'INR') : null,
              p.option.priceNote ?? null, JSON.stringify(p.option), checkedAt,
            ],
          );
        }
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },

    async card(tripId, cardId) {
      const { rows } = await pool.query<{ card_id: string; trip_id: string; results_id: string; title: string; option_kind: OptionKind; card: OptionsCardT; decision_id: string | null; vote_key: string | null }>(
        'select card_id, trip_id, results_id, title, option_kind, card, decision_id, vote_key from options_cards where trip_id = $1 and card_id = $2',
        [tripId, cardId],
      );
      const r = rows[0];
      return r
        ? { cardId: r.card_id, tripId: r.trip_id, resultsId: r.results_id, title: r.title, optionKind: r.option_kind, card: r.card, decisionId: r.decision_id, voteKey: r.vote_key }
        : null;
    },

    async setOptionFields(tripId, cardId, optionId, fields) {
      // One statement, so a card read between two writes is never half changed: the option's fields set in place, its order kept.
      const { rows } = await pool.query<{ card: OptionsCardT }>(
        `update options_cards set card = jsonb_set(card, '{options}', (
           select jsonb_agg(case when o->>'option_id' = $3 then o || $4::jsonb else o end order by i)
           from jsonb_array_elements(card->'options') with ordinality as t(o, i)))
         where trip_id = $1 and card_id = $2 and card->'options' @> jsonb_build_array(jsonb_build_object('option_id', $3::text))
         returning card`,
        [tripId, cardId, optionId, JSON.stringify(fields)],
      );
      return rows[0]?.card ?? null;
    },

    async claimVote(cardId, key) {
      const r = await pool.query(
        `update options_cards set decision_id = 'pending:' || $2, vote_key = $2
         where card_id = $1 and (decision_id is null or decision_id = 'pending:' || $2)`,
        [cardId, key],
      );
      return r.rowCount === 1;
    },

    async setDecision(cardId, decisionId) {
      await pool.query('update options_cards set decision_id = $2 where card_id = $1', [cardId, decisionId]);
    },

    async setCardDecision(tripId, cardId, decisionId, more) {
      const { rows } = await pool.query<{ card: OptionsCardT }>(
        `update options_cards set decision_id = $3, card = card || jsonb_build_object('decision_id', $3::text, 'actions', $4::jsonb)
         where trip_id = $1 and card_id = $2 returning card`,
        [tripId, cardId, decisionId, JSON.stringify(more ? [MORE_OPTIONS] : [])],
      );
      return rows[0]?.card ?? null;
    },

    async votesOfKind(tripId, kind, exceptCardId, exceptKey) {
      const { rows } = await pool.query<{ decision_id: string }>(
        `select distinct decision_id from options_cards
         where trip_id = $1 and option_kind = $2 and card_id <> $3 and decision_id is not null and decision_id not like 'pending:%'
           and vote_key is distinct from $4`,
        [tripId, kind, exceptCardId, exceptKey],
      );
      return rows.map((r) => r.decision_id);
    },

    async dropCard(tripId, cardId) {
      await pool.query('delete from travel_offers where trip_id = $1 and card_id = $2', [tripId, cardId]);
      await pool.query('delete from options_cards where trip_id = $1 and card_id = $2', [tripId, cardId]);
    },

    async shownFrom(tripId, resultsId, personId) {
      // A card for some people alone (for_person_ids) is shown to them; any other card, to everyone.
      const { rows } = await pool.query<{ option: ResultOption }>(
        `select o.option from travel_offers o left join options_cards c on c.trip_id = o.trip_id and c.card_id = o.card_id
         where o.trip_id = $1 and o.results_id = $2
           and ($3::text is null or jsonb_typeof(c.card->'for_person_ids') is distinct from 'array' or c.card->'for_person_ids' ? $3)`,
        [tripId, resultsId, personId ?? null],
      );
      return rows.map((r) => r.option);
    },

    async dropMore(tripId, cardId) {
      const { rows } = await pool.query<{ card: OptionsCardT }>(
        `update options_cards set card = card || jsonb_build_object('actions', (
           select coalesce(jsonb_agg(a order by i), '[]'::jsonb) from jsonb_array_elements(coalesce(card->'actions', '[]'::jsonb)) with ordinality as t(a, i)
           where a->>'action_id' is distinct from $3))
         where trip_id = $1 and card_id = $2 returning card`,
        [tripId, cardId, MORE_OPTIONS.action_id],
      );
      return rows[0]?.card ?? null;
    },

    async releaseVote(cardId, key) {
      await pool.query("update options_cards set decision_id = null, vote_key = null where card_id = $1 and decision_id = 'pending:' || $2", [cardId, key]);
    },

    async offer(optionId) {
      const { rows } = await pool.query<OfferDbRow>(`select ${OFFER_COLUMNS} from travel_offers where option_id = $1`, [optionId]);
      return rows[0] ? offerOf(rows[0]) : null;
    },

    async placeOf(optionId) {
      const { rows } = await pool.query<{ kind: string; title: string; option: ResultOption }>('select kind, title, option from travel_offers where option_id = $1', [optionId]);
      return rows[0] ? placeOfRow(rows[0]) : null;
    },

    async topPick(tripId, kind) {
      // A card's picks are saved together, so they share a created_at: the lowest number is its top pick.
      const { rows } = await pool.query<{ kind: string; title: string; option: ResultOption }>(
        'select kind, title, option from travel_offers where trip_id = $1 and kind = $2 and not starts_with(card_id, $3) order by created_at desc, n asc limit 1',
        [tripId, kind, `${MORE_CARD}_`],
      );
      return rows[0] ? placeOfRow(rows[0]) : null;
    },

    async optionsOnCard(cardId) {
      const { rows } = await pool.query<{ option_id: string; option: ResultOption }>('select option_id, option from travel_offers where card_id = $1', [cardId]);
      return new Map(rows.map((r) => [r.option_id, r.option]));
    },

    async optionOf(optionId) {
      const { rows } = await pool.query<{ option: ResultOption }>('select option from travel_offers where option_id = $1', [optionId]);
      return rows[0]?.option ?? null;
    },

    async replaceCard(tripId, card) {
      await pool.query('update options_cards set card = $3 where trip_id = $1 and card_id = $2', [tripId, card.card_id, JSON.stringify(card)]);
    },

    async offersOnCard(cardId) {
      const { rows } = await pool.query<OfferDbRow>(`select ${OFFER_COLUMNS} from travel_offers where card_id = $1 order by n`, [cardId]);
      return rows.map(offerOf);
    },
  };
}
