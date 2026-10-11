// GO_URL=https://<go> GO_SIGNING_SECRET=... GO_ADMIN_TOKEN=... pnpm --filter @go/sim learn-places [place ...]
// Learns the home screen's idea places before the Server's place_info asks for them (rev 5 R6). It connects a FakeServer
// as its own instance, makes a fresh trip (its own computer; no dates, so no stays load), then asks Go to learn each place
// through that trip (POST /admin/places/learn): one at a time, with a pause between, printing what place_info will answer.
// A place neither ixigo's place box nor its guide knows (unknown_place) is skipped; it stops at the first refusal (ixigo's
// 401, 403, 429 or check comes back as a 502). Run it in its ixigo queue turn.
// The URL and the secrets come from the environment only, never argv. On Railway, from the service's own variables:
//   railway run --service brain --environment staging -- sh -c \
//     'GO_URL="https://$RAILWAY_PUBLIC_DOMAIN" GO_ADMIN_TOKEN="$ADMIN_TOKEN" pnpm --filter @go/sim learn-places'
import { randomBytes } from 'node:crypto';
import { FakeServer } from '../src/fake-server.js';
import { goaFreshTrip } from '../src/goa.js';

/** The ideas the Server shows first (11 Oct). */
const PLACES = ['Goa', 'Manali', 'Ladakh', 'Jaipur', 'Udaipur', 'Kerala', 'Munnar', 'Rishikesh', 'Shimla', 'Coorg', 'Pondicherry', 'Andaman', 'Varanasi', 'Darjeeling', 'Gokarna', 'Kasol'];
/** Between two places, so the computer's pages come gently. */
const PAUSE_MS = 5_000;
/** Go's setup of the new trip, its computer starting, before the first place. */
const SETUP_MS = 60_000;

const goUrl = process.env['GO_URL'];
const secret = process.env['GO_SIGNING_SECRET'];
const token = process.env['GO_ADMIN_TOKEN'];
if (!goUrl || !secret || !token) {
  console.error('Set GO_URL, GO_SIGNING_SECRET and GO_ADMIN_TOKEN in the environment.');
  process.exit(2);
}
const names = process.argv.length > 2 ? process.argv.slice(2) : PLACES;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Learned {
  place?: { name: string; place_id?: string; lat?: number; photos?: unknown[] };
  best_months?: number[];
  complete?: boolean;
  error?: { code: string; message: string };
}

const run = randomBytes(4).toString('hex');
const tripId = `t_places_${run}`;
const fake = new FakeServer({ goUrl, secret, instance: `places-${run}` });
try {
  await fake.start(10_000);
  const created = await fake.createTrip({ ...goaFreshTrip(), trip_id: tripId, destination: null });
  if (created.error) throw new Error(`Go refused the trip: ${created.error}`);
  console.log(`Trip ${tripId} made on ${new URL(goUrl).origin}; its computer starts.`);
  await pause(SETUP_MS);
  for (const name of names) {
    const res = await fetch(new URL('/admin/places/learn', goUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ trip_id: tripId, name }),
    });
    const body = (await res.json().catch(() => ({}))) as Learned;
    if (res.status === 404 && body.error?.code === 'unknown_place') {
      console.log(`${name}: neither ixigo's place box nor its guide knows it; skipped.`);
      await pause(PAUSE_MS);
      continue;
    }
    if (!res.ok || !body.place) {
      console.error(`${name}: ${res.status} ${body.error?.message ?? ''}. Stopped.`);
      process.exitCode = 1;
      break;
    }
    const p = body.place;
    const months = body.best_months?.join(', ') ?? 'none';
    console.log(`${name}: ${p.name} (${p.place_id ?? 'no id'}), ${p.photos?.length ?? 0} photos, ${p.lat !== undefined ? 'on the map' : 'not on the map'}, best months ${months}${body.complete === false ? ', partial' : ''}`);
    await pause(PAUSE_MS);
  }
} catch (err) {
  console.error(`Stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  fake.stop();
}
