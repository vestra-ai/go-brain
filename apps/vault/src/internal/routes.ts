import { Id } from '@go/contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { VaultDeps } from '../app.js';
import { rawBody } from '../http/security.js';
import { createHomeLink } from '../links.js';
import { ensurePerson } from '../store/people.js';
import { checkInternal } from './auth.js';
import { PayLinkBody, openPayLink } from './pay-links.js';

const LinkBody = z.object({
  person_id: Id,
  // The contract's CreateLink allows add_login; the vault takes it and opens the home, which offers a card only.
  start: z.enum(['home', 'add_card', 'add_login']).nullish(),
  display_name: z.string().min(1).max(80).nullish(),
});

const invalid = (error: z.ZodError) => ({ error: { code: 'invalid', message: z.prettifyError(error).slice(0, 500) } });

/** The only calls Go makes to the vault. Each one is signed with VAULT_SHARED_SECRET. */
export const internalRoutes: FastifyPluginAsync<{ deps: VaultDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req, reply) => {
    const check = await checkInternal(deps.pool, deps.env.VAULT_SHARED_SECRET, req, rawBody(req), deps.now());
    if (!check.ok) return reply.code(401).send({ error: { code: 'bad_signature', message: 'signature refused' } });
    return undefined;
  });

  app.post('/internal/links', async (req, reply) => {
    const body = LinkBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(invalid(body.error));
    const now = deps.now();
    await ensurePerson(deps.pool, body.data.person_id, now, body.data.display_name ?? undefined);
    const link = await createHomeLink(deps.pool, now, { personId: body.data.person_id, start: body.data.start === 'add_card' ? 'add_card' : 'home' });
    return { url: `${deps.env.VAULT_PUBLIC_URL}/l/${link.token}`, expires_at: link.expiresAt.toISOString() };
  });

  app.post('/internal/pay-links', async (req, reply) => {
    const body = PayLinkBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(invalid(body.error));
    const result = await openPayLink(deps.pool, deps.env, deps.now(), body.data);
    if (!result.ok) {
      return reply.code(409).send({ error: { code: 'conflict', message: `the vault refused: ${result.reason}`, reason: result.reason } });
    }
    return { url: result.url, expires_at: result.expiresAt.toISOString() };
  });

  // Payments without both keys, counted from the vault's own records. Always 0 by construction.
  app.get('/internal/both-keys', async () => {
    const charged = await deps.pool.query<{ approval_id: string }>(
      "select distinct approval_id from unlock_log where kind = 'pay_ok' and approval_id is not null order by approval_id",
    );
    const missing = await deps.pool.query<{ n: number }>(
      `select (
         (select count(*) from unlock_log
           where kind in ('pay_attempt', 'pay_ok', 'pay_failed') and not (coalesce(passkey_ok, false) and coalesce(approval_ok, false)))
         + (select count(*) from used_approvals u
           where not exists (select 1 from unlock_log l
             where l.kind = 'pay_attempt' and l.approval_id = u.approval_id and l.passkey_ok and l.approval_ok))
       )::int as n`,
    );
    return { charged_approval_ids: charged.rows.map((r) => r.approval_id), without_both_keys: missing.rows[0]?.n ?? 0 };
  });
};
