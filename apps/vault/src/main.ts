import { buildVault } from './app.js';
import { migrate } from './db/migrate.js';
import { makePool } from './db/pool.js';
import { readVaultEnv } from './env.js';
import { startSweep } from './go-callback.js';
import { makeRails } from './rails/index.js';
import { customerIdOf } from './store/people.js';
import { realStripe } from './stripe-client.js';

const env = readVaultEnv();
const pool = makePool(env.VAULT_DATABASE_URL);
await migrate(pool);
const stripe = realStripe(env.STRIPE_SECRET_KEY);
const rails = makeRails({ stripe, customerOf: (personId) => customerIdOf(pool, personId) });
const now = () => new Date();
const app = await buildVault({ env, pool, now, stripe, rails, fetch, logger: { level: 'info' } });
startSweep({ env, pool, now, rails, fetch, log: app.log });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
