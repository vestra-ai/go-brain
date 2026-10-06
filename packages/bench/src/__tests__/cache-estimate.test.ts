import { describe, expect, it } from 'vitest';
import { CacheEstimator, cacheTurns, minCacheableTokens, summarizeCache } from '../cache-estimate.js';
import { promptParts, type MessageBody, type RecordedRequest } from '../requests.js';

const RULES = 'Rules for Go, the friend in the trip chat. '.repeat(100);
const TOOLS = [{ name: 'stay_silent', description: 'End the turn without a message.', input_schema: { type: 'object', properties: {} } }];
const line = (s: number): string => `#${s} Priya: message number ${s} about the villa and the beach`;
const chunk = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, k) => line(from + k)).join('\n');

function body(o: { chunks: string[]; open?: string; model?: string; rules?: string; thinking?: unknown; rounds?: boolean }): MessageBody {
  const content = [
    ...o.chunks.map((text, k) => ({ type: 'text', text, ...(k === o.chunks.length - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) })),
    { type: 'text', text: `Right now: nothing new.\n${o.open ?? ''}` },
  ];
  const messages: MessageBody['messages'] = [{ role: 'user', content }];
  if (o.rounds) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'trip', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Goa, 6 to 9 Nov', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
  }
  return {
    model: o.model ?? 'claude-sonnet-5-5',
    max_tokens: 1024,
    tools: TOOLS,
    system: [{ type: 'text', text: o.rules ?? RULES, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    ...(o.thinking !== undefined ? { thinking: o.thinking } : {}),
    messages,
  };
}
const req = (n: number, b: MessageBody, simS: number, realMs = n * 1000): RecordedRequest => ({ n, role: 'composer', body: b, realMs, simS });

describe('prompt parts', () => {
  it('splits a request into rules, the cached chat, right now and tool rounds', () => {
    const p = promptParts(body({ chunks: [chunk(1, 25), chunk(26, 50)], open: chunk(51, 55), rounds: true }));
    expect(p.chatBlocks).toBe(2);
    expect(p.tools).toBeGreaterThan(0);
    expect(p.system).toBeGreaterThan(1000);
    expect(p.chat).toBeGreaterThan(p.now);
    expect(p.rounds).toBeGreaterThan(0);
    expect(p.total).toBe(p.tools + p.system + p.chat + p.now + p.rounds);
  });

  it('treats a first user message with no breakpoint as all "right now"', () => {
    const b = body({ chunks: [], open: chunk(1, 10) });
    expect(promptParts(b).chatBlocks).toBe(0);
    expect(promptParts(b).chat).toBe(0);
  });
});

describe('the cache estimate', () => {
  it('knows each model\'s minimum', () => {
    expect(minCacheableTokens('claude-sonnet-5-5')).toBe(512);
    expect(minCacheableTokens('claude-haiku-4-5')).toBe(4096);
    expect(minCacheableTokens('claude-sonnet-5')).toBe(1024);
  });

  it('a growing chat reads everything the last turn cached', () => {
    const turns = cacheTurns([
      req(0, body({ chunks: [chunk(1, 25)], open: chunk(26, 30) }), 0),
      req(1, body({ chunks: [chunk(1, 25)], open: chunk(26, 40) }), 60),
      req(2, body({ chunks: [chunk(1, 25), chunk(26, 50)], open: chunk(51, 55) }), 120),
    ], []);
    expect(turns.map((t) => t.result)).toEqual(['first', 'hit', 'hit']);
    const [t0, t1, t2] = turns;
    expect(t0?.estimate.readTokens).toBe(0);
    expect(t1?.estimate.readTokens).toBe(t0?.estimate.chatEndTokens);
    expect(t2?.estimate.readTokens).toBe(t1?.estimate.chatEndTokens);
    expect(t2?.estimate.writeTokens).toBe((t2?.estimate.chatEndTokens ?? 0) - (t2?.estimate.readTokens ?? 0));
    expect(t2?.sharedBlocks).toBeGreaterThanOrEqual(3);
    const s = summarizeCache(turns);
    expect(s.status).toBe('ok');
    expect(s.hitRate).toBeGreaterThan(0.6);
    expect(s.hitRateAll).toBeLessThan(s.hitRate ?? 0);
  });

  it('a tool round reads the turn\'s own chat', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], rounds: true }), 1)], []);
    expect(turns[1]?.firstRound).toBe(false);
    expect(turns[1]?.result).toBe('hit');
  });

  it('a delete inside the cached part shows as a miss with its reason, and the same change without a delete is drift', () => {
    const before = req(0, body({ chunks: [chunk(1, 25)], open: chunk(26, 30) }), 0, 1000);
    const rebuilt = body({ chunks: [chunk(1, 25).replace(`${line(3)}\n`, '')], open: chunk(26, 31) });
    const withDelete = cacheTurns([before, req(1, rebuilt, 30, 2000)], [{ kind: 'delete', realMs: 1500 }]);
    expect(withDelete[1]?.result).toBe('delete');
    expect(withDelete[1]?.estimate.readTokens).toBe(withDelete[1]?.estimate.rulesTokens);
    expect(summarizeCache(withDelete).results.delete).toBe(1);
    const noDelete = cacheTurns([before, req(1, rebuilt, 30, 2000)], []);
    expect(noDelete[1]?.result).toBe('drift');
  });

  it('below the minimum on Haiku 4.5 the prompt is not cacheable yet, never 0%', () => {
    const small = [req(0, body({ chunks: [chunk(1, 25)], model: 'claude-haiku-4-5' }), 0), req(1, body({ chunks: [chunk(1, 25)], open: line(26), model: 'claude-haiku-4-5' }), 30)];
    const turns = cacheTurns(small, []);
    expect(turns.map((t) => t.result)).toEqual(['below_minimum', 'below_minimum']);
    const s = summarizeCache(turns);
    expect(s.status).toBe('not_cacheable_yet');
    expect(s.hitRate).toBeNull();
    expect(s.hitRateAll).toBeNull();
    const sonnet = cacheTurns(small.map((r) => ({ ...r, body: { ...r.body, model: 'claude-sonnet-5-5' } })), []);
    expect(sonnet.map((t) => t.result)).toEqual(['first', 'hit']);
  });

  it('a quiet gap past the TTL misses the chat but keeps the rules warm', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], open: line(26) }), 7200)], []);
    expect(turns[1]?.result).toBe('ttl');
    expect(turns[1]?.estimate.readTokens).toBe(turns[1]?.estimate.rulesTokens);
    const cold = new CacheEstimator({ rulesStayWarm: false });
    cold.estimate(body({ chunks: [chunk(1, 25)] }), 0);
    expect(cold.estimate(body({ chunks: [chunk(1, 25)] }), 7200).readTokens).toBe(0);
  });

  it('a read refreshes the TTL, so a chat that keeps talking stays cached', () => {
    const turns = cacheTurns([0, 3000, 6000, 9000].map((s, n) => req(n, body({ chunks: [chunk(1, 25)], open: line(26 + n) }), s)), []);
    expect(turns.map((t) => t.result)).toEqual(['first', 'hit', 'hit', 'hit']);
  });

  it('a fold is a miss that reports the chat size before and after', () => {
    const turns = cacheTurns([
      req(0, body({ chunks: [chunk(1, 25), chunk(26, 50), chunk(51, 75)] }), 0),
      req(1, body({ chunks: ['The story so far: Goa 6 to 9 Nov, villa under 8k a head (#3, #12).', chunk(51, 75)] }), 60),
    ], []);
    expect(turns[1]?.result).toBe('fold');
    const s = summarizeCache(turns);
    expect(s.folds.length).toBe(1);
    expect(s.folds[0]?.afterChatTokens).toBeLessThan(s.folds[0]?.beforeChatTokens ?? 0);
  });

  it('changed rules break the cache and say so', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], rules: `${RULES} Today is Tuesday.` }), 60)], []);
    expect(turns[1]?.result).toBe('rules_changed');
    expect(turns[1]?.estimate.readTokens).toBe(0);
  });

  it('the provider looks back at most 20 blocks from a breakpoint', () => {
    const many = Array.from({ length: 26 }, (_, k) => chunk(k * 25 + 1, k * 25 + 25));
    const far = cacheTurns([req(0, body({ chunks: many.slice(0, 1) }), 0), req(1, body({ chunks: many }), 60)], []);
    expect(far[1]?.result).toBe('drift');
    expect(far[1]?.estimate.readTokens).toBe(far[1]?.estimate.rulesTokens);
    const near = cacheTurns([req(0, body({ chunks: many.slice(0, 1) }), 0), req(1, body({ chunks: many.slice(0, 5) }), 60)], []);
    expect(near[1]?.result).toBe('hit');
  });

  it('changing the thinking settings keeps the rules and loses the chat', () => {
    const turns = cacheTurns([req(0, body({ chunks: [chunk(1, 25)] }), 0), req(1, body({ chunks: [chunk(1, 25)], thinking: { type: 'between_tools' } }), 60)], []);
    expect(turns[1]?.estimate.readTokens).toBe(turns[1]?.estimate.rulesTokens);
    expect(turns[1]?.result).toBe('drift');
  });

  it('no composer requests means no numbers, not zeros', () => {
    const s = summarizeCache([]);
    expect(s).toMatchObject({ status: 'no_requests', hitRate: null, hitRateAll: null, requests: 0 });
  });
});
