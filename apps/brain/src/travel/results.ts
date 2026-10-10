/**
 * Result sets (what a search or a finished job found, as checked), the options cards Go posted from them, and the
 * offers on those cards. An option_id on a card, and a vote option's option_ref, both name a row here.
 */
import type pg from 'pg';
import type { Journey, Photo, Place } from '@go/contract';
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
}

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

export interface ResultsStore {
  save(s: Omit<ResultSet, 'resultsId'> & { resultsId?: string }): Promise<ResultSet>;
  get(tripId: string, resultsId: string): Promise<ResultSet | null>;
  /**
   * The offer as Go's own search last showed it in this trip (the composer's search, or the trip's computer's through
   * Go's MCP server), with that check's time; null when no search of this trip showed it. A job's answer is never a source.
   */
  findOffer(tripId: string, offerId: string): Promise<{ option: ResultOption; checkedAt: string } | null>;
  /** The trip and the check-in or departure day of the newest search that showed this offer. */
  searchedFor(offerId: string): Promise<{ tripId: string; day: string | null } | null>;
  saveCard(
    row: Pick<OptionsCardRow, 'cardId' | 'tripId' | 'resultsId' | 'title' | 'optionKind' | 'card'>,
    picks: Array<{ optionId: string; n: number; option: ResultOption }>,
    checkedAt: string,
  ): Promise<void>;
  card(tripId: string, cardId: string): Promise<OptionsCardRow | null>;
  /**
   * One option's photos on a card Go put up (the top pick's labelled ones, the Server team's 10 Oct B3), nothing else on
   * the card changed: the card as kept now, or null when the trip has no such card or the card no such option.
   */
  setPhotos(tripId: string, cardId: string, optionId: string, photos: Photo[]): Promise<OptionsCardT | null>;
  /** True when the card had no vote, or this same key had already claimed it. */
  claimVote(cardId: string, key: string): Promise<boolean>;
  setDecision(cardId: string, decisionId: string): Promise<void>;
  releaseVote(cardId: string, key: string): Promise<void>;
  offer(optionId: string): Promise<StoredOffer | null>;
  offersOnCard(cardId: string): Promise<StoredOffer[]>;
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

export function createResultsStore(pool: pg.Pool): ResultsStore {
  return {
    async save(s) {
      const set: ResultSet = { ...s, resultsId: s.resultsId ?? mintId('r') };
      await pool.query(
        `insert into travel_results (results_id, trip_id, option_kind, source, query, options, checked_at, page)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (results_id) do nothing`,
        [set.resultsId, set.tripId, set.optionKind, set.source, JSON.stringify(set.query), JSON.stringify(set.options), set.checkedAt, set.page ?? null],
      );
      return set;
    },

    async get(tripId, resultsId) {
      const { rows } = await pool.query<{ results_id: string; trip_id: string; option_kind: OptionKind; source: 'search' | 'task'; query: Record<string, unknown>; options: ResultOption[]; checked_at: Date; page: string | null }>(
        'select results_id, trip_id, option_kind, source, query, options, checked_at, page from travel_results where trip_id = $1 and results_id = $2',
        [tripId, resultsId],
      );
      const r = rows[0];
      return r ? { resultsId: r.results_id, tripId: r.trip_id, optionKind: r.option_kind, source: r.source, query: r.query, options: r.options, checkedAt: r.checked_at.toISOString(), ...(r.page ? { page: r.page } : {}) } : null;
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

    async setPhotos(tripId, cardId, optionId, photos) {
      // One statement, so a card read between two writes is never half changed: the option's photos set in place, its order kept.
      const { rows } = await pool.query<{ card: OptionsCardT }>(
        `update options_cards set card = jsonb_set(card, '{options}', (
           select jsonb_agg(case when o->>'option_id' = $3 then o || jsonb_build_object('photos', $4::jsonb) else o end order by i)
           from jsonb_array_elements(card->'options') with ordinality as t(o, i)))
         where trip_id = $1 and card_id = $2 and card->'options' @> jsonb_build_array(jsonb_build_object('option_id', $3::text))
         returning card`,
        [tripId, cardId, optionId, JSON.stringify(photos)],
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
        'select kind, title, option from travel_offers where trip_id = $1 and kind = $2 order by created_at desc, n asc limit 1',
        [tripId, kind],
      );
      return rows[0] ? placeOfRow(rows[0]) : null;
    },

    async offersOnCard(cardId) {
      const { rows } = await pool.query<OfferDbRow>(`select ${OFFER_COLUMNS} from travel_offers where card_id = $1 order by n`, [cardId]);
      return rows.map(offerOf);
    },
  };
}
