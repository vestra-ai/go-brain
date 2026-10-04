/**
 * The endpoint table is the layer that decides WHOSE credentials a model call
 * carries, so its rows are asserted as bytes, not as "a client was returned".
 *
 * What replaced what: two `if` chains (`defaultChatClientFor` in
 * chat-completions-transport, `defaultClientFor` in openai-responses-transport),
 * each ending in an unguarded `// 'openai' (and any other value)` arm. Neither was
 * total over `ModelProvider`, so a provider added to the capability contract
 * compiled clean and silently received OPENAI_API_KEY + api.openai.com. These tests
 * pin the four real lanes byte-for-byte against those arms, and pin the three
 * no-lane rows as LOUD rather than borrowed.
 *
 * Reaches the real client constructor on purpose: an injected mock would bypass
 * exactly the lines under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import OpenAI from 'openai';
import { OPENAI_COMPATIBLE_ENDPOINTS, openAIClientFor } from '../openai-endpoints.js';
import type { ModelProvider } from '../../contract/model-capabilities.js';

const KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'FIREWORKS_API_KEY', 'FIREWORKS_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL',
  'META_API_KEY', 'META_BASE_URL',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The OpenAI SDK's own default base — what the `openai` lane resolves to when it
 *  is handed no baseURL at all. Read off a directly-constructed client rather than
 *  hardcoded, so an SDK upgrade that moved it cannot make this suite lie. */
const SDK_DEFAULT_BASE = new OpenAI({ apiKey: 'probe' }).baseURL;

/** Every lane's key set, so a construction is never testing "missing credentials".
 *  The SDK throws at construction when it can find no key at all — that throw is
 *  the subject of its own test below, not an accident of setup. */
const withAllLaneKeys = (): void => {
  process.env.OPENAI_API_KEY = 'openai-key';
  process.env.FIREWORKS_API_KEY = 'fireworks-key';
  process.env.XAI_API_KEY = 'xai-key';
  process.env.META_API_KEY = 'meta-key';
};

describe('openAIClientFor — the four real lanes, byte-identical to the arms they replace', () => {
  it('openai with no OPENAI_BASE_URL sends NO baseURL (the SDK default stands)', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const c = openAIClientFor('openai');
    expect(c.apiKey).toBe('openai-key');
    expect(c.baseURL).toBe(SDK_DEFAULT_BASE);
  });

  it.each([
    ['fireworks', 'FIREWORKS_API_KEY', 'https://api.fireworks.ai/inference/v1'],
    ['xai', 'XAI_API_KEY', 'https://api.x.ai/v1'],
    ['meta', 'META_API_KEY', 'https://api.meta.ai/v1'],
  ] as const)('%s falls back to the VENDOR default base, never OpenAI\'s', (provider, keyEnv, base) => {
    process.env[keyEnv] = 'lane-key';
    // The credential-proxy key is also set, to prove the lane does not read it.
    process.env.OPENAI_API_KEY = 'openai-key';
    const c = openAIClientFor(provider as ModelProvider);
    expect(c.apiKey).toBe('lane-key');
    expect(c.baseURL).toBe(base);
  });

  it.each([
    ['openai', 'OPENAI_BASE_URL'],
    ['fireworks', 'FIREWORKS_BASE_URL'],
    ['xai', 'XAI_BASE_URL'],
    ['meta', 'META_BASE_URL'],
  ] as const)('%s honours its own base override (the credential proxy in production)', (provider, baseEnv) => {
    withAllLaneKeys();
    process.env[baseEnv] = 'https://server.example/api/proxy/lane/v1';
    const c = openAIClientFor(provider as ModelProvider);
    expect(c.baseURL).toBe('https://server.example/api/proxy/lane/v1');
  });

  it('a lane with NO key anywhere throws at construction, and that is the lazy path', () => {
    // The old arms spread the key in only when truthy, leaving the SDK to decide —
    // and the SDK refuses to construct with no credential at all. Unchanged here,
    // and harmless: this factory is only ever reached from `callModel`, inside the
    // terminal catch that classifies it (auth_error), never at transport
    // construction. Pinned so a future "helpful" default key cannot slip in.
    expect(() => openAIClientFor('fireworks')).toThrow(/Missing credentials/);
  });

  it('every real lane is built with maxRetries: 0 — the engine is the one retry authority', () => {
    withAllLaneKeys();
    for (const provider of ['openai', 'fireworks', 'xai', 'meta'] as const) {
      expect(openAIClientFor(provider).maxRetries).toBe(0);
    }
  });
});

describe('openAIClientFor — the one deliberate divergence', () => {
  it('an EMPTY base-url env var is treated as unset on a VENDOR lane', () => {
    // The old arms disagreed: the `openai` arm tested truthiness (empty ⇒ omit)
    // while the vendor arms used `??` (empty ⇒ `baseURL: ''`, a base that reaches
    // no vendor at all). One reading now, and it is the safe one — an empty
    // FIREWORKS_BASE_URL falls to Fireworks, not to a broken URL.
    withAllLaneKeys();
    process.env.FIREWORKS_BASE_URL = '';
    expect(openAIClientFor('fireworks').baseURL).toBe('https://api.fireworks.ai/inference/v1');
  });

  it('an EMPTY base-url env var is treated as unset on the openai lane too (unchanged)', () => {
    withAllLaneKeys();
    process.env.OPENAI_BASE_URL = '';
    expect(openAIClientFor('openai').baseURL).toBe(SDK_DEFAULT_BASE);
  });
});

describe('openAIClientFor — providers with no OpenAI lane are LOUD, never borrowed', () => {
  it.each(['anthropic', 'google', 'deepseek'] as const)(
    "%s throws instead of returning an OpenAI client on OPENAI_API_KEY",
    (provider) => {
      // THE DEFECT THIS TABLE REPLACES. Under the old `else` arm each of these
      // returned a live client pointed at api.openai.com with OPENAI_API_KEY, so a
      // mis-declared capability row produced a wrong-lane call with someone else's
      // credentials — a 401/404 from the wrong vendor rather than an error naming
      // the mistake.
      process.env.OPENAI_API_KEY = 'openai-key';
      expect(() => openAIClientFor(provider)).toThrow(new RegExp(provider));
    },
  );

  it('the deepseek row keeps the retirement wording the removed lane threw', () => {
    // apps/sandbox and the money plane both key on this being a REMOVAL, not an
    // outage. Pinned so a table edit cannot soften it into a generic no-lane note.
    expect(() => openAIClientFor('deepseek')).toThrow(/removed \(2026-08-17, Google Limited Use\)/);
  });
});

describe('the table itself', () => {
  it('every row is either a real endpoint or a REASON, never an empty shrug', () => {
    for (const [provider, row] of Object.entries(OPENAI_COMPATIBLE_ENDPOINTS)) {
      if ('noLane' in row) {
        expect(row.noLane.length).toBeGreaterThan(20);
        expect(row.noLane).toContain(provider);
      } else {
        expect(row.keyEnv).toMatch(/_API_KEY$/);
        expect(row.baseEnv).toMatch(/_BASE_URL$/);
      }
    }
  });

  it('no two lanes share a credential env var', () => {
    // The invariant the per-provider split exists for: one process serves many
    // concurrent sessions, so two lanes reading one key would cross-authenticate
    // them. Derived from the table, so a copy-paste row goes red here.
    const keyEnvs = Object.values(OPENAI_COMPATIBLE_ENDPOINTS)
      .filter((r): r is Exclude<typeof r, { noLane: string }> => !('noLane' in r))
      .map((r) => r.keyEnv);
    expect(new Set(keyEnvs).size).toBe(keyEnvs.length);
  });
});
