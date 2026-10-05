import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TripSnapshot, signSpendApproval, verifySpendApproval } from '@go/contract';
import { GOA_PEOPLE, GOA_SEED_CHAT, GOA_SNAPSHOT, GOA_TRIP_ID, goaFreshTrip } from '../goa.js';
import { TEST_SPEND_PRIVATE_KEY_PEM, TEST_SPEND_PUBLIC_KEY_PEM } from '../test-spend-key.js';

function guideSnapshot(): unknown {
  const md = readFileSync(new URL('../../../../docs/guide/04-gos-requests.md', import.meta.url), 'utf8');
  const block = md.match(/<!-- schema: TripSnapshot -->\s*```json\n([\s\S]*?)\n```/);
  if (!block?.[1]) throw new Error('the TripSnapshot example is missing from the guide');
  return JSON.parse(block[1]);
}

describe('the Goa trip', () => {
  it('is exactly the read_trip example in the guide', () => {
    expect(GOA_SNAPSHOT).toEqual(guideSnapshot());
  });

  it('passes the contract, as it is and fresh', () => {
    expect(TripSnapshot.parse(GOA_SNAPSHOT)).toEqual(GOA_SNAPSHOT);
    const fresh = goaFreshTrip();
    expect(TripSnapshot.parse(fresh)).toEqual(fresh);
  });

  it('starts fresh at change 1 with the same five people and nothing decided', () => {
    const fresh = goaFreshTrip();
    expect(fresh.trip_id).toBe(GOA_TRIP_ID);
    expect(fresh.seq).toBe(1);
    expect(fresh.people.map((p) => p.person_id)).toEqual(Object.values(GOA_PEOPLE));
    expect(fresh.decisions).toEqual([]);
    expect(fresh.bookings).toEqual([]);
    expect(fresh.expenses).toEqual([]);
    expect(fresh.record).toEqual([]);
    expect(fresh.money).toEqual({ currency: 'INR', plan_minor: null, spent_minor: 0, by_category: [], transfers: [] });
    expect(fresh.budget).toEqual({ lowest: null, answered: 0, of: 5 });
  });

  it('hands out a new copy each time', () => {
    const a = goaFreshTrip();
    a.title = 'Changed';
    expect(goaFreshTrip().title).toBe('Goa 🌴');
    expect(GOA_SNAPSHOT.title).toBe('Goa 🌴');
  });

  it('has a seed chat from people in the trip, with only the last line for Go', () => {
    const ids = new Set<string>(Object.values(GOA_PEOPLE));
    for (const line of GOA_SEED_CHAT) expect(ids.has(line.personId)).toBe(true);
    expect(GOA_SEED_CHAT.filter((l) => /@go\b/i.test(l.text))).toEqual([GOA_SEED_CHAT[GOA_SEED_CHAT.length - 1]]);
    for (const line of GOA_SEED_CHAT) expect(line.text).not.toContain('\u2014');
  });
});

describe('the test spend key', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8')) as {
    private_key_pem: string; public_key_pem: string; claims: Parameters<typeof signSpendApproval>[0]; token: string; verify_at: number;
  };

  it('is the contract test vector key, and reproduces its token', () => {
    expect(TEST_SPEND_PRIVATE_KEY_PEM).toBe(vectors.private_key_pem);
    expect(TEST_SPEND_PUBLIC_KEY_PEM).toBe(vectors.public_key_pem);
    expect(signSpendApproval(vectors.claims, TEST_SPEND_PRIVATE_KEY_PEM)).toBe(vectors.token);
    expect(verifySpendApproval(vectors.token, TEST_SPEND_PUBLIC_KEY_PEM, vectors.verify_at)).toMatchObject({ ok: true });
  });
});
