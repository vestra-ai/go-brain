// By hand after a deploy: plays the Server against the deployed Go, with the real model.
//   GO_URL=https://<brain host> GO_SIGNING_SECRET=... pnpm --filter @go/brain exec tsx scripts/smoke.ts
import { FakeServer, goaFreshTrip } from '@go/sim';
import { waitTyping, waitWrite } from '../src/testing/watch.js';

const goUrl = process.env.GO_URL;
const secret = process.env.GO_SIGNING_SECRET;
if (!goUrl || !secret) throw new Error('set GO_URL and GO_SIGNING_SECRET');

const fake = new FakeServer({ goUrl, secret, instance: `smoke-${Date.now()}` });
await fake.start(15_000);
await fake.createTrip({ ...goaFreshTrip(), trip_id: `t_smoke_${Date.now()}` });
const hello = await waitWrite(fake, (w) => w.method === 'post_message', 30_000);
console.log('greeting:', hello.params.text, '| card:', hello.params.card?.kind);

const sentAt = Date.now();
await fake.say('p_priya', '@Go what is the weather like in Goa in early November?');
const typing = await waitTyping(fake, true, sentAt, 5_000);
const reply = await waitWrite(fake, (w) => w.method === 'post_message' && w.at > sentAt, 30_000);
// Measured from this machine: includes the round trip to Railway's region.
console.log(`typing after ${typing.at - sentAt} ms, reply after ${reply.at - sentAt} ms:`, reply.params.text);
fake.stop();
