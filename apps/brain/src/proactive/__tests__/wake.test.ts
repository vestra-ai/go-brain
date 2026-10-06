import { describe, expect, it } from 'vitest';
import type { DeskItem } from '../../desk/desk.js';
import { ALWAYS, composerRules, rulesForTurn, simulatedIn } from '../allowed.js';
import { candidate, goaPack, goaTrip } from '../fakes.js';
import { deskId, toPayload } from '../payload.js';
import type { Action, Candidate } from '../policy.js';
import { describeNoticed, openingsNow, renderWake } from '../wake.js';
import { clip, namesOf, plain, quote, rupees } from '../words.js';

const NOW = new Date('2026-10-06T06:30:00Z');
function proItem(c: Candidate, allowed: Action[], forPersonIds: string[] = []): DeskItem {
  const id = deskId(c);
  return {
    id, tripId: c.tripId, kind: c.source, ref: id, dueAt: NOW,
    payload: toPayload(c, { kind: 'go', allowed, forPersonIds, counted: true, score: 1, bar: 0 }, 'Asia/Kolkata'),
  };
}
const messageItem: DeskItem = { id: 'msg:1', tripId: 't_goa', kind: 'message', ref: 'm_1', dueAt: NOW, payload: {} };
const delay = candidate({
  dedupeKey: 'sim:flight_status:ab12',
  simulated: true,
  facts: { label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 120, arriveAt: '2026-11-06T22:45:00+05:30', note: "Arjun's airport cab is booked for 9 pm", simulated: true },
});
const chat = candidate({ dedupeKey: 'chat:m_9', source: 'opening', topic: 'chat', personIds: [], useful: ['react', 'record', 'message'], facts: { message_id: 'm_9', seq: 9 } });

describe('words', () => {
  it('keeps em dashes and vendor names out of what people see', () => {
    expect(plain('Villa Sol — 3 nights, 6–9 Nov')).toBe('Villa Sol, 3 nights, 6 to 9 Nov');
    expect(plain('I run on OpenAI GPT-5 and ChatGPT')).not.toMatch(/openai|gpt|chatgpt/i);
  });

  it('clips, quotes as data, writes rupees and names', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(rupees(5420000)).toBe('₹54,200');
    const people = goaTrip().people;
    expect(namesOf(['p_arjun'], people)).toBe('Arjun');
    expect(namesOf(['p_arjun', 'p_meher'], people)).toBe('Arjun and Meher');
    expect(namesOf(['p_arjun', 'p_meher', 'p_kabir'], people)).toBe('Arjun, Meher and Kabir');
  });
});

describe('rulesForTurn', () => {
  it('applies only when nothing but Go noticing woke the turn', () => {
    expect(rulesForTurn([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBeNull();
    expect(rulesForTurn([])).toBeNull();
  });

  it('allows a pin for Arjun and nothing louder', () => {
    const r = rulesForTurn([proItem(delay, ['pin'], ['p_arjun'])]);
    expect(r).toMatchObject({ allowed: ['pin'], mayPostText: false, pinOnlyFor: ['p_arjun'], dedupeKeys: ['sim:flight_status:ab12'] });
    for (const t of ALWAYS) expect(r?.tools).toContain(t);
    expect(r?.tools).toContain('post_notice');
    expect(r?.tools).not.toContain('react');
    expect(r?.tools).not.toContain('call_business');
    expect(r?.tools).not.toContain('start_task');
  });

  it('allows quiet tools and one message for a chat opening', () => {
    const r = rulesForTurn([proItem(chat, ['react', 'record', 'message'])]);
    expect(r).toMatchObject({ mayPostText: true, pinOnlyFor: null });
    expect(r?.tools).toEqual(expect.arrayContaining(['react', 'record', 'post_notice', 'stay_silent']));
  });

  it('never lets simulated news out as text: a notice card carries its label and pins', () => {
    const toAll = candidate({ dedupeKey: 'sim:flight_status:all', simulated: true, personIds: [] });
    expect(rulesForTurn([proItem(toAll, ['message'])])).toMatchObject({ mayPostText: false, tools: expect.arrayContaining(['post_notice']) });
    expect(composerRules([proItem(toAll, ['message'])])?.mayPostText).toBe(false);
    expect(rulesForTurn([proItem(chat, ['react', 'record', 'message'])])?.mayPostText).toBe(true);
  });

  it('gives a proactive item it cannot read the strictest rules: reading and stay_silent only, no text', () => {
    const broken: DeskItem = { id: 'watch:t_goa:bad', tripId: 't_goa', kind: 'watch', ref: 'watch:t_goa:bad', dueAt: NOW, payload: { candidate: 'nonsense' } };
    expect(rulesForTurn([broken])).toEqual({ allowed: [], tools: [...ALWAYS], mayPostText: false, pinOnlyFor: [], dedupeKeys: [] });
    expect(composerRules([broken, proItem(chat, ['react', 'record', 'message'])])).toEqual({ tools: [...ALWAYS], mayPostText: false });
    expect(rulesForTurn([messageItem, broken])).toBeNull();
  });

  it('notices a simulated item even in a turn a person woke', () => {
    expect(simulatedIn([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBe(true);
    expect(simulatedIn([messageItem])).toBe(false);
  });

  it('hands P1 exactly the tools and the text rule, and nothing for a turn a person woke', () => {
    expect(composerRules([messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toBeNull();
    const r = composerRules([proItem(delay, ['pin'], ['p_arjun'])]);
    expect(Object.keys(r ?? {}).sort()).toEqual(['mayPostText', 'tools']);
    expect(r?.mayPostText).toBe(false);
    expect(r?.tools).toEqual(expect.arrayContaining(['post_notice', 'stay_silent', 'trip', 'person', 'recall']));
    expect(r?.tools).not.toContain('call_business');
    expect(r?.tools).not.toContain('start_task');
  });
});

describe('the wake text', () => {
  it('says the demo watch is simulated, pinned to Arjun, and not for everyone', () => {
    const text = renderWake(proItem(delay, ['pin'], ['p_arjun']), goaPack(), NOW);
    expect(text).toContain('Simulated for the demo');
    expect(text).toContain('running 120 minutes late');
    expect(text).toContain("Arjun's airport cab");
    expect(text).toContain('["p_arjun"]');
    expect(text).toContain('Do not post a message to everyone');
    expect(text).toContain('Suggest, never act');
    expect(text).not.toContain('—');
  });

  it('names who has not voted, and when the vote closes', () => {
    const c = candidate({ source: 'timer', topic: 'vote_closing', personIds: ['p_arjun', 'p_meher'], facts: { decision_id: 'd_villa', closes_at: '2026-10-06T12:30:00Z' } });
    const text = describeNoticed(c, goaPack(), 'Asia/Kolkata', NOW);
    expect(text).toContain('"Where do we stay?"');
    expect(text).toContain('Not voted yet: Arjun and Meher');
    expect(text).toContain('in about 6 hours');
  });

  it('says how much is at stake when free cancellation ends', () => {
    const c = candidate({ source: 'timer', topic: 'free_cancel', personIds: ['p_rahul'], facts: { booking_id: 'b_villa', refundable_until: '2026-11-01T18:29:59Z' } });
    expect(describeNoticed(c, goaPack(), 'Asia/Kolkata', NOW)).toContain('₹54,200');
  });

  it('reads a watched flight and a train ticket from P4 status words, with how old the check is', () => {
    const late = candidate({
      topic: 'flight_status', personIds: ['p_rahul'],
      facts: { label: 'IndiGo 6E 2134', state: 'delayed', delayMinutes: 45, expectedDepartAt: '2026-11-06T13:30:00Z', checkedAt: '2026-10-06T06:27:00Z' },
    });
    const flightText = describeNoticed(late, goaPack(), 'Asia/Kolkata', NOW);
    expect(flightText).toContain('"IndiGo 6E 2134" is running 45 minutes late, now leaving');
    expect(flightText).toContain('(checked 3 min ago)');
    expect(flightText).toContain('It concerns Rahul.');
    const ticket = candidate({ topic: 'pnr_status', personIds: ['p_meher', 'p_arjun'], facts: { label: 'Mandovi Express', state: 'confirmed', detail: 'CNF B2 34', checkedAt: NOW.toISOString() } });
    expect(describeNoticed(ticket, goaPack(), 'Asia/Kolkata', NOW)).toBe('The train ticket "Mandovi Express" is now confirmed ("CNF B2 34") (checked just now). It concerns Meher and Arjun.');
  });
});

describe('the openings block', () => {
  const now = openingsNow();
  it('stays out of a turn Go did not wake for itself', async () => {
    expect(now.name).toBe('openings');
    expect(await now.render('t_goa', [messageItem])).toBeNull();
  });

  it('lists the tools a proactive turn may use', async () => {
    const text = await now.render('t_goa', [proItem(delay, ['pin'], ['p_arjun'])]);
    expect(text).toContain('Tools you may use');
    expect(text).toContain('Do not post a text message');
  });

  it('lets a noticed item ride along when a person woke Go too', async () => {
    expect(await now.render('t_goa', [messageItem, proItem(delay, ['pin'], ['p_arjun'])])).toContain('normal rules apply');
  });
});
