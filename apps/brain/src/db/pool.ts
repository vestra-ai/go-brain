import pg from 'pg';

/** One pool for the service. `schema` sets the search path; tests use one schema per file. */
export function createPool(url: string, o: { schema?: string; max?: number } = {}): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: o.max ?? 10,
    ...(o.schema ? { options: `-c search_path=${o.schema}` } : {}),
  });
}
