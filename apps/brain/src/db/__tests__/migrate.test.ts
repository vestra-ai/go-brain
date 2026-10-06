import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, migrationFiles } from '../migrate.js';
import { withSchema } from '../test-db.js';

const CORE_TABLES = [
  'trips', 'trip_setup', 'trip_events', 'messages', 'go_requests', 'desk_items',
  'trip_leases', 'turns', 'seen_signatures', 'switches', 'cards', 'card_taps',
];

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

describe('migrate', () => {
  it('reads NNNN_name.sql files in order, starting with lane A core', () => {
    const files = migrationFiles();
    expect(files[0]).toBe('1000_core.sql');
    expect([...files].sort()).toEqual(files);
  });

  it('creates every core table inside the test schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1',
      [db.schema],
    );
    const names = rows.map((r) => r.table_name);
    for (const t of CORE_TABLES) expect(names).toContain(t);
  });

  it('does nothing the second time', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('keeps test files apart: a second schema starts empty', async () => {
    const other = await withSchema();
    try {
      await db.pool.query(`insert into switches (name, value) values ('TRAVEL_MODE', 'fake')`);
      const { rows } = await other.pool.query<{ n: number }>('select count(*)::int as n from switches');
      expect(rows[0]?.n).toBe(0);
    } finally {
      await other.drop();
    }
  });

  it('takes an event once by event_id', async () => {
    const ins = `insert into trip_events (event_id, trip_id, seq, type, payload) values ('ev_1', 't_goa', 1, 'trip.created', '{}')
                 on conflict (event_id) do nothing`;
    expect((await db.pool.query(ins)).rowCount).toBe(1);
    expect((await db.pool.query(ins)).rowCount).toBe(0);
  });
});
