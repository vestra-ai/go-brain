import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenStore } from '../../mcp/tokens.js';
import { createSweep, type Sweep } from '../sweep.js';
import { VILLA_BRIEF, makeTaskHarness, type TaskHarness } from '../testing/harness.js';

let h: TaskHarness;
let sweep: Sweep;
const followed: string[] = [];
const VILLAS = { summary: 'Three villas.', options: [{ title: 'Villa Sol', area: 'Anjuna', price_minor: 1280000, price_note: 'per night', highlights: ['Private pool'], why: 'Pool.' }] };

beforeAll(async () => {
  h = await makeTaskHarness();
  sweep = createSweep({
    v1: h.v1, store: h.store, eventStore: h.eventStore, tasks: h.tasks, events: h.events, computer: h.computer, follow: (c) => { followed.push(c); },
    desk: h.lb.desk, packs: h.lb.brain.packs, now: h.lb.clock.now, log: h.lb.brain.log,
  });
});
afterAll(async () => {
  await h.close();
});

describe('the sweep', () => {
  it('finishes a job whose end came by no stream and no webhook, reading its status from /v1', async () => {
    const { row, v1TaskId } = await h.runningJob('sw1', 't_sw1');
    h.fake.finishSilently(v1TaskId, VILLAS, 'Three villas.');
    const report = await sweep.runOnce();
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect((await h.store.get(row.id))?.state).toBe('done');
    expect(h.lb.desk.items.filter((i) => i.id === `task:${row.id}:done`)).toHaveLength(1);
  });

  it('applies /v1 events after the last one it saw, once, and follows every conversation with a running job', async () => {
    const { row, v1TaskId } = await h.runningJob('sw2', 't_sw2');
    await sweep.runOnce();
    h.fake.complete(v1TaskId, VILLAS, 'Three villas.');
    const first = await sweep.runOnce();
    expect(first.polled).toBeGreaterThanOrEqual(1);
    expect((await h.store.get(row.id))?.state).toBe('done');
    expect((await sweep.runOnce()).polled).toBe(0);
    const live = await h.runningJob('sw2b', 't_sw2b');
    await sweep.runOnce();
    expect(followed).toContain(live.row.conversationId);
  });

  it("maps a job /v1 started when Go never heard task.started", async () => {
    const r = await h.tasks.start('t_sw3', { ...VILLA_BRIEF, key: 'sw3' });
    await h.tasks.settled();
    const row = (await h.store.get(r.taskId))!;
    const t = h.fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await h.eventStore.setCursor('events', h.fake.platformEvents.at(-1)!.id);
    h.lb.clock.advance(61_000);
    await sweep.runOnce();
    expect(await h.store.get(r.taskId)).toMatchObject({ state: 'running', v1TaskId: t.id });
  });

  it('stops a job past its deadline and says it took too long', async () => {
    const { row, v1TaskId } = await h.runningJob('sw4', 't_sw4');
    h.lb.clock.advance(9 * 60_000);
    const report = await sweep.runOnce();
    expect(report.expired).toBeGreaterThanOrEqual(1);
    await h.cards.flush();
    expect(await h.store.get(row.id)).toMatchObject({ state: 'failed', endReason: 'deadline' });
    expect(h.fake.tasks.get(v1TaskId)?.stopped).toBe(true);
    expect(h.lb.link.card(row.cardId)?.fallback_text).toBe('Took too long: Finding villas with a pool in North Goa');
    expect(h.lb.desk.items.find((i) => i.id === `task:${row.id}:failed`)?.payload).toMatchObject({ reason: 'It took too long, so Go stopped it.' });
  });

  it('cancels a question nobody answered in 10 minutes, with a line for the composer, and the job carries on', async () => {
    const { row, v1TaskId } = await h.runningJob('sw5', 't_sw5');
    const ask = h.fake.ask(v1TaskId, { type: 'question', kind: 'ask_question', summary: 'Which dates?', questions: [{ question: 'Which dates?', header: 'Dates', options: [{ label: '6 to 9 Nov', description: '' }], multi_select: false }] });
    await h.events.apply({ type: 'interaction.created', data: { interaction_id: ask.id, type: 'question', task_id: v1TaskId }, source: 'webhook' });
    h.lb.clock.advance(10.5 * 60_000);
    const report = await sweep.runOnce();
    expect(report.dropped).toBe(1);
    expect(h.fake.interactions.get(ask.id)?.status).toBe('cancelled');
    expect(h.lb.desk.items.find((i) => i.id === `task:${row.id}:dropped:${ask.id}`)?.payload).toMatchObject({ event: 'question_dropped', question: 'Which dates?' });
    expect((await h.store.get(row.id))?.state).toBe('running');
  });

  it('ends a job whose hand-off nobody answered in 10 minutes as "Didn\'t work", unpinned, naming who it waited for', async () => {
    const { row, v1TaskId } = await h.runningJob('sw6', 't_sw6');
    const ask = h.fake.ask(v1TaskId, { type: 'handoff', kind: 'ask_question', summary: 'Sign in to the villa site', browser: { suggested_mode: 'control', url: null } });
    await h.events.apply({ type: 'interaction.created', data: { interaction_id: ask.id, type: 'handoff', task_id: v1TaskId }, source: 'webhook' });
    h.lb.clock.advance(10.5 * 60_000);
    await sweep.runOnce();
    await h.cards.flush();
    const card = h.lb.link.card(row.cardId)!;
    expect(card).toMatchObject({ state: 'failed', fallback_text: "Didn't work: Finding villas with a pool in North Goa", actions: [] });
    expect(card.for_person_ids).toBeUndefined();
    expect(h.fake.interactions.get(ask.id)?.status).toBe('cancelled');
    expect(h.fake.tasks.get(v1TaskId)?.stopped).toBe(true);
    expect(h.lb.desk.items.find((i) => i.id === `task:${row.id}:failed`)?.payload).toMatchObject({ event: 'failed', reason: "Meher wasn't around to help, so Go stopped it." });
  });

  it('starts a waiting job when a slot is free, even if the job that ended forgot to start it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await h.tasks.start('t_sw7', { ...VILLA_BRIEF, key: `sw7_${i}` })).taskId);
    await h.tasks.settled();
    expect((await h.store.get(ids[3]!))?.state).toBe('queued');
    await h.store.transition(ids[0]!, ['starting', 'running'], 'done', { endedAt: h.lb.clock.now() });
    await sweep.runOnce();
    await h.tasks.settled();
    expect((await h.store.get(ids[3]!))?.state).toBe('starting');
    expect(h.fake.callsTo('POST', /\/messages$/).some((c) => c.headers['idempotency-key'] === `go-msg-${ids[3]}`)).toBe(true);
  });

  it('stops on /v1 a job Go stopped before /v1 named it, when no event about its start ever reached Go', async () => {
    const r = await h.tasks.start('t_sw8', { ...VILLA_BRIEF, key: 'sw8' });
    await h.tasks.settled();
    await h.tasks.stop(r.taskId);
    const row = (await h.store.get(r.taskId))!;
    // /v1 starts it only now, and Go hears nothing: no stream, and the events poll is already past it.
    const t = h.fake.startTask(row.conversationId!, row.v1TurnId!, row.title);
    await h.eventStore.setCursor('events', h.fake.platformEvents.at(-1)!.id);
    expect(h.fake.tasks.get(t.id)?.stopped).toBe(false);
    await sweep.runOnce();
    expect(h.fake.tasks.get(t.id)?.stopped).toBe(true);
    expect(await h.store.get(r.taskId)).toMatchObject({ state: 'stopped', v1TaskId: t.id });
  });

  it('revokes the tokens of a trip with no job running', async () => {
    await h.computer.armToken('t_sw9', new Date(h.lb.clock.now().getTime() + 30 * 60_000));
    const token = h.fake.callsTo('PUT', /TRIP_TOKEN/).at(-1)!.body.value as string;
    const tokens = createTokenStore(h.pool, h.lb.clock.now);
    expect(await tokens.tripFor(token)).toBe('t_sw9');
    await sweep.runOnce();
    expect(await tokens.tripFor(token)).toBeNull();
  });
});
