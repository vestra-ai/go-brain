/**
 * Task rows (one per job Go hands to the trip's computer), the asks a job raised, and the task starts /v1 announced.
 * A job's state only moves forward: transition() moves it from the states named and nothing else, so an event that
 * arrives twice, late, or after a stop changes nothing.
 */
import type pg from 'pg';

export type TaskState = 'queued' | 'starting' | 'running' | 'needs_you' | 'done' | 'failed' | 'stopped';
export const LIVE_STATES: TaskState[] = ['queued', 'starting', 'running', 'needs_you'];
/** The states that count toward a trip's three jobs at once. */
export const ACTIVE_STATES: TaskState[] = ['starting', 'running', 'needs_you'];
export interface TaskStep { text: string; state: 'todo' | 'doing' | 'done' | 'failed' }

export interface TaskRow {
  id: string;
  tripId: string;
  title: string;
  goal: string;
  returnsKind: string;
  returns: unknown;
  context: Record<string, unknown>;
  successCriteria: string | null;
  askedBy: string | null;
  state: TaskState;
  cardId: string;
  messageId: string | null;
  steps: TaskStep[];
  screenshotUrl: string | null;
  needsPersonId: string | null;
  conversationId: string | null;
  v1TurnId: string | null;
  v1TaskId: string | null;
  deadlineAt: Date | null;
  result: unknown;
  resultsId: string | null;
  error: string | null;
  endReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  stopRequestedAt: Date | null;
  todosAt: Date | null;
  costUsd: number | null;
}

export type NewTask = Pick<TaskRow, 'id' | 'tripId' | 'title' | 'goal' | 'returnsKind' | 'returns' | 'context' | 'successCriteria' | 'askedBy' | 'state' | 'cardId' | 'steps' | 'deadlineAt' | 'createdAt'>;
export type TaskPatch = Partial<Pick<TaskRow, 'messageId' | 'steps' | 'screenshotUrl' | 'needsPersonId' | 'conversationId' | 'deadlineAt' | 'result' | 'resultsId' | 'error' | 'endReason' | 'startedAt' | 'endedAt' | 'stopRequestedAt' | 'todosAt' | 'costUsd'>>;

export interface InteractionRow {
  interactionId: string;
  taskId: string;
  tripId: string;
  type: string;
  summary: string | null;
  questions: Array<{ question: string; options: string[] }>;
  forPersonIds: string[];
  status: 'open' | 'answered' | 'cancelled' | 'resolved' | 'expired';
  createdAt: Date;
}

export interface TaskStore {
  insert(row: NewTask): Promise<boolean>;
  get(id: string): Promise<TaskRow | null>;
  byV1Task(v1TaskId: string): Promise<TaskRow | null>;
  listLive(tripId?: string): Promise<TaskRow[]>;
  recent(tripId: string, limit: number): Promise<TaskRow[]>;
  countActive(tripId: string): Promise<number>;
  activeIds(tripId: string): Promise<string[]>;
  hasActiveIn(conversationId: string): Promise<boolean>;
  oldestQueued(tripId: string): Promise<TaskRow | null>;
  update(id: string, patch: TaskPatch): Promise<void>;
  transition(id: string, from: TaskState[], to: TaskState, patch?: TaskPatch): Promise<boolean>;
  setTurn(id: string, conversationId: string, turnId: string): Promise<void>;
  recordStart(turnId: string, v1TaskId: string, title: string | null): Promise<void>;
  matchStarts(): Promise<Array<{ id: string; v1TaskId: string }>>;
  addInteraction(row: Omit<InteractionRow, 'status'>): Promise<boolean>;
  openInteractions(taskId: string): Promise<InteractionRow[]>;
  allOpenInteractions(): Promise<InteractionRow[]>;
  setInteraction(interactionId: string, status: InteractionRow['status'], at: Date): Promise<void>;
}

interface TaskDb {
  id: string; trip_id: string; title: string; goal: string; returns_kind: string; returns: unknown; context: Record<string, unknown>;
  success_criteria: string | null; asked_by: string | null; state: TaskState; card_id: string; message_id: string | null; steps: TaskStep[];
  screenshot_url: string | null; needs_person_id: string | null; conversation_id: string | null; v1_turn_id: string | null; v1_task_id: string | null;
  deadline_at: Date | null; result: unknown; results_id: string | null; error: string | null; end_reason: string | null; created_at: Date;
  started_at: Date | null; ended_at: Date | null; stop_requested_at: Date | null; todos_at: Date | null; cost_usd: string | null;
}

const rowOf = (r: TaskDb): TaskRow => ({
  id: r.id, tripId: r.trip_id, title: r.title, goal: r.goal, returnsKind: r.returns_kind, returns: r.returns, context: r.context,
  successCriteria: r.success_criteria, askedBy: r.asked_by, state: r.state, cardId: r.card_id, messageId: r.message_id, steps: r.steps,
  screenshotUrl: r.screenshot_url, needsPersonId: r.needs_person_id, conversationId: r.conversation_id, v1TurnId: r.v1_turn_id, v1TaskId: r.v1_task_id,
  deadlineAt: r.deadline_at, result: r.result, resultsId: r.results_id, error: r.error, endReason: r.end_reason, createdAt: r.created_at,
  startedAt: r.started_at, endedAt: r.ended_at, stopRequestedAt: r.stop_requested_at, todosAt: r.todos_at, costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
});

interface InteractionDb {
  interaction_id: string; task_id: string; trip_id: string; type: string; summary: string | null; questions: Array<{ question: string; options: string[] }>;
  for_person_ids: string[]; status: InteractionRow['status']; created_at: Date;
}

const interactionOf = (r: InteractionDb): InteractionRow => ({
  interactionId: r.interaction_id, taskId: r.task_id, tripId: r.trip_id, type: r.type, summary: r.summary, questions: r.questions,
  forPersonIds: r.for_person_ids, status: r.status, createdAt: r.created_at,
});

const COLUMNS: Record<keyof TaskPatch, string> = {
  messageId: 'message_id', steps: 'steps', screenshotUrl: 'screenshot_url', needsPersonId: 'needs_person_id', conversationId: 'conversation_id',
  deadlineAt: 'deadline_at', result: 'result', resultsId: 'results_id', error: 'error', endReason: 'end_reason', startedAt: 'started_at',
  endedAt: 'ended_at', stopRequestedAt: 'stop_requested_at', todosAt: 'todos_at', costUsd: 'cost_usd',
};
const JSON_FIELDS = new Set<keyof TaskPatch>(['steps', 'result']);

function setClause(patch: TaskPatch, offset: number): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(patch) as Array<keyof TaskPatch>) {
    const v = patch[key];
    if (v === undefined) continue;
    values.push(JSON_FIELDS.has(key) && v !== null ? JSON.stringify(v) : v);
    parts.push(`${COLUMNS[key]} = $${offset + values.length}`);
  }
  return { sql: parts.join(', '), values };
}

export function createTaskStore(pool: pg.Pool): TaskStore {
  const many = async (sql: string, values: unknown[]): Promise<TaskRow[]> => (await pool.query<TaskDb>(sql, values)).rows.map(rowOf);
  const one = async (sql: string, values: unknown[]): Promise<TaskRow | null> => (await many(sql, values))[0] ?? null;
  return {
    async insert(t) {
      const r = await pool.query(
        `insert into tasks (id, trip_id, title, goal, returns_kind, returns, context, success_criteria, asked_by, state, card_id, steps, deadline_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict (id) do nothing`,
        [t.id, t.tripId, t.title, t.goal, t.returnsKind, JSON.stringify(t.returns), JSON.stringify(t.context), t.successCriteria, t.askedBy, t.state, t.cardId, JSON.stringify(t.steps), t.deadlineAt, t.createdAt],
      );
      return r.rowCount === 1;
    },
    get: (id) => one('select * from tasks where id = $1', [id]),
    byV1Task: (v1TaskId) => one('select * from tasks where v1_task_id = $1', [v1TaskId]),
    listLive: (tripId) =>
      tripId === undefined
        ? many('select * from tasks where state = any($1::text[]) order by created_at', [LIVE_STATES])
        : many('select * from tasks where trip_id = $1 and state = any($2::text[]) order by created_at', [tripId, LIVE_STATES]),
    recent: (tripId, limit) => many('select * from tasks where trip_id = $1 order by created_at desc limit $2', [tripId, limit]),
    async countActive(tripId) {
      const { rows } = await pool.query<{ n: string }>('select count(*) as n from tasks where trip_id = $1 and state = any($2::text[])', [tripId, ACTIVE_STATES]);
      return Number(rows[0]?.n ?? 0);
    },
    async activeIds(tripId) {
      const { rows } = await pool.query<{ id: string }>('select id from tasks where trip_id = $1 and state = any($2::text[])', [tripId, ACTIVE_STATES]);
      return rows.map((r) => r.id);
    },
    async hasActiveIn(conversationId) {
      const { rows } = await pool.query('select 1 from tasks where conversation_id = $1 and state = any($2::text[]) limit 1', [conversationId, ACTIVE_STATES]);
      return rows.length > 0;
    },
    oldestQueued: (tripId) => one("select * from tasks where trip_id = $1 and state = 'queued' order by created_at limit 1", [tripId]),
    async update(id, patch) {
      const { sql, values } = setClause(patch, 1);
      if (!sql) return;
      await pool.query(`update tasks set ${sql} where id = $1`, [id, ...values]);
    },
    async transition(id, from, to, patch = {}) {
      const { sql, values } = setClause(patch, 3);
      const r = await pool.query(`update tasks set state = $2${sql ? `, ${sql}` : ''} where id = $1 and state = any($3::text[]) returning id`, [id, to, from, ...values]);
      return r.rowCount === 1;
    },
    async setTurn(id, conversationId, turnId) {
      await pool.query('update tasks set conversation_id = $2, v1_turn_id = $3 where id = $1', [id, conversationId, turnId]);
    },
    async recordStart(turnId, v1TaskId, title) {
      await pool.query('insert into v1_task_starts (turn_id, v1_task_id, title) values ($1, $2, $3) on conflict (turn_id) do nothing', [turnId, v1TaskId, title]);
    },
    async matchStarts() {
      const { rows } = await pool.query<{ id: string; v1_task_id: string }>(
        `update tasks t set v1_task_id = s.v1_task_id from v1_task_starts s
         where t.v1_turn_id = s.turn_id and t.v1_task_id is null returning t.id, t.v1_task_id`,
      );
      return rows.map((r) => ({ id: r.id, v1TaskId: r.v1_task_id }));
    },
    async addInteraction(i) {
      const r = await pool.query(
        `insert into task_interactions (interaction_id, task_id, trip_id, type, summary, questions, for_person_ids, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (interaction_id) do nothing`,
        [i.interactionId, i.taskId, i.tripId, i.type, i.summary, JSON.stringify(i.questions), i.forPersonIds, i.createdAt],
      );
      return r.rowCount === 1;
    },
    async openInteractions(taskId) {
      const { rows } = await pool.query<InteractionDb>("select * from task_interactions where task_id = $1 and status = 'open' order by created_at", [taskId]);
      return rows.map(interactionOf);
    },
    async allOpenInteractions() {
      const { rows } = await pool.query<InteractionDb>("select * from task_interactions where status = 'open' order by created_at");
      return rows.map(interactionOf);
    },
    async setInteraction(interactionId, status, at) {
      await pool.query("update task_interactions set status = $2, settled_at = $3 where interaction_id = $1 and status = 'open'", [interactionId, status, at]);
    },
  };
}
