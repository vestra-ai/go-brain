// The demo (master §1) end to end in CI, in the run sheet's order: every lane registered, every outside thing faked,
// a scripted director as the model. It proves the plumbing, not the model's judgement: the director always makes the
// right call, and the test checks that each call reaches the room the way the run sheet says it must.
import type * as C from '@go/contract';
import { PersonPage } from '@go/contract';
import { goaFreshTrip } from '@go/sim';
import { registerAdmin } from '@go/brain/dist/admin/register.js';
import { registerCalls } from '@go/brain/dist/calls/register.js';
import { STOP_LINE } from '@go/brain/dist/calls/service.js';
import { LANES } from '@go/brain/dist/main.js';
import { countFacts } from '@go/brain/dist/memory/facts.js';
import { registerMemory } from '@go/brain/dist/memory/register.js';
import { registerMoney } from '@go/brain/dist/money/register.js';
import { refusalWords } from '@go/brain/dist/money/words.js';
import { registerProactive } from '@go/brain/dist/proactive/register.js';
import { registerReflex } from '@go/brain/dist/reflex/register.js';
import { registerRoom } from '@go/brain/dist/room.js';
import { registerStats } from '@go/brain/dist/stats/index.js';
import { registerTasks } from '@go/brain/dist/tasks/register.js';
import { armedToken, searchAsTheJob } from '@go/brain/dist/tasks/testing/job-search.js';
import { appliedCount, typingOf, waitTyping } from '@go/brain/dist/testing/watch.js';
import { registerTravel } from '@go/brain/dist/travel/register.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CAP_MINOR, DEMO_FORGET, DEMO_FRIEND, DEMO_LINES, DEMO_NOW, DEMO_PAYER, DEMO_PEOPLE, DEMO_STAY_SEARCH, DEMO_VILLAS, DEMO_WATCH, type DemoLine } from '../demo.js';
import { createDirector, DIRECTOR_WORDS as W } from '../director.js';
import { CALL_OUTCOME, CALL_RECORD, DEMO_ADMIN_TOKEN, DEMO_CALLEE, DEMO_PHOTO_URL, runClockFrom, startDemoRoom, type DemoRoom } from '../kit.js';
import { renderTranscript, rowsOfFile, type TranscriptAct } from '../transcript.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (process.env['CI'] !== undefined && DATABASE_URL === undefined) throw new Error('The demo test needs DATABASE_URL in CI (the Postgres service).');

type Card<K extends C.Card['kind']> = Extract<C.Card, { kind: K }>;

let demo: DemoRoom | undefined;
const director = createDirector({ trip: () => (demo ? demo.room.fake.trip() : null) });
const d = (): DemoRoom => {
  if (!demo) throw new Error('the demo room is not up');
  return demo;
};
const fake = () => d().room.fake;
const go = (): C.Message[] => fake().messages().filter((m) => m.author.kind === 'go');
const lastSeq = (): number => fake().messages().at(-1)?.seq ?? 0;
const kindIs = (kind: C.Card['kind']) => (m: C.Message): boolean => m.card?.kind === kind;
const cardNow = (cardId: string): C.Card | null => go().find((m) => m.card?.card_id === cardId)?.card ?? null;
const jobState = (): string | undefined => (cardNow(workingId) as Card<'working'> | null)?.state;
/** Go's first message after `seq` that matches. */
const goAfter = (seq: number, pred: (m: C.Message) => boolean, timeoutMs = 20_000): Promise<C.Message> =>
  fake().waitFor(() => go().find((m) => m.seq > seq && pred(m)) ?? null, timeoutMs);
/** Go's applied reactions on these messages, as [message_id, emoji]. */
const reactionsOn = (ids: string[]): Array<[string, string]> =>
  fake().writes
    .filter((w) => w.method === 'add_reaction' && w.applied && ids.includes(String(w.params['message_id'])))
    .map((w) => [String(w.params['message_id']), String(w.params['emoji'])]);

/**
 * For the transcript: the beats in order, the beat now playing, the beat of each message and what happened outside the
 * chat lines. Each beat's test names its own lines, acts and the replies it waits for, so no row is filed by the clock.
 */
const beats: string[] = [];
let beatNow = '';
const beatOf = new Map<string, string>();
const acts: TranscriptAct[] = [];
const chapter = (title: string): void => {
  beats.push(title);
  beatNow = title;
};
const nameOf = (personId: string): string => fake().trip().people.find((p) => p.person_id === personId)?.name ?? personId;
const act = (at: number, who: string, what: string, afterSeq = lastSeq()): void => {
  acts.push({ at, afterSeq, beat: beatNow, who, what });
};

async function say(line: DemoLine): Promise<{ message: C.Message; sentAt: number }> {
  const sentAt = Date.now();
  const message = await fake().say(
    line.person,
    line.text,
    line.photoCaption ? { attachments: [{ kind: 'photo', url: DEMO_PHOTO_URL, caption: line.photoCaption }] } : {},
  );
  beatOf.set(message.message_id, beatNow);
  return { message, sentAt };
}

/** Where each beat's outcome landed in the room, and how long it took from its cue (wall clock). */
const seqs: Array<[string, number]> = [];
const took: Array<{ beat: string; ms: number }> = [];
const mark = (beat: string, m: C.Message, sentAt?: number): void => {
  seqs.push([beat, m.seq]);
  beatOf.set(m.message_id, beatNow);
  if (sentAt !== undefined) took.push({ beat, ms: Date.now() - sentAt });
};

/** A tap, as the Server sends it, written down for the transcript. */
async function tap(cardId: string, action: string, personId: string) {
  const at = Date.now();
  const afterSeq = lastSeq();
  const kind = cardNow(cardId)?.kind ?? 'a';
  const r = await fake().tap(cardId, action, personId);
  act(at, nameOf(personId), `taps "${action}" on the ${kind} card: ${r.result}${'toast' in r && r.toast ? `, "${r.toast}"` : ''}`, afterSeq);
  return r;
}
/** The committed transcript, and where this run writes its own. */
const COMMITTED = fileURLToPath(new URL('../../../../../docs/demo/transcript.md', import.meta.url));
const WRITE_TO = process.env['DEMO_TRANSCRIPT'] ? resolve(process.env['DEMO_TRANSCRIPT']) : fileURLToPath(new URL('../../../out/demo-transcript.md', import.meta.url));

let vegSeq = 0;
let vegMessageId = '';
let workingId = '';
let v1TaskId = '';
let villaSentAt = 0;
let callCueSentAt = 0;
let callLine: C.Message | undefined;
let decisionId = '';
let payCard: Card<'pay'> | undefined;

describe.skipIf(DATABASE_URL === undefined)('the demo, end to end, with every lane and every outside thing faked', () => {
  let realClock: (() => void) | undefined;
  beforeAll(async () => {
    realClock = runClockFrom(DEMO_NOW);
    demo = await startDemoRoom({ anthropic: director.client });
  }, 60_000);
  afterAll(async () => {
    await demo?.stop();
    realClock?.();
  });

  it('every lane is registered, in master order', () => {
    expect(LANES).toEqual([registerRoom, registerReflex, registerMemory, registerStats, registerTravel, registerTasks, registerMoney, registerProactive, registerCalls, registerAdmin]);
  });

  it('0:00 Go joins the trip and says hello, the trip gets its computer, and the line a friend said days ago is in the chat', async () => {
    chapter('0:00 Go joins the trip');
    act(Date.now(), 'The Server', 'creates the Goa trip: Rahul, Priya, Arjun, Meher and Kabir', 0);
    await fake().createTrip(goaFreshTrip());
    mark('greeting', await goAfter(0, (m) => m.text === W.greeting));
    await fake().waitFor(() => (d().v1.users.size > 0 ? true : null), 15_000);
    // "Days ago" in the real trip: Arjun can't leave before 6 on Friday, which the flights card honours at 0:30.
    const from = lastSeq();
    for (const line of DEMO_LINES.history) await say(line);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(go().filter((m) => m.seq > from)).toEqual([]);
  }, 30_000);

  it('0:15 the chatter: Go says nothing and the model is not even asked, and a quiet ✅ lands under "I\'m veg btw" at once', async () => {
    chapter('0:15 The chatter');
    const from = lastSeq();
    const startedAt = Date.now();
    const asked = director.bodies.length;
    const chatterIds: string[] = [];
    let vegId = '';
    let vegAt = 0;
    for (const line of DEMO_LINES.chatter) {
      const { message, sentAt } = await say(line);
      chatterIds.push(message.message_id);
      if (line.fact) {
        vegSeq = message.seq;
        vegId = message.message_id;
        vegMessageId = vegId;
        vegAt = sentAt;
      }
    }
    // Q5 (a fact) and Q7 (a ✅) sure at once: P2 reacts inside the message hook, before any notes-pass timer.
    const tick = await fake().waitFor(
      () => fake().writes.find((w) => w.method === 'add_reaction' && w.applied && w.params['message_id'] === vegId && w.params['emoji'] === '✅') ?? null,
      2_000,
    );
    took.push({ beat: 'noted', ms: Date.parse(tick.at) - vegAt });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(go().filter((m) => m.seq > from)).toEqual([]);
    expect(typingOf(fake()).filter((t) => t.on && t.at >= startedAt)).toEqual([]);
    expect(director.bodies.length).toBe(asked);
    expect(vegSeq).toBeGreaterThan(from);
    // Only the veg line is a fact worth a ✅: the dates line and the photo get nothing.
    expect(reactionsOn(chatterIds)).toEqual([[vegId, '✅']]);
  }, 20_000);

  it('0:30 flights: typing in under half a second, then a flights card, every flight after 6 pm', async () => {
    chapter('0:30 Flights');
    const { message, sentAt } = await say(DEMO_LINES.flights);
    const typing = await waitTyping(fake(), true, sentAt, 2_000);
    expect(typing.at - sentAt).toBeLessThan(500);
    const posted = await goAfter(message.seq, kindIs('options'));
    mark('flights', posted, sentAt);
    expect(posted.text).toBe(W.flights);
    const card = posted.card as Card<'options'>;
    expect(card.option_kind).toBe('flight');
    expect(card.options.length).toBeGreaterThan(0);
    for (const o of card.options) expect(o.journey?.depart_at.slice(11, 16) ?? '', o.title).toMatch(/^(1[89]|2[0-3]):/);
  }, 30_000);

  it("0:45 the villa job: \"On it\" with a working card that ticks, and at 0:50 Watch opens the trip's computer", async () => {
    chapter('0:45 The villa job, and Watch');
    const before = d().v1.tasks.size;
    const { message, sentAt } = await say(DEMO_LINES.villa);
    villaSentAt = sentAt;
    const posted = await goAfter(message.seq, kindIs('working'));
    mark('villa_start', posted, sentAt);
    expect(posted.text).toBe(W.villaStarted);
    expect(posted.card).toMatchObject({ state: 'running' });
    workingId = (posted.card as Card<'working'>).card_id;
    await fake().waitFor(() => (d().v1.tasks.size > before ? true : null), 10_000);
    v1TaskId = d().v1.lastTask()?.id ?? '';
    act(Date.now(), "The trip's computer (simulated)", 'reports progress: searched stays in North Goa, keeping villas with a pool');
    d().v1.progress(v1TaskId, [['Search stays in North Goa', 'completed'], ['Keep villas with a pool', 'in_progress']]);
    await fake().waitFor(
      () => ((cardNow(workingId) as Card<'working'> | null)?.steps.some((s) => s.text === 'Keep villas with a pool' && s.state === 'doing') ? true : null),
      10_000,
    );
    expect(await tap(workingId, 'watch', DEMO_FRIEND)).toMatchObject({ result: 'open', url: expect.stringMatching(/^https:\/\//) });
  }, 30_000);

  it('1:00 the call cue while the job browses: one line naming who and why, with 30 seconds to say stop', async () => {
    chapter('1:00 The call, announced while the job runs');
    const { message, sentAt } = await say(DEMO_LINES.call);
    callCueSentAt = sentAt;
    const line = await goAfter(message.seq, (m) => !m.card && (m.text ?? '').endsWith(STOP_LINE));
    mark('call_line', line, sentAt);
    callLine = line;
    expect(line.text).toBe(`${W.callAnnounce} ${STOP_LINE}`);
    // Nothing is dialled yet, and the villa job keeps browsing.
    expect(d().twilio.calls).toEqual([]);
    expect(jobState()).toBe('running');
  }, 20_000);

  it('1:10 the weather is answered at once, while the job browses and the call waits out its 30 seconds', async () => {
    chapter('1:10 The weather');
    const { message, sentAt } = await say(DEMO_LINES.weather);
    const reply = await goAfter(message.seq, (m) => m.text === W.weather);
    mark('weather', reply, sentAt);
    expect(jobState()).toBe('running');
    // Still inside the stop window: the weather line is not a "stop", and nothing has been dialled.
    expect(d().twilio.calls).toEqual([]);
    expect(go().filter(kindIs('call'))).toEqual([]);
  }, 20_000);

  it('1:30 the call dials the dive shop about 30 seconds after the line, talks, and the outcome lands in the chat and the record', async () => {
    chapter('1:30 The call');
    const line = callLine;
    if (!line) throw new Error('no call line');
    const posted = await fake().waitFor(
      () => fake().writes.find((w) => w.method === 'post_message' && w.applied && (w.params as { card?: { kind?: string } }).card?.kind === 'call') ?? null,
      45_000,
    );
    const callCard = (posted.params as { card: Card<'call'> }).card;
    const dialAt = Date.parse(posted.at);
    expect(callCard).toMatchObject({ state: 'dialing', business: DEMO_CALLEE.name });
    expect(dialAt - Date.parse(line.sent_at)).toBeGreaterThanOrEqual(29_000);
    expect(dialAt - callCueSentAt).toBeLessThanOrEqual(35_000);
    took.push({ beat: 'call', ms: dialAt - callCueSentAt });
    // Only the allowlisted number is ever dialled. P6 posts the dialing card before it asks Twilio, so wait for the dial,
    // and time the dial itself: nothing may ring before the 30 s stop window is over.
    await fake().waitFor(() => (d().twilio.calls.length > 0 ? true : null), 5_000).catch(() => null);
    expect(d().twilio.calls.map((c) => c.to)).toEqual([DEMO_CALLEE.phone]);
    expect((d().twilio.calls[0]?.at ?? 0) - Date.parse(line.sent_at)).toBeGreaterThanOrEqual(29_000);
    mark('call_card', await goAfter(line.seq, (m) => m.card?.card_id === callCard.card_id));
    await fake().waitFor(() => ((cardNow(callCard.card_id) as Card<'call'> | null)?.state === 'ended' ? true : null), 40_000);
    expect(cardNow(callCard.card_id)).toMatchObject({ state: 'ended', outcome: CALL_OUTCOME });
    mark('call_outcome', await goAfter(line.seq, (m) => m.text === CALL_OUTCOME));
    // P6 writes the record line right after the outcome line, so it can land a moment later.
    const records = (): string[] => fake().writes.filter((w) => w.method === 'add_record_line' && w.applied).map((w) => (w.params as { text: string }).text);
    await fake().waitFor(() => (records().includes(CALL_RECORD) ? true : null), 5_000).catch(() => null);
    expect(records()).toContain(CALL_RECORD);
    // The REST hang-up runs beside the end of the call, so the ended card can land first.
    await fake().waitFor(() => (d().twilio.hangUps.length > 0 ? true : null), 5_000).catch(() => null);
    expect(d().twilio.hangUps).toHaveLength(1);
    // The villa job browsed through the whole call.
    expect(jobState()).toBe('running');
  }, 120_000);

  it("2:20 the job comes back: three villas as an options card that is the group's vote, bookable at their whole-stay prices", async () => {
    chapter('2:20 The villas, and the vote');
    const from = lastSeq();
    // The job searches Go's stays first, as the real one does: Go keeps what it showed for the trip.
    act(Date.now(), "The trip's computer (simulated)", "searches Go's stays for North Goa, 6 to 9 Nov, five people, with a pool");
    const searched = await searchAsTheJob({ goUrl: d().goUrl, token: armedToken(d().v1, fake().trip().trip_id), tool: 'search_stays', args: DEMO_STAY_SEARCH });
    for (const v of DEMO_VILLAS.options) expect(searched.results.find((r) => r.offer_id === v.offer_id)?.total_paise, v.title).toBe(v.total_paise);
    act(Date.now(), "The trip's computer (simulated)", 'finishes the job: three villas');
    d().v1.complete(v1TaskId, DEMO_VILLAS, 'Found three villas.');
    const shown = await goAfter(from, (m) => m.card?.kind === 'options' && (m.card as Card<'options'>).option_kind === 'stay');
    mark('villa_done', shown, villaSentAt);
    expect(shown.text).toBe(W.villasShown);
    const card = shown.card as Card<'options'>;
    expect(card.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    // The same path as the real flow: each option is the fake ixigo offer the job picked, at the whole stay.
    const offers = await Promise.all(card.options.map((o) => d().room.built.brain.travel!.offer(o.option_id)));
    expect(offers.map((o) => [o?.offerId, o?.priceMinor])).toEqual(DEMO_VILLAS.options.map((v) => [v.offer_id, v.total_paise]));
    // The card is the vote (rev 5 R5), opened with it: Vote on each option, no button of its own, and no vote card beside it.
    expect(card.actions ?? []).toEqual([]);
    expect(card.decision_id).toEqual(expect.any(String));
    expect(go().filter((m) => m.seq > from && m.card?.kind === 'vote')).toEqual([]);
    decisionId = card.decision_id!;
    const decision = fake().trip().decisions.find((x) => x.decision_id === decisionId);
    expect(decision?.options.map((o) => o.label)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(decision?.options.map((o) => o.price_minor)).toEqual(DEMO_VILLAS.options.map((v) => v.total_paise));
    // Each option names the card's option, the one the mandate and the pay card book.
    expect(decision?.options.map((o) => o.option_ref)).toEqual(card.options.map((o) => o.option_id));
    expect(cardNow(workingId)).toMatchObject({ state: 'done' });
  }, 30_000);

  it('2:30 all five vote and the vote closes: Go says who won, never who pays, and the card asks who books it for everyone', async () => {
    chapter('2:30 Everyone votes');
    const from = lastSeq();
    for (const person of DEMO_PEOPLE) {
      act(Date.now(), nameOf(person), 'votes for Villa Sol');
      await fake().vote(decisionId, person, 0);
    }
    await fake().waitFor(() => (fake().trip().decisions.find((x) => x.decision_id === decisionId)?.status === 'closed' ? true : null), 5_000);
    const won = await goAfter(from, (m) => m.card?.card_id === `c_claim_${decisionId}`);
    mark('claim', won);
    expect(won.text).toBe(W.villaWon);
    expect(won.card).toMatchObject({ kind: 'notice', title: 'One person books for all', actions: [{ action_id: 'claim', label: "I'll book it" }] });
    expect(fake().trip().decisions.find((x) => x.decision_id === decisionId)?.mandate ?? null).toBeNull();
  }, 30_000);

  it('2:40 Rahul says he will book it: his ask is his claim, so Go says he books for all five and sets the mandate up to the "8k a head" said in the chat (₹40,000)', async () => {
    chapter('2:40 Rahul books for everyone, and the mandate');
    const from = lastSeq();
    const { sentAt } = await say(DEMO_LINES.claim);
    const mandate = await goAfter(from, kindIs('mandate'));
    mark('mandate', mandate, sentAt);
    expect(mandate.text).toBe(W.mandate);
    // The words are Go's own: set_mandate told the model who is booking, and the claim card now says so too.
    expect(director.results.find((r) => r.name === 'set_mandate')?.content).toContain("Rahul, you're booking for all 5.");
    expect(cardNow(`c_claim_${decisionId}`)).toMatchObject({ title: 'Rahul is booking for all 5', actions: [] });
    expect(DEMO_CAP_MINOR).toBe(4_000_000);
    expect(fake().trip().decisions.find((x) => x.decision_id === decisionId)?.mandate).toMatchObject({
      choice_index: 0, cap_minor: DEMO_CAP_MINOR, payer_person_id: DEMO_PAYER, refundable_only: false,
    });
  }, 30_000);

  it('2:50 "Yes, book it": the pay card, pinned to Rahul only', async () => {
    chapter('2:50 Yes, book it');
    const from = lastSeq();
    const t0 = Date.now();
    act(Date.now(), nameOf(DEMO_PAYER), 'taps "Yes, book it" on the mandate card');
    await fake().confirmMandate(decisionId);
    const pay = await goAfter(from, kindIs('pay'));
    mark('pay_card', pay, t0);
    payCard = pay.card as Card<'pay'>;
    expect(payCard).toMatchObject({ state: 'waiting', payer_person_id: DEMO_PAYER, for_person_ids: [DEMO_PAYER] });
    // The hold is Villa Sol's whole stay, the price the group voted on, and it sits inside the cap.
    expect(payCard.amount_minor).toBe(DEMO_VILLAS.options[0]!.total_paise);
    expect(payCard.amount_minor).toBeLessThanOrEqual(DEMO_CAP_MINOR);
  }, 30_000);

  it('3:00 Approve, Face ID on the vault page, the test card charged once: booked, a ticket and the split', async () => {
    chapter('3:00 Approve and pay');
    const card = payCard;
    if (!card) throw new Error('no pay card');
    const from = lastSeq();
    // Only the payer may approve: Priya's tap is refused for that, not because Go does not know the card.
    expect(await tap(card.card_id, 'approve', DEMO_FRIEND)).toMatchObject({ result: 'refused' });
    const open = await tap(card.card_id, 'approve', DEMO_PAYER);
    if (open.result !== 'open') throw new Error(`Approve did not open the vault: ${JSON.stringify(open)}`);
    act(Date.now(), nameOf(DEMO_PAYER), 'approves on the vault page with his passkey (a software passkey in the test), and the 4242 test card is charged on the fake rail');
    expect(await d().vault.approve(open.url, d().payer)).toMatchObject({ state: 'paid' });
    const booking = await fake().waitFor(() => fake().trip().bookings[0] ?? null, 10_000);
    expect(booking).toMatchObject({ approval_id: card.approval_id, decision_id: decisionId, kind: 'stay' });
    const expense = await fake().waitFor(() => fake().trip().expenses[0] ?? null, 10_000);
    expect(expense).toMatchObject({ paid_by_person_id: DEMO_PAYER, booking_id: booking.booking_id });
    mark('ticket', await goAfter(from, kindIs('ticket')));
    await fake().waitFor(() => ((cardNow(card.card_id) as Card<'pay'> | null)?.state === 'paid' ? true : null), 10_000);
    expect(d().vault.rail.charges).toHaveLength(1);
  }, 30_000);

  it('3:40 the operator fires a watch from the admin page: one notice, pinned to Arjun, labelled as simulated', async () => {
    chapter('3:40 The simulated watch');
    const from = lastSeq();
    const t0 = Date.now();
    act(t0, 'The operator', `fires a simulated watch from the admin page: ${DEMO_WATCH.label}, ${DEMO_WATCH.delay_minutes} minutes late, for ${nameOf(DEMO_WATCH.person_id)}`);
    const res = await fetch(`${d().goUrl}/admin/fire-watch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEMO_ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ trip_id: fake().trip().trip_id, ...DEMO_WATCH }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promoted: 1 });
    const notice = await goAfter(from, kindIs('notice'));
    mark('notice', notice, t0);
    expect(notice.card).toMatchObject({ for_person_ids: [DEMO_WATCH.person_id], source: { name: 'Simulated for the demo' } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(go().filter((m) => m.seq > from && m.card?.kind === 'notice')).toHaveLength(1);
  }, 30_000);

  for (const [beat, line] of [['refusal_en', DEMO_LINES.attackEn], ['refusal_hi', DEMO_LINES.attackHi]] as const) {
    it(`3:55 "${line.text}": a calm refusal, no pay card, no approval asked, nothing charged`, async () => {
      chapter(beat === 'refusal_en' ? '3:55 The refusal, in English' : '3:55 The refusal, in Hinglish');
      const spendBefore = fake().writes.filter((w) => w.method === 'request_spend_approval').length;
      const triedBefore = director.results.filter((r) => r.name === 'ask_to_pay').length;
      const { message, sentAt } = await say(line);
      const reply = await goAfter(message.seq, (m) => m.text === W.refusal);
      mark(beat, reply, sentAt);
      expect(go().filter((m) => m.seq > message.seq && m.card?.kind === 'pay')).toEqual([]);
      expect(fake().writes.filter((w) => w.method === 'request_spend_approval')).toHaveLength(spendBefore);
      expect(d().vault.rail.charges).toHaveLength(1);
      const tried = director.results.filter((r) => r.name === 'ask_to_pay').slice(triedBefore);
      expect(tried).toHaveLength(1);
      // Refused for the reason that holds here (nobody voted on scuba), not because something was down.
      expect(JSON.parse(tried[0]?.content ?? '{}')).toMatchObject({ refused: refusalWords('no_vote', { payer: 'Rahul', what: 'scuba' }).text });
    }, 30_000);
  }

  it("4:10 memory: what Meher can't eat, replying to the message where she said it, and who hasn't paid yet", async () => {
    chapter('4:10 Memory');
    const { message, sentAt } = await say(DEMO_LINES.memory);
    const reply = await goAfter(message.seq, (m) => (m.text ?? '').includes('vegetarian'));
    mark('memory', reply, sentAt);
    // Villa Sol's ₹38,400 split five ways: everyone but Rahul owes him ₹7,680.
    // The director cites "#N" as Go reads the chat; the number leaves the words, and the answer replies to her line instead.
    expect(reply.text).toBe("Meher is vegetarian, so no seafood shacks. Meher said so. Priya, Arjun, Meher and Kabir haven't paid Rahul back yet: ₹7,680 each.");
    expect(reply.reply_to).toBe(vegMessageId);
  }, 20_000);

  it('4:20 Meher taps "Forget me in this trip" in the App: Go forgets her inside 2 s, the group sees nothing, Meher gets one notice pinned to her, and queries find nothing left', async () => {
    chapter('4:20 Forget me, from the App');
    const tripId = fake().trip().trip_id;
    const meher = DEMO_FORGET.person;
    const memory = d().room.built.brain.memory;
    if (!memory) throw new Error('the memory lane is not registered');
    // Before: Go holds what Meher said at 0:15, with its proof.
    expect(await countFacts(d().room.db.pool, meher, tripId)).toBeGreaterThan(0);
    const before = lastSeq();
    // What the App and the Server do (interface note 11): forget_person to Go, then her join answers cleared.
    const t0 = Date.now();
    act(t0, nameOf(meher), 'taps "Forget me in this trip" in the App, and the Server sends Go forget_person');
    const res = await fake().forgetPerson(meher, tripId);
    took.push({ beat: 'forget', ms: Date.now() - t0 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.remaining_facts).toBe(0);
    expect(res.deleted_facts).toBeGreaterThanOrEqual(1);
    // Checked by queries, not by trust: no fact row, nothing on her page for this trip, no recall hit on her old line.
    expect(await countFacts(d().room.db.pool, meher, tripId)).toBe(0);
    const page = PersonPage.parse(await fake().askGo('get_person', { person_id: meher }));
    expect(page.facts.filter((f) => f.trip_id === tripId)).toEqual([]);
    const hits = await memory.recall(tripId, "What can't Meher eat? veg", 'group');
    expect(hits.map((h) => h.seq)).not.toContain(vegSeq);
    // Forgetting is the App's job: the group sees nothing about it, and Meher alone gets one notice pinned to her that
    // names nobody (people.ts forgetNotice).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = go().filter((m) => m.seq > before);
    const onlyMeher = (m: (typeof after)[number]): boolean =>
      !m.text && m.card?.kind === 'notice' && m.card.for_person_ids?.length === 1 && m.card.for_person_ids[0] === meher;
    expect(after.filter((m) => !onlyMeher(m))).toEqual([]);
    expect(after.filter(onlyMeher)).toHaveLength(1);
  }, 20_000);

  it("the beats landed in the run sheet's order, each of Go's writes was done once, and nothing Go sent has a dash", () => {
    expect(seqs.map(([beat]) => beat)).toEqual([
      'greeting', 'flights', 'villa_start', 'call_line', 'weather', 'call_card', 'call_outcome', 'villa_done', 'claim', 'mandate', 'pay_card', 'ticket',
      'notice', 'refusal_en', 'refusal_hi', 'memory',
    ]);
    for (let k = 1; k < seqs.length; k++) expect(seqs[k]?.[1] ?? 0, seqs[k]?.[0]).toBeGreaterThan(seqs[k - 1]?.[1] ?? 0);
    const ids = new Set(fake().writes.map((w) => w.request_id).filter((id): id is string => typeof id === 'string' && id !== ''));
    for (const id of ids) expect(appliedCount(fake(), id), id).toBeLessThanOrEqual(1);
    expect(JSON.stringify(fake().writes.map((w) => w.params))).not.toMatch(/[\u2014\u2013]/);
    console.table(took.map((t) => ({ beat: t.beat, seconds: (t.ms / 1000).toFixed(2) })));
  });

  it('writes the transcript, and the committed one matches this run apart from the times', () => {
    const run = process.env['GITHUB_RUN_ID'];
    const text = renderTranscript({
      messages: fake().messages(), people: fake().trip().people, acts, beats, beatOf, took,
      runUrl: run ? `${process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${process.env['GITHUB_REPOSITORY'] ?? 'vestra-ai/go-brain'}/actions/runs/${run}` : null,
      at: new Date(),
    });
    mkdirSync(dirname(WRITE_TO), { recursive: true });
    writeFileSync(WRITE_TO, text);
    expect(text).not.toMatch(/[\u2014\u2013]/);
    // When this run regenerates the committed file there is nothing to compare it with.
    if (WRITE_TO === COMMITTED || !existsSync(COMMITTED)) return;
    expect(
      rowsOfFile(readFileSync(COMMITTED, 'utf8')),
      "docs/demo/transcript.md is out of date: run `pnpm --filter @go/bench demo-transcript`, or copy demo-transcript.md from this run's bench-report artifact",
    ).toEqual(rowsOfFile(text));
  });
});
