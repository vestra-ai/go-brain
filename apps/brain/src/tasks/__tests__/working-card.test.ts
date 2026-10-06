import { describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import type { TaskRow } from '../store.js';
import { buildWorkingCard, plannedSteps, settleSteps, stepsFromTodos } from '../working-card.js';

const NOW = new Date('2026-10-07T12:05:00Z');
const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 'gt_1', tripId: 't_goa', title: 'Finding villas with a pool in North Goa', goal: 'g', returnsKind: 'stays', returns: {}, context: {}, successCriteria: null, askedBy: 'p_meher',
  state: 'running', cardId: 'c_work_1', messageId: 'm_go_1', steps: plannedSteps(['Search stays', 'Read reviews']), screenshotUrl: null, needsPersonId: null, conversationId: 'conv_1',
  v1TurnId: 'turn_1', v1TaskId: 'task_1', deadlineAt: null, result: null, resultsId: null, error: null, endReason: null, createdAt: NOW, startedAt: NOW, endedAt: null,
  stopRequestedAt: null, todosAt: null, costUsd: null, ...over,
});

describe('the working card', () => {
  it('runs with Watch and Stop, the planned steps, and the screenshot when there is one', () => {
    const card = buildWorkingCard(row({ screenshotUrl: 'https://go.test/img/iabc.jpg' }), { now: NOW });
    expect(C.WorkingCard.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ kind: 'working', task_id: 'gt_1', state: 'running', screenshot_url: 'https://go.test/img/iabc.jpg', updated_at: NOW.toISOString() });
    expect(card.steps).toEqual([{ text: 'Search stays', state: 'doing' }, { text: 'Read reviews', state: 'todo' }]);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['watch', 'stop']);
    expect(card.fallback_text).toBe('Go is on it: Finding villas with a pool in North Goa');
  });

  it('pins a job that needs someone to that person, and names them', () => {
    const card = buildWorkingCard(row({ state: 'needs_you', needsPersonId: 'p_rahul' }), { now: NOW, nameOf: (id) => (id === 'p_rahul' ? 'Rahul' : undefined) });
    expect(card).toMatchObject({ state: 'needs_you', for_person_ids: ['p_rahul'], fallback_text: 'Rahul is needed: Finding villas with a pool in North Goa' });
  });

  it('ends done with every step ticked, failed or stopped with no buttons, and says what happened', () => {
    const done = buildWorkingCard(row({ state: 'done' }), { now: NOW });
    expect(done.steps.every((s) => s.state === 'done')).toBe(true);
    expect(done.actions).toEqual([]);
    const stopped = buildWorkingCard(row({ state: 'stopped' }), { now: NOW });
    expect(stopped).toMatchObject({ state: 'failed', fallback_text: 'Stopped: Finding villas with a pool in North Goa' });
    expect(stopped.steps.at(-1)).toEqual({ text: 'Stopped', state: 'failed' });
    expect(buildWorkingCard(row({ state: 'failed', endReason: 'deadline' }), { now: NOW }).fallback_text).toBe('Took too long: Finding villas with a pool in North Goa');
    expect(buildWorkingCard(row({ state: 'failed' }), { now: NOW }).fallback_text).toBe("Didn't work: Finding villas with a pool in North Goa");
  });
});

describe('steps', () => {
  it("takes the job's to-do list, mapping its statuses and keeping the step in hand in view when there are more than eight", () => {
    expect(stepsFromTodos([{ content: 'Search stays', status: 'completed' }, { content: 'Read reviews', status: 'in_progress' }, { content: 'Pick three', status: 'pending' }])).toEqual([
      { text: 'Search stays', state: 'done' }, { text: 'Read reviews', state: 'doing' }, { text: 'Pick three', state: 'todo' },
    ]);
    const many = Array.from({ length: 10 }, (_, i) => ({ content: `Step ${i + 1}`, status: i < 8 ? 'completed' : 'in_progress' }));
    const kept = stepsFromTodos(many);
    expect(kept).toHaveLength(8);
    expect(kept.some((s) => s.state === 'doing')).toBe(true);
  });

  it('plans steps from the brief, or two plain ones', () => {
    expect(plannedSteps(undefined)).toEqual([{ text: "Starting the trip's computer", state: 'doing' }, { text: 'Working on it', state: 'todo' }]);
    expect(settleSteps([{ text: 'a', state: 'doing' }], 'failed')).toEqual([{ text: 'a', state: 'failed' }]);
  });
});
