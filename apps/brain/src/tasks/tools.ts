/**
 * The composer's job tools. start_task hands a big job to the trip's computer; its working card goes out with the
 * turn's message ("On it" and the card together), and the job's answer comes back later as a desk item.
 * message_task passes words to a running job (an answer to its question, a code for its hand-off, or more to do),
 * stop_task stops it, and settle_handoff says the person did the sign-in themselves, or could not.
 */
import { z } from 'zod';
import type { QuickTool } from '../composer/tools.js';
import type { Trip } from '../door/methods.js';
import { RETURN_KINDS, returnsSchema } from './returns.js';
import { TaskError, type TasksService } from './tasks.js';

const TaskId = z.string().regex(/^gt_[0-9a-z]{6,40}$/, 'A job id from the jobs list, like gt_...');

const StartArgs = z.object({
  title: z.string().min(3).max(80).describe('What the working card says, e.g. "Finding villas with a pool in North Goa"'),
  goal: z.string().min(10).max(4000).describe('The whole job in plain words, with every constraint people gave'),
  returns: z.enum(RETURN_KINDS).describe('What comes back: options of one kind, or "answer" for a written answer'),
  steps: z.array(z.string().min(2).max(60)).min(1).max(6).optional().describe('Your plan in 2 to 6 short steps, shown on the card until the job writes its own'),
  context: z
    .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)]))
    .optional()
    .describe('Only the trip facts the job needs'),
  success_criteria: z.string().min(5).max(500).optional(),
  asked_by: z.string().min(1).max(80).optional().describe('The name of the person who asked'),
});
const MessageArgs = z.object({ task_id: TaskId, text: z.string().min(1).max(2000) });
const StopArgs = z.object({ task_id: TaskId });
const HandoffArgs = z.object({ task_id: TaskId, outcome: z.enum(['done', 'could_not', 'not_now']) });

function personNamed(trip: Trip, name: string): string | null {
  const want = name.trim().toLowerCase();
  const exact = trip.people.filter((p) => p.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!.person_id;
  const starts = trip.people.filter((p) => p.name.toLowerCase().startsWith(want));
  return starts.length === 1 ? starts[0]!.person_id : null;
}

async function asAnswer(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TaskError) return { error: err.code, note: err.message };
    throw err;
  }
}

export function taskTools(d: { tasks: TasksService }): QuickTool<any>[] {
  const startTask: QuickTool<z.infer<typeof StartArgs>> = {
    name: 'start_task',
    description:
      "Hands a big job to the trip's computer: anything that needs websites, many steps, long reading or comparing, or more than about 10 seconds. " +
      'Never for booking or paying. The working card goes out with your message: say one short line, like "On it."',
    input: StartArgs,
    async run(a, ctx) {
      const trip = ctx.pack.trip;
      const askedBy = a.asked_by ? personNamed(trip, a.asked_by) : null;
      const context = { ...(a.context ?? {}), trip: { destination: trip.destination?.name ?? null, dates: trip.dates ?? null, people: trip.people.length } };
      const r = await d.tasks.start(ctx.tripId, {
        goal: a.goal,
        returns: returnsSchema(a.returns),
        context,
        title: a.title,
        returnsKind: a.returns,
        key: ctx.stableId('task'),
        cardId: ctx.stableId('c_work'),
        cards: ctx.cards,
        ...(a.steps ? { steps: a.steps } : {}),
        ...(a.success_criteria ? { successCriteria: a.success_criteria } : {}),
        ...(askedBy ? { askedBy } : {}),
      });
      const state = (await d.tasks.running(ctx.tripId)).find((t) => t.id === r.taskId)?.state;
      return state === 'queued'
        ? { task_id: r.taskId, card_id: r.cardId, queued: true, note: 'Three jobs are already running here; this one starts when one finishes. Say so in one short line.' }
        : { task_id: r.taskId, card_id: r.cardId, note: 'The working card goes out with your message. Say one short line, like "On it." Do not list the steps.' };
    },
  };
  const messageTask: QuickTool<z.infer<typeof MessageArgs>> = {
    name: 'message_task',
    description:
      "Passes a person's words to a running job: the answer to its question, or more to do. Never for a one-time code or a password: " +
      "codes typed in the chat are hidden, so a sign-in is done on Go's screen through Watch, then settle_handoff. Use the job's id from the jobs list.",
    input: MessageArgs,
    run: (a) => asAnswer(async () => {
      await d.tasks.message(a.task_id, a.text);
      return { ok: true, note: 'Passed on. Say so only if someone is waiting to hear it.' };
    }),
  };
  const stopTask: QuickTool<z.infer<typeof StopArgs>> = {
    name: 'stop_task',
    description: 'Stops a running job. Its card says Stopped and it posts no results.',
    input: StopArgs,
    run: (a) => asAnswer(async () => {
      await d.tasks.stop(a.task_id);
      return { ok: true };
    }),
  };
  const settleHandoff: QuickTool<z.infer<typeof HandoffArgs>> = {
    name: 'settle_handoff',
    description: 'Tells a job waiting on a person that they did it themselves ("done"), could not ("could_not"), or will later ("not_now").',
    input: HandoffArgs,
    run: (a) => asAnswer(async () => {
      await d.tasks.handoff(a.task_id, a.outcome);
      return { ok: true };
    }),
  };
  return [startTask, messageTask, stopTask, settleHandoff];
}
