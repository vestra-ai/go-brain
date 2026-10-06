// G5, the 3:40 demo beat: a labelled simulated watch fires; the bar lets one pin through; the real composer
// (with a scripted model) posts one notice pinned to Arjun, labelled "Simulated for the demo".
import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import { loadEnv } from '../../env.js';
import { startProactive } from '../../proactive/register.js';
import { registerRoom } from '../../room.js';
import { fakeAnthropic, type Reply } from '../fixtures/fake-anthropic.js';
import { SECRET, TEST_TIMINGS, afterTools, rightNow } from './harness.js';

const ADMIN = 'admin-token-for-the-e2e-test';

function script(body: any): Reply {
  if (rightNow(body).includes('Simulated for the demo') && !afterTools(body)) {
    return {
      tools: [{
        name: 'post_notice',
        input: { tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm but your cab is at 9. Want me to move it to 11?', for_person_ids: ['p_arjun'] },
      }],
    };
  }
  return { tools: [{ name: 'stay_silent', input: { reason: 'nothing to add' } }] };
}

const isNotice = (w: { method: string; params: unknown }): boolean =>
  w.method === 'post_message' && (w.params as { card?: { kind?: string } }).card?.kind === 'notice';

let db: Awaited<ReturnType<typeof withSchema>>;
let built: Built;
let server: FakeServer;
let port = 0;
const trip = goaFreshTrip();

beforeAll(async () => {
  db = await withSchema();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent', ADMIN_TOKEN: ADMIN,
  });
  built = await buildBrain(env, { pool: db.pool, anthropic: fakeAnthropic(script).client, logger: false, timings: TEST_TIMINGS });
  await registerRoom(built.brain);
  await startProactive(built.brain, { intervals: false, travel: null });
  ({ port } = await built.start());
  server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'sim-p6' });
  await server.start();
  await server.createTrip(trip);
  // Someone speaks after Go's hello, so the first nudge is not "two in a row" (any message of Go's is its last word).
  await server.say('p_priya', 'Cannot wait for Goa!');
  await new Promise((resolve) => setTimeout(resolve, 500));
}, 30_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await db.drop();
});

async function fire(extra: Record<string, unknown> = {}): Promise<Response> {
  const body = JSON.stringify({
    trip_id: trip.trip_id, label: 'IndiGo 6E 2134', person_ids: ['p_arjun'], delay_minutes: 120,
    arrive_at: '2026-11-06T22:45:00+05:30', note: "Arjun's airport cab is booked for 9 pm", ...extra,
  });
  // Setup writes the trip row just after trip.created is answered; try for a few seconds.
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/admin/watch/fire`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body,
    });
    if (res.status !== 404) return res;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the trip never appeared');
}

describe('G5: Go speaks first', () => {
  it('3:40: the simulated delay reaches Arjun as one pinned, labelled notice', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promoted: 1 });
    const write = await server.waitFor(() => server.writes.find(isNotice), 10_000);
    expect((write.params as { card: unknown }).card).toMatchObject({
      kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' },
    });
  });

  it('a double click posts once, and another nudge waits while nobody has spoken (never two in a row)', async () => {
    expect(await (await fire()).json()).toMatchObject({ duplicate: true, promoted: 0 });
    expect(await (await fire({ delay_minutes: 150 })).json()).toMatchObject({ promoted: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(server.writes.filter(isNotice)).toHaveLength(1);
  });

  it('the stage fire (force: true) gets past "two in a row", and two clicks at once post one labelled notice for Arjun', async () => {
    const [a, b] = await Promise.all([fire({ delay_minutes: 180, force: true }), fire({ delay_minutes: 180, force: true })]);
    const answers = [await a.json(), await b.json()] as Array<{ promoted: number; duplicate?: boolean }>;
    expect(answers.filter((x) => x.promoted === 1)).toHaveLength(1);
    expect(answers.filter((x) => x.duplicate === true)).toHaveLength(1);
    const second = await server.waitFor(() => server.writes.filter(isNotice)[1], 10_000);
    expect((second.params as { card: unknown }).card).toMatchObject({
      kind: 'notice', for_person_ids: ['p_arjun'], source: { name: 'Simulated for the demo' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(server.writes.filter(isNotice)).toHaveLength(2);
  });
});
