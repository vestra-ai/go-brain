// Starts the hosted "try Go" room from the environment (env.ts): `node packages/sim/dist/try-room/main.js`, or
// `pnpm --filter @go/sim try` after a build. The dev room's command line (cli.ts) stays as it is.
import { FakeServer } from '../fake-server.js';
import { TryEnv } from './env.js';
import { serveTryRoom } from './serve.js';

const env = TryEnv.parse(process.env);
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const fake = new FakeServer({ goUrl: env.GO_URL, secret: env.GO_SIGNING_SECRET, instance: env.TRY_INSTANCE, log });
// The page is up before Go answers: it says Go is not answering, and the socket keeps dialling.
void fake.start().catch((err: unknown) => log(`the socket to Go did not open: ${String(err)}`));

const room = await serveTryRoom({
  fake,
  passcode: env.TRY_PASSCODE,
  goUrl: env.GO_URL,
  port: env.PORT,
  host: '0.0.0.0',
  trustProxy: true,
  caps: {
    dailyGoAsks: env.TRY_DAILY_GO_ASKS,
    dailyMessages: env.TRY_DAILY_MESSAGES,
    sessionGoAsks: env.TRY_SESSION_GO_ASKS,
    dailyTrips: env.TRY_DAILY_TRIPS,
  },
  simulatedLine: env.TRY_SIMULATED_LINE,
  log,
});
log(`the try room is listening on port ${env.PORT}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    fake.stop();
    void room.close().finally(() => process.exit(0));
  });
}
