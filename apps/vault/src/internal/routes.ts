import { Id } from '@go/contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { VaultDeps } from '../app.js';
import { masterKeyOf } from '../crypto/envelope.js';
import { rawBody } from '../http/security.js';
import { createHomeLink } from '../links.js';
import { ensurePerson } from '../store/people.js';
import { TRAVEL_FIELDS, travelForBooking } from '../store/travel.js';
import { logUnlock } from '../store/unlock-log.js';
import { checkInternal } from './auth.js';
import { PayLinkBody, openPayLink, voidPayLinks } from './pay-links.js';

const LinkBody = z.object({
  person_id: Id,
  // The contract's CreateLink allows add_login; the vault takes it and opens the home, which offers a card only.
  // add_travel opens it at the person's travel details.
  start: z.enum(['home', 'add_card', 'add_login', 'add_travel']).nullish(),
  display_name: z.string().min(1).max(80).nullish(),
  /**
   * add_travel: the travel details a booking still needs (Go's one ask for a ticket: a date of birth, the IRCTC user ID
   * for a train); its page shows those, with any it must have that the person hasn't kept. Absent: every field.
   */
  fields: z.array(z.enum(TRAVEL_FIELDS)).min(1).max(TRAVEL_FIELDS.length).nullish(),
  /** 1.3 (rev 5 R8): embedded, inside the App: its Done button and note. Any page may be framed by the App's origins. */
  display: z.enum(['sheet', 'embedded']).nullish(),
});

const VoidBody = z.object({ approval_id: Id });

/**
 * A ticket Go is booking for one person: whose details it asks for, the traveller that booking is for, and what for (the
 * person's page shows it). The vault answers only for the traveller themselves.
 */
const TravelBody = z.object({
  trip_id: Id,
  person_id: Id,
  booking: z.object({ ref: Id, traveller_person_id: Id, purpose: z.string().trim().min(1).max(120) }),
});

const invalid = (error: z.ZodError) => ({ error: { code: 'invalid', message: z.prettifyError(error).slice(0, 500) } });

/** The only calls Go makes to the vault. Each one is signed with VAULT_SHARED_SECRET. */
export const internalRoutes: FastifyPluginAsync<{ deps: VaultDeps }> = async (app, { deps }) => {
  const master = masterKeyOf(deps.env.VAULT_MASTER_KEY);
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
    const start = body.data.start === 'add_card' || body.data.start === 'add_travel' ? body.data.start : 'home';
    const display = body.data.display === 'embedded' ? 'embedded' : 'sheet';
    const link = await createHomeLink(deps.pool, now, { personId: body.data.person_id, start, display, fields: start === 'add_travel' ? (body.data.fields ?? null) : null });
    return { url: `${deps.env.VAULT_PUBLIC_URL}/l/${link.token}`, expires_at: link.expiresAt.toISOString() };
  });

  app.post('/internal/pay-links', async (req, reply) => {
    const body = PayLinkBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(invalid(body.error));
    const result = await openPayLink(deps.pool, deps.env, deps.now(), body.data);
    if (!result.ok) {
      // Logged by the approval, never a token: the operator sees why the Server's approvals are refused (a wrong key, say).
      app.log.warn({ approval_id: body.data.approval_id, trip_id: body.data.trip_id, reason: result.reason, detail: result.detail ?? null }, 'the vault refused a pay link');
      const message = result.detail ? `the vault refused: ${result.reason} (${result.detail})` : `the vault refused: ${result.reason}`;
      return reply.code(409).send({
        error: { code: 'conflict', message, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) },
      });
    }
    return { url: result.url, expires_at: result.expiresAt.toISOString() };
  });

  // Go let a payment go (declined, expired, failed or refused): its pay links stop working, and no new one is made.
  app.post('/internal/pay-links/void', async (req, reply) => {
    const body = VoidBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(invalid(body.error));
    return { ok: true, voided: await voidPayLinks(deps.pool, deps.now(), body.data.approval_id) };
  });

  // Payments without both keys, counted from the vault's own records. Always 0 by construction.
  // A person's travel details for a ticket of their own Go is booking (store/travel.ts): their values, or none. The answer
  // is never logged; the read is, without a value.
  app.post('/internal/travel-details', async (req, reply) => {
    const body = TravelBody.safeParse(req.body);
    if (!body.success) return reply.code(422).send(invalid(body.error));
    const { trip_id: tripId, person_id: personId, booking } = body.data;
    if (personId !== booking.traveller_person_id) {
      return reply.code(403).send({ error: { code: 'not_the_traveller', message: "a person's travel details are read only for a ticket of their own" } });
    }
    const now = deps.now();
    const details = await travelForBooking(deps.pool, master, now, { personId, travellerPersonId: booking.traveller_person_id });
    if (!details) return reply.code(404).send({ error: { code: 'none', message: 'no travel details kept' } });
    await logUnlock(deps.pool, now, { personId, kind: 'travel_read', tripId, bookingRef: booking.ref, reason: booking.purpose });
    return { first_name: details.first_name, last_name: details.last_name, gender: details.gender, dob: details.dob, irctc_user_id: details.irctc_user_id ?? null };
  });

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
