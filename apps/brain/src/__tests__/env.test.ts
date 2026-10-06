import { describe, expect, it } from 'vitest';
import { Env, LANE_ENVS, loadEnv, RoomEnv } from '../env.js';

const base = {
  DATABASE_URL: 'postgres://go:go@localhost:5432/go_test',
  GO_SIGNING_SECRET: 'a'.repeat(64),
  GO_PUBLIC_URL: 'https://brain.example.com',
  ANTHROPIC_API_KEY: 'sk-test',
};

describe('loadEnv', () => {
  it('needs only lane A, and fills the defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.COMPOSER_MODEL).toBe('claude-sonnet-5-5');
    expect(env.SIDE_MODEL).toBe('claude-haiku-4-5');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('leaves every other lane optional until that lane lands', () => {
    const env = loadEnv(base);
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.VESTRA_API_KEYS).toBeUndefined();
    expect(env.TRAVEL_MODE).toBeUndefined();
    expect(env.VAULT_URL).toBeUndefined();
    expect(env.CALLS_MODE).toBeUndefined();
    expect(env.ADMIN_TOKEN).toBeUndefined();
  });

  it('reads PORT as a number', () => {
    expect(loadEnv({ ...base, PORT: '3000' }).PORT).toBe(3000);
  });

  it('names what is missing', () => {
    const { GO_SIGNING_SECRET, ...rest } = base;
    expect(GO_SIGNING_SECRET).toHaveLength(64);
    expect(() => loadEnv(rest)).toThrow(/GO_SIGNING_SECRET/);
  });

  it('refuses a short signing secret', () => {
    expect(() => loadEnv({ ...base, GO_SIGNING_SECRET: 'short' })).toThrow(/GO_SIGNING_SECRET/);
  });

  it('checks a lane variable when it is set', () => {
    expect(loadEnv({ ...base, TRAVEL_MODE: 'fake' }).TRAVEL_MODE).toBe('fake');
    expect(() => loadEnv({ ...base, TRAVEL_MODE: 'bus' })).toThrow(/TRAVEL_MODE/);
  });

  it('has a stub for every lane in master §6.7, and merges every variable each one declares', () => {
    expect(Object.keys(LANE_ENVS)).toEqual(['reflex', 'memory', 'stats', 'travel', 'tasks', 'money', 'proactive', 'watches', 'calls', 'admin']);
    const merged = Object.keys(Env.shape);
    for (const lane of [RoomEnv, ...Object.values(LANE_ENVS)]) {
      for (const key of Object.keys(lane.shape)) expect(merged, key).toContain(key);
    }
  });

  it('every lane variable is optional or has a default, so Go boots before a lane lands', () => {
    for (const [name, lane] of Object.entries(LANE_ENVS)) {
      expect(lane.safeParse({}).success, name).toBe(true);
    }
  });

  it('drops a variable no lane declares, and keeps it once its lane declares it in its own stub', () => {
    // Today memory/env.ts is empty, so FOLD_AT_TOKENS is dropped; once P2 declares it there, it comes through as a number.
    const declared = Object.keys(LANE_ENVS.memory.shape).includes('FOLD_AT_TOKENS');
    expect((loadEnv({ ...base, FOLD_AT_TOKENS: '12000' }) as Record<string, unknown>).FOLD_AT_TOKENS).toBe(declared ? 12_000 : undefined);
    expect((loadEnv({ ...base, NOT_A_GO_VARIABLE: 'x' }) as Record<string, unknown>).NOT_A_GO_VARIABLE).toBeUndefined();
  });
});
