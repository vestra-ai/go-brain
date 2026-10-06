// pnpm --filter @go/sim room -- --go ws://localhost:8080 --secret $GO_SIGNING_SECRET --port 5174
// Starts the FakeServer against a running Go, creates the Goa trip, and serves the dev room.
// Options: --host 0.0.0.0 (open it from a phone), --instance <name>, --fixture fresh|planning, --seed (say the seed chat).
import { parseArgs } from 'node:util';
import { serveDevRoom } from './dev-room/serve.js';
import { FakeServer } from './fake-server.js';
import { GOA_SEED_CHAT, GOA_SNAPSHOT, goaFreshTrip } from './goa.js';

const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift(); // pnpm may pass its separator through
const { values } = parseArgs({
  args: argv,
  options: {
    go: { type: 'string' },
    secret: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    instance: { type: 'string' },
    fixture: { type: 'string' },
    seed: { type: 'boolean' },
  },
});

const goUrl = values.go ?? 'ws://localhost:8080';
const secret = values.secret ?? process.env.GO_SIGNING_SECRET;
if (!secret) {
  console.error('Pass --secret or set GO_SIGNING_SECRET.');
  process.exit(2);
}

const fake = new FakeServer({ goUrl, secret, instance: values.instance ?? 'sim', log: (line) => console.log(line) });
console.log(`connecting to Go at ${goUrl}`);
await fake.start();
await fake.createTrip(values.fixture === 'planning' ? GOA_SNAPSHOT : goaFreshTrip());
if (values.seed) for (const line of GOA_SEED_CHAT) await fake.say(line.personId, line.text);
const room = await serveDevRoom({ fake, port: Number(values.port ?? '5174'), host: values.host ?? '127.0.0.1' });
console.log(`the dev room is open at ${room.url}`);
