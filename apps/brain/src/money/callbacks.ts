import { Id } from '@go/contract';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { VaultFailReason } from './finish.js';
import { checkVaultCall, keepRawJson, rawBodyOf } from './signed.js';

const PaidBody = z.object({ trip_id: Id, approval_id: Id, rail_ref: z.string().min(1).max(200) });
const FailedBody = z.object({
  trip_id: Id,
  approval_id: Id,
  reason: z.enum(['card_declined', 'needs_authentication', 'rail_error', 'rail_not_ready']),
});

export interface MoneyRoutesOptions {
  pool: pg.Pool;
  secret: string;
  now: () => Date;
  paid: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<'ok' | 'unknown'>;
  failed: (p: { tripId: string; approvalId: string; reason: VaultFailReason }) => Promise<'ok' | 'unknown'>;
}

/** The vault's calls back to Go. Only a call signed with VAULT_SHARED_SECRET, seen once, gets through. */
export function moneyRoutes(o: MoneyRoutesOptions): FastifyPluginAsync {
  return async (scope) => {
    keepRawJson(scope);
    scope.addHook('preHandler', async (req, reply) => {
      if (!(await checkVaultCall(o.pool, o.secret, req, rawBodyOf(req), o.now()))) {
        return reply.code(401).send({ error: { code: 'bad_signature', message: 'signature refused' } });
      }
      return undefined;
    });
    const invalid = (error: z.ZodError) => ({ error: { code: 'invalid', message: z.prettifyError(error).slice(0, 500) } });
    const unknown = { error: { code: 'not_found', message: 'no payment with that approval in that trip' } };

    scope.post('/internal/vault/paid', async (req, reply) => {
      const body = PaidBody.safeParse(req.body);
      if (!body.success) return reply.code(422).send(invalid(body.error));
      const r = await o.paid({ tripId: body.data.trip_id, approvalId: body.data.approval_id, railRef: body.data.rail_ref });
      return r === 'unknown' ? reply.code(404).send(unknown) : { ok: true };
    });

    scope.post('/internal/vault/failed', async (req, reply) => {
      const body = FailedBody.safeParse(req.body);
      if (!body.success) return reply.code(422).send(invalid(body.error));
      const r = await o.failed({ tripId: body.data.trip_id, approvalId: body.data.approval_id, reason: body.data.reason });
      return r === 'unknown' ? reply.code(404).send(unknown) : { ok: true };
    });
  };
}
