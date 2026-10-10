/**
 * Memory's wiring into Go: sets brain.memory, answers the Server's people and catch-up requests, gives the composer
 * its tools and right-now blocks, hands P1's context the story so far, keeps the record copy and the facts in step
 * with events, and runs the notes pass and the fold off the reply path:
 *  - at once when Jev is sure a message holds a fact or a record line (or would get a ✅);
 *  - 2 s after Go posts (the after-turn pass);
 *  - after a quiet spell (20 s, at most 60 s in a busy chat) for everything else;
 *  - the fold right after Go posts, and after 60 s of quiet (at most 10 minutes in a busy chat);
 *  - a sweep every 5 minutes that finishes anything a restart dropped.
 * A sure 👍 or 🙌 from the reflex is sent with add_reaction without any model, 3 s later unless the line is part of a burst to
 * Go. A sure ✅ on a message Jev is also sure holds a fact (Q7 and Q5) is sent inside the hook, before the notes pass, which
 * stays the fallback.
 * The side passes run on brain.anthropic (the client buildBrain was given) with SIDE_MODEL. That client
 * does not retry; a failed pass keeps its cursor and the next quiet spell or sweep runs it again.
 */
import type { Brain, RegisterLane } from '../app.js';
import type { Message, TripEvent } from '../door/methods.js';
import { createJev, type JevClient } from '../reflex/jev.js';
import type { ReflexRead } from '../reflex/reflex.js';
import { inBurstToGo } from '../trips/names-go.js';
import type { TripPack } from '../trips/pack.js';
import { catchUpHandler } from './catch-up.js';
import { createMemory } from './create-memory.js';
import { dropFactsFromMessage, forgottenUpTo } from './facts.js';
import { settleDecisionLines } from './decision-lines.js';
import { createFold } from './fold.js';
import { syncJoinFacts } from './join-facts.js';
import { createNotes } from './notes.js';
import { peopleNow, recordNow } from './now.js';
import { forgotElsewhereNow } from './forget-elsewhere.js';
import { peopleHandlers } from './people.js';
import { reactOnce } from './reactions.js';
import { mirrorLine, mirrorSnapshot } from './record.js';
import { createDebouncer, realTimers, type Timers } from './schedule.js';
import { anthropicSideModel } from './side-model.js';
import { memoryTools } from './tools.js';

/** No model here: the side model is built from brain.anthropic, where tests and the bench put their fake. */
export interface WireDeps {
  /** Catch-up's ranking client. */
  jev: Pick<JevClient, 'ask'>;
  timers: Timers;
  clock: () => number;
}

const JOIN_FIELDS = new Set(['from_city', 'earliest_leave', 'know']);
const AFTER_POST_MS = 2_000;
/** A quiet 👍 or 🙌 waits this long: a burst's next line comes within a second or two (the intake waits 2 s for it). */
const QUIET_HOLD_MS = 3_000;
const NOTES_LONGEST_WAIT_MS = 60_000;
const FOLD_LONGEST_WAIT_MS = 10 * 60_000;
const ACTIVE_FOR_MS = 6 * 60 * 60_000;

export function wireMemory(brain: Brain, d: WireDeps): {
  onEvent(ev: TripEvent): Promise<void>;
  onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<void>;
  /** The trips it started a notes pass and a fold for. */
  sweep(): Promise<string[]>;
  /** Clears every quiet and after-post timer; registerMemory hands it to brain.onStop. */
  stop(): void;
} {
  const env = brain.env;
  const memory = createMemory({ pool: brain.pool, packs: brain.packs });
  brain.memory = memory;
  const side = anthropicSideModel(brain.anthropic, env.SIDE_MODEL, brain.log, brain.budget);
  const notes = createNotes({
    pool: brain.pool, packs: brain.packs, link: brain.door.link, side, log: brain.log, now: brain.now, travel: () => brain.travel,
  });
  const fold = createFold({
    pool: brain.pool, packs: brain.packs, side, log: brain.log, now: brain.now,
    foldAtTokens: env.FOLD_AT_TOKENS, storyTokens: env.STORY_TOKENS, hardCapTokens: env.CHAT_HARD_CAP_TOKENS,
  });
  const debounce = createDebouncer(d.timers, d.clock);
  const lastHeard = new Map<string, number>();

  for (const t of memoryTools({ pool: brain.pool, memory })) brain.tools.register(t);
  brain.context.addNow(recordNow({ pool: brain.pool, packs: brain.packs }));
  brain.context.addNow(peopleNow({ memory, packs: brain.packs }));
  brain.context.addNow(forgotElsewhereNow({ pool: brain.pool, packs: brain.packs }));
  // P1's Context.setStory (master §6.3) puts the story before the chat chunks and starts the chat at
  // chatFromSeq. The check only guards a context built without it (a lane-only test double).
  if (typeof brain.context.setStory === 'function') brain.context.setStory(fold);
  else brain.log.warn({}, 'context has no setStory: long trips are not folded in the prompt');
  // Forget me reaches the composer's chat: a forgotten person's earlier lines are hidden and "right now" names them.
  brain.context.setForgotten({ get: (tripId) => forgottenUpTo(brain.pool, tripId) });

  const people = peopleHandlers({
    pool: brain.pool, packs: brain.packs, fold, now: brain.now, log: brain.log,
    // Travel registers after memory, so the login is read when a forget runs.
    loginGone: async (tripId, personId) => brain.ixigoLogin?.personGone(tripId, personId, 'forgot'),
    // The person is told on a card pinned to them; the room hears nothing.
    tellPerson: async (tripId, _personId, card) => {
      await brain.door.link.request('post_message', { request_id: `go_${card.card_id}`, trip_id: tripId, card });
    },
  });
  brain.door.handle('get_person', people.get_person);
  brain.door.handle('update_person', people.update_person);
  brain.door.handle('delete_fact', people.delete_fact);
  brain.door.handle('forget_person', people.forget_person);
  brain.door.handle(
    'catch_up',
    catchUpHandler({ pool: brain.pool, packs: brain.packs, jev: d.jev, log: brain.log, jevOn: () => brain.switches.get('REFLEX_LIVE') !== 'off' && (brain.budget?.allows() ?? true) }),
  );

  const runNotes = (tripId: string, only?: string[]): void => {
    notes.run(tripId, only ? { only } : {}).catch((err: unknown) => brain.log.warn({ tripId, err: String(err) }, 'notes pass failed'));
  };
  const runFold = (tripId: string): void => {
    fold.maybeFold(tripId).catch((err: unknown) => brain.log.warn({ tripId, err: String(err) }, 'fold failed'));
  };
  const foldWhenQuiet = (tripId: string): void =>
    debounce.after(`fold:${tripId}`, env.FOLD_QUIET_MS, () => runFold(tripId), FOLD_LONGEST_WAIT_MS);

  async function onEvent(ev: TripEvent): Promise<void> {
    try {
      switch (ev.type) {
        case 'trip.created':
          await mirrorSnapshot(brain.pool, ev.data.trip);
          for (const p of ev.data.trip.people) await syncJoinFacts(brain.pool, ev.trip_id, p);
          break;
        case 'record.changed':
          await mirrorLine(brain.pool, ev.trip_id, ev.data.line, ev.seq);
          break;
        case 'person.joined':
          await syncJoinFacts(brain.pool, ev.trip_id, ev.data.person);
          break;
        case 'person.updated':
          if (ev.data.changed.some((c) => JOIN_FIELDS.has(c))) await syncJoinFacts(brain.pool, ev.trip_id, ev.data.person);
          break;
        case 'message.deleted':
          await dropFactsFromMessage(brain.pool, ev.trip_id, ev.data.message_id);
          await fold.onDeleted(ev.trip_id, ev.data.message_id);
          break;
        case 'message.edited': {
          const m = ev.data.message;
          await dropFactsFromMessage(brain.pool, ev.trip_id, m.message_id);
          await fold.onDeleted(ev.trip_id, m.message_id);
          if (m.author.kind === 'person' && !m.withheld && !m.deleted) runNotes(ev.trip_id, [m.message_id]);
          break;
        }
        case 'decision.closed':
        case 'decision.cancelled':
        case 'mandate.set':
        case 'mandate.confirmed':
        case 'mandate.declined':
          // A vote that ended, or a mandate set, settles Go's open lines about it.
          await settleDecisionLines(brain.pool, brain.door.link, ev.trip_id, await brain.packs.get(ev.trip_id));
          break;
        case 'message.created':
          // Go just spoke: read the turn's new lines once the burst has landed, and fold now if the chat is past its
          // budget, so the next turn starts from the story (a busy chat may never give the quiet fold its minute).
          if (ev.data.message.author.kind === 'go') {
            debounce.after(`notes:${ev.trip_id}`, AFTER_POST_MS, () => runNotes(ev.trip_id));
            runFold(ev.trip_id);
          }
          break;
        default:
          break;
      }
    } catch (err) {
      brain.log.warn({ tripId: ev.trip_id, type: ev.type, err: String(err) }, 'memory could not apply an event');
    }
  }

  async function onRead(msg: Message, read: ReflexRead, pack: TripPack): Promise<void> {
    const tripId = pack.trip.trip_id;
    lastHeard.set(tripId, d.clock());
    const sureFact = read.fact.sure && read.fact.value === true;
    if (sureFact && read.reaction.sure && read.reaction.value === '✅') {
      // The instant ✅ (Q5 and Q7 both sure): started here, before the notes pass, and never awaited, so the trip's
      // queue moves on at once. Its request id comes from the trip, message and emoji, so the notes pass's own ✅ for
      // this message joins it or finds it done (a 409 also counts as done).
      reactOnce(brain.pool, brain.door.link, tripId, msg, '✅').catch((err: unknown) =>
        brain.log.warn({ tripId, err: String(err) }, 'instant ✅ failed; the notes pass will react'),
      );
    } else if (read.reaction.sure && (read.reaction.value === '👍' || read.reaction.value === '🙌')) {
      // It waits for the burst to land: an "ok" that opens an ask to Go ("ok", "@Go one thing", ...) is part of the ask,
      // and gets Go's answer, not a reaction.
      const emoji = read.reaction.value;
      d.timers.set(() => {
        void brain.packs
          .get(tripId)
          .then((now) => (inBurstToGo(msg, now) ? 'skipped' : reactOnce(brain.pool, brain.door.link, tripId, msg, emoji)))
          .catch((err: unknown) => brain.log.warn({ tripId, err: String(err) }, 'quiet reaction failed'));
      }, QUIET_HOLD_MS);
    }
    const noteNow =
      sureFact ||
      (read.recordKind.sure && read.recordKind.value !== null) ||
      (read.reaction.sure && read.reaction.value === '✅');
    if (noteNow) {
      debounce.cancel(`notes:${tripId}`);
      runNotes(tripId);
    } else {
      debounce.after(`notes:${tripId}`, env.NOTES_QUIET_MS, () => runNotes(tripId), NOTES_LONGEST_WAIT_MS);
    }
    foldWhenQuiet(tripId);
  }

  /**
   * Level-triggered: whatever a restart or a lost timer left, the next sweep finishes. Both passes are no-ops when there
   * is nothing to do. Returns the trips it started them for.
   */
  async function sweep(): Promise<string[]> {
    const now = d.clock();
    // Open lines a vote settled while an event was missed or Go was down.
    const due = await brain.pool.query<{ trip_id: string }>(
      `SELECT DISTINCT ld.trip_id FROM line_decisions ld
         JOIN record_lines rl ON rl.trip_id = ld.trip_id AND rl.line_id = ld.line_id AND rl.status = 'active'
         JOIN trips t ON t.trip_id = ld.trip_id AND t.gone_at IS NULL`,
    );
    for (const { trip_id } of due.rows) {
      try {
        await settleDecisionLines(brain.pool, brain.door.link, trip_id, await brain.packs.get(trip_id));
      } catch (err) {
        // One trip's failure (its pack, the socket) never stops the sweep; the next one tries again.
        brain.log.warn({ tripId: trip_id, err: String(err) }, 'open lines a vote settled: not marked done yet');
      }
    }
    // After a restart the map starts empty: the database says which trips were active lately, or still have
    // people's words the notes pass has not read.
    const waiting = await brain.pool.query<{ trip_id: string }>(
      `SELECT t.trip_id FROM trips t
         LEFT JOIN notes_cursor n ON n.trip_id = t.trip_id
        WHERE t.gone_at IS NULL
          AND (t.active_at > $1
           OR EXISTS (SELECT 1 FROM messages m
                       WHERE m.trip_id = t.trip_id AND m.person_id IS NOT NULL AND m.text IS NOT NULL AND m.seq > coalesce(n.seq, 0)))`,
      [new Date(now - ACTIVE_FOR_MS)],
    );
    for (const { trip_id } of waiting.rows) if (!lastHeard.has(trip_id)) lastHeard.set(trip_id, now - env.FOLD_QUIET_MS);
    // A trip the Server no longer has gets no notes pass and no fold, whatever Go heard from it before.
    const gone = await brain.pool.query<{ trip_id: string }>('SELECT trip_id FROM trips WHERE gone_at IS NOT NULL AND trip_id = ANY($1)', [
      [...lastHeard.keys()],
    ]);
    for (const { trip_id } of gone.rows) lastHeard.delete(trip_id);
    const ran: string[] = [];
    for (const [tripId, at] of lastHeard) {
      if (now - at > ACTIVE_FOR_MS) {
        lastHeard.delete(tripId);
        continue;
      }
      if (now - at < env.FOLD_QUIET_MS) continue;
      runNotes(tripId);
      runFold(tripId);
      ran.push(tripId);
    }
    return ran;
  }

  brain.tripLog.onEvent(onEvent);
  brain.hooks.onRead(onRead);
  return { onEvent, onRead, sweep, stop: () => debounce.cancelAll() };
}

export const registerMemory: RegisterLane = (brain) => {
  // Catch-up's ranking client; it never starts a keep-warm (registerReflex keeps the shared pool warm).
  const jev = createJev({ apiKey: brain.env.TYPESAFE_API_KEY, baseUrl: brain.env.TYPESAFE_BASE_URL, model: brain.env.JEV_MODEL });
  const wired = wireMemory(brain, { jev, timers: realTimers, clock: Date.now });
  const t = setInterval(() => {
    wired.sweep().catch((err: unknown) => brain.log.warn({ err: String(err) }, 'memory sweep failed'));
  }, 5 * 60_000);
  t.unref();
  brain.onStop(() => {
    clearInterval(t);
    wired.stop();
  });
};
