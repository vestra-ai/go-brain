// A trip's chat from Go's database as a bench recording, keeping the labels already written by hand in the file.
//   pnpm --filter @go/bench export-trip -- --trip <trip_id> --database-url <url>
// It writes packages/bench/chats/private/real-trip.jsonl, which git ignores (real people's words), unless --out names
// another file. The database is the brain service's DATABASE_URL (or GO_DATABASE_URL); the export only reads it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { parseChat } from '../src/chat.js';
import { exportPath, exportTrip } from '../src/export/trip-export.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { trip: { type: 'string' }, 'database-url': { type: 'string' }, out: { type: 'string' } },
});
const trip = values.trip;
const databaseUrl = values['database-url'] ?? process.env['GO_DATABASE_URL'];
if (!trip || !databaseUrl) {
  console.error('Usage: export-trip -- --trip <trip_id> --database-url <url> [--out <file>] (or set GO_DATABASE_URL)');
  process.exit(2);
}
// pnpm runs the script inside packages/bench; a path on the command line is read from where pnpm was started.
const out = exportPath(values.out, process.env['INIT_CWD'] ?? process.cwd());
mkdirSync(dirname(out), { recursive: true });

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  const existing = existsSync(out) ? readFileSync(out, 'utf8') : null;
  const r = await exportTrip(pool, trip, existing);
  const text = `${r.lines.join('\n')}\n`;
  parseChat('real-trip', text); // never write a file the bench cannot read
  writeFileSync(out, text);
  console.log(`Wrote ${r.lines.length} lines to ${out}: ${r.kept} labels kept, ${r.added} new lines to label by hand, ${r.skipped} messages left out.`);
  for (const d of r.droppedProbes) console.log(`Dropped a recall probe: ${d}`);
} finally {
  await pool.end();
}
