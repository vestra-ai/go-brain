import { describe, expect, it } from 'vitest';
import { TravelError } from '../../mcp-travel.js';
import { airportOf, busCityOf, goaHalfOf, stationOf, stayPlaceOf } from '../places.js';
import { RECIPES } from '../index.js';
import { bodiesFor, ddmmyyyy, istAt, istOf, matches, snapshotText } from '../recipe.js';
import { capture } from './fixtures.js';

describe('the places tables', () => {
  it('resolve the names people use, and codes as they are', () => {
    expect(airportOf('Goa')).toEqual({ code: 'GOI', city: 'Goa' });
    expect(airportOf('North Goa').code).toBe('GOX');
    expect(airportOf('Goa (GOX)').code).toBe('GOX');
    expect(airportOf(' new  Delhi ').code).toBe('DEL');
    expect(airportOf('blr').code).toBe('BLR');
    expect(airportOf('GOA').code).toBe('GOI');
    expect(stationOf('Margao')).toEqual({ code: 'MAO', name: 'Madgaon' });
    expect(stationOf('NZM').code).toBe('NZM');
    expect(stationOf('Pune').code).toBe('PUNE');
    expect(busCityOf('Bombay')).toEqual({ name: 'Mumbai', id: 4 });
    const goa = { locationId: 32, locationName: 'Goa', locationType: 'S', masterLocationId: 48569, countryId: 1 };
    // An area with ixigo's own filter keeps the Goa search to it; one without searches all of Goa.
    // One town code a place: two or more don't add up on ixigo, and ward codes change from load to load.
    expect(stayPlaceOf('Calangute')).toEqual({ location: goa, areas: ['PA_C_1047'], half: 'north' });
    // Baga has no code of its own: it sits with Calangute.
    expect(stayPlaceOf('Baga')).toEqual(stayPlaceOf('Calangute'));
    expect(stayPlaceOf('Vagator, Goa')).toEqual({ location: goa, areas: ['PA_C_78528'], half: 'north' });
    expect(stayPlaceOf('Colva')).toEqual({ location: goa, areas: ['PA_C_1489'], half: 'south' });
    expect(stayPlaceOf('Goa')).toEqual({ location: goa, areas: [], half: null });
    // A half of Goa is all of Goa, its stays checked against the half's places.
    expect(stayPlaceOf('South Goa')).toEqual({ location: goa, areas: [], half: 'south' });
    // North Goa takes in Anjuna's wards and Baga's (Calangute's) codes too.
    expect(stayPlaceOf('north goa')).toEqual({ location: goa, areas: [], half: 'north' });
    expect(goaHalfOf('Vasco da Gama')).toBe('south');
    expect(goaHalfOf('Prabhu wada, Candolim')).toBe('north');
    expect(goaHalfOf('Fatona')).toBe('south');
    expect(goaHalfOf('Bouta Waddo')).toBeNull();
    // Anjuna is a location of its own, which takes in the stays around it.
    expect(stayPlaceOf('Anjuna')).toEqual({ location: { locationId: 1026, locationName: 'Anjuna', locationType: 'C', masterLocationId: 50347, countryId: 1 }, areas: [], half: 'north' });
  });

  it('refuse a place they do not have, with the places that work, and never guess', () => {
    for (const ask of [() => airportOf('Genoa'), () => stationOf('Shimla'), () => busCityOf('Pune'), () => stayPlaceOf('Manali')]) {
      try {
        ask();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(TravelError);
        expect((err as TravelError).code).toBe('unknown_place');
      }
    }
  });
});

describe('the recipe helpers', () => {
  it('match a capture as the browser fetch does: a part of the URL, or the end of its path with "$"', () => {
    expect(matches('/buslist/v3/services', 'https://www.ixigo.com/buslist/v3/services/meta/105')).toBe(true);
    expect(matches('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services/meta/105')).toBe(false);
    expect(matches('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services?x=1')).toBe(true);
    expect(matches('/buslist/v3/services$', 'not a url')).toBe(false);
  });

  it('read only whole, successful bodies', () => {
    const url = 'https://www.ixigo.com/a';
    const cut = { ...capture('/a', url, '{"half":'), truncated: true };
    expect(bodiesFor([capture('/a', url, 'one'), capture('/a', url, 'two', 500), cut, capture('/a', url, 'three')], '/a')).toEqual(['one', 'three']);
  });

  it("read a snapshot's text nodes in order, as the page's own text reads", () => {
    const snap = ['- main', '  - link "IndiGo 6E5341 05:00 DEL" [@e4]', '    - StaticText "IndiGo"', '    - StaticText "6E5341"', '    - StaticText "say \\"hi\\""'].join('\n');
    expect(snapshotText(snap)).toBe('IndiGo\n6E5341\nsay "hi"');
    // With no text nodes, every name, in order.
    expect(snapshotText('- heading "05:00" [level=6]\n- paragraph "DEL"')).toBe('05:00\nDEL');
  });

  it('write dates and times as ixigo and India read them', () => {
    expect(ddmmyyyy('2026-11-06')).toBe('06112026');
    expect(istAt('2026-11-06', '05:00:00')).toBe('2026-11-06T05:00:00+05:30');
    expect(istOf(Date.parse('2026-11-06T13:00:00Z'))).toBe('2026-11-06T18:30:00+05:30');
  });

  it('cover every kind of search, each reusing a result for 10 minutes', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(['buses', 'flights', 'stays', 'trains']);
    for (const [kind, r] of Object.entries(RECIPES)) {
      expect(r.kind).toBe(kind);
      expect(r.ttlMs).toBe(600_000);
      expect(r.capture.some((c) => c.required)).toBe(true);
    }
  });
});
