import { describe, expect, it } from 'vitest';
import { DEMO_PEOPLE } from '../../scenarios/demo.js';
import { cueGapMs, parseRehearseArgs, patienceMs, readHealth, RefusedError, rehearsalTrip, rehearse } from '../run.js';

const HEALTH = {
  at: '2026-10-08T13:30:00.000Z',
  role: 'rehearsal',
  trip_id: null,
  server_socket_open: false,
  probes: [{ name: 'server', label: "The Server's socket", dot: 'red', ms: 0, detail: 'no Server is connected to Go' }],
  switches: { TRAVEL_MODE: 'fake', PAY_RAIL: 'fake', CALLS_MODE: 'allowlist', REFLEX_LIVE: 'q1,q2,q3' },
  calls: { mode: 'allowlist', allowlist: [], allowlist_count: 0 },
};

function healthFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, urls };
}

const base = { go: 'https://brain.example.com', secret: 's'.repeat(64), adminToken: 't'.repeat(24), warm: false, log: () => undefined };
const ALLOWED = { mode: 'allowlist', allowlist: ['Anjuna Dive Shop'], allowlist_count: 1 };

describe('the rehearsal runner', () => {
  it('refuses before it opens any socket when calls are on the allowlist and the list is empty', async () => {
    const { f, urls } = healthFetch(HEALTH);
    const err = await rehearse({ ...base, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).reasons.join(' ')).toMatch(/CALLS_ALLOWLIST is empty/);
    expect(urls).toEqual(['https://brain.example.com/admin/health.json']);
  });

  it('says so when the admin token is refused', async () => {
    const { f } = healthFetch({ error: { code: 'bad_signature', message: 'Wrong or missing admin token.' } }, 401);
    await expect(rehearse({ ...base, fetch: f })).rejects.toThrow(/admin token was refused/);
  });

  it('refuses a full run, before it opens any socket, when a Server is connected: that is the stage Go', async () => {
    const { f, urls } = healthFetch({ ...HEALTH, server_socket_open: true, calls: ALLOWED });
    const err = await rehearse({ ...base, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).reasons).toEqual([expect.stringMatching(/brain-rehearsal/)]);
    expect(urls).toEqual(['https://brain.example.com/admin/health.json']);
  });

  it('refuses a full run, before it opens any socket, on a Go that says it is the stage Go', async () => {
    const { f, urls } = healthFetch({ ...HEALTH, role: 'stage', calls: ALLOWED });
    const err = await rehearse({ ...base, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).reasons).toEqual([expect.stringMatching(/GO_ROLE=stage/)]);
    expect(urls).toEqual(['https://brain.example.com/admin/health.json']);
  });

  it('refuses a full run, before it opens any socket, on the try-room Go', async () => {
    const { f, urls } = healthFetch({ ...HEALTH, role: 'try', calls: ALLOWED });
    const err = await rehearse({ ...base, fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).reasons).toEqual([expect.stringMatching(/GO_ROLE=try/)]);
    expect(urls).toEqual(['https://brain.example.com/admin/health.json']);
  });

  it('--warm on the stage Go only reads health.json for the real trip: no socket, no trip, no message, no secret', async () => {
    const { f, urls } = healthFetch({ ...HEALTH, server_socket_open: true, trip_id: 't_real' });
    const out = await rehearse({ go: base.go, adminToken: base.adminToken, warm: true, trip: 't_real', fetch: f, log: () => undefined });
    expect(out).toMatchObject({ warmed: true, tripId: null, runs: [], health: { trip_id: 't_real', server_socket_open: true } });
    expect(urls).toEqual(['https://brain.example.com/admin/health.json?trip=t_real']);
    const direct = healthFetch({ ...HEALTH, trip_id: 't_real' });
    expect(await readHealth({ go: base.go, adminToken: base.adminToken, trip: 't_real', fetch: direct.f })).toMatchObject({ trip_id: 't_real' });
  });

  it('--warm without the real trip is refused, because the health read warms that trip', async () => {
    const { f, urls } = healthFetch(HEALTH);
    const err = await rehearse({ go: base.go, adminToken: base.adminToken, warm: true, fetch: f, log: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).reasons.join(' ')).toMatch(/--trip/);
    expect(urls).toEqual([]);
  });

  it("spaces the cues as the run sheet does, and waits up to three times a beat's budget", () => {
    // The call cue 15 s after the villa cue and the weather 10 s after that, so the stop window overlaps the job.
    expect(cueGapMs('villa_start', 'call_line')).toBe(15_000);
    expect(cueGapMs('call_line', 'weather')).toBe(10_000);
    expect(patienceMs('call_line')).toBe(20_000);
    expect(patienceMs('call')).toBe(105_000);
    expect(patienceMs('villa_done')).toBe(180_000);
    expect(patienceMs('call_outcome')).toBe(20_000);
  });

  it('makes a fresh rehearsal trip every run, with the Goa people and never the real trip', () => {
    const a = rehearsalTrip(new Date('2026-10-08T13:35:02Z'));
    const b = rehearsalTrip(new Date('2026-10-08T13:41:10Z'));
    expect(a.trip_id).toBe('t_reh_20261008133502');
    expect(b.trip_id).toBe('t_reh_20261008134110');
    expect(a.title).toBe('Rehearsal 19:05');
    expect(a.people.map((p) => p.person_id).sort()).toEqual([...DEMO_PEOPLE].sort());
  });

  it('reads its settings from flags, or from the environment: a full run on brain-rehearsal, --warm on the stage Go', () => {
    const env = { GO_REHEARSAL_URL: 'https://rehearsal.example.com/', GO_STAGE_URL: 'https://brain.example.com', GO_SIGNING_SECRET: 's'.repeat(64), GO_ADMIN_TOKEN: 't'.repeat(24) };
    expect(parseRehearseArgs(['--', '--new-trip'], env)).toEqual({ go: 'https://rehearsal.example.com', secret: 's'.repeat(64), adminToken: 't'.repeat(24), warm: false });
    expect(parseRehearseArgs(['--warm', '--trip', 't_real'], env)).toEqual({ go: 'https://brain.example.com', adminToken: 't'.repeat(24), warm: true, trip: 't_real' });
    expect(parseRehearseArgs(['--go', 'https://g.test', '--secret', 'x'.repeat(64), '--admin-token', 'y'.repeat(20)], {})).toEqual({
      go: 'https://g.test', secret: 'x'.repeat(64), adminToken: 'y'.repeat(20), warm: false,
    });
    // A warm read needs no secret: it opens no socket.
    expect(parseRehearseArgs(['--warm', '--go', 'https://g.test', '--trip', 't_real', '--admin-token', 'y'.repeat(20)], {})).not.toHaveProperty('secret');
    expect(() => parseRehearseArgs(['--secret', 'x'], {})).toThrow(/--go/);
    expect(() => parseRehearseArgs(['--go', 'https://g.test'], {})).toThrow(/GO_SIGNING_SECRET/);
    expect(() => parseRehearseArgs(['--go', 'https://g.test', '--secret', 'x'], {})).toThrow(/ADMIN_TOKEN/);
    // Never a full run on the stage Go.
    expect(() => parseRehearseArgs(['--go', 'https://brain.example.com/'], env)).toThrow(/brain-rehearsal/);
  });
});
