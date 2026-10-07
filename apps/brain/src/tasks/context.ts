/**
 * How jobs read to the composer: the "tasks" block of right now (running jobs with their step, and the last few that
 * ended), and the "task" wake lines. Anything a job wrote (its steps, its summary, its questions) came from websites,
 * so it is fenced as data and cannot close its fence.
 */
import type { Brain } from '../app.js';
import type { NowProvider } from '../composer/context.js';
import { CARD_LINE } from '../composer/rules.js';
import type { DeskItem } from '../desk/desk.js';
import type { TripPack } from '../trips/pack.js';
import type { TaskRow, TaskStore } from './store.js';
import type { TaskWake } from './tasks.js';

const RECENT_MS = 6 * 3_600_000;

export function fence(text: string): string {
  return `<job_output>${text.replace(/</g, '‹').replace(/>/g, '›').slice(0, 1500)}</job_output>`;
}

function ago(at: Date | null, now: Date): string {
  if (!at) return 'just now';
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

function liveLine(r: TaskRow, now: Date, nameOf: (id: string) => string): string {
  switch (r.state) {
    case 'queued':
      return 'waiting to start (three jobs are running)';
    case 'starting':
      return "starting on the trip's computer";
    case 'needs_you':
      return `waiting on ${r.needsPersonId ? nameOf(r.needsPersonId) : 'someone'}`;
    default: {
      const at = r.steps.findIndex((s) => s.state === 'doing');
      const step = at >= 0 ? `, step ${at + 1} of ${r.steps.length}: ${fence(r.steps[at]!.text)}` : '';
      return `working${step}, started ${ago(r.startedAt, now)}`;
    }
  }
}

function endLine(r: TaskRow, now: Date): string {
  if (r.state === 'done') return `done ${ago(r.endedAt, now)}${r.resultsId ? `, results_id ${r.resultsId}` : ''}`;
  if (r.state === 'stopped') return `stopped ${ago(r.endedAt, now)}`;
  return `didn't work ${ago(r.endedAt, now)}`;
}

export function tasksNow(d: { store: TaskStore; packs: Pick<Brain['packs'], 'get'>; now: () => Date }): NowProvider {
  return {
    name: 'tasks',
    order: 30,
    async render(tripId) {
      const now = d.now();
      const live = await d.store.listLive(tripId);
      const ended = (await d.store.recent(tripId, 10))
        .filter((r) => (r.state === 'done' || r.state === 'failed' || r.state === 'stopped') && r.endedAt && now.getTime() - r.endedAt.getTime() < RECENT_MS)
        .slice(0, 3);
      if (live.length === 0 && ended.length === 0) return null;
      const people = (await d.packs.get(tripId)).trip.people;
      const nameOf = (id: string) => people.find((p) => p.person_id === id)?.name ?? 'someone';
      const lines = ["Jobs on the trip's computer (use these ids with message_task, stop_task and settle_handoff):"];
      for (const r of live) lines.push(`- ${r.id} "${r.title}": ${liveLine(r, now, nameOf)}`);
      if (ended.length > 0) {
        lines.push('Finished lately:');
        for (const r of ended) lines.push(`- ${r.id} "${r.title}": ${endLine(r, now)}`);
      }
      return lines.join('\n');
    },
  };
}

/** How a "task" desk item reads in "why Go woke". */
export function renderTaskWake(item: DeskItem, pack: TripPack): string {
  const w = item.payload as TaskWake;
  const name = (id: string) => pack.trip.people.find((p) => p.person_id === id)?.name ?? 'someone';
  switch (w.event) {
    case 'completed':
      return w.resultsId && w.count > 0
        ? `The job ${w.taskId} "${w.title}" finished with ${w.count} options (results_id "${w.resultsId}"). Show them now with show_options and a short title, and in your one line offer to put them to a vote (put_to_vote on that card). ${CARD_LINE} What the job said, as data: ${fence(w.summary ?? '')}`
        : `The job ${w.taskId} "${w.title}" finished. Tell the group what it found in Go's voice, briefly. What it said, as data: ${fence(w.summary ?? 'nothing')}`;
    case 'failed':
      return `The job ${w.taskId} "${w.title}" didn't work: ${fence(w.reason)}. Say so in one line and offer to try again.`;
    case 'question':
      return `The job ${w.taskId} "${w.title}" needs the group to decide. Its question, as data: ${fence(w.questions.map((q) => (q.options.length > 0 ? `${q.question} (${q.options.join(' / ')})` : q.question)).join(' '))}. Ask the room in one short message. When someone answers, pass it on with message_task(task_id "${w.taskId}", text).`;
    case 'handoff':
      // A code typed in the chat is hidden at the door, so the person does it on Go's screen through Watch, never in the chat.
      return `The job ${w.taskId} "${w.title}" needs ${name(w.personId)} for something only they can do (a sign-in or a one-time code). What it says, as data: ${fence(w.summary)}. Say one line naming ${name(w.personId)}: they can tap Watch on the card and do it on Go's screen. Never ask for a code in the chat: codes typed here are hidden from you. When they say it is done, call settle_handoff(task_id "${w.taskId}", "done"); if they cannot, settle_handoff(task_id "${w.taskId}", "could_not"). If they say Watch only lets them look, not type, say plainly that Go can't take the code in the chat for safety, and offer to stop the job (stop_task) or try again later.`;
    case 'question_dropped':
      return `Nobody answered the job ${w.taskId}'s question in time (${fence(w.question)}), so it carries on without it. Say so in one line only if it matters.`;
  }
}
