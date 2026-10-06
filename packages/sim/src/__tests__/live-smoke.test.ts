import type { Message, TripSnapshot } from '@go/contract';
import { describe, expect, it } from 'vitest';
import type { GoRequest, WriteRecord } from '../fake-server.js';
import { GOA_SNAPSHOT } from '../goa.js';
import { formatReport, measureStep, runSmoke, SMOKE_LINES, SMOKE_PERSON, smokeTripId, verdictOf, type SmokeServer, type SmokeStep } from '../live-smoke.js';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const post = (trip_id: string, ms: number, params: Record<string, unknown>, applied = true): WriteRecord => ({
  method: 'post_message', request_id: `go_${ms}`, trip_id, params: { trip_id, ...params }, applied, at: at(ms),
});
const typing = (trip_id: string, ms: number, on = true): GoRequest => ({ method: 'typing', params: { trip_id, on }, at: at(ms) });

describe('one step, measured from what the FakeServer recorded', () => {
  it("times typing and the reply from the line, and lists the cards, for this trip's writes in the window only", () => {
    const step = measureStep({
      line: SMOKE_LINES[1],
      tripId: 't_smoke_1',
      sentAt: T0,
      until: T0 + 6_000,
      requests: [typing('t_real', 50), typing('t_smoke_1', 100, false), typing('t_smoke_1', 240)],
      writes: [
        post('t_smoke_1', -500, { text: 'Hi all, I am Go.' }),
        post('t_real', 300, { text: 'for the real trip' }),
        post('t_smoke_1', 400, { text: 'a write Go repeated' }, false),
        post('t_smoke_1', 2_100, { text: 'Friday evening flights from Delhi.', card: { kind: 'options' } }),
        post('t_smoke_1', 3_000, { card: { kind: 'notice' } }),
        post('t_smoke_1', 9_000, { text: 'after the window' }),
      ],
    });
    expect(step).toEqual({ line: SMOKE_LINES[1], typingMs: 240, replyMs: 2_100, reply: 'Friday evening flights from Delhi.', cards: ['options', 'notice'] });
  });

  it('gives null when there was no typing and no reply', () => {
    expect(measureStep({ line: 'x', tripId: 't', sentAt: T0, until: T0 + 15_000, requests: [], writes: [] })).toEqual({
      line: 'x', typingMs: null, replyMs: null, reply: null, cards: [],
    });
  });
});

describe('the verdict', () => {
  const ok = (over: Partial<SmokeStep> = {}): SmokeStep => ({ line: SMOKE_LINES[0], typingMs: 300, replyMs: 2_400, reply: 'Hi', cards: [], ...over });

  it('passes typing at 1 s or less and a reply within 15 s, on both lines', () => {
    expect(verdictOf([ok({ typingMs: 1_000 }), ok({ line: SMOKE_LINES[1], replyMs: 14_900 })])).toEqual({ ok: true, problems: [] });
  });

  it('fails typing over 1 s, no typing at all, and no reply, and says which step', () => {
    expect(verdictOf([ok({ typingMs: 1_250 }), ok({ line: SMOKE_LINES[1] })]).problems).toEqual([
      'Step 1 ("@Go hello, what can you do?"): typing took 1.25 s, over 1.00 s',
    ]);
    expect(verdictOf([ok(), ok({ line: SMOKE_LINES[1], typingMs: null })]).problems).toEqual([
      'Step 2 ("@Go flights Delhi to Goa Friday evening"): Go never showed typing',
    ]);
    const missed = verdictOf([ok({ typingMs: null, replyMs: null, reply: null })]);
    expect(missed.ok).toBe(false);
    expect(missed.problems).toEqual([
      'Step 1 ("@Go hello, what can you do?"): Go never showed typing',
      'Step 1 ("@Go hello, what can you do?"): no reply within 15.00 s',
      'Not run after the first miss: "@Go flights Delhi to Goa Friday evening"',
    ]);
  });
});

/** A Go that answers each line on a schedule: typing after `typingMs`, a reply after `replyMs` (null: never). */
function scriptedGo(script: Array<{ typingMs: number | null; replyMs: number | null; text: string; card?: string }>) {
  const requests: GoRequest[] = [];
  const writes: WriteRecord[] = [];
  const created: TripSnapshot[] = [];
  const said: Array<{ personId: string; text: string; tripId: string }> = [];
  let n = 0;
  const later = (ms: number, fn: () => void): void => {
    setTimeout(fn, ms);
  };
  const write = (tripId: string, params: Record<string, unknown>): void => {
    n += 1;
    writes.push({ method: 'post_message', request_id: `go_${n}`, trip_id: tripId, params: { trip_id: tripId, ...params }, applied: true, at: new Date().toISOString() });
  };
  const server: SmokeServer = {
    requests,
    writes,
    async createTrip(snapshot) {
      created.push(snapshot);
      later(10, () => write(snapshot.trip_id, { text: 'Hi all, I am Go.' }));
    },
    async say(personId, text, opts) {
      const step = script[said.length];
      said.push({ personId, text, tripId: opts.tripId });
      if (step?.typingMs != null) later(step.typingMs, () => requests.push({ method: 'typing', params: { trip_id: opts.tripId, on: true }, at: new Date().toISOString() }));
      if (step?.replyMs != null) later(step.replyMs, () => write(opts.tripId, { text: step.text, ...(step.card ? { card: { kind: step.card } } : {}) }));
      return {} as Message;
    },
  };
  return { server, created, said };
}

describe('the smoke run, against a scripted Go', () => {
  it('makes a fresh smoke trip, waits for the hello, says both lines as Priya, and times each answer', async () => {
    const go = scriptedGo([
      { typingMs: 20, replyMs: 60, text: 'I find flights, stays, run votes and can call a place.' },
      { typingMs: 30, replyMs: 80, text: 'Friday evening flights from Delhi.', card: 'options' },
    ]);
    const report = await runSmoke({ server: go.server, settleMs: 40, limits: { typingMs: 1_000, replyMs: 2_000 } });
    expect(report.tripId).toMatch(/^t_smoke_\d{8}T\d{6}_[0-9a-f]{8}$/);
    expect(go.created).toHaveLength(1);
    expect(go.created[0]).toMatchObject({ trip_id: report.tripId, seq: 1, decisions: [], record: [] });
    expect(go.created[0]?.title).toMatch(/^Smoke test /);
    expect(go.created[0]?.people.map((p) => p.person_id)).toEqual(GOA_SNAPSHOT.people.map((p) => p.person_id));
    expect(go.said).toEqual(SMOKE_LINES.map((text) => ({ personId: SMOKE_PERSON, text, tripId: report.tripId })));
    expect(report.joined.text).toBe('Hi all, I am Go.');
    expect(report.steps.map((s) => [s.reply, s.cards])).toEqual([
      ['I find flights, stays, run votes and can call a place.', []],
      ['Friday evening flights from Delhi.', ['options']],
    ]);
    for (const s of report.steps) {
      expect(s.typingMs).not.toBeNull();
      expect(s.replyMs ?? 0).toBeGreaterThanOrEqual(s.typingMs ?? 0);
      expect(s.replyMs).toBeLessThan(1_000);
    }
    expect(report.verdict).toEqual({ ok: true, problems: [] });
    expect(report.totalMs).toBeGreaterThan(0);
  });

  it('a new trip id every run, so the real trip is never touched', () => {
    const now = new Date('2026-10-06T10:15:00Z');
    const ids = new Set(Array.from({ length: 20 }, () => smokeTripId(now)));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).not.toBe('t_goa');
  });

  it('fails slow typing, and stops at a line with no reply so a late answer is never taken for the next', async () => {
    const go = scriptedGo([{ typingMs: 1_200, replyMs: null, text: '' }, { typingMs: 10, replyMs: 20, text: 'never asked' }]);
    const report = await runSmoke({ server: go.server, settleMs: 20, limits: { typingMs: 1_000, replyMs: 1_500 } });
    expect(go.said.map((s) => s.text)).toEqual([SMOKE_LINES[0]]);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ replyMs: null, reply: null });
    expect(report.steps[0]?.typingMs).toBeGreaterThan(1_000);
    expect(report.verdict.ok).toBe(false);
    expect(report.verdict.problems[0]).toMatch(/^Step 1 \("@Go hello, what can you do\?"\): typing took 1\.\d\d s, over 1\.00 s$/);
    expect(report.verdict.problems.slice(1)).toEqual([
      'Step 1 ("@Go hello, what can you do?"): no reply within 1.50 s',
      'Not run after the first miss: "@Go flights Delhi to Goa Friday evening"',
    ]);
  }, 10_000);
});

describe('the printed report', () => {
  it('shows each step, the total and PASS or FAIL with what missed, with no dashes', () => {
    const steps: SmokeStep[] = [
      { line: SMOKE_LINES[0], typingMs: 210, replyMs: 2_400, reply: 'I can find flights,\nstays and run votes.', cards: [] },
      { line: SMOKE_LINES[1], typingMs: 1_400, replyMs: 3_100, reply: null, cards: ['options'] },
    ];
    const text = formatReport({ tripId: 't_smoke_x', joined: { ms: 1_200, text: 'Hi all' }, steps, totalMs: 9_870, verdict: verdictOf(steps) });
    expect(text).toBe([
      'Smoke trip t_smoke_x',
      'Go joined: 1.20 s, "Hi all"',
      '1. Priya: "@Go hello, what can you do?"',
      '   typing on  0.21 s',
      '   reply      2.40 s, "I can find flights, stays and run votes."',
      '   cards      none',
      '2. Priya: "@Go flights Delhi to Goa Friday evening"',
      '   typing on  1.40 s',
      '   reply      3.10 s, "(a card)"',
      '   cards      options',
      'Total 9.87 s',
      'FAIL',
      '- Step 2 ("@Go flights Delhi to Goa Friday evening"): typing took 1.40 s, over 1.00 s',
    ].join('\n'));
    expect(text).not.toMatch(/[—–]/);
  });
});
