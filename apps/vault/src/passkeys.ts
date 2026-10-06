import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Db } from './store/people.js';

export const CHALLENGE_TTL_MS = 120_000;

export interface PasskeyConfig {
  rpId: string;
  origin: string;
  rpName: string;
}

export function passkeyConfig(env: { WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string }): PasskeyConfig {
  return { rpId: env.WEBAUTHN_RP_ID, origin: env.WEBAUTHN_ORIGIN, rpName: 'Go' };
}

type Purpose = 'register' | 'unlock' | 'pay';

interface PasskeyRow {
  credential_id: string;
  person_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
}

async function passkeysOf(db: Db, personId: string): Promise<PasskeyRow[]> {
  const r = await db.query<PasskeyRow>(
    'select credential_id, person_id, public_key, counter, transports from passkeys where person_id = $1',
    [personId],
  );
  return r.rows;
}

export async function hasPasskey(db: Db, personId: string): Promise<boolean> {
  const r = await db.query('select 1 from passkeys where person_id = $1 limit 1', [personId]);
  return (r.rowCount ?? 0) > 0;
}

async function saveChallenge(db: Db, now: Date, c: { personId: string; linkId: string; purpose: Purpose; challenge: string }): Promise<string> {
  const challengeId = `ch_${randomBytes(12).toString('hex')}`;
  await db.query(
    'insert into challenges (challenge_id, link_id, person_id, purpose, challenge, expires_at) values ($1, $2, $3, $4, $5, $6)',
    [challengeId, c.linkId, c.personId, c.purpose, c.challenge, new Date(now.getTime() + CHALLENGE_TTL_MS)],
  );
  return challengeId;
}

/** Marks the challenge used and returns it, or null when it is unknown, used, expired or meant for something else. */
async function takeChallenge(
  db: Db,
  now: Date,
  c: { challengeId: string; linkId: string; purpose: Purpose },
): Promise<{ challenge: string; personId: string } | null> {
  const r = await db.query<{ challenge: string; person_id: string }>(
    `update challenges set used_at = $2
     where challenge_id = $1 and link_id = $3 and purpose = $4 and used_at is null and expires_at > $2
     returning challenge, person_id`,
    [c.challengeId, now, c.linkId, c.purpose],
  );
  const row = r.rows[0];
  return row ? { challenge: row.challenge, personId: row.person_id } : null;
}

const transportsOf = (row: PasskeyRow): AuthenticatorTransportFuture[] => row.transports as AuthenticatorTransportFuture[];

export async function registrationOptions(
  db: Db,
  cfg: PasskeyConfig,
  now: Date,
  o: { personId: string; linkId: string; displayName?: string },
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const name = o.displayName ?? 'Your Go vault';
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpId,
    userName: name,
    userDisplayName: name,
    attestationType: 'none',
    excludeCredentials: (await passkeysOf(db, o.personId)).map((p) => ({ id: p.credential_id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = await saveChallenge(db, now, { personId: o.personId, linkId: o.linkId, purpose: 'register', challenge: options.challenge });
  return { challengeId, options };
}

export async function finishRegistration(
  db: Db,
  cfg: PasskeyConfig,
  now: Date,
  o: { personId: string; linkId: string; challengeId: string; response: RegistrationResponseJSON },
): Promise<{ ok: true; credentialId: string } | { ok: false; reason: 'challenge' | 'not_verified' }> {
  const taken = await takeChallenge(db, now, { challengeId: o.challengeId, linkId: o.linkId, purpose: 'register' });
  if (!taken || taken.personId !== o.personId) return { ok: false, reason: 'challenge' };
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: o.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpId,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: 'not_verified' };
  }
  if (!verified.verified) return { ok: false, reason: 'not_verified' };
  const c = verified.registrationInfo.credential;
  await db.query(
    `insert into passkeys (credential_id, person_id, public_key, counter, transports, created_at)
     values ($1, $2, $3, $4, $5, $6) on conflict (credential_id) do nothing`,
    [c.id, o.personId, Buffer.from(c.publicKey), c.counter, c.transports ?? [], now],
  );
  return { ok: true, credentialId: c.id };
}

export async function authenticationOptions(
  db: Db,
  cfg: PasskeyConfig,
  now: Date,
  o: { personId: string; linkId: string; purpose: 'unlock' | 'pay' },
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON } | null> {
  const keys = await passkeysOf(db, o.personId);
  if (keys.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId,
    allowCredentials: keys.map((p) => ({ id: p.credential_id, transports: transportsOf(p) })),
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = await saveChallenge(db, now, { personId: o.personId, linkId: o.linkId, purpose: o.purpose, challenge: options.challenge });
  return { challengeId, options };
}

/** Checks one assertion and answers whose passkey it was. The caller compares that person with the payer. */
export async function verifyAssertion(
  db: Db,
  cfg: PasskeyConfig,
  now: Date,
  o: { linkId: string; purpose: 'unlock' | 'pay'; challengeId: string; response: AuthenticationResponseJSON },
): Promise<{ ok: true; personId: string } | { ok: false; reason: 'challenge' | 'unknown_passkey' | 'not_verified' }> {
  const taken = await takeChallenge(db, now, { challengeId: o.challengeId, linkId: o.linkId, purpose: o.purpose });
  if (!taken) return { ok: false, reason: 'challenge' };
  const r = await db.query<PasskeyRow>(
    'select credential_id, person_id, public_key, counter, transports from passkeys where credential_id = $1',
    [o.response.id],
  );
  const key = r.rows[0];
  if (!key) return { ok: false, reason: 'unknown_passkey' };
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: o.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpId,
      credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: transportsOf(key) },
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: 'not_verified' };
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) return { ok: false, reason: 'not_verified' };
  await db.query('update passkeys set counter = $2, last_used_at = $3 where credential_id = $1', [
    key.credential_id,
    verified.authenticationInfo.newCounter,
    now,
  ]);
  return { ok: true, personId: key.person_id };
}
