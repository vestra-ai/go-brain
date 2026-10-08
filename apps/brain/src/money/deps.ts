import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type * as C from '@go/contract';
import { mentionsIn } from '../composer/speak.js';
import type { ServerLink } from '../door/server-link.js';
import type { Travel } from '../travel/travel.js';
import type { Claims } from './claims.js';
import type { PaymentKind, VaultClient } from './vault-client.js';
import { clip, plain } from './words.js';

export interface MoneyDeps {
  pool: pg.Pool;
  link: ServerLink;
  /** The travel layer, read on every use (P4 sets brain.travel). */
  travel: () => Travel | undefined;
  vault: VaultClient;
  /** PAY_RAIL, read on every ask so the demo switch flips without a redeploy. */
  payRail: () => PaymentKind;
  now: () => Date;
  log: FastifyBaseLogger;
  /** The vault call inside an Approve tap. P1's tap router answers within 2.5 s. */
  tapVaultMs?: number;
  /** Who books a stay for the group (claims.ts): the payer is whoever claimed it, never Go's pick. Absent: no claims. */
  claims?: Claims;
}

/** Who a money line can name: the payer, or the trip's people. */
export type Named = ReadonlyArray<Pick<C.Person, 'person_id' | 'name' | 'go_paused'>>;

/**
 * One line in Go's voice, outside a turn. The request id comes from what triggered it, so a retry posts it once. The
 * people it names ("Rahul, the payment for … didn't go through") get a push, as in a turn (composer/speak.ts).
 */
export async function postLine(d: Pick<MoneyDeps, 'link'>, tripId: string, text: string, requestId: string, people: Named = []): Promise<void> {
  const line = clip(plain(text), 2000);
  const mentions = mentionsIn(line, people);
  await d.link.request('post_message', { request_id: requestId, trip_id: tripId, text: line, ...(mentions.length ? { mentions } : {}) });
}

/** A payments row's payer, as postLine takes people. */
export const payerOf = (row: { payer_person_id: string; payer_name: string }): Named => [
  { person_id: row.payer_person_id, name: row.payer_name, go_paused: false },
];

/** Work done after an answer was sent. Errors are logged, and tests can wait for all of it. */
export class Later {
  private readonly running = new Set<Promise<void>>();

  run(log: FastifyBaseLogger, label: string, fn: () => Promise<unknown>): void {
    const p: Promise<void> = fn()
      .then(() => undefined)
      .catch((e: unknown) => {
        log.error({ err: e instanceof Error ? e.message : 'unknown' }, `${label} failed`);
      })
      .finally(() => {
        this.running.delete(p);
      });
    this.running.add(p);
  }

  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}
