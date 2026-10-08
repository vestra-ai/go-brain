import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
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

/** One line in Go's voice, outside a turn. The request id comes from what triggered it, so a retry posts it once. */
export async function postLine(d: Pick<MoneyDeps, 'link'>, tripId: string, text: string, requestId: string): Promise<void> {
  await d.link.request('post_message', { request_id: requestId, trip_id: tripId, text: clip(plain(text), 2000) });
}

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
