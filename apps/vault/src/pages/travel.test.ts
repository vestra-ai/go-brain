import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedInject } from '../testing/vault-test-env.js';
import { VAULT_JS } from './assets.js';
import { homePage } from './html.js';
import { startTestVault, type TestVault } from '../testing/start-test-vault.js';
import type { TestAuthenticator } from '../testing/test-authenticator.js';

// A person's travel details (store/travel.ts): saved on their own vault page behind Face ID, read by Go's signed call
// only for a ticket of their own, every save, read and delete in their log without a value.
let v: TestVault;
const now = new Date('2026-10-10T09:00:00Z');
let seconds = 0;
const signedAt = () => new Date(now.getTime() + 1000 * ++seconds);
let meher: TestAuthenticator;
const MEHER = { first_name: 'Meher', last_name: 'Kapoor', gender: 'female', dob: '1996-03-14' };
const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] as string;

async function homeLink(personId: string, start?: string): Promise<string> {
  const res = await signedInject(v.app, { method: 'POST', url: '/internal/links', body: { person_id: personId, ...(start ? { start } : {}) }, now: signedAt() });
  return new URL((res.json() as { url: string }).url).pathname;
}

async function unlocked(personId: string, who: TestAuthenticator, start?: string): Promise<{ path: string; cookie: string }> {
  const path = await homeLink(personId, start);
  const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
  const res = await v.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: who.assert(opts.options) } });
  return { path, cookie: cookieOf(res.headers['set-cookie']) };
}

const read = (personId: string, traveller = personId) => signedInject(v.app, {
  method: 'POST', url: '/internal/travel-details', now: signedAt(),
  body: { trip_id: 't_goa', person_id: personId, booking: { ref: 'fb_01JA7Q3V8Z', traveller_person_id: traveller, purpose: 'Flight to Goa, 6 Nov' } },
});

beforeAll(async () => {
  v = await startTestVault({ now: () => now, goFetch: (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
  meher = await v.passkeyFor('p_meher');
});
afterAll(async () => {
  await v.close();
});

describe('travel details on the vault page', () => {
  it('are saved only behind the unlock, and only with the tick that lets Go use them', async () => {
    const path = await homeLink('p_meher');
    expect((await v.app.inject({ method: 'POST', url: `${path}/travel`, payload: { ...MEHER, allow: true } })).statusCode).toBe(401);
    const { path: open, cookie } = await unlocked('p_meher', meher);
    const bad = await v.app.inject({ method: 'POST', url: `${open}/travel`, headers: { cookie }, payload: { ...MEHER, dob: '2031-01-01', allow: true } });
    expect(bad.statusCode).toBe(400);
    const saved = await v.app.inject({ method: 'POST', url: `${open}/travel`, headers: { cookie }, payload: { ...MEHER, allow: true } });
    expect(saved.json()).toEqual({ saved: true });
    const state = (await v.app.inject({ method: 'GET', url: `${open}/state`, headers: { cookie } })).json() as { travel: Record<string, unknown>; log: Array<{ text: string }> };
    expect(state.travel).toEqual({ ...MEHER, last_used: null });
    expect(state.log.map((l) => l.text)).toContain('Saved your travel details');
    // Before the unlock, the state says nothing of them.
    expect(JSON.stringify((await v.app.inject({ method: 'GET', url: `${path}/state` })).json())).not.toMatch(/Kapoor|1996/);
  });

  it("are read by Go only for the person's own ticket, the read in their log by what it was for, never a value", async () => {
    expect((await read('p_meher', 'p_rahul')).statusCode).toBe(403);
    expect((await read('p_rahul')).statusCode).toBe(404);
    const res = await read('p_meher');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...MEHER, irctc_user_id: null });
    const log = (await v.pool.query("select * from unlock_log where person_id = 'p_meher' and kind = 'travel_read'")).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ trip_id: 't_goa', booking_ref: 'fb_01JA7Q3V8Z', approval_id: null, reason: 'Flight to Goa, 6 Nov' });
    expect(JSON.stringify((await v.pool.query("select * from unlock_log where person_id = 'p_meher'")).rows)).not.toMatch(/Kapoor|1996-03-14|female/);
    // The person sees when it was used, and what for.
    const { path, cookie } = await unlocked('p_meher', meher, 'add_travel');
    const state = (await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie } })).json() as { start: string; travel: { last_used: string } };
    expect(state.start).toBe('add_travel');
    expect(state.travel.last_used).toMatch(/^Last used: Flight to Goa, 6 Nov, /);
  });

  it('are gone, the row itself, when the tick is taken off or they are deleted', async () => {
    const { path, cookie } = await unlocked('p_meher', meher);
    // Unticked with a field emptied still deletes: the tick is the consent, not the fields.
    expect((await v.app.inject({ method: 'POST', url: `${path}/travel`, headers: { cookie }, payload: { ...MEHER, last_name: '', allow: false } })).json()).toEqual({ saved: false });
    expect((await v.pool.query("select count(*)::int as n from travel_details where person_id = 'p_meher'")).rows[0]).toEqual({ n: 0 });
    expect((await read('p_meher')).statusCode).toBe(404);
    await v.app.inject({ method: 'POST', url: `${path}/travel`, headers: { cookie }, payload: { ...MEHER, allow: true } });
    expect((await v.app.inject({ method: 'POST', url: `${path}/travel/delete`, headers: { cookie }, payload: {} })).json()).toEqual({ saved: false });
    expect((await read('p_meher')).statusCode).toBe(404);
    const state = (await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie } })).json() as { travel: unknown; log: Array<{ text: string }> };
    expect(state.travel).toBeNull();
    expect(state.log.map((l) => l.text)).toContain('Deleted your travel details');
  });

  // p0 and p5, 11 Oct: one ask for a ticket's missing details, for trains and buses alike: a train needs the IRCTC user ID.
  it('keep an optional IRCTC user ID for train tickets, read by Go like the rest, never in a log, and never a malformed one', async () => {
    const { path, cookie } = await unlocked('p_meher', meher);
    const save = (extra: Record<string, unknown>) => v.app.inject({ method: 'POST', url: `${path}/travel`, headers: { cookie }, payload: { ...MEHER, ...extra, allow: true } });
    expect((await save({ irctc_user_id: 'meh er!' })).statusCode).toBe(400);
    expect((await save({ irctc_user_id: 'meher_k96' })).json()).toEqual({ saved: true });
    expect((await read('p_meher')).json()).toEqual({ ...MEHER, irctc_user_id: 'meher_k96' });
    const state = (await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie } })).json() as { travel: Record<string, unknown> };
    expect(state.travel).toMatchObject({ irctc_user_id: 'meher_k96' });
    expect(JSON.stringify((await v.pool.query("select * from unlock_log where person_id = 'p_meher'")).rows)).not.toContain('meher_k96');
    // Saved again without it, it is gone.
    await save({ irctc_user_id: null });
    expect((await read('p_meher')).json()).toEqual({ ...MEHER, irctc_user_id: null });
    expect(homePage()).toContain('IRCTC user ID, for train tickets (optional)');
  });

  it('an add_travel link names the details a booking still needs, and its page shows those and any it must have', async () => {
    const link = async (body: Record<string, unknown>) => signedInject(v.app, { method: 'POST', url: '/internal/links', body: { person_id: 'p_meher', ...body }, now: signedAt() });
    const stateOf = async (res: Awaited<ReturnType<typeof link>>) => {
      const path = new URL((res.json() as { url: string }).url).pathname;
      const opts = (await v.app.inject({ method: 'POST', url: `${path}/unlock/options`, payload: {} })).json() as { challenge_id: string; options: never };
      const done = await v.app.inject({ method: 'POST', url: `${path}/unlock/verify`, payload: { challenge_id: opts.challenge_id, response: meher.assert(opts.options) } });
      return (await v.app.inject({ method: 'GET', url: `${path}/state`, headers: { cookie: cookieOf(done.headers['set-cookie']) } })).json() as { start: string; fields: string[] | null };
    };
    expect(await stateOf(await link({ start: 'add_travel', fields: ['dob', 'irctc_user_id'] }))).toMatchObject({ start: 'add_travel', fields: ['dob', 'irctc_user_id'] });
    // A detail the vault doesn't keep is refused; a home link takes no fields.
    expect((await link({ start: 'add_travel', fields: ['passport'] })).statusCode).toBe(422);
    expect(await stateOf(await link({ fields: ['dob'] }))).toMatchObject({ start: 'home', fields: null });
    // The page shows the fields named, and any it must have that isn't kept yet.
    expect(VAULT_JS).toContain('el.hidden = !!wanted && !wanted.includes(name) && !(must[name] && !$(must[name]).value);');
  });
});
