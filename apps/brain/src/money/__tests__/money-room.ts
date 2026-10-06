import type * as C from '@go/contract';
import { FakeServer, goaFreshTrip } from '@go/sim';
import { injectFetch, startTestVault, TEST_SHARED_SECRET } from '@go/vault/testing';
import { buildBrain, type Built } from '../../app.js';
import { fakeAnthropic, type Script } from '../../__tests__/fixtures/fake-anthropic.js';
import { withSchema } from '../../db/test-db.js';
import { loadEnv } from '../../env.js';
import { registerRoom } from '../../room.js';
import type { PayEngine } from '../engine.js';
import { registerMoneyWith } from '../register.js';
import { FakeTravel } from './kit.js';

const SECRET = 'm'.repeat(64);

/** True when a model request answers a round of tool calls. */
export const afterTools = (body: any): boolean => {
  const last = body?.messages?.at(-1);
  return Array.isArray(last?.content) && last.content.some((b: { type: string }) => b.type === 'tool_result');
};
export const bodyText = (body: unknown): string => JSON.stringify(body);

/** The guide's Goa people with the stay vote, open or closed with a mandate the payer has not confirmed yet. */
export function goaWithStayVote(stage: 'open' | 'mandate'): C.TripSnapshot {
  const trip = goaFreshTrip();
  const closed = stage === 'mandate';
  return {
    ...trip,
    decisions: [
      {
        decision_id: 'd_villa',
        question: 'Where do we stay?',
        kind: 'choice',
        anonymous: false,
        status: closed ? 'closed' : 'open',
        // As P4's put_to_vote makes them: option_ref is the options card's option_id; FakeTravel.offer() resolves it.
        options: [
          { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'opt_villa_sol', note: '3 nights, private pool, Anjuna' },
          { label: 'Casa Azul', price_minor: 6180000, currency: 'INR', option_ref: 'opt_casa_azul' },
          { label: 'The Palms', price_minor: 5850000, currency: 'INR', option_ref: 'opt_the_palms' },
        ],
        voted: closed ? 5 : 0,
        of: trip.people.length,
        tally: closed ? [4, 1, 0] : [0, 0, 0],
        opened_at: trip.created_at,
        ...(closed
          ? {
              result_index: 0,
              closed_at: trip.created_at,
              mandate: { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', set_at: trip.created_at },
            }
          : {}),
      },
    ],
  };
}

/**
 * Go on a real port (room lane plus money lane, scripted model, fake travel), P0's FakeServer on the signed socket,
 * and a whole vault in this process. The vault reaches Go's callback routes in process too.
 * This is P5's own harness for this week; it can move to P1's reusable e2e harness (which registers LANES) once that lands.
 */
export async function startMoneyRoom(o: { script: Script }) {
  const db = await withSchema();
  let built: Built | null = null;
  const goFetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (!built) throw new Error('Go is not up');
    return injectFetch(built.brain.http)(input, init);
  }) as typeof fetch;
  const now = () => new Date();
  const vault = await startTestVault({ goFetch, now });
  const env = loadEnv({
    PORT: '0',
    DATABASE_URL: process.env.DATABASE_URL,
    GO_SIGNING_SECRET: SECRET,
    GO_PUBLIC_URL: 'http://127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key',
    LOG_LEVEL: 'silent',
    VAULT_URL: 'https://vault.test',
    VAULT_SHARED_SECRET: TEST_SHARED_SECRET,
    PAY_RAIL: 'fake',
  });
  const model = fakeAnthropic(o.script);
  const b = await buildBrain(env, { pool: db.pool, anthropic: model.client, logger: false, timings: { waitMs: 300, deskPollMs: 50, deskRetryMs: [50, 100] } });
  built = b;
  const travel = new FakeTravel(now);
  b.brain.travel = travel;
  await registerRoom(b.brain);
  await registerMoneyWith({ fetch: vault.fetch, sweepEveryMs: 0 })(b.brain);
  const { port } = await b.start();
  const server = new FakeServer({ goUrl: `http://127.0.0.1:${port}`, secret: SECRET, instance: 'money' });
  await server.start(10_000);
  return {
    server,
    model,
    built: b,
    db,
    vault,
    travel,
    pay: b.brain.pay as PayEngine,
    async stop() {
      server.stop();
      await b.stop();
      await vault.close();
      await db.drop();
    },
  };
}
