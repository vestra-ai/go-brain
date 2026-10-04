import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: mockCreate }; } }));

import Anthropic from '@anthropic-ai/sdk';
import { parseRawClaims, CAPTURE_EXTRACTION_SYSTEM_PROMPT, makeCaptureExtractor } from '../capture-extractor.js';
import {
  parseCandidateClaims,
  makeCaptureJudge,
  CAPTURE_JUDGE_V2_SYSTEM_PROMPT,
  NOT_A_SKILL,
} from '../capture-extractor.js';
import { transcriptToBlocks } from '../episode.js';

const source = { kind: 'task', ref: 't1', date: '2026-06-29T00:00:00.000Z' };

describe('parseRawClaims', () => {
  it('parses a JSON array of claims into RawClaim[] with the source injected', () => {
    const text = '[{"subject":"the user","predicate":"works at","object":"Acme","entity_type":"company","confidence":0.8}]';
    const out = parseRawClaims(text, source);
    expect(out).toEqual([
      { subject: 'the user', predicate: 'works at', object: 'Acme', source, confidence: 0.8 },
    ]);
  });

  it('tolerates prose around the JSON (extractJsonValue) and returns [] for an empty array', () => {
    expect(parseRawClaims('Here you go: []', source)).toEqual([]);
  });

  it('ignores prompt-only fields entity_type and supersedes, and drops malformed items', () => {
    const text = '[{"subject":"a","predicate":"b","object":"c","supersedes":"x"},{"subject":"only-subject"}]';
    const out = parseRawClaims(text, source);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: 'a', predicate: 'b', object: 'c' });
    expect((out[0] as unknown as Record<string, unknown>).supersedes).toBeUndefined();
  });

  it('returns [] on non-JSON garbage (degrade-safe)', () => {
    expect(parseRawClaims('the model refused', source)).toEqual([]);
  });

  it('trims subject/predicate/object and skips an item that is whitespace-only in any field', () => {
    const text = '[{"subject":"  spaced  ","predicate":"  has  ","object":"  value  "},{"subject":"   ","predicate":"p","object":"o"}]';
    const out = parseRawClaims(text, source);
    expect(out).toEqual([
      { subject: 'spaced', predicate: 'has', object: 'value', source },
    ]);
  });

  it('clamps confidence to [0,1]', () => {
    const text = '[{"subject":"a","predicate":"b","object":"c","confidence":1.7},{"subject":"d","predicate":"e","object":"f","confidence":-0.3}]';
    const out = parseRawClaims(text, source);
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0);
  });

  it('reads a valid decay class and ignores an invalid one', () => {
    const text = '[{"subject":"a","predicate":"b","object":"c","decay":"semi-stable"},{"subject":"d","predicate":"e","object":"f","decay":"bogus"}]';
    const out = parseRawClaims(text, source);
    expect(out[0].decay).toBe('semi-stable');
    expect(out[1].decay).toBeUndefined();
  });

  it('keeps the production prompt wording (durable-fact rule, not the old open-taxonomy copy)', () => {
    expect(CAPTURE_EXTRACTION_SYSTEM_PROMPT).toContain('worth remembering long-term about THIS user');
    expect(CAPTURE_EXTRACTION_SYSTEM_PROMPT).not.toContain('You extract open-taxonomy CLAIMS');
  });
});

describe('makeCaptureExtractor', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('calls messages.create with correct model, max_tokens, system prompt, and user content containing transcript and dedup framing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '[{"subject":"a","predicate":"b","object":"c"}]' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const now = '2026-06-29T00:00:00.000Z';
    const extractor = makeCaptureExtractor(new Anthropic({ apiKey: 'x' }), {
      taskId: 'task1',
      dedupList: 'existing fact',
    });
    const result = await extractor.extract({ transcript: 'hello transcript', now });

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.max_tokens).toBe(600);
    expect(call.system).toBe(CAPTURE_EXTRACTION_SYSTEM_PROMPT);
    const msgs = call.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].content).toContain('FINISHED TASK TRANSCRIPT:');
    expect(msgs[0].content).toContain('FACTS ALREADY KNOWN');
    expect(msgs[0].content).toContain('hello transcript');
    expect(result).toEqual([
      { subject: 'a', predicate: 'b', object: 'c', source: { kind: 'task', ref: 'task1', date: now } },
    ]);
  });

  it('calls meter once with the usage object when meter is provided', async () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '[{"subject":"a","predicate":"b","object":"c"}]' }],
      usage,
    });
    const meter = vi.fn();
    const extractor = makeCaptureExtractor(new Anthropic({ apiKey: 'x' }), { taskId: 'task2', meter });
    await extractor.extract({ transcript: 't', now: '2026-06-29T00:00:00.000Z' });
    expect(meter).toHaveBeenCalledOnce();
    expect(meter).toHaveBeenCalledWith(usage);
  });

  it('does not error when meter is omitted and still returns parsed claims', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '[{"subject":"a","predicate":"b","object":"c"}]' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const extractor = makeCaptureExtractor(new Anthropic({ apiKey: 'x' }), { taskId: 'task3' });
    const result = await extractor.extract({ transcript: 't', now: '2026-06-29T00:00:00.000Z' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subject: 'a', predicate: 'b', object: 'c' });
  });
});

// --- nami brain v2 §3c: the predict-then-residual capture judge -----------
const NOW = '2026-06-29T00:00:00.000Z';

/** Deterministic injected fake Anthropic client (no network): always returns `text`. */
const fakeClient = (text: string): Anthropic =>
  ({
    messages: {
      create: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }),
    },
  }) as unknown as Anthropic;

describe('CAPTURE_JUDGE_V2_SYSTEM_PROMPT', () => {
  it('is the predict-then-residual prompt and names no assistant brand', () => {
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).toContain('PASS 1 - PREDICT');
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).toContain('PASS 2 - RESIDUAL');
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).toContain('noveltyToFrontier');
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).not.toContain('Claude');
    // supersession is structural (mergeClaim), not emitted by the judge; the prompt
    // must not instruct it (it would disagree with parseCandidateClaims, which ignores it).
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).not.toContain('supersedes');
  });
});

describe('parseCandidateClaims (v2)', () => {
  it('rejects the WHOLE output when NOT_A_SKILL appears anywhere (substring, not ===)', () => {
    expect(NOT_A_SKILL).toBe('NOT_A_SKILL');
    const text = 'prefix NOT_A_SKILL suffix [{"subject":"a","predicate":"b","object":"c"}]';
    expect(parseCandidateClaims(text, source, '')).toEqual([]);
  });

  it('carries and clamps noveltyToFrontier (the §3d tie-breaker)', () => {
    const text =
      '[{"subject":"a","predicate":"b","object":"c","noveltyToFrontier":1.7},{"subject":"d","predicate":"e","object":"f","noveltyToFrontier":-0.3},{"subject":"g","predicate":"h","object":"i","noveltyToFrontier":0.5}]';
    const out = parseCandidateClaims(text, source, 'now: x');
    expect(out).toHaveLength(3);
    expect(out[0].noveltyToFrontier).toBe(1);
    expect(out[1].noveltyToFrontier).toBe(0);
    expect(out[2].noveltyToFrontier).toBe(0.5);
  });

  it('stamps sourceTaskId (= source.ref) and a stable, deterministic evidenceSpanHash', () => {
    const text = '[{"subject":"a","predicate":"b","object":"c"}]';
    const out = parseCandidateClaims(text, source, 'now: x');
    expect(out[0].sourceTaskId).toBe(source.ref);
    expect(typeof out[0].evidenceSpanHash).toBe('string');
    expect(out[0].evidenceSpanHash).toBe(parseCandidateClaims(text, source, 'now: x')[0].evidenceSpanHash);
  });
});

describe('makeCaptureJudge (v2)', () => {
  it('emits a residual correction with claimType "correction" (test case 1)', async () => {
    const judge = makeCaptureJudge(
      fakeClient(
        '[{"subject":"project Atlas","predicate":"deadline is","object":"March 15","claimType":"correction","noveltyToFrontier":0.9}]',
      ),
      { taskId: 't1' },
    );
    const episode = {
      taskId: 't1',
      observedAt: NOW,
      blocks: transcriptToBlocks('user: Atlas is March 1\nassistant: noted\nuser: no, March 15'),
    };
    const out = await judge.judge({ episode, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].claimType).toBe('correction');
    expect(out[0].sourceTaskId).toBe('t1');
    expect(out[0].evidenceSpanHash).toBeTruthy();
  });

  it('drops a NOT_A_SKILL-contaminated output entirely, even with a real claim attached (test case 2)', async () => {
    const judge = makeCaptureJudge(
      fakeClient('Sorry: NOT_A_SKILL [{"subject":"x","predicate":"is","object":"y"}]'),
      { taskId: 't1' },
    );
    const episode = { taskId: 't1', observedAt: NOW, blocks: transcriptToBlocks('user: hi\nassistant: hello') };
    expect(await judge.judge({ episode, now: NOW })).toEqual([]);
  });

  it('drops a transcript-leakage object (>40-char verbatim journal substring) (test case 3)', async () => {
    const longSpan = 'the quarterly board deck must ship before the Tuesday investor sync';
    expect(longSpan.length).toBeGreaterThan(40);
    const episode = {
      taskId: 't1',
      observedAt: NOW,
      blocks: transcriptToBlocks(`user: remember this: ${longSpan}\nassistant: ok`),
    };
    const judge = makeCaptureJudge(
      fakeClient(`[{"subject":"the user","predicate":"noted","object":${JSON.stringify(longSpan)},"claimType":"user-fact"}]`),
      { taskId: 't1' },
    );
    expect(await judge.judge({ episode, now: NOW })).toEqual([]);
  });

  it('drops self-referential subjects and procedures, keeping a genuine fact (test case 4)', async () => {
    const judge = makeCaptureJudge(
      fakeClient(
        '[' +
          '{"subject":"assistant","predicate":"produced","object":"a summary"},' +
          '{"subject":"release runbook","predicate":"steps to deploy","object":"build then push","claimType":"routine"},' +
          '{"subject":"onboarding","predicate":"is documented","object":"in notion","claimType":"procedure"},' +
          '{"subject":"the user","predicate":"prefers","object":"dark mode","claimType":"preference"}' +
          ']',
      ),
      { taskId: 't1' },
    );
    const episode = { taskId: 't1', observedAt: NOW, blocks: transcriptToBlocks('user: hi\nassistant: hi') };
    const out = await judge.judge({ episode, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('the user');
    expect(out[0].object).toBe('dark mode');
  });

  it('returns [] for a generic episode when the judge emits [] (test case 5)', async () => {
    const judge = makeCaptureJudge(fakeClient('[]'), { taskId: 't1' });
    const episode = {
      taskId: 't1',
      observedAt: NOW,
      blocks: transcriptToBlocks('user: what is the capital of France?\nassistant: Paris'),
    };
    expect(await judge.judge({ episode, now: NOW })).toEqual([]);
  });

  it('falls back to episode.taskId for sourceTaskId when opts.taskId is omitted', async () => {
    const judge = makeCaptureJudge(fakeClient('[{"subject":"a","predicate":"b","object":"c"}]'), {});
    const episode = { taskId: 'episode-task', observedAt: NOW, blocks: transcriptToBlocks('user: a\nassistant: b') };
    const out = await judge.judge({ episode, now: NOW });
    expect(out[0].sourceTaskId).toBe('episode-task');
  });

  it('calls meter once with usage when provided (kernel stays pure; server bills)', async () => {
    const meter = vi.fn();
    const judge = makeCaptureJudge(fakeClient('[]'), { taskId: 't1', meter });
    await judge.judge({ episode: { taskId: 't1', observedAt: NOW, blocks: [] }, now: NOW });
    expect(meter).toHaveBeenCalledOnce();
    expect(meter).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 5 });
  });

  it('calls onError with the thrown error and still degrades to [] (a persistent 400 is no longer silent)', async () => {
    // Simulate the live failure mode: a billing/auth 400 from the SDK (carries .status).
    const boom = Object.assign(new Error('Your credit balance is too low'), { status: 400 });
    const throwingClient = {
      messages: { create: async () => { throw boom; } },
    } as unknown as Anthropic;
    const onError = vi.fn();
    const judge = makeCaptureJudge(throwingClient, { taskId: 't1', onError });
    const out = await judge.judge({ episode: { taskId: 't1', observedAt: NOW, blocks: [] }, now: NOW });
    expect(out).toEqual([]); // degrade-safe contract preserved
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(boom); // the caller gets the real error to surface
  });

  it('does not require onError (omitted => still degrades to [] on a throw)', async () => {
    const throwingClient = {
      messages: { create: async () => { throw new Error('network'); } },
    } as unknown as Anthropic;
    const judge = makeCaptureJudge(throwingClient, { taskId: 't1' });
    expect(await judge.judge({ episode: { taskId: 't1', observedAt: NOW, blocks: [] }, now: NOW })).toEqual([]);
  });
});

// ─── P2-M3: open-loop claim types + judge upgrades ──────────────────────────

describe('P2-M3 open-loop passthrough (parseCandidateClaims)', () => {
  it('carries due_at (normalized to ISO-Z) and recurrence onto the claim', () => {
    const text = JSON.stringify([
      {
        subject: 'the user', predicate: 'owes Sasha', object: 'the board deck',
        claimType: 'commitment', due_at: '2026-07-10', confidence: 0.9,
      },
      {
        subject: 'the user', predicate: 'runs board sync', object: 'every Monday 09:00',
        claimType: 'rhythm', recurrence: 'every Monday 09:00',
      },
    ]);
    const out = parseCandidateClaims(text, source, '');
    expect(out).toHaveLength(2);
    expect(out[0].claimType).toBe('commitment');
    expect(out[0].dueAt).toBe('2026-07-10T00:00:00.000Z');
    expect(out[0].recurrence).toBeUndefined();
    expect(out[1].claimType).toBe('rhythm');
    expect(out[1].recurrence).toBe('every Monday 09:00');
    expect(out[1].dueAt).toBeUndefined();
  });

  it('drops an unparseable due_at instead of storing garbage (field stays unset)', () => {
    const text = JSON.stringify([
      { subject: 's', predicate: 'p', object: 'o', claimType: 'expectation', due_at: 'sometime soon' },
    ]);
    const out = parseCandidateClaims(text, source, '');
    expect(out).toHaveLength(1);
    expect(out[0].dueAt).toBeUndefined();
  });

  it('claims without open-loop fields stay byte-identical (no new keys)', () => {
    const text = JSON.stringify([{ subject: 's', predicate: 'p', object: 'o', confidence: 0.5 }]);
    const out = parseCandidateClaims(text, source, '');
    expect(Object.keys(out[0]).sort()).toEqual(
      ['confidence', 'evidenceSpanHash', 'object', 'predicate', 'source', 'sourceTaskId', 'subject'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// F3 (adjudicated review blocker): a no-year due date ("September 20") must NOT
// be stored as V8's fabricated year-2001 deadline. It resolves FORWARD from the
// capture timestamp (source.date); an explicit year is kept as-is; unparseable
// is dropped (claim still captured).
// ---------------------------------------------------------------------------
describe('F3: no-year due dates resolve forward from capture time', () => {
  const capOn = (iso: string) => ({ kind: 'task', ref: 't1', date: iso });
  const dueOf = (dueAt: string, cap: { date: string }) =>
    parseCandidateClaims(
      JSON.stringify([{ subject: 's', predicate: 'p', object: 'o', claimType: 'commitment', due_at: dueAt }]),
      cap as typeof source,
      '',
    )[0]?.dueAt;

  it('never stores V8 year-2001 for a no-year month+day', () => {
    const got = dueOf('September 20', capOn('2026-07-03T12:00:00.000Z'));
    expect(got).not.toMatch(/^2001-/);
    expect(got).toBe('2026-09-20T00:00:00.000Z');
  });

  it('resolves a later-this-year date to the capture year', () => {
    expect(dueOf('September 20', capOn('2026-07-03T12:00:00.000Z'))).toBe('2026-09-20T00:00:00.000Z');
  });

  it('wraps a date that has already passed this year to next year', () => {
    expect(dueOf('March 1', capOn('2026-07-03T12:00:00.000Z'))).toBe('2027-03-01T00:00:00.000Z');
  });

  it('is forward-inclusive: the capture day itself resolves to today, not +1 year', () => {
    expect(dueOf('July 3', capOn('2026-07-03T12:00:00.000Z'))).toBe('2026-07-03T00:00:00.000Z');
  });

  it('handles the abbreviated-month and numeric-slash shapes the parser already accepts', () => {
    const cap = capOn('2026-07-03T12:00:00.000Z');
    expect(dueOf('Sept 20', cap)).toBe('2026-09-20T00:00:00.000Z');
    expect(dueOf('9/20', cap)).toBe('2026-09-20T00:00:00.000Z');
  });

  it('keeps an explicit-year date exactly as-is (does not forward-shift it)', () => {
    // Explicit year present -> trust the string (current behavior), even a past year.
    expect(dueOf('2026-07-10', capOn('2026-06-29T00:00:00.000Z'))).toBe('2026-07-10T00:00:00.000Z');
    expect(dueOf('2020-01-01', capOn('2026-07-03T12:00:00.000Z'))).toBe('2020-01-01T00:00:00.000Z');
  });

  it('drops an unparseable date but still captures the claim', () => {
    const text = JSON.stringify([
      { subject: 's', predicate: 'p', object: 'o', claimType: 'expectation', due_at: '20th September' },
    ]);
    const out = parseCandidateClaims(text, capOn('2026-07-03T12:00:00.000Z') as typeof source, '');
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('s');
    expect(out[0].dueAt).toBeUndefined();
  });

  it('drops the date when the capture timestamp is itself unusable (never fabricates 2001)', () => {
    expect(dueOf('September 20', capOn('not-a-date'))).toBeUndefined();
  });

  it('treats 3-component numeric dates with a 2-digit year as EXPLICIT (V8 parse kept verbatim)', () => {
    // Fix round 2: "3/1/28" has no 4-digit token, so it wrongly took the no-year path
    // and DISCARDED V8's honored year (2028), storing 2027-03-01 from a 2026-07-03
    // capture. A 3-component numeric date is explicit — trust the V8 parse verbatim.
    const cap = capOn('2026-07-03T12:00:00.000Z');
    const mar28 = dueOf('3/1/28', cap);
    expect(mar28).toBe(new Date('3/1/28').toISOString()); // verbatim V8 parse (2028 honored)
    expect(new Date(mar28 as string).getFullYear()).toBe(2028);
    expect(mar28).not.toBe('2027-03-01T00:00:00.000Z'); // the confirmed regression

    const sep25 = dueOf('9/20/25', cap);
    expect(sep25).toBe(new Date('9/20/25').toISOString());
    expect(new Date(sep25 as string).getFullYear()).toBe(2025); // past 2-digit year kept (explicit semantics)
  });

  it('keeps pure month+day numeric shapes ("9/20") on the no-year forward path', () => {
    expect(dueOf('9/20', capOn('2026-07-03T12:00:00.000Z'))).toBe('2026-09-20T00:00:00.000Z');
  });

  it('PINNED SPEC: forward-inclusive comparison is strict-UTC — a behind-UTC local evening wraps', () => {
    // Deliberate choice, not an accident: no user TZ is available at the parser, so
    // "today" is the capture instant's UTC calendar day. Captured 2026-07-03 23:00 PDT
    // (= 2026-07-04T06:00Z), "July 3" is already "yesterday" in UTC and wraps a year.
    expect(dueOf('July 3', capOn('2026-07-04T06:00:00.000Z'))).toBe('2027-07-03T00:00:00.000Z');
  });

  it('INVARIANT: a resolved no-year dueAt is never earlier than capture minus 24h', () => {
    // Worst case: captured at end of day, resolving to the same calendar day's UTC midnight.
    const capIso = '2026-07-03T23:59:59.000Z';
    const floor = Date.parse(capIso) - 24 * 60 * 60 * 1000;
    for (const raw of ['July 3', 'September 20', 'March 1', 'Sept 20', '9/20', 'December 31', 'January 1']) {
      const got = dueOf(raw, capOn(capIso));
      expect(got).toBeDefined();
      expect(Date.parse(got as string)).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('P2-M3 judge prompt upgrades (single source of truth)', () => {
  it('teaches the three open-loop claim types with due_at/recurrence', () => {
    for (const marker of ['commitment', 'expectation', 'rhythm', 'due_at', 'recurrence']) {
      expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).toContain(marker);
    }
  });

  it('carries the self-containment gate (rewrite-or-discard)', () => {
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT.toLowerCase()).toContain('self-contain');
  });

  it('carries entity-surfacing in both directions', () => {
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT.toUpperCase()).toContain('BOTH directions'.toUpperCase());
  });

  it('never invents dates: the prompt forbids fabricated due_at', () => {
    expect(CAPTURE_JUDGE_V2_SYSTEM_PROMPT).toMatch(/do not invent dates/i);
  });
});
