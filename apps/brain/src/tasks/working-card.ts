/**
 * The working card: Go's job, live. Its steps are the job's own to-do list once it writes one (the planned steps until
 * then); the screenshot is the trip's screen as Go re-hosted it. Rebuilt from the row every time, and checked against
 * the contract on every build.
 */
import * as C from '@go/contract';
import type { z } from 'zod';
import { clip } from '../travel/cards.js';
import type { TaskRow, TaskStep } from './store.js';

export type WorkingCardT = z.infer<typeof C.WorkingCard>;
export const WATCH_ACTION = { action_id: 'watch', label: 'Watch', style: 'primary' } as const;
export const STOP_ACTION = { action_id: 'stop', label: 'Stop', style: 'secondary' } as const;
const MAX_STEPS = 8;

const STATE_OF: Record<string, TaskStep['state']> = {
  completed: 'done', done: 'done', in_progress: 'doing', doing: 'doing', pending: 'todo', todo: 'todo', failed: 'failed', cancelled: 'failed',
};

export function plannedSteps(texts: string[] | undefined): TaskStep[] {
  const list = (texts ?? []).map((t) => clip(t, 80)).filter((t) => t.length > 0).slice(0, 6);
  const steps = list.length > 0 ? list : ["Starting the trip's computer", 'Working on it'];
  return steps.map((text, i): TaskStep => ({ text, state: i === 0 ? 'doing' : 'todo' }));
}

export function stepsFromTodos(todos: Array<{ content?: unknown; status?: unknown }>): TaskStep[] {
  const steps = todos
    .map((t): TaskStep => ({ text: clip(typeof t.content === 'string' ? t.content : '', 80), state: STATE_OF[typeof t.status === 'string' ? t.status : ''] ?? 'todo' }))
    .filter((s) => s.text.length > 0);
  // More than eight: drop the oldest finished steps first, so the step in hand stays in view.
  while (steps.length > MAX_STEPS) {
    const firstDone = steps.findIndex((s) => s.state === 'done');
    if (firstDone === -1) break;
    steps.splice(firstDone, 1);
  }
  return steps.slice(0, MAX_STEPS);
}

export function settleSteps(steps: TaskStep[], how: 'done' | 'failed' | 'stopped'): TaskStep[] {
  if (how === 'done') return steps.map((s): TaskStep => ({ ...s, state: 'done' }));
  const out = steps.map((s): TaskStep => (s.state === 'doing' ? { ...s, state: 'failed' } : s));
  if (how === 'stopped' && out.length < MAX_STEPS) out.push({ text: 'Stopped', state: 'failed' });
  return out;
}

export type CardView = Pick<TaskRow, 'id' | 'cardId' | 'title' | 'state' | 'steps' | 'screenshotUrl' | 'endReason' | 'needsPersonId'>;

export function buildWorkingCard(t: CardView, o: { now: Date; nameOf?: (personId: string) => string | undefined }): WorkingCardT {
  const live = t.state === 'queued' || t.state === 'starting' || t.state === 'running' || t.state === 'needs_you';
  const state: WorkingCardT['state'] = t.state === 'needs_you' ? 'needs_you' : t.state === 'done' ? 'done' : t.state === 'failed' || t.state === 'stopped' ? 'failed' : 'running';
  const steps = t.state === 'done' ? settleSteps(t.steps, 'done') : t.state === 'stopped' ? settleSteps(t.steps, 'stopped') : t.state === 'failed' ? settleSteps(t.steps, 'failed') : t.steps;
  const who = t.needsPersonId ? (o.nameOf?.(t.needsPersonId) ?? 'Someone') : 'Someone';
  const fallback: Record<TaskRow['state'], string> = {
    queued: `Waiting to start: ${t.title}`,
    starting: `Go is on it: ${t.title}`,
    running: `Go is on it: ${t.title}`,
    needs_you: `${who} is needed: ${t.title}`,
    done: `Done: ${t.title}`,
    failed: t.endReason === 'deadline' ? `Took too long: ${t.title}` : `Didn't work: ${t.title}`,
    stopped: `Stopped: ${t.title}`,
  };
  return C.WorkingCard.parse({
    card_id: t.cardId,
    kind: 'working',
    fallback_text: clip(fallback[t.state], 300),
    task_id: t.id,
    title: clip(t.title, 80),
    state,
    steps: steps.slice(0, MAX_STEPS),
    ...(t.screenshotUrl ? { screenshot_url: t.screenshotUrl } : {}),
    updated_at: o.now.toISOString(),
    actions: live ? [WATCH_ACTION, STOP_ACTION] : [],
    ...(t.state === 'needs_you' && t.needsPersonId ? { for_person_ids: [t.needsPersonId] } : {}),
  });
}
