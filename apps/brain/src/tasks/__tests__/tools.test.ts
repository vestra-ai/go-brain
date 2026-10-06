import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { TaskBrief, TasksService } from '../tasks.js';
import { goaPack } from '../testing/goa.js';
import { makeLaneBrain } from '../testing/lane-brain.js';
import { taskTools } from '../tools.js';

// start_task reads no database here: the jobs service is a stand-in that keeps the brief it was given.
const lb = makeLaneBrain({ pool: {} as pg.Pool });
const ARGS = { title: 'Finding villas with a pool', goal: 'Find 3 villas with a pool in North Goa for 6 to 9 Nov', returns: 'stays', context: { area: 'North Goa' } };

function startTask(today?: string) {
  const briefs: TaskBrief[] = [];
  const tasks = {
    start: async (_tripId: string, brief: TaskBrief) => {
      briefs.push(brief);
      return { taskId: 'gt_tools00001', cardId: 'c_work_tools1' };
    },
    running: async () => [],
  } as unknown as TasksService;
  const tool = taskTools({ tasks, ...(today ? { today: async () => today } : {}) }).find((t) => t.name === 'start_task')!;
  return { run: (ctx = lb.ctx()) => tool.run(tool.input.parse(ARGS), ctx), briefs };
}

describe('start_task', () => {
  it("hands the job the trip's dates with their year, and today, so it never guesses the year", async () => {
    const s = startTask('2026-10-07');
    await s.run();
    const context = s.briefs[0]!.context;
    expect(context).toMatchObject({ area: 'North Goa', trip: { dates: { start: '2026-11-06', end: '2026-11-09' } }, today: '2026-10-07' });
    expect(JSON.stringify(context)).toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it('gives a trip with no dates yet today, with its year', async () => {
    const s = startTask('2026-10-07');
    const pack = goaPack();
    await s.run(lb.ctx({ pack: { ...pack, trip: { ...pack.trip, dates: null } } }));
    expect(s.briefs[0]!.context).toMatchObject({ trip: { dates: null }, today: '2026-10-07' });
  });
});
