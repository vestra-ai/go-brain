import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moneyRoutes } from '../callbacks.js';
import { markConfirming, markFailed, markPaid, reconcile } from '../finish.js';
import { signVaultCall } from '../signed.js';
import { getPayment } from '../store.js';
import { moneyKit, type MoneyKit } from './kit.js';

const SECRET = 'test-only-vault-shared-secret-0123456789';
let k: MoneyKit;
let app: FastifyInstance;
let approvalId: string;
let paymentId: string;
let second = 0;

async function call(path: string, body: unknown, o: { secret?: string; header?: string } = {}) {
  const text = JSON.stringify(body);
  const at = new Date(k.now().getTime() + 1000 * ++second);
  const header = o.header ?? signVaultCall(o.secret ?? SECRET, 'POST', path, text, at);
  return { res: await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-vault-signature': header }, payload: text }), header };
}

beforeEach(async () => {
  k = await moneyKit();
  const r = await k.ask();
  if (!('cardId' in r)) throw new Error(r.refused);
  paymentId = r.paymentId;
  approvalId = [...k.server.approvals.keys()][0] as string;
  app = Fastify({ logger: false });
  await app.register(
    moneyRoutes({
      pool: k.pool,
      secret: SECRET,
      now: k.now,
      paid: async (p) => {
        const row = await markPaid(k.deps, p);
        if (!row) return 'unknown';
        await reconcile(k.deps, row.payment_id);
        return 'ok';
      },
      failed: async (p) => ((await markFailed(k.deps, p)) ? 'ok' : 'unknown'),
      confirming: async (p) => ((await markConfirming(k.deps, p)) ? 'ok' : 'unknown'),
    }),
  );
});
afterEach(async () => {
  await app.close();
  await k.drop();
});

describe("the vault's call back", () => {
  it('refuses a call without the shared secret, and a replayed one', async () => {
    const body = { trip_id: 't_goa', approval_id: approvalId, rail_ref: 'fake_1' };
    expect((await app.inject({ method: 'POST', url: '/internal/vault/paid', payload: body })).statusCode).toBe(401);
    expect((await call('/internal/vault/paid', body, { secret: 'x'.repeat(40) })).res.statusCode).toBe(401);
    const first = await call('/internal/vault/paid', body);
    expect(first.res.statusCode).toBe(200);
    expect((await call('/internal/vault/paid', body, { header: first.header })).res.statusCode).toBe(401);
    expect(k.server.writesOf('add_booking')).toHaveLength(1);
  });

  it('finishes the booking on paid', async () => {
    const { res } = await call('/internal/vault/paid', { trip_id: 't_goa', approval_id: approvalId, rail_ref: 'fake_1' });
    expect(res.json()).toEqual({ ok: true });
    expect((await getPayment(k.pool, paymentId))?.booking_id).toMatch(/^b_/);
  });

  it('answers 404 for an approval Go does not know, or one from another trip', async () => {
    expect((await call('/internal/vault/paid', { trip_id: 't_goa', approval_id: 'ap_unknown_01', rail_ref: 'x' })).res.statusCode).toBe(404);
    expect((await call('/internal/vault/paid', { trip_id: 't_other', approval_id: approvalId, rail_ref: 'x' })).res.statusCode).toBe(404);
    expect(k.server.writesOf('add_booking')).toEqual([]);
  });

  it('refuses a body that does not match', async () => {
    expect((await call('/internal/vault/failed', { trip_id: 't_goa', approval_id: approvalId, reason: 'bored' })).res.statusCode).toBe(422);
  });

  it('keeps the payment waiting on the bank on confirming', async () => {
    const { res } = await call('/internal/vault/confirming', { trip_id: 't_goa', approval_id: approvalId });
    expect(res.statusCode).toBe(200);
    expect((await getPayment(k.pool, paymentId))?.state).toBe('confirming');
    expect((await call('/internal/vault/confirming', { trip_id: 't_goa', approval_id: 'ap_unknown_01' })).res.statusCode).toBe(404);
  });

  it('marks the payment failed on failed', async () => {
    const { res } = await call('/internal/vault/failed', { trip_id: 't_goa', approval_id: approvalId, reason: 'card_declined' });
    expect(res.statusCode).toBe(200);
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'failed', fail_reason: 'card_declined', release_reason: 'payment_failed' });
  });
});
