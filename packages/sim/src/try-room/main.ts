// Starts the hosted "try Go" room from the environment (env.ts): `node packages/sim/dist/try-room/main.js`, or
// `pnpm --filter @go/sim try` after a build. The dev room's command line (cli.ts) stays as it is.
import { FakeServer } from '../fake-server.js';
import { TryEnv } from './env.js';
import { openLiveFeed } from './live-feed.js';
import { serveTryRoom } from './serve.js';

const env = TryEnv.parse(process.env);
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const fake = new FakeServer({ goUrl: env.GO_URL, secret: env.GO_SIGNING_SECRET, instance: env.TRY_INSTANCE, log });
// The page is up before Go answers: it says Go is not answering, and the socket keeps dialling.
void fake.start().catch((err: unknown) => log(`the socket to Go did not open: ${String(err)}`));

const room = await serveTryRoom({
  fake,
  passcode: env.TRY_PASSCODE,
  cookieSalt: env.TRY_COOKIE_SALT,
  goUrl: env.GO_URL,
  port: env.PORT,
  host: '0.0.0.0',
  trustProxy: true,
  caps: { dailyTurns: env.TRY_DAILY_TURNS, dailyMessages: env.TRY_DAILY_MESSAGES, visitTurns: env.TRY_VISIT_TURNS },
  ...(env.TRY_SIMULATED_LINE ? { simulatedLine: env.TRY_SIMULATED_LINE } : {}),
  ...(env.TRY_LIVE === '1'
    ? {
      live: (tripId: string, onMessage: (m: unknown) => void) => openLiveFeed({ goUrl: env.GO_URL, secret: env.GO_SIGNING_SECRET, tripId, onMessage, log }),
      ...(env.TRY_WATCH_ORIGIN ? { watchOrigin: env.TRY_WATCH_ORIGIN } : {}),
    }
    : {}),
  log,
});
log(`the try room is listening on port ${env.PORT}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    fake.stop();
    void room.close().finally(() => process.exit(0));
  });
}
