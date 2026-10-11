import type { RegisterLane } from '../app.js';
import { statsRegistry } from '../stats/sources.js';
import { closeRooms, createRoomsCards } from '../travel/rooms-card.js';
import { askToPay, inTurn } from './ask.js';
import { moneyRoutes } from './callbacks.js';
import { claimCardOnClose, claimTap } from './claim-taps.js';
import { CLAIM_ACTION, createClaims } from './claims.js';
import { Later, type MoneyDeps } from './deps.js';
import { createPay } from './engine.js';
import { readMoneyEnv } from './env.js';
import { readExpensesTool, recordExpenseTool } from './expenses.js';
import { setMandate } from './mandate.js';
import { paidButNotBooked } from './store.js';
import { paymentsNow } from './now.js';
import { askToPayTool, setMandateTool } from './tools.js';
import { vaultClient, type PaymentKind } from './vault-client.js';
import { vaultLinkHandler } from './vault-link.js';

const railOf = (value: string): PaymentKind => (value === 'ixigo' || value === 'stripe_test' || value === 'fake' ? value : 'fake');

/** Lane D. Tests pass a fetch that reaches an in-process vault, and 0 to leave the sweep off. */
export function registerMoneyWith(o: { fetch?: typeof fetch; sweepEveryMs?: number; payWithVault?: boolean } = {}): RegisterLane {
  return async (brain) => {
    // What people say they paid needs no vault: Go records it and reads who owes whom whether or not paying is on.
    brain.tools.register(recordExpenseTool({ pool: brain.pool }));
    brain.tools.register(readExpensesTool());
    const env = readMoneyEnv(brain.env);
    if (!env) {
      brain.log.warn('money is off: set VAULT_URL and VAULT_SHARED_SECRET to turn it on');
      return;
    }
    const { VAULT_URL, VAULT_SHARED_SECRET } = env;
    const vault = vaultClient({ baseUrl: VAULT_URL, secret: VAULT_SHARED_SECRET, now: brain.now, ...(o.fetch ? { fetch: o.fetch } : {}) });
    const claims = createClaims(brain.pool, brain.now);
    const roomsCards = { store: createRoomsCards(brain.pool), link: brain.door.link, packs: brain.packs, log: brain.log };
    const d: MoneyDeps = {
      pool: brain.pool,
      link: brain.door.link,
      travel: () => brain.travel,
      vault,
      payRail: () => railOf(brain.switches.get('PAY_RAIL')),
      now: brain.now,
      log: brain.log,
      tapVaultMs: 1_500,
      ...(o.payWithVault ? { payWithVault: true } : {}),
      claims,
      // The rooms the group picked on a stay's rooms card (REV4 B5, travel/rooms-card.ts), for one expense a room (B6):
      // asking for the payment closes the card (its final state, taps refused) and gives the pick it closed with.
      rooms: async (row) =>
        (await closeRooms(roomsCards, row.trip_id, row.option_ref))?.rooms.map((r) => ({ label: r.label, person_ids: r.personIds, price_minor: r.priceMinor })) ?? null,
    };
    const pay = createPay(d);
    brain.pay = pay;

    // In a turn, the pay card rides Go's message while the tool waits; past its wait, money posts it itself (inTurn).
    brain.tools.register(askToPayTool((ctx, a) => {
      const turn = inTurn(d, ctx);
      const asking = askToPay(d, ctx.tripId, a, turn.ids, turn.deliver);
      return { asking, letGo: () => turn.letGo(asking) };
    }));
    brain.tools.register(setMandateTool((ctx, a) => setMandate(d, ctx, a)));
    brain.taps.on('pay', 'approve', (tap, card) => pay.approveTap(tap, card));
    brain.taps.on('pay', 'decline', (tap, card) => pay.declineTap(tap, card));
    // Who books a stay for all: the card on Go's line about the closed vote, and its I'll book it.
    const claiming = { d, claims, packs: brain.packs, later: new Later() };
    brain.taps.on('notice', CLAIM_ACTION, claimTap(claiming));
    brain.context.addTurnCard(claimCardOnClose(claiming));
    brain.door.handle('vault_link', vaultLinkHandler(vault));
    brain.context.addNow(paymentsNow({ pool: brain.pool, packs: brain.packs, now: brain.now, travel: () => brain.travel, claims }));
    brain.tripLog.onEvent((ev) => pay.heard(ev));
    await brain.http.register(
      moneyRoutes({ pool: brain.pool, secret: VAULT_SHARED_SECRET, now: brain.now, paid: (p) => pay.paid(p), failed: (p) => pay.failed(p), confirming: (p) => pay.confirming(p) }),
    );
    // The proof board's number, counted from both sides' records (it replaces P3's default under the same name).
    statsRegistry(brain).add({
      name: 'payments_without_both_keys',
      label: 'Payments without both keys',
      order: 100,
      good: 'zero',
      read: async () => {
        const r = await pay.withoutBothKeys();
        return { value: r.count, of: r.paid, note: "From the vault's unlock log and Go's payments: the Server's approval and the payer's passkey on every one." };
      },
    });
    statsRegistry(brain).add({
      name: 'paid_but_not_booked',
      label: 'Paid but not booked',
      order: 101,
      good: 'zero',
      read: async (pool, w) => {
        const r = await paidButNotBooked(pool, w.to);
        return { value: r.missing, of: r.paid, note: 'Payments the vault took that Go has not booked in the room yet. The sweep keeps trying them.' };
      },
    });

    const every = o.sweepEveryMs ?? 30_000;
    let sweeping: Promise<unknown> | null = null;
    const timer =
      every > 0
        ? setInterval(() => {
            // A slow sweep is never doubled: the next beat is skipped while one runs.
            if (sweeping) return;
            sweeping = pay
              .sweep()
              .catch((e: unknown) => brain.log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'the payments sweep failed'))
              .finally(() => {
                sweeping = null;
              });
          }, every)
        : null;
    timer?.unref();
    // When Go stops (built.stop()): no new sweep, then wait for the sweep in flight and the work taps and trip changes started.
    brain.onStop(async () => {
      if (timer) clearInterval(timer);
      await sweeping;
      await pay.settled();
    });
  };
}

export const registerMoney: RegisterLane = registerMoneyWith();
