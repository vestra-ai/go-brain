// Boots the fake Go: `node dist/main.js` with GO_SIGNING_SECRET and FAKE_GO_ADMIN_TOKEN set (PORT is optional).
import { fakeGoBehaviour } from './behaviour.js';
import { Env, publicUrl } from './env.js';
import { buildFakeGo } from './server.js';

const env = Env.parse(process.env);
const base = publicUrl(env);
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const fake = buildFakeGo({
  secret: env.GO_SIGNING_SECRET,
  adminToken: env.FAKE_GO_ADMIN_TOKEN,
  log,
  behaviour: (link) => fakeGoBehaviour(link, { publicUrl: base, log }),
});
await fake.app.listen({ port: env.PORT, host: '0.0.0.0' });
log(`the fake Go is listening on port ${env.PORT}; its links start ${base}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void fake.close().finally(() => process.exit(0));
  });
}
