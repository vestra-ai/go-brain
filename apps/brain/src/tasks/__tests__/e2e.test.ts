import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import type * as C from '@go/contract';
import { FakeServer, goaFreshTrip } from '@go/sim';
import { afterTools, newSince, rightNow, SECRET, TEST_TIMINGS } from '../../__tests__/e2e/harness.js';
import { fakeAnthropic, type Reply } from '../../__tests__/fixtures/fake-anthropic.js';
import { buildBrain, type Built } from '../../app.js';
import { withSchema } from '../../db/test-db.js';
import { loadEnv } from '../../env.js';
import { createTokenStore } from '../../mcp/tokens.js';
import { registerRoom } from '../../room.js';
import { registerTravel } from '../../travel/register.js';
import { createTasksLane, type TasksLane } from '../register.js';
import { FakeV1 } from '../testing/fake-v1.js';
import { HARNESS_ADMIN, HARNESS_KEYS } from '../testing/harness.js';
import { armedToken, searchAsTheJob } from '../testing/job-search.js';
import { eventually } from '../testing/lane-brain.js';

const WEBHOOK_SECRET = 'whsec_e2e_0123456789abcdef';
const TRIP = 't_goa';
/** The job's search, as its instructions ask: Go's search_stays for the trip's dates and people, pools only. */
const STAY_SEARCH = { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5, must_have: ['pool'] };
/** What the job returns: three of the villas Go's search showed, each with its offer_id and whole-stay price. */
const VILLAS = {
  summary: 'Three villas with a pool near the beach.',
  options: [
    { title: 'Villa Sol', area: 'Anjuna', price_minor: 1280000, price_note: 'per night', total_paise: 3840000, highlights: ['Private pool', '8 min to the beach'], rating: 4.7, offer_id: 'fake:st-villa-sol-anjuna-20261106-20261109-5', why: 'Pool and the beach close by.' },
    { title: 'The Palms Villa', area: 'Vagator', price_minor: 1220000, price_note: 'per night', total_paise: 3660000, highlights: ['Private pool'], rating: 4.5, offer_id: 'fake:st-the-palms-vagator-20261106-20261109-5', why: 'Closest to Vagator beach.' },
    { title: 'Ocean Breeze Villa', area: 'Candolim', price_minor: 1310000, price_note: 'per night', total_paise: 3930000, highlights: ['Private pool'], rating: 4.3, offer_id: 'fake:st-ocean-breeze-candolim-20261106-20261109-5', why: 'Three minutes from the sand.' },
  ],
};

/** The composer's model, scripted on what each request asks. */
function goScript(body: any): Reply {
  const now = rightNow(body);
  const fresh = newSince(body);
  if (afterTools(body)) {
    if (now.includes('finished with')) return { text: 'Three villas that fit. Want a vote?' };
    if (fresh.includes('find a villa')) return { text: 'On it. Looking for villas with a pool in North Goa.' };
    return { tools: [{ name: 'stay_silent', input: { reason: 'done' } }] };
  }
  if (now.includes('you just joined this trip')) return { text: 'Hi all, I am Go.' };
  const results = /results_id "([^"]+)"/.exec(now)?.[1];
  if (results && now.includes('finished with')) {
    return { text: 'Three villas that fit. Want a vote?', tools: [{ name: 'show_options', input: { results_id: results, title: 'Villas with a pool in North Goa' } }] };
  }
  if (now.includes("didn't work")) return { text: "That didn't work. Want me to try again?" };
  if (now.includes('needs Meher for something only they can do')) return { text: 'Meher, the villa site wants a one-time code. Send it here, or tap Watch on the card.' };
  const job = /\b(gt_[0-9a-z]{6,40})\b/.exec(now)?.[1];
  if (job && fresh.includes('I put the code in')) return { tools: [{ name: 'settle_handoff', input: { task_id: job, outcome: 'done' } }] };
  if (job && fresh.includes('allow pets')) return { tools: [{ name: 'message_task', input: { task_id: job, text: 'Also check if any of them allow pets' } }] };
  if (fresh.includes('find a villa')) {
    return {
      tools: [{
        name: 'start_task',
        input: {
          title: 'Finding villas with a pool in North Goa',
          goal: "Find villas with a pool in North Goa for 6 to 9 Nov for 5 people, under 8,000 rupees a head, near the beach. Use Go's search_stays first.",
          returns: 'stays',
          steps: ['Search stays in North Goa', 'Keep villas with a pool', 'Read the reviews', 'Pick the best three'],
          context: { area: 'North Goa', budget_per_head_inr: 8000, must_have: ['pool', 'near the beach'] },
          asked_by: 'Meher',
        },
      }],
    };
  }
  return { tools: [{ name: 'stay_silent', input: { reason: 'chatter' } }] };
}

let offset = 0;
const now = (): Date => new Date(Date.now() + offset);
let db: Awaited<ReturnType<typeof withSchema>>;
let fake: FakeV1;
let built: Built;
let lane: TasksLane;
let server: FakeServer;
let goUrl = '';

const goMessages = (): C.Message[] => server.messages(TRIP).filter((m) => m.author.kind === 'go');
const working = (): C.Message[] => goMessages().filter((m) => m.card?.kind === 'working');
const options = (): C.Message[] => goMessages().filter((m) => m.card?.kind === 'options');
const cardOf = (cardId: string): any => goMessages().find((m) => m.card?.card_id === cardId)?.card;

/** Asks for a new villa job and waits for its working card and its /v1 task. */
async function newJob(personId: string, text: string): Promise<{ cardId: string; v1TaskId: string; message: C.Message }> {
  const cardsBefore = working().length;
  const tasksBefore = fake.tasks.size;
  await server.say(personId, text);
  const message = await server.waitFor(() => (working().length > cardsBefore ? working().at(-1)! : null), 20_000);
  await eventually(() => fake.tasks.size > tasksBefore, 10_000);
  const v1TaskId = fake.lastTask()!.id;
  return { cardId: message.card!.card_id, v1TaskId, message };
}

beforeAll(async () => {
  db = await withSchema();
  fake = new FakeV1({ keys: HARNESS_KEYS, adminKey: HARNESS_ADMIN, now });
  await fake.start();
  const env = loadEnv({
    PORT: '0', DATABASE_URL: process.env.DATABASE_URL, GO_SIGNING_SECRET: SECRET, GO_PUBLIC_URL: 'https://go.test', ANTHROPIC_API_KEY: 'test-key', LOG_LEVEL: 'silent',
    TRAVEL_MODE: 'fake', VESTRA_API_URL: fake.url, VESTRA_API_KEYS: HARNESS_KEYS.join(','), VESTRA_ADMIN_KEY: HARNESS_ADMIN,
    VESTRA_WEBHOOK_SECRET: WEBHOOK_SECRET, VESTRA_DEPLOYMENT_ID: 'dep_go', VESTRA_MCP_SERVER_ID: 'mcp_go',
  });
  const model = fakeAnthropic(goScript);
  built = await buildBrain(env, { pool: db.pool, anthropic: model.client, logger: false, timings: TEST_TIMINGS, now });
  await registerRoom(built.brain);
  await registerTravel(built.brain);
  lane = (await createTasksLane(built.brain, { sweepEveryMs: 0, cardGapMs: 0, follower: { reconnectMs: [20, 50], screenMs: 60_000 } }))!;
  const { port } = await built.start();
  goUrl = `http://127.0.0.1:${port}`;
  // The sim shares Go's clock, so signatures still check after the test jumps ten minutes.
  server = new FakeServer({ goUrl, secret: SECRET, instance: 'p4-e2e', now });
  await server.start(10_000);
  await server.createTrip(goaFreshTrip());
  await server.waitFor(() => (goMessages().length > 0 ? true : null), 20_000);
  await eventually(() => fake.users.size > 0, 10_000);
}, 60_000);

afterAll(async () => {
  server.stop();
  await built.stop();
  await fake.close();
  await db.drop();
});

describe('G3: Go does real work', () => {
  it('turns "find a villa" into a job: "On it" with a working card that ticks, Watch, a hand-off answered from the chat, and the villas as an options card', async () => {
    const { cardId, v1TaskId, message } = await newJob('p_meher', 'Go, find a villa with a pool in North Goa under 8k a head, near the beach');
    expect(message.text).toBe('On it. Looking for villas with a pool in North Goa.');
    expect(message.card).toMatchObject({ kind: 'working', state: 'running', steps: [{ text: 'Search stays in North Goa', state: 'doing' }, { text: 'Keep villas with a pool', state: 'todo' }, { text: 'Read the reviews', state: 'todo' }, { text: 'Pick the best three', state: 'todo' }] });
    const handed = fake.callsTo('POST', /\/messages$/).at(-1)!;
    expect(handed.body).toMatchObject({ hand_off: 'always', output_schema: { required: ['summary', 'options'] }, context: { area: 'North Goa', trip: { people: 5 } } });

    fake.progress(v1TaskId, [['Search stays in North Goa', 'completed'], ['Keep villas with a pool', 'in_progress']]);
    await server.waitFor(() => (cardOf(cardId)?.steps?.some((s: { text: string; state: string }) => s.text === 'Keep villas with a pool' && s.state === 'doing') ? true : null), 10_000);

    const watch = await server.tap(cardId, 'watch', 'p_priya');
    const again = await server.tap(cardId, 'watch', 'p_priya');
    expect(watch).toMatchObject({ result: 'open', url: expect.stringMatching(/^https:\/\//) });
    expect((again as { url?: string }).url).not.toBe((watch as { url?: string }).url);
    expect(goMessages().some((m) => (m.text ?? '').includes('web.vestra.test'))).toBe(false);

    const ask = fake.ask(v1TaskId, { type: 'handoff', kind: 'ask_question', summary: 'The villa site sent a one-time code to Meher', browser: { suggested_mode: 'control', url: null } });
    await server.waitFor(() => (cardOf(cardId)?.state === 'needs_you' ? true : null), 10_000);
    expect(cardOf(cardId)?.for_person_ids).toEqual(['p_meher']);
    await server.waitFor(() => goMessages().find((m) => (m.text ?? '').startsWith('Meher, the villa site')) ?? null, 20_000);
    // The door hides a one-time code typed in the chat (master §6.3 notes), so Meher puts it in on the Watch screen and says so here.
    await server.say('p_meher', 'done, I put the code in');
    await eventually(() => fake.interactions.get(ask.id)?.status === 'resolved', 20_000);
    expect(fake.interactions.get(ask.id)?.answer).toEqual({ done: true });
    await server.waitFor(() => (cardOf(cardId)?.state === 'running' ? true : null), 10_000);

    // The job searches Go's stays with the trip token Go armed for it; Go keeps what it showed for the trip.
    const searched = await searchAsTheJob({ goUrl, token: armedToken(fake, TRIP), tool: 'search_stays', args: STAY_SEARCH });
    for (const v of VILLAS.options) expect(searched.results.find((r) => r.offer_id === v.offer_id)?.total_paise, v.title).toBe(v.total_paise);

    const optionsBefore = options().length;
    fake.complete(v1TaskId, VILLAS, 'Found three villas.');
    const shown = await server.waitFor(() => (options().length > optionsBefore ? options().at(-1)! : null), 20_000);
    expect(shown.text).toBe('Three villas that fit. Want a vote?');
    const card = shown.card as Extract<C.Card, { kind: 'options' }>;
    expect(card.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote']);
    // Bookable end to end: each option is the offer the job picked, at the whole-stay price a vote and a payment use.
    const offers = await Promise.all(card.options.map((o) => built.brain.travel!.offer(o.option_id)));
    expect(offers.map((o) => [o?.offerId, o?.priceMinor])).toEqual(VILLAS.options.map((v) => [v.offer_id, v.total_paise]));
    expect(cardOf(cardId)).toMatchObject({ state: 'done', actions: [] });
  }, 120_000);

  it('a job stopped from its card says Stopped, and never posts results when /v1 finishes it anyway', async () => {
    const { cardId, v1TaskId } = await newJob('p_kabir', 'Go, find a villa in Morjim with a pool for us');
    expect(await server.tap(cardId, 'stop', 'p_kabir')).toMatchObject({ result: 'done' });
    await server.waitFor(() => (String(cardOf(cardId)?.fallback_text ?? '').startsWith('Stopped') ? true : null), 10_000);
    // The tap may land before Go has heard /v1 name the job; Go stops it on /v1 the moment it does (mapStarts).
    await eventually(() => fake.tasks.get(v1TaskId)?.stopped === true, 10_000);
    const optionsBefore = options().length;
    fake.tasks.get(v1TaskId)!.status = 'working';
    fake.complete(v1TaskId, VILLAS, 'Found them anyway.');
    await new Promise((r) => setTimeout(r, 2_000));
    expect(options()).toHaveLength(optionsBefore);
    expect(cardOf(cardId)).toMatchObject({ state: 'failed', actions: [] });
  }, 60_000);

  it('a finish that came by no stream and no webhook is found by the sweep', async () => {
    const { cardId, v1TaskId } = await newJob('p_priya', 'Go, find a villa in Assagao with a pool');
    await server.waitFor(() => (cardOf(cardId)?.state === 'running' ? true : null), 10_000);
    const optionsBefore = options().length;
    fake.finishSilently(v1TaskId, VILLAS, 'Found three villas.');
    await new Promise((r) => setTimeout(r, 1_000));
    expect(options()).toHaveLength(optionsBefore);
    await lane.sweep.runOnce();
    await server.waitFor(() => (options().length > optionsBefore ? true : null), 20_000);
    expect(cardOf(cardId)).toMatchObject({ state: 'done' });
  }, 60_000);

  it('a dropped stream is reopened from the last event it saw, and nothing is missed or applied twice', async () => {
    const { cardId, v1TaskId } = await newJob('p_arjun', 'Go, find a villa in Siolim with a pool');
    const resumes = (): number => fake.callsTo('GET', /^\/v1\/conversations\/[^/]+\/events$/).filter((c) => c.headers['last-event-id'] !== undefined).length;
    const before = resumes();
    // Go has seen an event of the job's own conversation, so there is a place to resume from.
    fake.progress(v1TaskId, [['Search stays in North Goa', 'in_progress'], ['Read the reviews', 'pending']]);
    await server.waitFor(() => (cardOf(cardId)?.steps?.length === 2 ? true : null), 15_000);
    await eventually(() => fake.cutStreams() > 0, 5_000);
    fake.progress(v1TaskId, [['Search stays in North Goa', 'completed'], ['Read the reviews', 'in_progress']]);
    await server.waitFor(() => (cardOf(cardId)?.steps?.some((s: { text: string; state: string }) => s.text === 'Read the reviews' && s.state === 'doing') ? true : null), 15_000);
    expect(resumes()).toBeGreaterThan(before);
    const optionsBefore = options().length;
    fake.complete(v1TaskId, VILLAS, 'Found three villas.');
    await server.waitFor(() => (options().length > optionsBefore ? true : null), 20_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(options()).toHaveLength(optionsBefore + 1);
  }, 60_000);

  it("replays the rehearsal drill: a follow-up sent while the job is queued runs first, and only the job's last run ends it, with one options card", async () => {
    fake.autoStart = false;
    onTestFinished(() => {
      fake.autoStart = true;
    });
    const messages = () => fake.callsTo('POST', /^\/v1\/conversations\/[^/]+\/messages$/);
    const sentBefore = messages().length;
    const cardsBefore = working().length;
    await server.say('p_priya', 'Go, find a villa with a pool in North Goa for 6 to 9 Nov under 8k a head, and check real reviews and how far the beach really is');
    const { card: startCard } = await server.waitFor(() => (working().length > cardsBefore ? working().at(-1)! : null), 20_000);
    const cardId = startCard!.card_id;
    await eventually(() => messages().length > sentBefore, 10_000);
    const start = messages()[sentBefore]!;
    expect(start.body).toMatchObject({ hand_off: 'always', output_schema: { required: ['summary', 'options'] } });
    // The job has a conversation of its own.
    const conv = start.path.split('/')[3]!;
    expect(messages().slice(0, sentBefore).some((c) => c.path.includes(`/${conv}/`))).toBe(false);
    const turnsOf = () => [...fake.turns.values()].filter((u) => u.conversationId === conv);
    // /v1 names the job while the computer is still waking: no run has its words yet.
    const task = fake.startTask(conv, turnsOf()[0]!.id, 'Finding villas with a pool in North Goa', { queued: true });

    // Priya's follow-up while it waits: one more message to the job, with its output_schema.
    await server.say('p_priya', 'Go, also check if any of them allow pets');
    await eventually(() => turnsOf().length === 2, 20_000);
    const follow = messages().filter((c) => c.path.includes(`/${conv}/`)).at(-1)!;
    expect(follow.body).toMatchObject({ hand_off: 'auto', output_schema: { required: ['summary', 'options'] } });
    expect(follow.body.message).toContain('allow pets');
    const token = armedToken(fake, TRIP);

    // Run 1 takes the follow-up first, ticks its own to-do list, and ends with its answer as JSON text, no data.
    fake.nextRun(task.id, [turnsOf()[1]!.id]);
    fake.progress(task.id, [['Find the villas already shortlisted', 'completed'], ['Check each villa’s pet policy', 'completed']]);
    await server.waitFor(() => (cardOf(cardId)?.steps?.some((st: { text: string }) => st.text === 'Check each villa’s pet policy') ? true : null), 10_000);
    const looks = () => fake.callsTo('GET', new RegExp(`^/v1/conversations/${conv}$`)).length;
    const looksBefore = looks();
    const optionsBefore = options().length;
    fake.complete(task.id, null, JSON.stringify({ summary: 'No pet policy is confirmed yet.', options: [] }));
    // Go looks, finds the job's start still open, and keeps the job running.
    await eventually(() => looks() > looksBefore, 10_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(cardOf(cardId)).toMatchObject({ state: 'running', actions: [{ action_id: 'watch' }, { action_id: 'stop' }] });
    expect(options()).toHaveLength(optionsBefore);
    // The trip token still opens Go's tools between the runs: no 401 mid-task.
    const between = await searchAsTheJob({ goUrl, token, tool: 'search_stays', args: STAY_SEARCH });
    expect(between.results.length).toBeGreaterThan(0);

    // Run 2 takes the start: /v1's to-do list keeps run 1's steps and adds its own; the job searches Go's stays.
    fake.nextRun(task.id);
    fake.progress(task.id, [
      ['Find the villas already shortlisted', 'completed'], ['Check each villa’s pet policy', 'completed'],
      ['Find pool villas for 6 to 9 November', 'completed'], ['Verify reviews, beach access and pet rules', 'in_progress'], ['Return the best three verified villas', 'pending'],
    ]);
    await server.waitFor(() => (cardOf(cardId)?.steps?.length === 5 ? true : null), 10_000);
    await searchAsTheJob({ goUrl, token, tool: 'search_stays', args: STAY_SEARCH });
    fake.complete(task.id, VILLAS, 'Found three villas.');
    const shown = await server.waitFor(() => (options().length > optionsBefore ? options().at(-1)! : null), 20_000);
    const card = shown.card as Extract<C.Card, { kind: 'options' }>;
    expect(card.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote']);
    await server.waitFor(() => (cardOf(cardId)?.state === 'done' ? true : null), 10_000);
    expect(cardOf(cardId).steps.map((st: { state: string }) => st.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    // The token goes at the real end, and only one options card came.
    await eventually(async () => (await createTokenStore(db.pool, now).tripFor(token)) === null, 10_000);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(options()).toHaveLength(optionsBefore + 1);
  }, 90_000);

  it('a hand-off nobody answers ends as "Didn\'t work" after 10 minutes, unpinned, and Go says so', async () => {
    const { cardId, v1TaskId } = await newJob('p_meher', 'Go, find a villa in Vagator with a pool');
    await server.waitFor(() => (cardOf(cardId)?.state === 'running' ? true : null), 10_000);
    const toMeher = (): number => goMessages().filter((m) => (m.text ?? '').startsWith('Meher, the villa site')).length;
    const linesBefore = toMeher();
    const ask = fake.ask(v1TaskId, { type: 'handoff', kind: 'ask_question', summary: 'Sign in to the villa site', browser: { suggested_mode: 'control', url: null } });
    await server.waitFor(() => (cardOf(cardId)?.state === 'needs_you' ? true : null), 10_000);
    // Go has told Meher (its turn is over) before the clock jumps, so no turn is cut in half by the jump.
    await server.waitFor(() => (toMeher() > linesBefore ? true : null), 20_000);
    offset += 10.5 * 60_000;
    await lane.sweep.runOnce();
    await server.waitFor(() => (cardOf(cardId)?.state === 'failed' ? true : null), 10_000);
    expect(cardOf(cardId)).toMatchObject({ fallback_text: "Didn't work: Finding villas with a pool in North Goa", actions: [] });
    expect(cardOf(cardId)?.for_person_ids ?? undefined).toBeUndefined();
    expect(fake.interactions.get(ask.id)?.status).toBe('cancelled');
    await server.waitFor(() => goMessages().find((m) => m.text === "That didn't work. Want me to try again?") ?? null, 20_000);
  }, 60_000);
});
