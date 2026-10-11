import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture } from '../../recipes/__tests__/fixtures.js';
import { htmlInputsOf, htmlTablesOf, readBodyAs, type HtmlInputs, type HtmlTables } from '../bodies.js';
import { BOOK_DIR, checkRecipe } from '../book.js';

/** Each ld+json block by its @type, a list as "list". */
const ldTypes = (page: HtmlTables): unknown[] => page.ld.map((b) => (Array.isArray(b) ? 'list' : (b as Record<string, unknown>)['@type']));

describe('html_tables: a plain server-rendered page, read as its tables', () => {
  it("reads a train's schedule page: its title, canonical address, both tables with their header row, and its ld+json", () => {
    const page = readBodyAs(fixture('train-schedule-10103.html'), 'html_tables', 'the schedule') as HtmlTables;
    expect(page.title).toBe('10103 Mandovi Express Train Route, Schedule, Time Table | C Shivaji Mah T (CSMT) to Madgaon (MAO)');
    expect(page.canonical).toBe('https://www.ixigo.com/trains/10103');
    expect(page.tables).toHaveLength(2);
    expect(page.tables[0]).toEqual([
      ['Classes', '1A, 2A, 3A, 3E, SL'],
      ['Service Days', 'Mon, Tue, Wed, Thu, Fri, Sat, Sun'],
      ['Stops', '19'],
      ['Duration', '14hr 45min'],
      ['Type', 'Mail Express'],
      ['Pantry', 'No'],
    ]);
    // Each stop's row sits in a <div> inside the table: still the table's own row.
    const stops = page.tables[1]!;
    expect(stops).toHaveLength(21);
    expect(stops[0]).toEqual(['Stn Code', 'Stn Name', 'Arrives', 'Departs', 'Stop time', 'Distance', 'Platform', 'Route', 'Day', 'Avg delay']);
    expect(stops[1]).toEqual(['CSMT', 'C Shivaji Mah T', 'starts', '07:10', '-', '0', '18', '1', '1', 'On Time']);
    expect(stops[20]).toEqual(['MAO', 'Madgaon', '21:55', 'ends', '-', '765 km', '5', '1', '1', '17min']);
    expect(stops.every((row) => row.length === 10)).toBe(true);
    expect(ldTypes(page)).toEqual(['WebPage', 'TrainTrip', 'BreadcrumbList', 'FAQPage', 'MobileApplication', 'list']);
  });

  it("reads a train's running status page: a cell's pieces joined by a space, and a spacer row left out", () => {
    const page = readBodyAs(fixture('train-running-status-12992.html'), 'html_tables', 'the running status') as HtmlTables;
    expect(page.title).toBe('12992 Train Running Status, Jp Udz Superfast 12992 Running Status LIVE');
    expect(page.canonical).toBe('https://www.ixigo.com/trains/12992/running-status');
    expect(page.tables).toHaveLength(1);
    const rows = page.tables[0]!;
    // The header, then the 16 stations: the empty spacer row under the header is gone.
    expect(rows).toHaveLength(17);
    expect(rows[0]).toEqual(['', 'Station', 'Arrival Status Actual/Scheduled', 'Departure Status Actual/Scheduled', 'Delay', 'PF/Halt']);
    expect(rows[1]).toEqual(['', 'Jaipur -', 'Source', '14:10', 'Cancelled', '1 Source']);
    expect(rows[2]).toEqual(['', 'Asalpur Jobner 37 km', '14:37', '14:39', 'Cancelled', '3 -']);
    expect(rows[16]).toEqual(['', 'Udaipur City 434 km', '21:48', 'Destination', 'Cancelled', '4 Destination']);
    expect(ldTypes(page)).toEqual(['WebPage', 'BreadcrumbList', 'FAQPage', 'MobileApplication', 'list']);
  });

  it("drops the page's credentials, and reads no attribute but the canonical address", () => {
    const html = `<html><head><title>Station &amp; platforms</title>
      <link rel="canonical" href="https://www.ixigo.com/stations/ndls">
      <script type="application/ld+json">{"@type":"TrainStation","name":"New Delhi","apiKey":"k-123","nested":{"deviceId":"d-1","token":"t-1","keep":"yes"}}</script>
      <script type="application/ld+json">{ not json }</script>
      <script data-cf-beacon='{"token":"cf-1"}'></script></head>
      <body><table><tr><th>Platform</th><th>Trains</th></tr><tr><td>1<script>var secret = "s-1";</script></td><td>12</td></tr></table></body></html>`;
    const page = readBodyAs(html, 'html_tables', 'the station') as HtmlTables;
    expect(page).toEqual({
      title: 'Station & platforms',
      canonical: 'https://www.ixigo.com/stations/ndls',
      tables: [[['Platform', 'Trains'], ['1', '12']]],
      ld: [{ '@type': 'TrainStation', name: 'New Delhi', nested: { keep: 'yes' } }],
    });
    expect(JSON.stringify(page)).not.toMatch(/k-123|d-1|t-1|cf-1|s-1/);
    // The two real pages carry a beacon token in an attribute: it never reaches what a recipe reads.
    for (const name of ['train-schedule-10103.html', 'train-running-status-12992.html']) {
      expect(JSON.stringify(readBodyAs(fixture(name), 'html_tables', 'the page'))).not.toMatch(/"token"|REDACTED/);
    }
  });

  it('keeps a table inside a cell to its own rows', () => {
    const page = htmlTablesOf('<table><tr><td>outer<table><tr><td>inner</td></tr></table></td><td>2</td></tr></table>');
    expect(page.tables).toEqual([[['outer inner', '2']], [['inner']]]);
  });

  it('is a shape Go does not read when the page has no table and no ld+json', () => {
    expect(() => readBodyAs('<html><head><title>Nothing</title></head><body><p>hi</p></body></html>', 'html_tables', 'the page')).toThrow(/shape Go does not read/);
  });

  it('is a body format a recipe may name', () => {
    const file = readFileSync(`${BOOK_DIR}plan/destination.yaml`, 'utf8').replace('format: next_html', 'format: html_tables');
    const checked = checkRecipe('plan/destination.yaml', file);
    expect('recipe' in checked && checked.recipe.read?.rows.format).toBe('html_tables');
  });
});

describe("html_inputs: a plain page's data, read from the JSON its hidden inputs carry", () => {
  it("reads a train's page: its whole data in dataBE, the inputs that are not JSON left out", () => {
    const page = readBodyAs(fixture('train-schedule-10103.html'), 'html_inputs', 'the train') as HtmlInputs;
    expect(page.title).toBe('10103 Mandovi Express Train Route, Schedule, Time Table | C Shivaji Mah T (CSMT) to Madgaon (MAO)');
    expect(page.canonical).toBe('https://www.ixigo.com/trains/10103');
    // backendTime is a number and isProdEnv a flag: only the data is kept.
    expect(Object.keys(page.inputs)).toEqual(['dataBE']);
    const data = page.inputs['dataBE'] as { info: Record<string, unknown>; schedules: Array<Record<string, unknown>> };
    expect(data.info).toMatchObject({ code: '10103', localName: 'Mandovi Express', rakeType: 'LHB', avgSpeedInKmph: 39, maxPermissibleSpeedInKmph: 120 });
    expect(data.info['locomotives']).toHaveLength(2);
    expect(data.schedules).toHaveLength(20);
  });

  it("decodes the value's entities, drops the page's credentials, and keeps a list", () => {
    const page = htmlInputsOf(`<html><head><title>T</title></head><body>
      <input type="hidden" id="data" value="{&quot;name&quot;:&quot;A &amp; B&quot;,&quot;token&quot;:&quot;t-1&quot;,&quot;nested&quot;:{&quot;apiKey&quot;:&quot;k-1&quot;,&quot;keep&quot;:1}}">
      <input type="hidden" id="list" value="[1,2]"><input type="hidden" id="when" value="1791399824320">
      <input type="hidden" value="{&quot;no&quot;:&quot;id&quot;}"><input type="text" id="typed" value="{}"></body></html>`);
    expect(page.inputs).toEqual({ data: { name: 'A & B', token: 't-1', nested: { apiKey: 'k-1', keep: 1 } }, list: [1, 2] });
    const read = readBodyAs(`<input type="hidden" id="data" value="{&quot;token&quot;:&quot;t-1&quot;,&quot;keep&quot;:1}">`, 'html_inputs', 'the page') as HtmlInputs;
    expect(read.inputs).toEqual({ data: { keep: 1 } });
  });

  it('is a shape Go does not read when no hidden input carries JSON', () => {
    expect(() => readBodyAs('<html><body><input type="hidden" id="t" value="12"><table><tr><td>1</td></tr></table></body></html>', 'html_inputs', 'the page')).toThrow(/shape Go does not read/);
  });

  it('is a body format a recipe may name', () => {
    const file = readFileSync(`${BOOK_DIR}plan/destination.yaml`, 'utf8').replace('format: next_html', 'format: html_inputs');
    const checked = checkRecipe('plan/destination.yaml', file);
    expect('recipe' in checked && checked.recipe.read?.rows.format).toBe('html_inputs');
  });
});
