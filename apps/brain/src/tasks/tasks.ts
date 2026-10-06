/**
 * Tasks: big jobs on the trip's computer. start() saves the job, posts its working card and returns at once; the
 * hand-off to /v1 runs behind it (a fresh trip token, the trip's conversation, one message with hand_off: always),
 * so "On it" and the card reach the room within a second. At most three jobs run per trip; more wait as queued and
 * start in order as others end. message() answers an open question or hand-off, or passes the words on to the job.
 * stop() ends a job at once on the card and on /v1; a stopped job never posts results.
 */
import type * as C from '@go/contract';
import type { Brain } from '../app.js';
import type { ServerLink } from '../door/server-link.js';
import { clip } from '../travel/cards.js';
import { mintId, stableId } from '../travel/ids.js';
import type { CardUpdater } from './card-updater.js';
import type { Computer } from './computer.js';
import type { ReturnsKind } from './returns.js';
import { LIVE_STATES, type NewTask, type TaskRow, type TaskState, type TaskStore } from './store.js';
import { V1Error, type V1Client } from './v1-client.js';
import type { PlatformEvent } from './webhooks.js';
import { buildWorkingCard, plannedSteps, type WorkingCardT } from './working-card.js';

export const MAX_ACTIVE_PER_TRIP = 3;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
export const DEFAULT_DEADLINE_MS = 8 * 60_000;
/** While a job waits on a person, its deadline moves past the 10 minutes a question or hand-off may wait. */
export const WAITING_GRACE_MS = 11 * 60_000;

export interface TaskBrief {
  goal: string;
  /** JSON Schema for the answer: the job's output_schema. */
  returns: unknown;
  /** Only the trip facts the job needs. /v1 fences them as data. */
  context: Record<string, unknown>;
  title?: string;
  steps?: string[];
  successCriteria?: string;
  returnsKind?: ReturnsKind;
  /** The person who asked: a hand-off is pinned to them. */
  askedBy?: string;
  /** The same key starts one job, so a turn that runs again does not start a second. */
  key?: string;
  /** The working card's id: a turn passes ctx.stableId('c_work'). Otherwise one is made from the job's id. */
  cardId?: string;
  /** A turn's ctx.cards: the working card rides with the turn's message instead of being posted at once. */
  cards?: C.Card[];
}

export interface Tasks {
  start(tripId: string, brief: TaskBrief): Promise<{ taskId: string; cardId: string }>;
  message(taskId: string, text: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  running(tripId: string): Promise<Array<{ id: string; brief: string; state: string }>>;
  /** Added by P4: settles a hand-off the person did themselves, or could not do. */
  handoff(taskId: string, outcome: 'done' | 'could_not' | 'not_now'): Promise<void>;
}

/** What a task desk item carries; tasks/context.ts says how each reads in "why Go woke". */
export type TaskWake =
  | { event: 'completed'; taskId: string; title: string; resultsId: string | null; count: number; summary: string | null }
  | { event: 'failed'; taskId: string; title: string; reason: string }
  | { event: 'question'; taskId: string; title: string; interactionId: string; questions: Array<{ question: string; options: string[] }> }
  | { event: 'handoff'; taskId: string; title: string; interactionId: string; personId: string; summary: string }
  | { event: 'question_dropped'; taskId: string; title: string; question: string };

export class TaskError extends Error {
  constructor(readonly code: 'unknown_task' | 'not_live' | 'not_started' | 'no_handoff', message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface TasksDeps {
  store: TaskStore;
  v1: V1Client;
  computer: Computer;
  cards: CardUpdater;
  link: Pick<ServerLink, 'request'>;
  desk: Brain['desk'];
  packs: Pick<Brain['packs'], 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /** Told when a job reached a conversation, so the follower opens its stream. */
  follow: (conversationId: string, tripId: string) => void;
  deadlineMs?: number;
}

export interface TasksService extends Tasks {
  dispatch(taskId: string): Promise<void>;
  /** Maps task starts /v1 announced to their jobs; a job stopped before it was named is stopped on /v1 now. */
  mapStarts(): Promise<void>;
  startQueued(tripId: string): Promise<void>;
  /** After a job ends: tokens go when nothing runs, and the next waiting job starts. */
  afterEnd(tripId: string): Promise<void>;
  /** Ends a live job as "Didn't work", with one line for the composer. */
  fail(row: TaskRow, endReason: string, reason: string): Promise<void>;
  /** Stops a live job on /v1 and ends it as "Didn't work" (a deadline, a hand-off nobody answered). */
  expire(taskId: string, endReason: 'deadline' | 'handoff_expired', reason: string): Promise<void>;
  cardFor(row: TaskRow): Promise<WorkingCardT>;
  pushCard(row: TaskRow, urgent: boolean): Promise<void>;
  stopV1(v1TaskId: string): Promise<void>;
  /** Names a job /v1 started without Go hearing it, from /v1's task.started events for the trip's user since the job was made. */
  findStart(row: TaskRow): Promise<void>;
  /** Waits for every hand-off running in the background. */
  settled(): Promise<void>;
}

export function createTasks(d: TasksDeps): TasksService {
  const deadlineMs = d.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };
  const isLive = (state: TaskState): boolean => LIVE_STATES.includes(state);

  async function live(taskId: string): Promise<TaskRow> {
    const row = await d.store.get(taskId);
    if (!row) throw new TaskError('unknown_task', `There is no job ${taskId}.`);
    if (!isLive(row.state)) throw new TaskError('not_live', `That job has ended (${row.state}).`);
    return row;
  }

  /** Stops a job on /v1: by its task id, or, when Go never heard /v1 name it, by looking its start up (mapStarts then stops it). */
  async function stopOnV1(row: TaskRow): Promise<void> {
    if (row.v1TaskId) return service.stopV1(row.v1TaskId);
    if (!row.v1TurnId) return;
    await service.findStart(row).catch((err: unknown) => d.log.warn({ err, taskId: row.id }, "tasks: looking up a stopped job's start failed; the sweep tries again"));
  }

  async function backToWork(row: TaskRow): Promise<void> {
    if (await d.store.transition(row.id, ['needs_you'], 'running', { needsPersonId: null })) {
      const fresh = await d.store.get(row.id);
      if (fresh) await service.pushCard(fresh, true);
    }
  }

  const service: TasksService = {
    async start(tripId, brief) {
      const id = brief.key ? stableId('gt', tripId, brief.key) : mintId('gt');
      const known = await d.store.get(id);
      if (known) {
        // A rerun of the same turn: the card rides with the rerun's message too.
        if (brief.cards && !brief.cards.some((c) => c.card_id === known.cardId)) brief.cards.push(await service.cardFor(known));
        return { taskId: known.id, cardId: known.cardId };
      }
      const now = d.now();
      const state: TaskState = (await d.store.countActive(tripId)) >= MAX_ACTIVE_PER_TRIP ? 'queued' : 'starting';
      const row: NewTask = {
        id,
        tripId,
        title: clip(brief.title ?? brief.goal, 80),
        goal: brief.goal,
        returnsKind: brief.returnsKind ?? 'custom',
        returns: brief.returns,
        context: brief.context,
        successCriteria: brief.successCriteria ?? null,
        askedBy: brief.askedBy ?? null,
        state,
        cardId: brief.cardId ?? `c_work_${id.slice(3)}`,
        steps: plannedSteps(brief.steps),
        deadlineAt: state === 'starting' ? new Date(now.getTime() + deadlineMs) : null,
        createdAt: now,
      };
      if (!(await d.store.insert(row))) {
        const again = await d.store.get(id);
        if (again) return { taskId: again.id, cardId: again.cardId };
      }
      const saved = await d.store.get(id);
      if (!saved) throw new TaskError('unknown_task', `The job ${id} was not saved.`);
      if (brief.cards) {
        brief.cards.push(await service.cardFor(saved));
      } else {
        try {
          const posted = await d.link.request('post_message', { trip_id: tripId, request_id: `go_task_${id}_card`, card: await service.cardFor(saved) });
          await d.store.update(id, { messageId: posted.message_id });
        } catch (err) {
          // No card, no job: a job the room cannot see must not run.
          await d.store.transition(id, ['starting', 'queued'], 'failed', { endedAt: d.now(), endReason: 'card_failed', error: 'The working card could not be posted.' });
          throw err;
        }
      }
      if (state === 'starting') track(service.dispatch(id));
      return { taskId: id, cardId: row.cardId };
    },

    async dispatch(taskId) {
      const row = await d.store.get(taskId);
      if (!row || row.state !== 'starting' || row.stopRequestedAt) return;
      try {
        await d.computer.armToken(row.tripId);
        const { conversationId } = await d.computer.conversation(row.tripId);
        const turn = await d.v1.call<{ id: string }>('POST', `/v1/conversations/${conversationId}/messages`, {
          idempotencyKey: `go-msg-${row.id}`,
          body: {
            message: row.goal,
            context: row.context,
            output_schema: row.returns,
            ...(row.successCriteria ? { success_criteria: row.successCriteria } : {}),
            hand_off: 'always',
            metadata: { go_task_id: row.id },
          },
        });
        await d.store.setTurn(row.id, conversationId, turn.id);
        await service.mapStarts();
        d.follow(conversationId, row.tripId);
      } catch (err) {
        d.log.warn({ err, taskId }, "tasks: handing the job to the trip's computer failed");
        const reason = err instanceof V1Error && err.code === 'wallet_empty' ? "Go's account for the trip's computer is out of credit." : "It could not start on the trip's computer.";
        await service.fail(row, 'dispatch_failed', reason);
      }
    },

    async mapStarts() {
      for (const m of await d.store.matchStarts()) {
        const row = await d.store.get(m.id);
        if (!row) continue;
        if (row.stopRequestedAt) {
          await service.stopV1(m.v1TaskId);
          continue;
        }
        if (await d.store.transition(row.id, ['starting'], 'running', { startedAt: d.now() })) {
          const fresh = await d.store.get(row.id);
          if (fresh) await service.pushCard(fresh, false);
        }
      }
    },

    async startQueued(tripId) {
      while ((await d.store.countActive(tripId)) < MAX_ACTIVE_PER_TRIP) {
        const next = await d.store.oldestQueued(tripId);
        if (!next) return;
        if (!(await d.store.transition(next.id, ['queued'], 'starting', { deadlineAt: new Date(d.now().getTime() + deadlineMs) }))) continue;
        const fresh = await d.store.get(next.id);
        if (fresh) await service.pushCard(fresh, true);
        track(service.dispatch(next.id));
      }
    },

    async afterEnd(tripId) {
      if ((await d.store.countActive(tripId)) === 0) await d.computer.releaseTokens(tripId);
      await service.startQueued(tripId);
    },

    async fail(row, endReason, reason) {
      if (!(await d.store.transition(row.id, LIVE_STATES, 'failed', { endedAt: d.now(), endReason, error: clip(reason, 300), needsPersonId: null }))) return;
      const fresh = await d.store.get(row.id);
      if (fresh) await service.pushCard(fresh, true);
      const wake: TaskWake = { event: 'failed', taskId: row.id, title: row.title, reason: clip(reason, 200) };
      await d.desk.put({ id: `task:${row.id}:failed`, tripId: row.tripId, kind: 'task', ref: row.id, dueAt: d.now(), payload: wake });
      await service.afterEnd(row.tripId);
    },

    async expire(taskId, endReason, reason) {
      const row = await d.store.get(taskId);
      if (!row || !isLive(row.state)) return;
      await d.store.update(taskId, { stopRequestedAt: d.now() });
      const open = await d.store.openInteractions(taskId);
      // The job ends in Go first, so the task.stopped /v1 sends back (on the stream, at once) finds it ended and
      // changes nothing: the card says "Didn't work", never "Stopped".
      await service.fail(row, endReason, reason);
      for (const i of open) {
        await d.v1.call('POST', `/v1/interactions/${i.interactionId}/cancel`, { body: { reason: 'Nobody could answer in time.' } }).catch(() => undefined);
        await d.store.setInteraction(i.interactionId, 'cancelled', d.now());
      }
      await stopOnV1(row);
    },

    async message(taskId, text) {
      const row = await live(taskId);
      const open = await d.store.openInteractions(taskId);
      const ask = open.find((i) => i.type === 'question') ?? open.find((i) => i.type === 'handoff');
      if (ask) {
        const words = text.slice(0, 4000);
        const answers = ask.type === 'question' && ask.questions.length > 1 ? ask.questions.map(() => words) : [words];
        await d.v1.call('POST', `/v1/interactions/${ask.interactionId}/answer`, { body: { answers } });
        await d.store.setInteraction(ask.interactionId, 'answered', d.now());
        if (ask.type === 'handoff') await backToWork(row);
        return;
      }
      if (!row.conversationId) throw new TaskError('not_started', 'That job has not reached the computer yet. Try again in a moment.');
      await d.v1.call('POST', `/v1/conversations/${row.conversationId}/messages`, {
        idempotencyKey: stableId('go-follow', taskId, text),
        body: { message: `About the job "${row.title}"${row.v1TaskId ? ` (${row.v1TaskId})` : ''}: ${text.slice(0, 4000)}`, hand_off: 'auto', metadata: { go_task_id: taskId } },
      });
    },

    async handoff(taskId, outcome) {
      const row = await live(taskId);
      const ask = (await d.store.openInteractions(taskId)).find((i) => i.type === 'handoff');
      if (!ask) throw new TaskError('no_handoff', 'That job is not waiting on anyone.');
      await d.v1.call('POST', `/v1/interactions/${ask.interactionId}/answer`, { body: { [outcome]: true } });
      await d.store.setInteraction(ask.interactionId, 'answered', d.now());
      await backToWork(row);
    },

    async stop(taskId) {
      const row = await d.store.get(taskId);
      if (!row || !isLive(row.state)) return;
      await d.store.update(taskId, { stopRequestedAt: d.now() });
      if (!(await d.store.transition(taskId, LIVE_STATES, 'stopped', { endedAt: d.now(), endReason: 'stopped', needsPersonId: null }))) return;
      const fresh = await d.store.get(taskId);
      if (fresh) await service.pushCard(fresh, true);
      await d.desk.cancel(row.tripId, taskId);
      for (const i of await d.store.openInteractions(taskId)) await d.store.setInteraction(i.interactionId, 'cancelled', d.now());
      await stopOnV1(row);
      await service.afterEnd(row.tripId);
    },

    async running(tripId) {
      return (await d.store.listLive(tripId)).map((r) => ({ id: r.id, brief: r.title, state: r.state }));
    },

    async cardFor(row) {
      const pack = await d.packs.get(row.tripId);
      return buildWorkingCard(row, { now: d.now(), nameOf: (id) => pack.trip.people.find((p) => p.person_id === id)?.name });
    },

    async pushCard(row, urgent) {
      d.cards.push(row.tripId, await service.cardFor(row), { now: urgent });
    },

    async stopV1(v1TaskId) {
      try {
        await d.v1.call('POST', `/v1/tasks/${v1TaskId}/stop`, { idempotencyKey: `go-stop-${v1TaskId}` });
      } catch (err) {
        if (!(err instanceof V1Error && (err.status === 404 || err.status === 409))) d.log.warn({ err, v1TaskId }, 'tasks: stopping a job on /v1 failed');
      }
    },

    async findStart(row) {
      if (!row.v1TurnId || row.v1TaskId) return;
      const found = await d.v1.call<{ data: PlatformEvent[] }>('GET', '/v1/events', {
        query: { type: 'task.started', user_id: d.computer.userIdFor(row.tripId), created_after: new Date(row.createdAt.getTime() - 10_000).toISOString(), limit: 50 },
      });
      for (const e of found.data) {
        const turnId = str(e.data?.turn_id);
        const v1TaskId = str(e.data?.task_id) ?? str(e.task_id);
        if (turnId && v1TaskId) await d.store.recordStart(turnId, v1TaskId, str(e.data?.title));
      }
      await service.mapStarts();
    },

    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
  return service;
}
