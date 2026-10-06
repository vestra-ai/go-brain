import { BenchSummary } from '@go/brain/dist/stats/index.js';
import { describe, expect, it } from 'vitest';
import type { LiveRun } from '../compare.js';
import { liveEnv, parseArgs, postSummary, toBoardSummary } from '../run-live.js';
import type { ChatScore } from '../score.js';

const score = {
  chat: 'goa-300', mode: 'live', composerModel: 'claude-sonnet-5-5', reflexSource: 'live',
  messages: { people: 300, goLinesSkipped: 0, edits: 1, deletes: 1, reactions: 1, photos: 2 },
  wake: { turns: 33, messages: 300, rate: 0.11 },
  typing: { n: 12, p50Ms: 120, p90Ms: 240, missing: 0, withoutPost: 0 },
  reply: { n: 12, p50Ms: 1850, p90Ms: 3400 },
  speak: { asks: 12, answered: 12, missed: [], posts: 14, byKind: { prompted: 12, follow_up: 1, greeting: 1, duplicate: 0, unprompted: 0 }, unprompted: [], duplicates: [] },
  quiet: { reactions: 9, wrongReactions: [], recordLines: 3 },
  cache: { requests: 40, eligible: 40, hitRate: 0.9, hitRateAll: 0.87, status: 'ok', results: { hit: 35, first: 1, below_minimum: 0, ttl: 3, rules_changed: 0, delete: 1, edit: 0, fold: 0, drift: 0 }, folds: [] },
  turns: [],
  prompt: { maxTokens: 24_000, lastTokens: 23_500, average: { tools: 1200, system: 3800, chat: 15_000, now: 900 } },
  recall: { probes: 7, ran: true, passed: 7, afterFold: 0, failed: [] },
  leaks: [], firstToken: { p50Ms: 700, p90Ms: 1100 }, side: { requests: 12, tokens: 30_000 }, costUsd: 0.21, unreadByReflex: 0, durationMs: 600_000,
} satisfies ChatScore;
const run: LiveRun = { model: 'claude-sonnet-5-5', chat: 'goa-300', score, provider: { requests: 40, cacheHit: 0.92, firstTokenP50Ms: 700, firstTokenP90Ms: 1100, costUsd: 0.21 } };

describe('the live bench', () => {
  it('reads its arguments, with the Tuesday comparison as the default', () => {
    expect(parseArgs([])).toEqual({ chats: ['goa-50', 'goa-300'], models: ['claude-sonnet-5-5', 'claude-haiku-4-5'], gateModel: 'claude-sonnet-5-5', recordJev: false, postBoard: false });
    expect(parseArgs(['--chats', 'goa-2000', '--models', 'claude-haiku-4-5', '--record-jev', '--post-board'])).toEqual({
      chats: ['goa-2000'], models: ['claude-haiku-4-5'], gateModel: 'claude-haiku-4-5', recordJev: true, postBoard: true,
    });
    expect(parseArgs(['--chats', '', '--gate-model', 'claude-haiku-4-5']).chats).toEqual(['goa-50', 'goa-300']);
    expect(parseArgs(['--gate-model', 'claude-haiku-4-5']).gateModel).toBe('claude-haiku-4-5');
  });

  it('builds Go\'s environment from the real keys, with a fresh board token and no signing secret (the harness signs)', () => {
    const base = { DATABASE_URL: 'postgres://localhost/go', ANTHROPIC_API_KEY: 'k1', TYPESAFE_API_KEY: 'k2' };
    expect(() => liveEnv({ DATABASE_URL: 'postgres://localhost/go', ANTHROPIC_API_KEY: 'k1' }, 'claude-sonnet-5-5')).toThrow(/TYPESAFE_API_KEY is required/);
    const env = liveEnv(base, 'claude-haiku-4-5');
    expect(env).toMatchObject({ COMPOSER_MODEL: 'claude-haiku-4-5', REFLEX_LIVE: 'q1,q2,q3', JEV_MODEL: 'jev-1.13.0', SIDE_MODEL: 'claude-haiku-4-5', CALLS_MODE: 'off' });
    expect(env).not.toHaveProperty('GO_SIGNING_SECRET');
    expect(env['ADMIN_TOKEN']?.length).toBe(32);
    expect(liveEnv(base, 'claude-haiku-4-5')['ADMIN_TOKEN']).not.toBe(env['ADMIN_TOKEN']);
  });

  it('sends the board a summary it accepts, with the provider\'s own cache number', () => {
    const s = toBoardSummary(run, '2026-10-06T22:00:00Z');
    expect(s).toMatchObject({ chat: 'goa-300', mode: 'live', cacheHit: 0.92, wakeRate: 0.11, replyP50Ms: 1850, recall: { passed: 7, probes: 7 }, wrongSpeak: 0, messages: 300 });
    expect(BenchSummary.safeParse(s).success).toBe(true);
    const noUsage = toBoardSummary({ ...run, provider: { ...run.provider, cacheHit: null } }, '2026-10-06T22:00:00Z');
    expect(noUsage.cacheHit).toBe(0.9);
  });

  it('posts with the bearer token and fails loudly when the board refuses', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ok = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    await postSummary('https://go.example/', 'board-token-0123456789', toBoardSummary(run, '2026-10-06T22:00:00Z'), ok);
    expect(calls[0]?.url).toBe('https://go.example/stats/bench');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer board-token-0123456789');
    const refused = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    await expect(postSummary('https://go.example', 'x', toBoardSummary(run, '2026-10-06T22:00:00Z'), refused)).rejects.toThrow(/HTTP 401/);
  });
});
