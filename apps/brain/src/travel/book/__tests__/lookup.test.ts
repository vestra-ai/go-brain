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

describe("ixigo's search box, read and picked as a person would (p4's raw answers, 7 Oct)", () => {
  const pick = async (id: string, match: string, param: string, words: string, file: string) => {
    const list = await readSuggestions(book.get(id)!, [call(match, param, words, sample(file))], words);
    return { list, picked: pickSuggestion(words, list) };
  };

  it('takes the "All Airports" entry, in the country the words mean: London is England, not Ontario or Kentucky', async () => {
    const { list, picked } = await pick('flights.airport_lookup', 'searchFor=airportSuggestions', 'value', 'London', 'flights.airport_lookup.london.json');
    expect(list.slice(0, 2).map((s) => [s.name, s.line, s.all])).toEqual([
      ['LON All Airports', 'London, England, United Kingdom', true],
      ['LHR Heathrow', 'London, England, United Kingdom', false],
    ]);
    expect(list.some((s) => s.line === 'London, Ontario, Canada')).toBe(true);
    expect(picked).toEqual({ place: { code: 'LON', city: 'London' } });
    // Delhi has no "All" entry: the one in India the words fit, never Delhi, Louisiana.
    expect((await pick('flights.airport_lookup', 'searchFor=airportSuggestions', 'value', 'Delhi', 'flights.airport_lookup.delhi.json')).picked)
      .toEqual({ place: { code: 'DEL', city: 'New Delhi' } });
  });

  it('takes a city by its own name, and an area by the words that fit it, though ixigo lists the city first', async () => {
    expect((await pick('hotels.place_lookup', '/hotels-autocompleter/api/v2/results', 'query', 'Manali', 'hotels.place_lookup.manali.json')).picked)
      .toEqual({ place: { locationId: 184, locationName: 'Manali', locationType: 'C', masterLocationId: 9425, countryId: 1, lat: 32.2431872, lng: 77.1891761 } });
    const old = await pick('hotels.place_lookup', '/hotels-autocompleter/api/v2/results', 'query', 'Old Manali', 'hotels.place_lookup.old-manali.json');
    expect(old.list.map((s) => s.name)).toEqual(['Manali', 'Old Manali']);
    expect(old.picked).toEqual({
      place: { locationId: 3588, locationName: 'Old Manali', locationType: 'L', masterLocationId: 31346, countryId: 1, lat: 32.2521478, lng: 77.17871140000001 },
    });
  });

  it('takes the "All boarding points" entry, and a town by its name when there is none: Bangalore is Bengaluru 7, Hampi is 1579', async () => {
    const blr = await pick('buses.city_lookup', '/wap/abus-autocompleter/api/v1/results', 's', 'Bangalore', 'buses.city_lookup.bangalore.json');
    expect(blr.list.map((s) => [s.name, s.all])).toEqual([
      ['Bangalore', true], ['Bangalore Kempegowda Intl Airport', false], ['Chikkalsandra (Bangalore)', false], ['Mangalore', false],
    ]);
    expect(blr.picked).toEqual({ place: { name: 'Bengaluru', id: 7 } });
    expect((await pick('buses.city_lookup', '/wap/abus-autocompleter/api/v1/results', 's', 'Hampi', 'buses.city_lookup.hampi.json')).picked)
      .toEqual({ place: { name: 'Hampi', id: 1579 } });
  });

  it('takes the "All stations" entry, and hands the model the stations that fit when there is none: Udaipur City (UDZ) or Udaipur (UDPU)', async () => {
    expect((await pick('trains.station_lookup', 'searchFor=trainstationsLatLon', 'value', 'Jaipur', 'trains.station_lookup.jaipur.json')).picked)
      .toEqual({ place: { code: 'JP', name: 'Jaipur' } });
    const udaipur = await pick('trains.station_lookup', 'searchFor=trainstationsLatLon', 'value', 'Udaipur', 'trains.station_lookup.udaipur.json');
    expect(udaipur.list.map((s) => s.name)).toEqual(['Udaipur City (UDZ)', 'Jai Samand Road (JYM)', 'Udaipura (UDPR)', 'Udaipur (UDPU)', 'Udaypur Khurd (UDKN)']);
    // A station's name is not its city's: the pick never takes one by name, so the model chooses, by meaning.
    expect(udaipur.picked).toEqual({ choose: [udaipur.list[0], udaipur.list[3]] });
  });

  it('hands the model the entries that fit when more than one does, and nothing when ixigo knows nothing', () => {
    const s = (name: string, code: string): Suggestion => ({ name, line: 'Rajasthan', all: false, country: 'India', place: { code, name }, placeName: '' });
    const both = [s('Udaipur City (UDZ)', 'UDZ'), s('Udaipur Junction (UDPU)', 'UDPU'), s('Jaipur (JP)', 'JP')];
    expect(pickSuggestion('Udaipur', both)).toEqual({ choose: both.slice(0, 2) });
    expect(pickSuggestion('Kasol', [])).toBeNull();
  });

  // Keshav's Varkala trip, 11 Oct: every flights search stopped on "TRV, TCR or COK?" for a town with no airport.
  it("takes the nearest airport ixigo lists for a place with none of its own, never a choice; an airport by the words keeps its rules", () => {
    const a = (code: string, name: string, city: string): Suggestion => ({ name: `${code} ${name}`, line: `${city}, Kerala, India`, all: false, country: 'India', place: { code, city }, placeName: city });
    const near = [a('TRV', 'Thiruvananthapuram International Airport', 'Thiruvananthapuram'), a('TCR', 'Tuticorin', 'Tuticorin'), a('COK', 'Cochin International Airport', 'Kochi')];
    expect(pickSuggestion('Varkala', near, { nearest: true })).toEqual({ place: { code: 'TRV', city: 'Thiruvananthapuram' }, nearest: true });
    // Without the flight box's rule, the model is handed the list, as before.
    expect(pickSuggestion('Varkala', near)).toEqual({ choose: near });
    // A place an airport is named for is never "nearest": Kochi is COK.
    expect(pickSuggestion('Kochi', near, { nearest: true })).toEqual({ place: { code: 'COK', city: 'Kochi' } });
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
