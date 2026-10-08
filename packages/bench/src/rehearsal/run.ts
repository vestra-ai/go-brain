/**
 * The live rehearsal. P0's FakeServer plays the Server and the five people of a fresh rehearsal trip against
 * brain-rehearsal (the second deployment of the same code, its own database) with its real model, Jev, /v1 and vault
 * (test mode), and times each beat of the run sheet, in its order and spacing: the call cue 15 s after the villa cue and
 * the weather 10 s after the call cue, so the stop window and the weather overlap the villa job as on stage. It never
 * runs on the stage Go, never touches the real trip, never pays (it declines the pay card after timing it), stops the
 * trip's jobs when it ends, and refuses to start when a call could reach someone outside the allowlist. With warm, it
 * only reads the stage Go's health for the real trip.
 */
import { parseArgs } from 'node:util';
import type * as C from '@go/contract';
import type { HealthJson } from '@go/brain/dist/admin/register.js';
import { STOP_LINE } from '@go/brain/dist/calls/service.js';
import { FakeServer, goaFreshTrip } from '@go/sim';
import { beatOf, clockMs, DEMO_DIVE_SHOP, DEMO_FORGET, DEMO_FRIEND, DEMO_LINES, DEMO_PEOPLE, DEMO_WATCH, type BeatId, type DemoLine } from '../scenarios/demo.js';
import { BeatTimer, preflight, secs, type BeatRun } from './sheet.js';

export const REHEARSAL_PHOTO_URL = 'https://cdn.go.example/rehearsal/beach.jpg';

export class RefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`The rehearsal will not run:\n- ${reasons.join('\n- ')}`);
  }
}

export interface RehearseOptions {
  /** brain-rehearsal for a full run; the stage Go only with warm. */
  go: string;
  /** Signs the simulator's socket; a full run only (warm opens no socket). */
  secret?: string;
  adminToken: string;
  /** The stage Go: read /admin/health.json?trip=<trip> and nothing else. */
  warm: boolean;
  /** With warm, the real trip whose computer the health check warms. */
  trip?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RehearseOutcome {
  tripId: string | null;
  runs: BeatRun[];
  warmed: boolean;
  health: HealthJson;
}

type Card<K extends C.Card['kind']> = Extract<C.Card, { kind: K }>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sleepUntil = (at: number): Promise<void> => sleep(Math.max(0, at - Date.now()));
const short = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const kind = (k: C.Card['kind']) => (m: C.Message): boolean => m.card?.kind === k;
const textOnly = (m: C.Message): boolean => !m.card && !!m.text;
/** Go's call line: its own words plus P6's stop notice. */
const isCallLine = (m: C.Message): boolean => textOnly(m) && (m.text ?? '').endsWith(STOP_LINE);

/** How long to wait for a beat before calling it missing: three times its budget, at least 20 s, at most 3 minutes. */
export function patienceMs(id: BeatId): number {
  return Math.min(180_000, Math.max(20_000, (beatOf(id).budgetMs ?? 0) * 3));
}

/** The time between two cues on the run sheet's clock, so a rehearsal spaces them as the stage does. */
export function cueGapMs(from: BeatId, to: BeatId): number {
  return clockMs(beatOf(to).time) - clockMs(beatOf(from).time);
}

/** A fresh trip every run: the Goa people, a new id and a title that says it is a rehearsal. */
export function rehearsalTrip(now: Date): C.TripSnapshot {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const local = new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 16);
  return { ...goaFreshTrip(), trip_id: `t_reh_${stamp}`, title: `Rehearsal ${local}` };
}

export async function readHealth(o: Pick<RehearseOptions, 'go' | 'adminToken' | 'fetch' | 'trip'>): Promise<HealthJson> {
  const f = o.fetch ?? fetch;
  const q = o.trip ? `?trip=${encodeURIComponent(o.trip)}` : '';
  const res = await f(`${o.go}/admin/health.json${q}`, { headers: { authorization: `Bearer ${o.adminToken}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new RefusedError(['This Go has no admin page: set ADMIN_TOKEN on the brain service.']);
  if (res.status === 401) throw new RefusedError(['The admin token was refused.']);
  if (!res.ok) throw new RefusedError([`/admin/health.json answered HTTP ${res.status}.`]);
  return (await res.json()) as HealthJson;
}

async function adminPost(o: RehearseOptions, path: string, body: object): Promise<{ status: number; json: unknown }> {
  const f = o.fetch ?? fetch;
  const res = await f(`${o.go}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The rehearsal trip as the FakeServer sees it. */
class RehearsalRoom {
  constructor(readonly fake: FakeServer, readonly tripId: string) {}

  go(): C.Message[] {
    return this.fake.messages(this.tripId).filter((m) => m.author.kind === 'go');
  }
  lastSeq(): number {
    return this.fake.messages(this.tripId).at(-1)?.seq ?? 0;
  }
  card(cardId: string): C.Card | null {
    return this.go().find((m) => m.card?.card_id === cardId)?.card ?? null;
  }
  say(line: DemoLine): Promise<C.Message> {
    return this.fake.say(line.person, line.text, {
      tripId: this.tripId,
      ...(line.photoCaption ? { attachments: [{ kind: 'photo' as const, url: REHEARSAL_PHOTO_URL, caption: line.photoCaption }] } : {}),
    });
  }
  /** Go's first message after `seq` that matches. */
  waitGo(seq: number, pred: (m: C.Message) => boolean, ms: number): Promise<C.Message> {
    return this.fake.waitFor(() => this.go().find((m) => m.seq > seq && pred(m)) ?? null, ms);
  }
  spendAsks(): number {
    return this.fake.writes.filter((w) => w.trip_id === this.tripId && w.method === 'request_spend_approval').length;
  }
  /** When Go's reaction landed on a message (ms since 1970), or null. */
  reactedAt(messageId: string, emoji: string): number | null {
    const w = this.fake.writes.find(
      (x) => x.trip_id === this.tripId && x.method === 'add_reaction' && x.applied && x.params['message_id'] === messageId && x.params['emoji'] === emoji,
    );
    return w ? Date.parse(w.at) : null;
  }
  /** True once Go wrote a record line whose proof is this message (P6 cites the call card's message). */
  recordLineCiting(messageId: string): boolean {
    return this.fake.writes.some((w) => {
      if (w.trip_id !== this.tripId || w.method !== 'add_record_line' || !w.applied) return false;
      const proof = w.params['proof'];
      return Array.isArray(proof) && proof.some((p: unknown) => (p as { message_id?: unknown } | null)?.message_id === messageId);
    });
  }
}

/** Waits for a beat and records it: PASS inside its budget and when `check` finds nothing wrong. */
async function timed<T>(timer: BeatTimer, id: BeatId, startedAt: number, wait: (ms: number) => Promise<T>, check?: (v: T) => string | null): Promise<T | null> {
  const ms = patienceMs(id);
  try {
    const v = await wait(ms);
    const problem = check ? check(v) : null;
    timer.done(id, startedAt, problem === null ? {} : { ok: false, note: problem });
    return v;
  } catch {
    timer.miss(id, `nothing in ${secs(ms)}`);
    return null;
  }
}

/** 2:30 the vote, 2:50 "Yes, book it". The rehearsal never pays: the payer declines once the card is timed. */
async function payBeat(room: RehearsalRoom, timer: BeatTimer, villas: C.Message | null, log: (line: string) => void): Promise<void> {
  if (!villas?.card) {
    timer.miss('pay_card', 'not reached: no villa options to vote on');
    return;
  }
  let vote = room.go().find((m) => m.seq > villas.seq && m.card?.kind === 'vote') ?? null;
  if (!vote) {
    // Phone B taps "Put it to a vote" on the options card, as the run sheet says.
    await room.fake.tap(villas.card.card_id, 'vote', DEMO_FRIEND).catch(() => null);
    vote = await room.waitGo(villas.seq, kind('vote'), 15_000).catch(() => null);
  }
  if (!vote?.card || vote.card.kind !== 'vote') {
    timer.miss('pay_card', 'not reached: the villas were never put to a vote');
    return;
  }
  const decisionId = vote.card.decision_id;
  for (const person of DEMO_PEOPLE) await room.fake.vote(decisionId, person, 0);
  // One person books for all: the I'll book it card goes up with the result, and Rahul says it is him.
  const claim = await room.waitGo(vote.seq, (m) => m.card?.card_id === `c_claim_${decisionId}`, 30_000).catch(() => null);
  if (!claim) {
    timer.miss('pay_card', "not reached: no I'll book it card after the vote closed");
    return;
  }
  const claimed = await room.say(DEMO_LINES.claim);
  const mandate = await room.waitGo(claimed.seq, kind('mandate'), 30_000).catch(() => null);
  if (!mandate) {
    timer.miss('pay_card', "not reached: no mandate card after Rahul said he'd book it");
    return;
  }
  const t = Date.now();
  await room.fake.confirmMandate(decisionId);
  const pay = await timed(timer, 'pay_card', t, (ms) => room.waitGo(mandate.seq, kind('pay'), ms));
  if (pay?.card?.kind === 'pay') {
    const r = await room.fake.tap(pay.card.card_id, 'decline', pay.card.payer_person_id).catch(() => null);
    log(`The pay card was declined after timing: ${r?.result ?? 'no answer'}.`);
  }
}

/**
 * From the call card to 2:20: the call talks (the teammate playing the dive shop answers on speaker) until it ends, then
 * the outcome must be in the chat and in the record (a record line whose proof is the call card's message).
 */
async function callBeat(room: RehearsalRoom, timer: BeatTimer, callMessage: C.Message | null, log: (line: string) => void): Promise<void> {
  if (!callMessage?.card || callMessage.card.kind !== 'call') {
    timer.miss('call_outcome', 'not reached: the call never dialed');
    return;
  }
  const cardId = callMessage.card.card_id;
  const { seq, message_id: messageId } = callMessage;
  const ended = await room.fake
    .waitFor(() => {
      const state = (room.card(cardId) as Card<'call'> | null)?.state;
      return state === 'ended' || state === 'failed' ? state : null;
    }, 150_000)
    .catch(() => null);
  if (!ended) {
    await room.fake.tap(cardId, 'stop', DEMO_FRIEND).catch(() => null);
    timer.miss('call_outcome', 'the call was still live after 150 s, so the runner pressed Stop');
    return;
  }
  const outcome = (room.card(cardId) as Card<'call'> | null)?.outcome ?? '';
  log(`The call ${ended}: ${short(outcome || 'no outcome')}`);
  const said = (): boolean => outcome !== '' && room.go().some((m) => m.seq > seq && textOnly(m) && (m.text ?? '').startsWith(outcome));
  const recorded = (): boolean => room.recordLineCiting(messageId);
  // The outcome line and the record line follow the final card within a moment.
  await room.fake.waitFor(() => said() && recorded(), 10_000).catch(() => null);
  const problems = [
    ended === 'failed' ? 'the call failed' : null,
    said() ? null : 'no outcome line in the chat',
    recorded() ? null : 'no record line citing the call',
  ].filter((p): p is string => p !== null);
  timer.check('call_outcome', problems.length === 0, problems.length === 0 ? outcome : problems.join('; '));
}

/**
 * 4:20: Meher taps "Forget me in this trip" in the App. The runner does what the App and the Server do (the FakeServer's
 * forgetPerson: forget_person to Go, then her join answers cleared), times Go's answer against the App's 2 s, checks
 * nothing of hers is left, and that Go said nothing in the chat about it.
 */
async function forgetBeat(room: RehearsalRoom, timer: BeatTimer): Promise<void> {
  const before = room.lastSeq();
  const t = Date.now();
  const res = await room.fake.forgetPerson(DEMO_FORGET.person, room.tripId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const answeredAt = Date.now();
  if (res instanceof Error) {
    timer.miss('forget', `forget_person failed: ${short(res.message)}`);
    return;
  }
  // Go must stay quiet in the room: forgetting is the App's job.
  await sleep(2_000);
  const said = room.go().find((m) => m.seq > before);
  const problems = [
    res.remaining_facts === 0 ? null : `${res.remaining_facts} facts left`,
    said ? `Go said: ${short(said.text ?? said.card?.kind ?? 'a card')}` : null,
  ].filter((p): p is string => p !== null);
  timer.done('forget', t, problems.length === 0 ? { endedAt: answeredAt } : { endedAt: answeredAt, ok: false, note: problems.join('; ') });
}

async function playBeats(room: RehearsalRoom, timer: BeatTimer, o: RehearseOptions, log: (line: string) => void): Promise<void> {
  // Days ago, in the real trip: when a friend can leave. The flights card at 0:30 must honour it.
  for (const line of DEMO_LINES.history) {
    await room.say(line);
    await sleep(800);
  }
  await sleep(2_000);

  // 0:15 quiet through the chatter, and a quiet ✅ under the veg line (no ✅ is not a miss: the run sheet moves on)
  const quietFrom = room.lastSeq();
  let veg: { id: string; at: number } | null = null;
  for (const line of DEMO_LINES.chatter) {
    const at = Date.now();
    const said = await room.say(line);
    if (line.fact) veg = { id: said.message_id, at };
    await sleep(800);
  }
  await sleep(4_000);
  const spoke = room.go().filter((m) => m.seq > quietFrom);
  const ticked = veg ? room.reactedAt(veg.id, '✅') : null;
  const noted = veg && ticked !== null ? `✅ under the veg line in ${secs(Math.max(0, ticked - veg.at))}` : 'no ✅ under the veg line';
  timer.check(
    'quiet',
    spoke.length === 0,
    spoke.length === 0 ? `${DEMO_LINES.chatter.length} lines, Go said nothing; ${noted}` : `Go posted: ${short(spoke[0]?.text ?? spoke[0]?.card?.kind ?? 'a card')}`,
  );

  // 0:30 flights
  let t = Date.now();
  const flights = await room.say(DEMO_LINES.flights);
  await timed(timer, 'flights', t, (ms) => room.waitGo(flights.seq, kind('options'), ms));

  // 0:45 the villa job, 0:50 Watch
  const villaAt = Date.now();
  const villa = await room.say(DEMO_LINES.villa);
  const working = await timed(timer, 'villa_start', villaAt, (ms) => room.waitGo(villa.seq, kind('working'), ms));
  const workingId = working?.card?.card_id ?? null;
  if (workingId) {
    const watch = await room.fake.tap(workingId, 'watch', DEMO_FRIEND).catch(() => null);
    log(watch?.result === 'open' ? 'Watch: the live screen opened.' : `Watch: ${short(JSON.stringify(watch))}`);
  }
  const jobStillRunning = (): string | null => {
    if (!workingId) return null;
    const state = (room.card(workingId) as Card<'working'> | null)?.state;
    return state === 'running' || state === 'needs_you' ? null : `the villa job was ${state ?? 'gone'} when the answer came`;
  };

  // 1:00 the call cue, 15 s after the villa cue: one line naming who and why, then 30 s to say stop while the job browses
  await sleepUntil(villaAt + cueGapMs('villa_start', 'call_line'));
  log(`Calling ${DEMO_DIVE_SHOP.name}. The teammate answers: "${DEMO_DIVE_SHOP.answer}"`);
  const callAt = Date.now();
  const callCue = await room.say(DEMO_LINES.call);
  const announced = timed(timer, 'call_line', callAt, (ms) => room.waitGo(callCue.seq, isCallLine, ms));
  const dialing = timed(timer, 'call', callAt, (ms) => room.waitGo(callCue.seq, kind('call'), ms));

  // 1:10 the weather, 10 s after the call cue, answered at once while the job runs and the stop window is open
  await sleepUntil(callAt + cueGapMs('call_line', 'weather'));
  t = Date.now();
  const weather = await room.say(DEMO_LINES.weather);
  const answered = timed(timer, 'weather', t, (ms) => room.waitGo(weather.seq, (m) => textOnly(m) && !isCallLine(m), ms), jobStillRunning);
  const [, , callMessage] = await Promise.all([announced, answered, dialing]);

  // About 1:30 to 2:20: the call talks while the job browses; then the outcome, and the villas (budget from the villa cue)
  const [villas] = await Promise.all([
    timed(timer, 'villa_done', villaAt, (ms) =>
      room.waitGo(villa.seq, (m) => m.card?.kind === 'options' && (m.card as Card<'options'>).option_kind === 'stay', ms)),
    callBeat(room, timer, callMessage, log),
  ]);

  // 2:30 the vote, 2:50 "Yes, book it", the pay card (declined after timing: a rehearsal never pays)
  await payBeat(room, timer, villas, log);

  // 3:40 the simulated watch, fired the way the operator does
  const before = room.lastSeq();
  t = Date.now();
  const fired = await adminPost(o, '/admin/fire-watch', { trip_id: room.tripId, ...DEMO_WATCH });
  if (fired.status !== 200) timer.miss('notice', `the watch did not fire: HTTP ${fired.status}`);
  else {
    await timed(timer, 'notice', t, (ms) => room.waitGo(before, kind('notice'), ms), (m) => {
      const card = m.card as Card<'notice'>;
      if (card.source?.name !== 'Simulated for the demo') return 'the notice does not say "Simulated for the demo"';
      if (!(card.for_person_ids ?? []).includes(DEMO_WATCH.person_id)) return `the notice is not pinned to ${DEMO_WATCH.person_id}`;
      return null;
    });
  }

  // 3:55 the chat cannot talk Go into paying
  for (const [id, line] of [['refusal_en', DEMO_LINES.attackEn], ['refusal_hi', DEMO_LINES.attackHi]] as const) {
    const asks = room.spendAsks();
    t = Date.now();
    const said = await room.say(line);
    await timed(timer, id, t, (ms) => room.waitGo(said.seq, textOnly, ms), () => {
      if (room.spendAsks() > asks) return 'Go asked the Server for a spend approval';
      if (room.go().some((m) => m.seq > said.seq && m.card?.kind === 'pay')) return 'a pay card appeared';
      return null;
    });
  }

  // 4:10 memory: what Meher can't eat (with a link to her message), and who hasn't paid
  t = Date.now();
  const asked = await room.say(DEMO_LINES.memory);
  await timed(timer, 'memory', t, (ms) => room.waitGo(asked.seq, textOnly, ms), (m) => (/veg/i.test(m.text ?? '') ? null : 'the answer does not say veg'));

  // 4:20 "Forget me in this trip", from the App
  await forgetBeat(room, timer);
}

/** The stage Go before the demo: one health read for the real trip (it warms Jev, /v1, ixigo and that trip's computer). */
async function warmStage(o: RehearseOptions, log: (line: string) => void): Promise<RehearseOutcome> {
  if (!o.trip) throw new RefusedError(['--warm needs --trip <the real trip id>: the health read warms that trip\'s computer.']);
  // Nothing else touches the stage Go: no simulator socket, no rehearsal trip, no message (master §9).
  const health = await readHealth(o);
  for (const p of health.probes) log(`${p.dot.toUpperCase().padEnd(5)} ${p.label}: ${p.detail} (${p.ms} ms)`);
  return { tripId: null, runs: [], warmed: true, health };
}

export async function rehearse(o: RehearseOptions): Promise<RehearseOutcome> {
  const log = o.log ?? ((line: string) => console.log(line));
  const now = o.now ?? (() => new Date());
  if (o.warm) return warmStage(o, log);
  if (!o.secret) throw new RefusedError(['A full rehearsal connects as the Server: set GO_SIGNING_SECRET in the environment.']);
  const health = await readHealth(o);
  for (const p of health.probes) log(`${p.dot.toUpperCase().padEnd(5)} ${p.label}: ${p.detail} (${p.ms} ms)`);
  const reasons = preflight(health);
  if (reasons.length > 0) throw new RefusedError(reasons);

  const trip = rehearsalTrip(now());
  const fake = new FakeServer({ goUrl: o.go, secret: o.secret, instance: `rehearsal-${trip.trip_id.slice('t_reh_'.length)}` });
  await fake.start(15_000);
  const room = new RehearsalRoom(fake, trip.trip_id);
  const timer = new BeatTimer();
  try {
    await fake.createTrip(trip);
    await room.waitGo(0, (m) => !!m.text, 30_000);
    log(`Rehearsal trip ${trip.trip_id}: Go said hello.`);
    await playBeats(room, timer, o, log);
    return { tripId: trip.trip_id, runs: timer.results(), warmed: false, health };
  } finally {
    await adminPost(o, '/admin/stop-jobs', { trip_id: trip.trip_id }).catch(() => null);
    fake.stop();
  }
}

const bare = (url: string): string => url.replace(/\/+$/, '');

/**
 * Flags first, then the environment. A full run goes to GO_REHEARSAL_URL and never to GO_STAGE_URL; --warm goes to
 * GO_STAGE_URL and needs no secret. `--new-trip` is accepted: every run makes a fresh trip (interface note 6).
 */
export function parseRehearseArgs(argv: string[], env: Record<string, string | undefined>): RehearseOptions {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      go: { type: 'string' },
      secret: { type: 'string' },
      'admin-token': { type: 'string' },
      warm: { type: 'boolean' },
      'new-trip': { type: 'boolean' },
      trip: { type: 'string' },
    },
  });
  const warm = values.warm === true;
  const raw = values.go ?? (warm ? env['GO_STAGE_URL'] : env['GO_REHEARSAL_URL']);
  if (!raw) {
    throw new Error(warm
      ? 'Give --go <url> (or GO_STAGE_URL): the stage Go whose health read --warm makes.'
      : 'Give --go <url> (or GO_REHEARSAL_URL): brain-rehearsal, the Go a full rehearsal runs on.');
  }
  const go = bare(raw);
  const stage = env['GO_STAGE_URL'];
  if (!warm && stage && bare(stage) === go) {
    throw new Error('That is the stage Go (GO_STAGE_URL). Rehearsals never share it: give --go brain-rehearsal\'s URL, or use --warm for the health read.');
  }
  const secret = values.secret ?? env['GO_SIGNING_SECRET'];
  if (!warm && !secret) throw new Error('Set GO_SIGNING_SECRET in the environment (never on the command line): a full run connects as the Server.');
  const adminToken = values['admin-token'] ?? env['GO_ADMIN_TOKEN'];
  if (!adminToken) throw new Error('Set GO_ADMIN_TOKEN in the environment (never on the command line): the runner reads /admin/health.json first.');
  return {
    go,
    ...(!warm && secret ? { secret } : {}),
    adminToken,
    warm,
    ...(values.trip ? { trip: values.trip } : {}),
  };
}
