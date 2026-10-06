import type pg from 'pg';

/** Demo fallbacks that flip at runtime with no redeploy. P7 adds the admin page. */
export type SwitchName = 'TRAVEL_MODE' | 'PAY_RAIL' | 'CALLS_MODE' | 'REFLEX_LIVE';

export interface Switches {
  /** The stored value, else the environment's, else the safe default. Read on every use, cached 2 s. */
  get(name: SwitchName): string;
  /** Admin page only; validated per name. */
  set(name: SwitchName, value: string): Promise<void>;
}

const oneOf = (...values: string[]) => (v: string): boolean => values.includes(v);

/** What each switch may hold, and its value when nothing sets it. */
export const SWITCH_RULES: Record<SwitchName, { valid: (v: string) => boolean; fallback: string }> = {
  TRAVEL_MODE: { valid: oneOf('ixigo', 'fake'), fallback: 'fake' },
  PAY_RAIL: { valid: oneOf('ixigo', 'stripe_test', 'fake'), fallback: 'fake' },
  CALLS_MODE: { valid: oneOf('off', 'allowlist'), fallback: 'off' },
  // "q1,q2,..." names the live Jev questions, empty keeps all in shadow, "off" makes no Jev call (P2's kill switch).
  REFLEX_LIVE: { valid: (v) => /^(off|q[1-9](,q[1-9])*)?$/.test(v), fallback: '' },
};

export function createSwitches(o: {
  pool: pg.Pool;
  env: Partial<Record<SwitchName, string | undefined>>;
  now: () => Date;
  cacheMs?: number;
}): Switches & { refresh(): Promise<void> } {
  const cacheMs = o.cacheMs ?? 2_000;
  let stored = new Map<string, string>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const { rows } = await o.pool.query<{ name: string; value: string }>('select name, value from switches');
    stored = new Map(rows.map((r) => [r.name, r.value]));
    loadedAt = o.now().getTime();
  }

  return {
    refresh,
    get(name) {
      // Serve what we have and refresh in the background once it is older than 2 s.
      if (o.now().getTime() - loadedAt > cacheMs && !loading) {
        loading = refresh()
          .catch(() => undefined)
          .finally(() => {
            loading = null;
          });
      }
      return stored.get(name) ?? o.env[name] ?? SWITCH_RULES[name].fallback;
    },
    async set(name, value) {
      if (!SWITCH_RULES[name].valid(value)) throw new Error(`${name} cannot be "${value}"`);
      await o.pool.query(
        `insert into switches (name, value, updated_at) values ($1, $2, $3)
         on conflict (name) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [name, value, o.now()],
      );
      stored.set(name, value);
    },
  };
}
