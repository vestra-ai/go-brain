import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture } from '../../recipes/recipe.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { boxPlan, pickSuggestion, readSuggestions, type Suggestion } from '../lookup.js';

const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
/** ixigo's suggestion call for the words, as the browser fetch keeps it. */
const call = (match: string, param: string, words: string, body: string): Capture => ({
  match, url: `https://www.ixigo.com/suggest?${param}=${encodeURIComponent(words)}`, status: 200, content_type: 'application/json', body, truncated: false, at_ms: 300,
});

describe("ixigo's search box, read and picked as a person would", () => {
  it('takes the "All airports" entry, in the country the words mean: London is England, not Ontario or Kentucky', async () => {
    const r = book.get('flights.airport_lookup')!;
    const list = await readSuggestions(r, [call('searchFor=airportSuggestions', 'value', 'London', sample('flights.airport_lookup.london.json'))], 'London');
    expect(list.map((s) => [s.name, s.line, s.all])).toEqual([
      ['LON All Airports', 'London, England, United Kingdom', true],
      ['LHR Heathrow', 'London, England, United Kingdom', false],
      ['LGW Gatwick', 'London, England, United Kingdom', false],
      ['YXU London', 'London, Ontario, Canada', false],
      ['LOZ London-Corbin', 'London, Kentucky, United States', false],
    ]);
    expect(pickSuggestion('London', list)).toEqual({ place: { code: 'LON', city: 'London' } });
  });

  it('takes a city by its own name, and an area by the words that fit it; never a property', async () => {
    const r = book.get('hotels.place_lookup')!;
    const read = (words: string) => readSuggestions(r, [call('/hotels-autocompleter/api/v2/results', 'query', words, sample('hotels.place_lookup.manali.json'))], words);
    const manali = await read('Manali');
    expect(manali.map((s) => s.name)).toEqual(['Manali', 'Manali and Nearby', 'Old Manali']);
    expect(pickSuggestion('Manali', manali)).toEqual({ place: { locationId: 184, locationName: 'Manali', locationType: 'C', masterLocationId: 9425, countryId: 1 } });
    expect(pickSuggestion('Old Manali', await read('Old Manali'))).toEqual({ place: { locationId: 184001, locationName: 'Old Manali', locationType: 'SL', masterLocationId: 9425001, countryId: 1 } });
  });

  it('takes the "All boarding points" entry, with the city id the results address takes', async () => {
    const r = book.get('buses.city_lookup')!;
    const list = await readSuggestions(r, [call('/wap/abus-autocompleter/api/v1/results', 's', 'Bangalore', sample('buses.city_lookup.bangalore.json'))], 'Bangalore');
    expect(pickSuggestion('Bangalore', list)).toEqual({ place: { name: 'Bengaluru', id: 7 } });
  });

  it('takes the station the words name, never one whose name only starts the same: Udaipur is Udaipur City (UDZ)', async () => {
    const r = book.get('trains.station_lookup')!;
    const list = await readSuggestions(r, [call('searchFor=trainstationsLatLon', 'value', 'Udaipur', sample('trains.station_lookup.udaipur.json'))], 'Udaipur');
    expect(list.map((s) => s.name)).toEqual(['Udaipur City (UDZ)', 'Jai Samand Road (JYM)', 'Udaipura (UDPR)']);
    expect(pickSuggestion('Udaipur', list)).toEqual({ place: { code: 'UDZ', name: 'Udaipur City' } });
  });

  it('hands the model the entries that fit when more than one does, and nothing when ixigo knows nothing', () => {
    const s = (name: string, code: string): Suggestion => ({ name, line: 'Rajasthan', all: false, country: 'India', place: { code, name }, placeName: '' });
    const both = [s('Udaipur City (UDZ)', 'UDZ'), s('Udaipur Junction (UDPU)', 'UDPU'), s('Jaipur (JP)', 'JP')];
    expect(pickSuggestion('Udaipur', both)).toEqual({ choose: both.slice(0, 2) });
    expect(pickSuggestion('Kasol', [])).toBeNull();
  });

  it("types each end's words into ixigo's box in one fetch, and keeps one suggestion call per end", async () => {
    const plan = await boxPlan(book.get('trains.station_lookup')!, [{ end: 'from', words: 'Jaipur' }, { end: 'to', words: 'Udaipur' }]);
    expect(plan).toEqual({
      path: '/trains',
      steps: [
        { op: 'type', role: 'searchbox', name: 'Enter Origin', text: 'Jaipur' },
        { op: 'wait_for', match: 'searchFor=trainstationsLatLon' },
        { op: 'type', role: 'searchbox', name: 'Enter Destination', text: 'Udaipur' },
        { op: 'wait_for', match: 'searchFor=trainstationsLatLon' },
      ],
      capture: [{ match: 'searchFor=trainstationsLatLon', required: true, min_count: 2, max_count: 6, max_bytes: 200_000 }],
    });
    // The flights box opens unnamed and focused once its text is clicked; the words are typed as they are, never encoded.
    const air = await boxPlan(book.get('flights.airport_lookup')!, [{ end: 'to', words: 'São Paulo' }]);
    expect(air.steps).toEqual([
      { op: 'click', role: 'StaticText', name: 'To' },
      { op: 'type', text: 'São Paulo' },
      { op: 'wait_for', match: 'searchFor=airportSuggestions' },
    ]);
  });
});
