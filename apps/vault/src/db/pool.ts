import pg from 'pg';

export function makePool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
