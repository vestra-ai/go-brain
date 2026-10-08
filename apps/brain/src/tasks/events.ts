/**
 * One place that applies a /v1 event to Go's jobs, whichever way it came: the live stream, a webhook, the events poll
 * or the sweep. Every step is idempotent (state moves only forward, desk items have fixed ids), so the same event from
 * two sources, or twice from one, changes things once. A stopped job never posts results.
 *
 * task.completed ends one run of a job's /v1 task, not the job: a message Go sent while the job waited (a follow-up)
 * runs as a run of its own, in either order. The job ends only when /v1 says nothing of it is left: its conversation
 * is idle (every message Go put in has settled, no work open) and its task has ended. Until then a run's end is
 * progress, and the trip token stays live for the runs still to come.
 */
import type { Brain } from '../app.js';
import { clip } from '../travel/cards.js';
import type { ResultsStore } from '../travel/results.js';
import { GO_MCP_SLUG, GO_READ_ONLY_TOOLS } from './instructions.js';
import { OPTION_KIND_FOR, readReturned, resolvePicks, type ReturnsKind } from './returns.js';
import { LIVE_STATES, type TaskRow, type TaskStore } from './store.js';
import { WAITING_GRACE_MS, type TaskWake, type TasksService } from './tasks.js';
import type { V1Client } from './v1-client.js';
import { stepsFromTodos } from './working-card.js';

export interface V1Event { type: string; data: Record<string, unknown>; conversationId?: string | null; source: 'stream' | 'webhook' | 'poll' | 'sweep' }
export interface TaskEvents { apply(ev: V1Event): Promise<void> }

export interface TaskEventsDeps {
  store: TaskStore;
  tasks: TasksService;
  v1: V1Client;
  desk: Brain['desk'];
  results: Pick<ResultsStore, 'save' | 'findOffer'>;
  packs: Pick<Brain['packs'], 'get'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

interface V1Interaction {
  id: string;
  type: string;
  status: string;
  task_id: string | null;
  summary: string | null;
  questions?: Array<{ question: string; options?: Array<{ label: string }> }>;
  details?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** "mcp__go-trip__trip" or ("go-trip", "trip"): the MCP server and the bare tool name. */
function toolOf(name: string | null, server: string | null): { server: string | null; tool: string | null } {
  const m = name ? /^mcp__(.+?)__(.+)$/.exec(name) : null;
  return m ? { server: m[1] ?? null, tool: m[2] ?? null } : { server, tool: name };
}

export function createTaskEvents(d: TaskEventsDeps): TaskEvents {
  const isLive = (row: TaskRow | null): row is TaskRow => row !== null && LIVE_STATES.includes(row.state);

  async function wake(row: TaskRow, suffix: string, payload: TaskWake): Promise<void> {
    await d.desk.put({ id: `task:${row.id}:${suffix}`, tripId: row.tripId, kind: 'task', ref: row.id, dueAt: d.now(), payload });
  }

  async function extendDeadline(row: TaskRow): Promise<void> {
    const until = new Date(d.now().getTime() + WAITING_GRACE_MS);
    if (!row.deadlineAt || row.deadlineAt < until) await d.store.update(row.id, { deadlineAt: until });
  }

  async function answer(row: TaskRow, interactionId: string, type: string, body: Record<string, unknown>): Promise<void> {
    await d.store.addInteraction({ interactionId, taskId: row.id, tripId: row.tripId, type, summary: null, questions: [], forPersonIds: [], createdAt: d.now() });
    await d.v1.call('POST', `/v1/interactions/${interactionId}/answer`, { body }).catch((err: unknown) => d.log.warn({ err, interactionId }, 'tasks: answering an interaction failed'));
    await d.store.setInteraction(interactionId, 'answered', d.now());
  }

  async function started(data: Record<string, unknown>): Promise<void> {
    const turnId = str(data.turn_id);
    const v1TaskId = str(data.task_id);
    if (!turnId || !v1TaskId) return;
    await d.store.recordStart(turnId, v1TaskId, str(data.title));
    await d.tasks.mapStarts();
  }

  async function progress(data: Record<string, unknown>): Promise<void> {
    const v1TaskId = str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row) || row.stopRequestedAt || !Array.isArray(data.todos)) return;
    const steps = stepsFromTodos(data.todos as Array<{ content?: unknown; status?: unknown }>);
    if (steps.length === 0) return;
    const at = d.now();
    await d.store.update(row.id, { steps, todosAt: at });
    await d.tasks.pushCard({ ...row, steps, todosAt: at }, false);
  }

  async function interactionCreated(data: Record<string, unknown>): Promise<void> {
    const id = str(data.interaction_id);
    if (!id) return;
    let detail: V1Interaction;
    try {
      detail = await d.v1.call<V1Interaction>('GET', `/v1/interactions/${id}`);
    } catch (err) {
      d.log.warn({ err, interactionId: id }, 'tasks: reading an interaction failed; the sweep tries again');
      return;
    }
    if (detail.status !== 'pending') return;
    const v1TaskId = str(detail.task_id) ?? str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row)) {
      // An ask from a job that already ended (or was stopped) waits forever unless Go withdraws it.
      if (row) await d.v1.call('POST', `/v1/interactions/${id}/cancel`, { body: { reason: 'The job has ended.' } }).catch(() => undefined);
      return;
    }
    const summary = detail.summary ? clip(detail.summary, 300) : null;
    switch (detail.type) {
      case 'question': {
        const questions = (detail.questions ?? []).slice(0, 4).map((q) => ({ question: clip(q.question, 300), options: (q.options ?? []).map((o) => clip(o.label, 80)).slice(0, 4) }));
        if (!(await d.store.addInteraction({ interactionId: id, taskId: row.id, tripId: row.tripId, type: 'question', summary, questions, forPersonIds: [], createdAt: d.now() }))) return;
        await extendDeadline(row);
        await wake(row, `ask:${id}`, { event: 'question', taskId: row.id, title: row.title, interactionId: id, questions });
        return;
      }
      case 'handoff': {
        const personId = row.askedBy ?? (await d.packs.get(row.tripId)).trip.organizer_person_id;
        if (!(await d.store.addInteraction({ interactionId: id, taskId: row.id, tripId: row.tripId, type: 'handoff', summary, questions: [], forPersonIds: [personId], createdAt: d.now() }))) return;
        await extendDeadline(row);
        if (await d.store.transition(row.id, ['starting', 'running'], 'needs_you', { needsPersonId: personId })) {
          const fresh = await d.store.get(row.id);
          if (fresh) await d.tasks.pushCard(fresh, true);
        }
        await wake(row, `handoff:${id}`, { event: 'handoff', taskId: row.id, title: row.title, interactionId: id, personId, summary: summary ?? 'It needs someone to sign in or give a code.' });
        return;
      }
      case 'approval': {
        // Go's tools run without asking, so this should never come. When it does, Go's policy answers it.
        const { server, tool } = toolOf(str(data.name) ?? str(detail.details?.tool), str(data.server) ?? str(detail.details?.server));
        const allowed = server === GO_MCP_SLUG && tool !== null && ((GO_READ_ONLY_TOOLS as readonly string[]).includes(tool) || tool === 'note');
        d.log.warn({ taskId: row.id, server, tool, allowed }, "tasks: a job asked for an approval; answered from Go's policy");
        await answer(row, id, 'approval', allowed ? { approve: true, present_user: true } : { approve: false, message: 'Go does not allow this for trip jobs.' });
        return;
      }
      case 'connect':
        d.log.warn({ taskId: row.id }, 'tasks: a job asked to connect an app; refused');
        await answer(row, id, 'connect', { approve: false });
        return;
      case 'tool_call':
        await answer(row, id, 'tool_call', { error: 'Go has no client tools for this job.' });
        return;
      default:
        return;
    }
  }

  async function interactionSettled(type: string, data: Record<string, unknown>): Promise<void> {
    const id = str(data.interaction_id);
    if (!id) return;
    await d.store.setInteraction(id, type === 'interaction.expired' ? 'expired' : 'resolved', d.now());
    const v1TaskId = str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row) || row.state !== 'needs_you') return;
    if ((await d.store.openInteractions(row.id)).some((i) => i.type === 'handoff')) return;
    if (await d.store.transition(row.id, ['needs_you'], 'running', { needsPersonId: null })) {
      const fresh = await d.store.get(row.id);
      if (fresh) await d.tasks.pushCard(fresh, true);
    }
  }

  async function completed(data: Record<string, unknown>): Promise<void> {
    const v1TaskId = str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row) || row.stopRequestedAt || !v1TaskId) return;
    await finishIfIdle(row, v1TaskId, str(data.answer) ?? str(data.summary));
  }

  /** A turn of a conversation settled: when the conversation says it is idle, its jobs may have nothing left to run. */
  async function conversationStatus(data: Record<string, unknown>, conversationId: string | null): Promise<void> {
    const status = str(data.status);
    if (!conversationId || (status !== null && status !== 'idle')) return;
    for (const row of await d.store.liveIn(conversationId)) {
      if (row.v1TaskId && !row.stopRequestedAt) await finishIfIdle(row, row.v1TaskId, null);
    }
  }

  /**
   * Ends a job once nothing of it is left on /v1: its conversation idle and its task done (or failed). Anything else is
   * a run ending with more to come, so the job keeps running, its card live and its token armed.
   */
  async function finishIfIdle(row: TaskRow, v1TaskId: string, eventText: string | null): Promise<void> {
    if (row.conversationId) {
      const conv = await d.v1.call<{ status?: string }>('GET', `/v1/conversations/${row.conversationId}`);
      if (conv.status !== 'idle') {
        d.log.info({ taskId: row.id, v1TaskId, conversation: conv.status ?? null }, 'tasks: a run of the job ended, and more of it is still on /v1');
        return;
      }
    }
    let task: { status?: string; result?: { text?: string | null; data?: unknown } | null; cost_usd?: number | null };
    try {
      task = await d.v1.call('GET', `/v1/tasks/${v1TaskId}`);
    } catch (err) {
      d.log.warn({ err, v1TaskId }, "tasks: reading a finished job's result failed; using the event's summary");
      task = { status: 'done', result: { text: eventText, data: null } };
    }
    if (task.status === 'failed') {
      await d.tasks.fail(row, 'failed', 'The computer reported a problem.');
      return;
    }
    if (task.status !== 'done') return;
    const kind = row.returnsKind as ReturnsKind;
    const read = readReturned(kind, task.result?.data ?? null, task.result?.text ?? eventText);
    if (read.fromText) d.log.info({ taskId: row.id, v1TaskId }, "tasks: the job's answer came as JSON in its text, not as data; read it from the text");
    const optionKind = OPTION_KIND_FOR[kind];
    // An offer id Go's search showed this trip becomes that offer, checked prices and whole stay included; any other
    // stay or journey pick is "Found on the web", with no offer, so it can be voted on but never booked.
    const picks = optionKind && read.options.length > 0
      ? await resolvePicks(row.tripId, optionKind, read.options, (tripId, offerId) => d.results.findOffer(tripId, offerId))
      : null;
    if (picks && picks.fromWeb > 0) d.log.info({ taskId: row.id, fromWeb: picks.fromWeb }, 'tasks: picks with no offer Go showed are shown as found on the web');
    const set = optionKind && picks
      ? await d.results.save({ tripId: row.tripId, optionKind, source: 'task', query: { task_id: row.id }, options: picks.options, checkedAt: picks.checkedAt ?? d.now().toISOString() })
      : null;
    const moved = await d.store.transition(row.id, LIVE_STATES, 'done', {
      endedAt: d.now(),
      endReason: 'completed',
      needsPersonId: null,
      result: task.result ?? null,
      resultsId: set?.resultsId ?? null,
      ...(typeof task.cost_usd === 'number' ? { costUsd: task.cost_usd } : {}),
    });
    if (!moved) return;
    const fresh = await d.store.get(row.id);
    if (fresh) await d.tasks.pushCard(fresh, true);
    // A quiet job's lane speaks for it (the ixigo login's own card), so its end never wakes the composer.
    if (!row.quiet) await wake(row, 'done', { event: 'completed', taskId: row.id, title: row.title, resultsId: set?.resultsId ?? null, count: read.options.length, summary: read.summary });
    await d.tasks.afterEnd(row.tripId);
  }

  async function quietStop(row: TaskRow): Promise<void> {
    if (await d.store.transition(row.id, LIVE_STATES, 'stopped', { endedAt: d.now(), endReason: 'stopped', needsPersonId: null })) {
      const fresh = await d.store.get(row.id);
      if (fresh) await d.tasks.pushCard(fresh, true);
      await d.tasks.afterEnd(row.tripId);
    }
  }

  async function failed(data: Record<string, unknown>): Promise<void> {
    const v1TaskId = str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row)) return;
    if (row.stopRequestedAt) return quietStop(row);
    await d.tasks.fail(row, 'failed', str(data.message) ?? str(data.reason) ?? 'The computer reported a problem.');
    // Ended in Go, so its token goes: /v1 must not run a message still waiting in the task without it.
    if (v1TaskId) await d.tasks.stopV1(v1TaskId);
  }

  async function stopped(data: Record<string, unknown>): Promise<void> {
    const v1TaskId = str(data.task_id);
    const row = v1TaskId ? await d.store.byV1Task(v1TaskId) : null;
    if (!isLive(row)) return;
    if (row.stopRequestedAt) return quietStop(row);
    const why = str(data.reason);
    const reason = why === 'max_budget'
      ? 'It hit its spending limit, so it stopped.'
      : why === 'credits_exhausted'
        ? "Go's account for the trip's computer ran out of credit."
        : 'It was stopped on the computer.';
    await d.tasks.fail(row, why === 'max_budget' ? 'max_budget' : 'stopped_on_v1', reason);
  }

  return {
    async apply(ev) {
      switch (ev.type) {
        case 'task.started':
          return started(ev.data);
        case 'task.progress':
          return progress(ev.data);
        case 'interaction.created':
          return interactionCreated(ev.data);
        case 'interaction.resolved':
        case 'interaction.expired':
          return interactionSettled(ev.type, ev.data);
        case 'task.completed':
          return completed(ev.data);
        case 'task.failed':
          return failed(ev.data);
        case 'task.stopped':
          return stopped(ev.data);
        case 'conversation.status':
          return conversationStatus(ev.data, ev.conversationId ?? null);
        default:
          return;
      }
    },
  };
}
