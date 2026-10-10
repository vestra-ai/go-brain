/**
 * ixigo's review page for one flight's fare, the address its own "Book" click opens (7 Oct capture): built from the
 * results stream Go reads, so the trip's computer goes straight there on the stage. A fare's token carries the search's
 * head count, so the stream is a search for the traveller alone (one adult).
 */
import { eventValues } from '../book/bodies.js';

export interface StreamFare {
  searchToken: string;
  providerId: string;
  /** The flight, as ixigo keys it: "DEL-GOI-6E5341-06112026". */
  fareKey: string;
  fareToken: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null);

/**
 * The fare of one flight (its flightKeys) in a results stream, from its last event that lists it: the search's token,
 * the provider and the fare's own token. fareType picks one of the flight's fares ("REGULAR", "HAND_BAGGAGE_ONLY"); the
 * first otherwise, as the card shows it.
 */
export function fareOf(stream: string, flightKey: string, fareType?: string): StreamFare | null {
  for (const value of eventValues(stream).reverse()) {
    const data = isObject(value) && isObject(value['data']) ? value['data'] : null;
    const searchToken = text(data?.['searchToken']);
    if (!data || !searchToken || !Array.isArray(data['flightJourneys'])) continue;
    for (const journey of data['flightJourneys']) {
      const fares = isObject(journey) && Array.isArray(journey['flightFare']) ? journey['flightFare'] : [];
      const flight = fares.find((f) => isObject(f) && f['flightKeys'] === flightKey);
      if (!isObject(flight) || !Array.isArray(flight['fares'])) continue;
      const all = flight['fares'].filter(isObject);
      const fare = (fareType ? all.find((f) => f['fareType'] === fareType) : undefined) ?? all[0];
      const details = isObject(fare?.['fareDetails']) ? fare['fareDetails'] : null;
      const meta = Array.isArray(fare?.['fareMetadata']) && isObject(fare['fareMetadata'][0]) ? fare['fareMetadata'][0] : null;
      const fareToken = text(details?.['fareToken']);
      const providerId = text(meta?.['providerId']);
      if (fareToken && providerId) return { searchToken, providerId, fareKey: flightKey, fareToken };
    }
  }
  return null;
}

/** The review page's address, as ixigo's "Book" writes it. */
export function reviewAddress(f: StreamFare): string {
  const q = new URLSearchParams({ fareKey: f.fareKey, providers: f.providerId, hbo: 'false', ftk: f.fareToken, source: 'Search Form' });
  return `https://www.ixigo.com/flight/booking/${encodeURIComponent(f.providerId)}/${encodeURIComponent(f.searchToken)}?${q.toString().replace(/\+/g, '%20')}`;
}
