import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { VaultDeps } from '../app.js';
import { masterKeyOf } from '../crypto/envelope.js';
import { readCookie, sessionCookie } from '../http/security.js';
import { findLink, hashToken, linkProblem, type LinkRow } from '../links.js';
import { authenticationOptions, finishRegistration, hasPasskey, passkeyConfig, registrationOptions, verifyAssertion } from '../passkeys.js';
import { approvePayment, payInfo, payOptions, type PayDeps } from '../pay.js';
import { listCards, saveCardFromSetup, startCardSetup } from '../store/cards.js';
import { personName } from '../store/people.js';
import { TravelDetails, deleteTravel, readOwnTravel, realBirthday, saveTravel } from '../store/travel.js';
import { lastTravelRead, logUnlock, readUnlockLog } from '../store/unlock-log.js';
import { VAULT_CSS, VAULT_JS } from './assets.js';
import { homePage, payPage } from './html.js';
import { PAY_MESSAGES, brandLabel, lastUsedLabel, moneyLabel, unlockLine, whenLabel } from './words.js';

const require = createRequire(import.meta.url);
const WEBAUTHN_JS = readFileSync(
  join(dirname(require.resolve('@simplewebauthn/browser')), '..', 'dist', 'bundle', 'index.umd.min.js'),
  'utf8',
);

const SESSION = 'vs';
const SESSION_SECONDS = 600;

const Ceremony = z.object({
  challenge_id: z.string().min(1).max(64),
  response: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
});
const CardBody = z.object({ setup_intent_id: z.string().regex(/^seti_[A-Za-z0-9_]{1,200}$/) });
/** The travel section's save: the details, and the tick that lets Go use them (unticked, they are deleted). */
const TravelBody = TravelDetails.extend({ allow: z.boolean() });

type WithToken = { Params: { token: string } };
type TokenRequest = FastifyRequest<WithToken>;

export const pageRoutes: FastifyPluginAsync<{ deps: VaultDeps }> = async (app, { deps }) => {
  const db = deps.pool;
  const cfg = passkeyConfig(deps.env);
  const master = masterKeyOf(deps.env.VAULT_MASTER_KEY);
  const payDeps: PayDeps = { env: deps.env, pool: db, now: deps.now, rails: deps.rails, fetch: deps.fetch, log: app.log };

  app.get('/static/vault.css', async (_req, reply) => reply.type('text/css; charset=utf-8').send(VAULT_CSS));
  app.get('/static/vault.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').send(VAULT_JS));
  app.get('/static/webauthn.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').send(WEBAUTHN_JS));
  app.get('/l/:token', async (_req, reply) => reply.type('text/html; charset=utf-8').send(homePage()));
  app.get('/p/:token', async (_req, reply) => reply.type('text/html; charset=utf-8').send(payPage()));

  // ── home ──

  async function homeLink(req: TokenRequest): Promise<LinkRow | null> {
    const link = await findLink(db, req.params.token);
    if (linkProblem(link, deps.now()) || !link || link.kind !== 'home') return null;
    return link;
  }

  function hasSession(req: FastifyRequest, link: LinkRow): boolean {
    const value = readCookie(req, SESSION);
    if (!value || !link.session_hash || !link.session_until) return false;
    return hashToken(value).equals(link.session_hash) && link.session_until.getTime() > deps.now().getTime();
  }

  async function openSession(reply: FastifyReply, link: LinkRow, token: string): Promise<void> {
    const value = randomBytes(32).toString('base64url');
    await db.query('update links set session_hash = $2, session_until = $3 where link_id = $1', [
      link.link_id,
      hashToken(value),
      new Date(deps.now().getTime() + SESSION_SECONDS * 1000),
    ]);
    reply.header('set-cookie', sessionCookie(SESSION, value, `/l/${token}`, SESSION_SECONDS));
  }

  async function unlocked(req: TokenRequest, reply: FastifyReply): Promise<LinkRow | null> {
    const link = await homeLink(req);
    if (!link || !hasSession(req, link)) {
      await reply.code(401).send({ message: 'Unlock your vault first.' });
      return null;
    }
    return link;
  }

  app.get<WithToken>('/l/:token/state', async (req) => {
    const link = await homeLink(req);
    if (!link) return { state: 'expired' };
    if (!hasSession(req, link)) return { state: (await hasPasskey(db, link.person_id)) ? 'unlock' : 'register' };
    const [cards, log, travel, used] = await Promise.all([
      listCards(db, link.person_id), readUnlockLog(db, link.person_id), readOwnTravel(db, master, link.person_id), lastTravelRead(db, link.person_id),
    ]);
    return {
      state: 'open',
      start: link.start,
      publishable_key: deps.env.STRIPE_PUBLISHABLE_KEY,
      cards: cards.map((c) => ({ brand_label: brandLabel(c.brand), last4: c.last4, expires: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}` })),
      // The person's own details, to them alone once unlocked, and when Go last used them, for what.
      travel: travel ? { ...travel, last_used: used ? lastUsedLabel(used) : null } : null,
      log: log.map((row) => ({ when: whenLabel(row.at), text: unlockLine(row) })),
    };
  });

  app.post<WithToken>('/l/:token/register/options', async (req, reply) => {
    const link = await homeLink(req);
    if (!link) return reply.code(410).send({ message: PAY_MESSAGES.link_expired });
    if (await hasPasskey(db, link.person_id)) return reply.code(409).send({ message: 'Your vault already has Face ID. Unlock it instead.' });
    const name = await personName(db, link.person_id);
    const { challengeId, options } = await registrationOptions(db, cfg, deps.now(), {
      personId: link.person_id,
      linkId: link.link_id,
      ...(name ? { displayName: name } : {}),
    });
    return { challenge_id: challengeId, options };
  });

  app.post<WithToken>('/l/:token/register/verify', async (req, reply) => {
    const link = await homeLink(req);
    const body = Ceremony.safeParse(req.body);
    if (!link || !body.success) return reply.code(400).send({ message: "That didn't work. Try again." });
    const done = await finishRegistration(db, cfg, deps.now(), {
      personId: link.person_id,
      linkId: link.link_id,
      challengeId: body.data.challenge_id,
      response: body.data.response as unknown as RegistrationResponseJSON,
    });
    if (!done.ok) return reply.code(400).send({ message: "That didn't work. Try again." });
    await logUnlock(db, deps.now(), { personId: link.person_id, kind: 'passkey_added' });
    await openSession(reply, link, req.params.token);
    return { ok: true };
  });

  app.post<WithToken>('/l/:token/unlock/options', async (req, reply) => {
    const link = await homeLink(req);
    if (!link) return reply.code(410).send({ message: PAY_MESSAGES.link_expired });
    const opts = await authenticationOptions(db, cfg, deps.now(), { personId: link.person_id, linkId: link.link_id, purpose: 'unlock' });
    if (!opts) return reply.code(409).send({ message: 'Set up Face ID first.' });
    return { challenge_id: opts.challengeId, options: opts.options };
  });

  app.post<WithToken>('/l/:token/unlock/verify', async (req, reply) => {
    const link = await homeLink(req);
    const body = Ceremony.safeParse(req.body);
    if (!link || !body.success) return reply.code(400).send({ message: "That didn't work. Try again." });
    const check = await verifyAssertion(db, cfg, deps.now(), {
      linkId: link.link_id,
      purpose: 'unlock',
      challengeId: body.data.challenge_id,
      response: body.data.response as unknown as AuthenticationResponseJSON,
    });
    if (!check.ok) return reply.code(400).send({ message: "That didn't work. Try again." });
    if (check.personId !== link.person_id) return reply.code(403).send({ message: 'Only the owner can open this vault.' });
    await logUnlock(db, deps.now(), { personId: link.person_id, kind: 'unlock' });
    await openSession(reply, link, req.params.token);
    return { ok: true };
  });

  app.post<WithToken>('/l/:token/cards/setup', async (req, reply) => {
    const link = await unlocked(req, reply);
    if (!link) return reply;
    const { clientSecret } = await startCardSetup(db, deps.stripe, link.person_id, deps.now());
    return { client_secret: clientSecret, publishable_key: deps.env.STRIPE_PUBLISHABLE_KEY };
  });

  app.post<WithToken>('/l/:token/cards', async (req, reply) => {
    const link = await unlocked(req, reply);
    if (!link) return reply;
    const body = CardBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: 'The card was not saved.' });
    const saved = await saveCardFromSetup(db, deps.stripe, master, deps.now(), { personId: link.person_id, setupIntentId: body.data.setup_intent_id });
    if (!saved.ok) return reply.code(409).send({ message: 'The card was not saved. Try again.' });
    return { brand_label: brandLabel(saved.card.brand), last4: saved.card.last4 };
  });

  // Travel details, behind the unlock as cards are. Saved only with the tick that lets Go use them for the person's own
  // tickets; unticked, or deleted, the row itself goes.
  app.post<WithToken>('/l/:token/travel', async (req, reply) => {
    const link = await unlocked(req, reply);
    if (!link) return reply;
    const body = TravelBody.safeParse(req.body);
    if (!body.success || !realBirthday(body.data.dob, deps.now())) return reply.code(400).send({ message: 'Check your details: your name as on your ID, and a real date of birth.' });
    const { allow, ...details } = body.data;
    if (!allow) {
      if (await deleteTravel(db, link.person_id)) await logUnlock(db, deps.now(), { personId: link.person_id, kind: 'travel_deleted' });
      return { saved: false };
    }
    await saveTravel(db, master, deps.now(), link.person_id, details);
    await logUnlock(db, deps.now(), { personId: link.person_id, kind: 'travel_saved' });
    return { saved: true };
  });

  app.post<WithToken>('/l/:token/travel/delete', async (req, reply) => {
    const link = await unlocked(req, reply);
    if (!link) return reply;
    if (await deleteTravel(db, link.person_id)) await logUnlock(db, deps.now(), { personId: link.person_id, kind: 'travel_deleted' });
    return { saved: false };
  });

  // ── pay ──

  app.get<WithToken>('/p/:token/info', async (req) => {
    const info = await payInfo(payDeps, req.params.token);
    if (info.state === 'used') return { state: 'used', title: 'Already used', message: PAY_MESSAGES.link_used };
    if (info.state === 'expired') return { state: 'expired', title: 'This link has expired', message: PAY_MESSAGES.link_expired };
    if (info.state === 'invalid') return { state: 'invalid', title: "This link doesn't work", message: PAY_MESSAGES.link_invalid };
    const labels = {
      amount_label: moneyLabel(info.amount_minor, info.currency),
      merchant: info.merchant,
      purpose: info.purpose,
      refundable_label: info.refundable_until ? `Free cancellation until ${whenLabel(info.refundable_until)}` : null,
      card_label: info.card ? `${brandLabel(info.card.brand)} ending ${info.card.last4}` : null,
    };
    if (info.state === 'no_passkey') return { state: 'no_passkey', title: 'Set up your vault first', message: PAY_MESSAGES.no_card, ...labels };
    if (info.state === 'no_card') return { state: 'no_card', title: 'Add a card first', message: PAY_MESSAGES.no_card, ...labels };
    return { state: 'ready', ...labels };
  });

  app.post<WithToken>('/p/:token/options', async (req, reply) => {
    const opts = await payOptions(payDeps, req.params.token);
    if (!opts.ok) return reply.code(409).send({ reason: opts.reason, message: PAY_MESSAGES[opts.reason] });
    return { challenge_id: opts.challengeId, options: opts.options };
  });

  app.post<WithToken>('/p/:token/approve', async (req, reply) => {
    const body = Ceremony.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ state: 'refused', message: PAY_MESSAGES.passkey_failed, retry: true });
    const result = await approvePayment(payDeps, {
      token: req.params.token,
      challengeId: body.data.challenge_id,
      response: body.data.response as unknown as AuthenticationResponseJSON,
    });
    if (result.state === 'paid') return { state: 'paid', message: PAY_MESSAGES.paid };
    if (result.state === 'confirming') return { state: 'confirming', message: PAY_MESSAGES.confirming, retry: false };
    if (result.state === 'failed') return { state: 'failed', message: PAY_MESSAGES[result.reason], retry: false };
    return { state: 'refused', message: PAY_MESSAGES[result.reason], retry: result.reason === 'passkey_failed' };
  });
};
