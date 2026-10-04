import { describe, it, expect } from 'vitest';
import { resolveProviderChain, searchWithChain, AllProvidersUnconfigured, type WebProvider } from '../web-providers.js';

const ok = (name: string): WebProvider => ({
  name, isUnconfigured: () => false, httpStatus: () => undefined,
  search: async () => ({ query: name, durationSeconds: null, results: [{ content: [{ title: name, url: 'https://'+name }], excerpts: [], publish_date: null }] }),
  fetch: async () => ({ url: 'u', content: name }),
});
const failHard = (name: string): WebProvider => ({ name, isUnconfigured: () => false, httpStatus: () => undefined, search: async () => { throw new Error('boom'); }, fetch: async () => { throw new Error('boom'); } });
const unconf = (name: string): WebProvider => ({ name, isUnconfigured: () => true, httpStatus: () => undefined, search: async () => { throw new Error('unconfigured'); }, fetch: async () => { throw new Error('unconfigured'); } });
const empty = (name: string): WebProvider => ({ name, isUnconfigured: () => false, httpStatus: () => undefined, search: async () => ({ query: name, durationSeconds: null, results: [] }), fetch: async () => ({ url: 'u', content: '' }) });
// Billing-dead double: throws a typed error the provider maps to HTTP 402 — the
// classification must read the STATUS via httpStatus, never the message text.
const billing402 = (name: string): WebProvider => ({
  name, isUnconfigured: () => false, httpStatus: () => 402,
  search: async () => { throw new Error(`${name} payment required`); },
  fetch: async () => { throw new Error(`${name} payment required`); },
});

describe('resolveProviderChain', () => {
  it('defaults to exa alone', () => expect(resolveProviderChain(undefined).map(p => p.name)).toEqual(['exa']));
  // Parallel is retired: an env order that still names it resolves to exa only.
  it('ignores the retired parallel provider in a custom order', () => expect(resolveProviderChain('parallel,exa').map(p => p.name)).toEqual(['exa']));
  it('falls back to default on garbage (parallel alone is garbage now)', () => {
    expect(resolveProviderChain('nope,bogus').map(p => p.name)).toEqual(['exa']);
    expect(resolveProviderChain('parallel').map(p => p.name)).toEqual(['exa']);
  });
  it('dedups and ignores unknown names', () => expect(resolveProviderChain('exa, exa , parallel').map(p => p.name)).toEqual(['exa']));
});

describe('searchWithChain', () => {
  it('returns the first provider that succeeds', async () => {
    const r = await searchWithChain([ok('exa'), ok('second')], { query: 'q' }, 't', {}, () => {});
    expect(r.results[0].content[0].title).toBe('exa');
  });
  it('falls back to the next provider on a hard failure', async () => {
    const r = await searchWithChain([failHard('exa'), ok('second')], { query: 'q' }, 't', {}, () => {});
    expect(r.results[0].content[0].title).toBe('second');
  });
  it('does NOT fall back on empty results (empty is success)', async () => {
    const r = await searchWithChain([empty('exa'), ok('second')], { query: 'q' }, 't', {}, () => {});
    expect(r.results).toEqual([]);
  });
  it('throws AllProvidersUnconfigured when every provider is unconfigured', async () => {
    await expect(searchWithChain([unconf('exa'), unconf('second')], { query: 'q' }, 't', {}, () => {})).rejects.toBeInstanceOf(AllProvidersUnconfigured);
  });
  it('throws the last hard error when providers fail (not unconfigured)', async () => {
    await expect(searchWithChain([failHard('exa'), failHard('second')], { query: 'q' }, 't', {}, () => {})).rejects.toThrow(/boom/);
  });
  it('classifies an all-402 chain as AllProvidersBillingDead, carrying the provider names', async () => {
    await expect(searchWithChain([billing402('exa'), billing402('second')], { query: 'q' }, 't', {}, () => {}))
      .rejects.toMatchObject({ name: 'AllProvidersBillingDead', providers: ['exa', 'second'] });
  });
  it('a single-provider chain (the default shape: exa alone) is billing-dead on one 402', async () => {
    await expect(searchWithChain([billing402('exa')], { query: 'q' }, 't', {}, () => {}))
      .rejects.toMatchObject({ name: 'AllProvidersBillingDead', providers: ['exa'] });
  });
  it('402 plus unconfigured is still billing-dead (the only reachable provider is out of credits)', async () => {
    await expect(searchWithChain([billing402('exa'), unconf('second')], { query: 'q' }, 't', {}, () => {}))
      .rejects.toMatchObject({ name: 'AllProvidersBillingDead', providers: ['exa'] });
  });
  it('a 402 mixed with a non-402 hard failure keeps the last-error rethrow (NOT billing-dead)', async () => {
    await expect(searchWithChain([billing402('exa'), failHard('second')], { query: 'q' }, 't', {}, () => {}))
      .rejects.toThrow(/boom/);
  });
});
