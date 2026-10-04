import { describe, it, expect } from 'vitest';
import { OPENAI_TOKEN_PRICING, priceForModel } from '../openai-pricing.js';

// GPT-6 Sol / Luna (2026-09-23), verified that day against
// developers.openai.com/api/docs/models/gpt-6-sol and /gpt-6-luna; re-verified
// 2026-09-29 (standard rates unchanged) when the >272K long-context tier was added —
// openai-pricing.long-context.test.ts pins that tier.
describe('openai-pricing — GPT-6 Sol and Luna', () => {
  it.each([
    ['gpt-6-sol', 2, 0.2, 2.5, 10],
    ['gpt-6-luna', 0.1, 0.01, 0.125, 0.5],
  ] as const)('%s carries its verified card (in / cached / write / out)', (id, input, cached, write, out) => {
    const row = OPENAI_TOKEN_PRICING[id];
    expect(row).toMatchObject({ inputPerMTok: input, cachedInputPerMTok: cached, cacheWriteInputPerMTok: write, outputPerMTok: out, verifiedAt: '2026-09-29' });
    expect(row.sources).toEqual([`https://developers.openai.com/api/docs/models/${id}`, 'https://developers.openai.com/api/docs/pricing']);
  });

  it('no gpt-6 id borrows another one: Sol and Luna never price as Astra, Astra is unchanged', () => {
    expect(priceForModel('gpt-6-sol').outputPerMTok).toBe(10);
    expect(priceForModel('gpt-6-luna').outputPerMTok).toBe(0.5);
    expect(priceForModel('gpt-6-astra')).toMatchObject({ inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 50, cacheWriteInputPerMTok: 12.5 });
  });

  it('the superseded 5.6 rows keep their own rates for historical tasks', () => {
    expect(OPENAI_TOKEN_PRICING['gpt-5.6-sol']).toMatchObject({ inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 20, cacheWriteInputPerMTok: 5 });
    expect(OPENAI_TOKEN_PRICING['gpt-5.6-terra']).toMatchObject({ inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 12, cacheWriteInputPerMTok: 2.5 });
    expect(OPENAI_TOKEN_PRICING['gpt-5.6-luna']).toMatchObject({ inputPerMTok: 0.2, cachedInputPerMTok: 0.02, outputPerMTok: 1.2, cacheWriteInputPerMTok: 0.25 });
  });

  it('GPT-6 Sol undercuts 5.6 Terra on every bucket (why it is Terra\'s successor)', () => {
    const sol = OPENAI_TOKEN_PRICING['gpt-6-sol'];
    const terra = OPENAI_TOKEN_PRICING['gpt-5.6-terra'];
    expect(sol.inputPerMTok).toBeLessThanOrEqual(terra.inputPerMTok);
    expect(sol.cachedInputPerMTok).toBeLessThanOrEqual(terra.cachedInputPerMTok);
    expect(sol.cacheWriteInputPerMTok!).toBeLessThanOrEqual(terra.cacheWriteInputPerMTok!);
    expect(sol.outputPerMTok).toBeLessThan(terra.outputPerMTok);
  });
});
