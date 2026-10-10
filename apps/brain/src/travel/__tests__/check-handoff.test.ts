import { describe, expect, it, vi } from 'vitest';
import type { CardTapResult } from '../../door/methods.js';
import { CHECK_ASK_EVERY_MS, CHECK_LINE, CHECK_LOOK_MS, CHECK_TAB, CHECK_WAIT_MS, createCheckHandOff } from '../check-handoff.js';

const PAGE = 'https://www.ixigo.com/hotels/search/result?locationId=32&checkinDate=13112026&checkoutDate=15112026&adultCount=2';
type Tap = (tap: { trip_id: string; person_id: string; card_id: string; action_id: string; tap_id: string }) => Promise<CardTapResult>;

/** The check's world: the trip's browser (its hand-off, its looks, its release), the room, the clock, the taps. */
function world(o: { looks?: Array<number | null>; challenged?: boolean; loginOpen?: boolean; onLook?: (n: number) => Promise<void> } = {}) {
  let nowMs = Date.parse('2026-10-10T02:30:00Z');
  const requests: Array<{ method: string; params: any }> = [];
  let looked = 0;
  const runner = {
    handOff: vi.fn(async () => ({ captures: [], ...(o.challenged === false ? {} : { challenged: true as const }) })),
    tabCall: vi.fn(async () => {
      looked += 1;
      await o.onLook?.(looked);
      const s = o.looks ? o.looks[Math.min(looked, o.looks.length) - 1] : 403;
      return s === null || s === undefined ? null : { match: 'tab_call', url: 'https://www.ixigo.com/', status: s, content_type: null, body: '', truncated: false, at_ms: 0 };
    }),
    release: vi.fn(async () => undefined),
  };
  const taps = new Map<string, Tap>();
  const info = vi.fn();
  const check = createCheckHandOff({
    runner: () => runner as never,
    link: { request: (async (method: string, params: unknown) => { requests.push({ method, params }); return {}; }) as never },
    packs: { get: (async () => ({ trip: { organizer_person_id: 'p_rahul', people: [] } })) as never },
    screen: () => async (_t: string, mode: 'view' | 'control') => ({ url: `https://watch.test/${mode}`, expires_at: '2026-10-10T02:45:00Z' }),
    loginOpen: async () => o.loginOpen === true,
    now: () => new Date(nowMs),
    log: { warn: vi.fn(), info },
    sleep: async (ms) => {
      nowMs += ms;
    },
  });
  check.registerTaps({ on: (kind: string, action: string, h: Tap) => taps.set(`${kind}/${action}`, h) } as never);
  const tap = (person: string) => taps.get('notice/ixigo_check_watch')!({ trip_id: 't_goa', person_id: person, card_id: 'c', action_id: 'ixigo_check_watch', tap_id: `tap_${person}` });
  return { check, runner, requests, info, tap, advance: (ms: number) => (nowMs += ms) };
}

describe("Cloudflare's check, handed to a person", () => {
  it("opens the checked page in front for the organizer, says it once, and when ixigo lets the browser through, closes it and answers true", async () => {
    const taps: CardTapResult[] = [];
    let w: ReturnType<typeof world>;
    w = world({ looks: [403, 403, 200], onLook: async (n) => { if (n === 1) taps.push(await w.tap('p_rahul'), await w.tap('p_priya')); } });
    expect(await w.check.ask('t_goa', PAGE)).toBe(true);
    // The same front hand-off as the login, on the page that was checked, the check itself kept for them.
    expect(w.runner.handOff).toHaveBeenCalledWith('t_goa', PAGE, expect.anything(), { keepOpenMs: CHECK_WAIT_MS, tab: CHECK_TAB, check: { url: '/', method: 'GET' }, keepChallenge: true });
    const [posted, ...after] = w.requests;
    expect(posted).toMatchObject({
      method: 'post_message',
      params: { trip_id: 't_goa', text: CHECK_LINE, mentions: ['p_rahul'], card: { kind: 'notice', for_person_ids: ['p_rahul'], actions: [{ action_id: 'ixigo_check_watch', only_for_person_ids: ['p_rahul'] }] } },
    });
    // Only the organizer gets Go's screen, in control, to tick it; Go never ticks it.
    expect(taps).toEqual([{ result: 'open', url: 'https://watch.test/control', expires_at: '2026-10-10T02:45:00Z' }, { result: 'refused', toast: 'This check is for the trip organizer.' }]);
    // Cleared on the third look: the hand-off closes on its own, the card says so, and how long it took is logged.
    expect(w.runner.tabCall).toHaveBeenCalledTimes(3);
    expect(w.runner.release).toHaveBeenCalledWith('t_goa', CHECK_TAB);
    expect(after).toEqual([{ method: 'replace_card', params: { trip_id: 't_goa', card: expect.objectContaining({ title: 'ixigo let Go through', actions: [] }) } }]);
    expect(w.info).toHaveBeenCalledWith({ tripId: 't_goa', ms: 3 * CHECK_LOOK_MS }, "travel: a person cleared ixigo's check on Go's screen");
    // Nothing is open once it is done: a late tap opens nothing.
    expect(await w.tap('p_rahul')).toMatchObject({ result: 'refused' });
  });

  it('asks a browser once in 10 minutes, shares one ask between searches at once, and never over the login', async () => {
    const w = world({ looks: [200] });
    const [a, b] = await Promise.all([w.check.ask('t_goa', PAGE), w.check.ask('t_goa', PAGE)]);
    expect([a, b]).toEqual([true, true]);
    expect(w.runner.handOff).toHaveBeenCalledTimes(1);
    expect(await w.check.ask('t_goa', PAGE)).toBe(false);
    w.advance(CHECK_ASK_EVERY_MS);
    expect(await w.check.ask('t_goa', PAGE)).toBe(true);
    expect(w.runner.handOff).toHaveBeenCalledTimes(2);
    const login = world({ loginOpen: true });
    expect(await login.check.ask('t_goa', PAGE)).toBe(false);
    expect(login.runner.handOff).not.toHaveBeenCalled();
  });

  it('asks nothing when the check passed by itself before it opened', async () => {
    const w = world({ challenged: false });
    expect(await w.check.ask('t_goa', PAGE)).toBe(true);
    expect(w.requests).toEqual([]);
    expect(w.runner.release).toHaveBeenCalledWith('t_goa', CHECK_TAB);
  });

  it('closes after 3 minutes nobody ticked it, or once its tab is gone, saying so: false, and the search fails as before', async () => {
    const slow = world();
    expect(await slow.check.ask('t_goa', PAGE)).toBe(false);
    expect(slow.runner.tabCall).toHaveBeenCalledTimes(CHECK_WAIT_MS / CHECK_LOOK_MS);
    expect(slow.requests.at(-1)).toMatchObject({ method: 'replace_card', params: { card: { title: "A quick check on Go's screen", actions: [], body: expect.stringContaining('closed after 3 minutes') } } });
    expect(slow.runner.release).toHaveBeenCalledWith('t_goa', CHECK_TAB);
    const gone = world({ looks: [403, null] });
    expect(await gone.check.ask('t_goa', PAGE)).toBe(false);
    expect(gone.runner.tabCall).toHaveBeenCalledTimes(2);
  });

  it("opens ixigo's home for a page off ixigo, never another site", async () => {
    const w = world({ looks: [200] });
    await w.check.ask('t_goa', 'https://evil.example/');
    expect(w.runner.handOff).toHaveBeenCalledWith('t_goa', 'https://www.ixigo.com/', expect.anything(), expect.anything());
  });
});
