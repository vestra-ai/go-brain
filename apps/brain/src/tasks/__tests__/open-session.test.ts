import { describe, expect, it } from 'vitest';
import { openSession, SESSION_RETRY_MAX_MS } from '../taps.js';
import { V1Error, type V1Client } from '../v1-client.js';

/** A /v1 that records each POST /v1/sessions body and answers with what `answer` says for it. */
function v1(answer: (body: Record<string, unknown>) => V1Error | null) {
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    async call(_method: string, _path: string, o?: { body?: unknown }) {
      const body = o?.body as Record<string, unknown>;
      bodies.push(body);
      const err = answer(body);
      if (err) throw err;
      return { id: `ses_${bodies.length}`, url: `https://screen.example/${String(body.screen)}`, expires_at: '2026-10-11T09:00:00.000Z' };
    },
  } as unknown as V1Client;
  return { client, bodies };
}

// Keshav, 11 Oct: "the person logging in has control from the first frame": the login's screen asks for driver: user.
describe('openSession', () => {
  it('asks for driver: user on a control screen, and never on a view', async () => {
    const s = v1(() => null);
    await openSession(s.client, 'u_1', null, 'control', { driver: 'user' });
    await openSession(s.client, 'u_1', null, 'view', { driver: 'user' });
    expect(s.bodies).toEqual([
      { user_id: 'u_1', screen: 'control', driver: 'user' },
      { user_id: 'u_1', screen: 'view' },
    ]);
  });

  it('a Bash from before driver (400) opens the control screen as it did; control switched off still falls back to a view', async () => {
    const old = v1((b) => ('driver' in b ? new V1Error(400, 'invalid_request', 'driver is not a field') : null));
    expect(await openSession(old.client, 'u_1', null, 'control', { driver: 'user' })).toMatchObject({ url: 'https://screen.example/control' });
    expect(old.bodies).toEqual([
      { user_id: 'u_1', screen: 'control', driver: 'user' },
      { user_id: 'u_1', screen: 'control' },
    ]);
    const off = v1((b) => (b.screen === 'control' ? new V1Error(409, 'screen_control_unavailable', 'off') : null));
    expect(await openSession(off.client, 'u_1', null, 'control', { driver: 'user' })).toMatchObject({ url: 'https://screen.example/view' });
    expect(off.bodies.at(-1)).toEqual({ user_id: 'u_1', screen: 'view' });
  });

  // 11 Oct: Saket's Log in to ixigo found every Go key resting for a moment, and said "Can't open Go's screen right now".
  it('a short 429 is waited out and tried once more; a long one is not', async () => {
    let n = 0;
    const brief = v1(() => (n++ === 0 ? new V1Error(429, 'rate_limited', 'Every /v1 key is resting.', 20) : null));
    expect(await openSession(brief.client, 'u_1', null, 'control', { driver: 'user' })).toMatchObject({ url: 'https://screen.example/control' });
    expect(brief.bodies).toHaveLength(2);
    const long = v1(() => new V1Error(429, 'rate_limited', 'Every /v1 key is resting.', SESSION_RETRY_MAX_MS + 1));
    await expect(openSession(long.client, 'u_1', null, 'control')).rejects.toMatchObject({ status: 429 });
    expect(long.bodies).toHaveLength(1);
    let m = 0;
    const twice = v1(() => (m++ < 2 ? new V1Error(429, 'rate_limited', 'Every /v1 key is resting.', 20) : null));
    await expect(openSession(twice.client, 'u_1', null, 'view')).rejects.toMatchObject({ status: 429 });
    expect(twice.bodies).toHaveLength(2);
  });
});
