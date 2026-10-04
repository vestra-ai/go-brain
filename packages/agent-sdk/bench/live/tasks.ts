/**
 * The live bench's fixed tasks: small, real, and checkable without judging prose.
 *
 * Each runs in a fresh copy of `workspace/` (a tiny shop codebase with a memo, a buggy
 * function and its test, three TODOs and a numbers file). A check reads the workspace
 * the run left behind first; where the answer only exists in the reply (a count, a
 * file path), it looks for the one token the right answer must contain.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskCheck {
  pass: boolean;
  detail: string;
}

export interface LiveTask {
  id: string;
  /** What it exercises, for the report. */
  shape: string;
  prompt: string;
  check(workspaceDir: string, finalText: string): TaskCheck;
}

const says = (text: string, ...needles: string[]): TaskCheck => {
  const lower = text.toLowerCase();
  const missing = needles.filter((n) => !lower.includes(n.toLowerCase()));
  return missing.length === 0
    ? { pass: true, detail: `reply names ${needles.join(', ')}` }
    : { pass: false, detail: `reply is missing ${missing.join(', ')}` };
};

export const LIVE_TASKS: readonly LiveTask[] = [
  {
    id: 'summarise',
    shape: 'one read, then prose',
    prompt: 'Read notes.md and summarise it in two sentences.',
    check: (_dir, text) => says(text, 'thursday'),
  },
  {
    id: 'count-todos',
    shape: 'search across files',
    prompt: 'How many TODO comments are there in the files under src/? Reply with just the number.',
    check: (_dir, text) =>
      /(^|\D)3(\D|$)/.test(text) ? { pass: true, detail: 'reply says 3' } : { pass: false, detail: 'reply does not say 3' },
  },
  {
    id: 'find-default',
    shape: 'find, read, answer (3 tools)',
    prompt: 'Which file defines the function computeTotal, and what is its default discount? Answer with the file path and the number.',
    check: (_dir, text) => says(text, 'cart.js', '0.15'),
  },
  {
    id: 'fix-and-test',
    shape: 'edit, then run the test',
    prompt: 'The add function in src/math.js is wrong. Fix it, then run `node test.js` to confirm it passes.',
    check: (dir) => {
      const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
      return r.status === 0 ? { pass: true, detail: 'node test.js passes' } : { pass: false, detail: `node test.js exits ${r.status}` };
    },
  },
  {
    id: 'write-file',
    shape: 'one write',
    prompt: 'Create a file named hello.txt whose entire content is: bench ok',
    check: (dir) => {
      // The product prompt says files meant for the person belong in files/, so that is
      // where a well-behaved run puts it; the workspace root is accepted too.
      const rel = ['files/hello.txt', 'hello.txt'].find((p) => existsSync(join(dir, p)));
      if (!rel) return { pass: false, detail: 'hello.txt was not written (neither files/hello.txt nor hello.txt)' };
      const body = readFileSync(join(dir, rel), 'utf8').trim();
      return body === 'bench ok' ? { pass: true, detail: `${rel} holds "bench ok"` } : { pass: false, detail: `${rel} holds ${JSON.stringify(body.slice(0, 40))}` };
    },
  },
  {
    id: 'sum-numbers',
    shape: 'shell arithmetic',
    prompt: 'Use a shell command to add up the numbers in data/nums.txt and tell me the total.',
    check: (_dir, text) => says(text, '100'),
  },
];

/** The tasks named by id (all when none named); an unknown id is an error, not a silent skip. */
export function pickTasks(ids: readonly string[] = []): LiveTask[] {
  if (ids.length === 0) return [...LIVE_TASKS];
  const unknown = ids.filter((id) => !LIVE_TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`live bench: no task named ${unknown.join(', ')}`);
  return LIVE_TASKS.filter((t) => ids.includes(t.id));
}
