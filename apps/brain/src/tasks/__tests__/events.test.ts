import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as C from '@go/contract';
import { FakeIxigoStore } from '../../travel/fake-ixigo/data.js';
import { createImages } from '../../travel/images.js';
import { createTravelLayer } from '../../travel/layer.js';
import { createFakeTravel } from '../../travel/mcp-travel.js';
import type { ResultOption } from '../../travel/results.js';
import { travelTools } from '../../travel/tools.js';
import { FakeSwitches } from '../testing/lane-brain.js';
import { makeTaskHarness, type TaskHarness } from '../testing/harness.js';

let h: TaskHarness;
let travel: ReturnType<typeof createTravelLayer>;
beforeAll(async () => {
  h = await makeTaskHarness();
  const now = h.lb.clock.now;
  travel = createTravelLayer({
    switches: new FakeSwitches(), now, fake: createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' }), ixigo: null, results: h.results,
  });
});
afterAll(async () => {
  await h.close();
});

/** The three villas as Go's search_stays showed them to the job (fake ixigo, 6 to 9 Nov, 5 guests): nightly and whole stay. */
const SEARCHED_AT = '2026-10-07T11:58:00.000Z';
const stay = (offerId: string, title: string, area: string, night: number): ResultOption => ({
  offerId, kind: 'stay', title, priceMinor: night, totalMinor: night * 3, currency: 'INR', priceNote: 'per night', highlights: ['Private pool'], facts: { nights: 3, area },
});
const SOL = stay('fake:st-villa-sol-anjuna-20261106-20261109-5', 'Villa Sol', 'Anjuna', 1280000);
const PALMS = stay('fake:st-the-palms-vagator-20261106-20261109-5', 'The Palms Villa', 'Vagator', 1220000);
const BREEZE = stay('fake:st-ocean-breeze-candolim-20261106-20261109-5', 'Ocean Breeze Villa', 'Candolim', 1310000);
/** What Go saved when the job called Go's search_stays (Task 13 saves every search the trip's computer makes). */
const searched = (tripId: string) =>
  h.results.save({ tripId, optionKind: 'stay', source: 'search', query: { area: 'North Goa' }, options: [SOL, PALMS, BREEZE], checkedAt: SEARCHED_AT });

const VILLAS = {
  summary: 'Three villas with a pool near the beach.',
  options: [
    { title: 'Villa Sol', area: 'Anjuna', price_minor: 1280000, price_note: 'per night', total_paise: 3840000, highlights: ['Private pool', '8 min to the beach'], rating: 4.7, offer_id: SOL.offerId, why: 'Pool and the beach close by.' },
    { title: 'The Palms Villa', area: 'Vagator', price_minor: 1220000, price_note: 'per night', total_paise: 3660000, highlights: ['Private pool', '5 min to the beach'], rating: 4.5, offer_id: PALMS.offerId, why: 'Closest to Vagator beach.' },
    { title: 'Ocean Breeze Villa', area: 'Candolim', price_minor: 1310000, price_note: 'per night', total_paise: 3930000, highlights: ['Private pool'], rating: 4.3, offer_id: BREEZE.offerId, why: 'Three minutes from the sand.' },
  ],
};

describe('applying /v1 events', () => {
  it('maps task.started to the job, which then runs', async () => {
    const { row, v1TaskId } = await h.runningJob('ev1', 't_ev1');
    expect(row).toMatchObject({ state: 'running', v1TaskId });
    expect(h.lb.link.card(row.cardId)?.state).toBe('running');
  });

  it("ticks the card's steps from the job's to-do list", async () => {
    const { row, v1TaskId } = await h.runningJob('ev2', 't_ev2');
    await h.events.apply({ type: 'task.progress', data: { progress: 'status', task_id: v1TaskId, todos: [{ content: 'Search stays', status: 'completed' }, { content: 'Read reviews', status: 'in_progress' }] }, source: 'stream' });
    await h.cards.flush();
    expect(h.lb.link.card(row.cardId)?.steps).toEqual([{ text: 'Search stays', state: 'done' }, { text: 'Read reviews', state: 'doing' }]);
    expect((await h.store.get(row.id))?.todosAt).not.toBeNull();
  });

  it('puts a question on the desk for the composer once, and gives the job time to wait', async () => {
    const { row, v1TaskId } = await h.runningJob('ev3', 't_ev3');
    const ask = h.fake.ask(v1TaskId, { type: 'question', kind: 'ask_question', summary: 'Which dates?', questions: [{ question: 'Which dates?', header: 'Dates', options: [{ label: '6 to 9 Nov', description: '' }], multi_select: false }] });
    const ev = { type: 'interaction.created', data: { interaction_id: ask.id, type: 'question', task_id: v1TaskId }, source: 'stream' as const };
    await h.events.apply(ev);
    await h.events.apply({ ...ev, source: 'webhook' });
    const items = h.lb.desk.items.filter((i) => i.id === `task:${row.id}:ask:${ask.id}`);
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ event: 'question', taskId: row.id, questions: [{ question: 'Which dates?', options: ['6 to 9 Nov'] }] });
    expect((await h.store.get(row.id))!.deadlineAt!.getTime()).toBeGreaterThanOrEqual(h.lb.clock.now().getTime() + 11 * 60_000);
  });

  it('pins a hand-off to the person who asked, and lets go when it is resolved', async () => {
    const { row, v1TaskId } = await h.runningJob('ev4', 't_ev4');
    const ask = h.fake.ask(v1TaskId, { type: 'handoff', kind: 'ask_question', summary: 'Sign in to the villa site', browser: { suggested_mode: 'control', url: null } });
    await h.events.apply({ type: 'interaction.created', data: { interaction_id: ask.id, type: 'handoff', task_id: v1TaskId }, source: 'webhook' });
    await h.cards.flush();
    expect(h.lb.link.card(row.cardId)).toMatchObject({ state: 'needs_you', for_person_ids: ['p_meher'], fallback_text: 'Meher is needed: Finding villas with a pool in North Goa' });
    expect(h.lb.desk.items.find((i) => i.id === `task:${row.id}:handoff:${ask.id}`)?.payload).toMatchObject({ event: 'handoff', personId: 'p_meher' });
    await h.events.apply({ type: 'interaction.resolved', data: { interaction_id: ask.id, type: 'handoff', task_id: v1TaskId }, source: 'stream' });
    await h.cards.flush();
    expect(h.lb.link.card(row.cardId)).toMatchObject({ state: 'running' });
    expect(h.lb.link.card(row.cardId)?.for_person_ids).toBeUndefined();
  });

  it("answers an approval from Go's policy: yes for Go's read-only tools, no for anything else", async () => {
    const { v1TaskId } = await h.runningJob('ev5', 't_ev5');
    const read = h.fake.ask(v1TaskId, { type: 'approval', kind: 'tool_permission', summary: 'Use trip', details: { server: 'go-trip', tool: 'trip' } });
    await h.events.apply({ type: 'interaction.created', data: { interaction_id: read.id, type: 'approval', task_id: v1TaskId, server: 'go-trip', name: 'trip' }, source: 'stream' });
    expect(h.fake.interactions.get(read.id)?.answer).toEqual({ approve: true, present_user: true });
    const other = h.fake.ask(v1TaskId, { type: 'approval', kind: 'tool_permission', summary: 'Post on a site', details: {} });
    await h.events.apply({ type: 'interaction.created', data: { interaction_id: other.id, type: 'approval', task_id: v1TaskId, name: 'mcp__composio__TWITTER_POST' }, source: 'stream' });
    expect(h.fake.interactions.get(other.id)?.answer).toMatchObject({ approve: false });
  });

  it("on completion reads the job's result from /v1, saves the villas as results, ticks the card done and wakes the composer once", async () => {
    const { row, v1TaskId } = await h.runningJob('ev6', 't_ev6');
    await searched(row.tripId);
    h.fake.complete(v1TaskId, VILLAS, 'Found three villas.');
    const ev = { type: 'task.completed', data: { task_id: v1TaskId, status: 'completed' }, source: 'webhook' as const };
    await h.events.apply(ev);
    await h.events.apply({ ...ev, source: 'stream' });
    await h.cards.flush();
    const done = (await h.store.get(row.id))!;
    expect(done).toMatchObject({ state: 'done', endReason: 'completed', costUsd: 0.42 });
    expect(h.lb.link.card(row.cardId)).toMatchObject({ state: 'done', actions: [] });
    const items = h.lb.desk.items.filter((i) => i.id === `task:${row.id}:done`);
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ event: 'completed', resultsId: done.resultsId, count: 3, summary: 'Three villas with a pool near the beach.' });
    const set = await h.results.get(row.tripId, done.resultsId!);
    expect(set?.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(set?.options.map((o) => [o.offerId, o.totalMinor])).toEqual([[SOL.offerId, 3840000], [PALMS.offerId, 3660000], [BREEZE.offerId, 3930000]]);
    expect(set?.checkedAt).toBe(SEARCHED_AT);
  });

  it("builds the options card from the job's picks: offer ids answer travel.offer with those offers at whole-stay totals, and a web pick has no offer", async () => {
    const { row, v1TaskId } = await h.runningJob('ev10', 't_ev10');
    await searched(row.tripId);
    const webPick = {
      title: 'Casa Lua', area: 'Assagao', price_minor: 1500000, price_note: 'per night', total_paise: 4500000, highlights: ['Garden'], offer_id: null,
      source_url: 'https://villas.example/casa-lua', why: 'Quiet, with a big garden.',
    };
    h.fake.complete(v1TaskId, { ...VILLAS, options: [...VILLAS.options, webPick] }, 'Found four villas.');
    await h.events.apply({ type: 'task.completed', data: { task_id: v1TaskId }, source: 'webhook' });
    const done = (await h.store.get(row.id))!;
    expect(h.lb.desk.items.find((i) => i.id === `task:${row.id}:done`)?.payload).toMatchObject({ event: 'completed', count: 4 });
    // The card, built the way show_options builds it in the composer's turn.
    const show = travelTools({ travel, results: h.results, images: createImages({ pool: h.pool, publicUrl: 'https://go.test' }), now: h.lb.clock.now })
      .find((t) => t.name === 'show_options')!;
    const ctx = h.lb.ctx({ tripId: row.tripId, turnId: 'turn_ev10' });
    await show.run(show.input.parse({ results_id: done.resultsId, option_numbers: [1, 2, 3, 4], title: 'Villas with a pool' }), ctx);
    const card = ctx.cards[0] as Extract<C.Card, { kind: 'options' }>;
    expect(card.checked_at).toBe(SEARCHED_AT);
    expect(await Promise.all(card.options.map((o) => travel.offer(o.option_id)))).toEqual([
      { offerId: SOL.offerId, title: 'Villa Sol', priceMinor: 3840000, currency: 'INR', kind: 'stay', link: null },
      { offerId: PALMS.offerId, title: 'The Palms Villa', priceMinor: 3660000, currency: 'INR', kind: 'stay', link: null },
      { offerId: BREEZE.offerId, title: 'Ocean Breeze Villa', priceMinor: 3930000, currency: 'INR', kind: 'stay', link: null },
      { offerId: null, title: 'Casa Lua', priceMinor: 4500000, currency: 'INR', kind: 'stay', link: null },
    ]);
    expect(card.options[0]).toMatchObject({ price_minor: 1280000, price_note: 'per night', subtitle: 'Anjuna, ₹38,400 for 3 nights' });
    expect(card.options[3]?.highlights[0]).toBe('Found on the web');
  });

  it('never posts results for a job that was stopped, even when /v1 finishes it afterwards', async () => {
    const { row, v1TaskId } = await h.runningJob('ev7', 't_ev7');
    await h.tasks.stop(row.id);
    await h.tasks.settled();
    h.fake.tasks.get(v1TaskId)!.status = 'working';
    h.fake.complete(v1TaskId, VILLAS, 'Found three villas.');
    await h.events.apply({ type: 'task.completed', data: { task_id: v1TaskId }, source: 'webhook' });
    await h.cards.flush();
    expect((await h.store.get(row.id))?.state).toBe('stopped');
    expect(h.lb.desk.items.some((i) => i.id === `task:${row.id}:done`)).toBe(false);
    expect(h.lb.link.card(row.cardId)?.fallback_text).toBe('Stopped: Finding villas with a pool in North Goa');
  });

  it('ends a failed job as "Didn\'t work", and a job that hit its spend cap with that reason', async () => {
    const a = await h.runningJob('ev8', 't_ev8');
    await h.events.apply({ type: 'task.failed', data: { task_id: a.v1TaskId, message: 'The villa site would not load.' }, source: 'webhook' });
    expect(h.lb.desk.items.find((i) => i.id === `task:${a.row.id}:failed`)?.payload).toMatchObject({ event: 'failed', reason: 'The villa site would not load.' });
    const b = await h.runningJob('ev9', 't_ev9');
    await h.events.apply({ type: 'task.stopped', data: { task_id: b.v1TaskId, reason: 'max_budget' }, source: 'webhook' });
    expect(await h.store.get(b.row.id)).toMatchObject({ state: 'failed', endReason: 'max_budget' });
    expect(h.lb.desk.items.find((i) => i.id === `task:${b.row.id}:failed`)?.payload).toMatchObject({ reason: 'It hit its spending limit, so it stopped.' });
  });
});
