/**
 * Truncate-and-store for oversized WebFetch content — the browser
 * snapshot-store pattern applied to fetched pages: NEVER LLM-summarize; return
 * a head+tail window and write the full text to disk with an exact Read
 * invocation so the agent can page through the omitted middle on demand.
 * Deliberately a sibling of apps/sandbox/src/browser/snapshot-store.ts, not a
 * shared refactor: the dependency direction (sandbox → agent-sdk) forbids
 * importing the hardened browser module from here.
 */
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webFetchStoreEnabled, toolResultShapeEnabled } from '../policy/feature-flags.js';
import { truncationMarker } from './result-shape.js';

/**
 * READ AT CALL TIME, never cached at module load. The sandbox runner points its process at a
 * temp dir on the user's volume (apps/sandbox runner/tools-env.ts sets TMPDIR before the first
 * tool runs), and os.tmpdir() reads TMPDIR on every call — a module-level constant would freeze
 * the image's /tmp into every stored page for the life of the process, which is the 6.3 GB
 * overlay that program exists to empty. A function, not a const, for that reason alone.
 */
export const webStoreDir = (): string => join(tmpdir(), 'vestra-web');
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const HEAD_RATIO = 0.75;
// INVARIANT: must be >= the WebFetch max batch size (5, web-fetch-tool.ts) plus
// history headroom — a single batch call stores up to 5 generations concurrently
// and none of them may be reaped before the call's response (with their footers)
// returns. 8 = one full batch + 3 of history. Worst case 8 × 2MB per task,
// reaped at task teardown.
const KEEP_GENERATIONS = 8;
const READ_LIMIT_CAP = 400;

const sanitize = (taskId: string): string => taskId.replace(/[^a-zA-Z0-9_-]/g, '_');

// Per-task monotonic generation counter (keyed per task — never global — per
// the multi-session invariant). Cleared on reap. Seeded from files already on
// disk so a process restart mid-task (auto-upgrade/crash + resume) cannot
// restart at g1 below surviving higher generations — reapOldGenerations would
// instantly delete the just-written file its footer advertises.
const generations = new Map<string, number>();
const seeding = new Map<string, Promise<void>>();

async function maxGenOnDisk(safeId: string): Promise<number> {
  try {
    const entries = await readdir(webStoreDir());
    return entries.reduce((max, f) => {
      const m = f.match(new RegExp(`^webfetch-${safeId}-g(\\d+)\\.txt$`));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  } catch {
    return 0;
  }
}

async function ensureSeeded(safeId: string): Promise<void> {
  if (generations.has(safeId)) return;
  let p = seeding.get(safeId);
  if (!p) {
    p = (async () => {
      const max = await maxGenOnDisk(safeId);
      if (!generations.has(safeId)) generations.set(safeId, max);
    })().finally(() => seeding.delete(safeId));
    seeding.set(safeId, p);
  }
  await p;
}

export async function truncateAndStoreWeb(text: string, taskId: string, budget: number): Promise<string> {
  if (text.length <= budget) return text;

  const capped = text.length > STORE_MAX_BYTES;
  const stored = capped ? text.slice(0, STORE_MAX_BYTES) : text;

  const safeId = sanitize(taskId);
  await ensureSeeded(safeId);
  // Synchronous get→set (no await between) — concurrent batch stores allocate
  // distinct generations without a tear.
  const gen = (generations.get(safeId) ?? 0) + 1;
  generations.set(safeId, gen);
  const filePath = join(webStoreDir(), `webfetch-${safeId}-g${gen}.txt`);

  await mkdir(webStoreDir(), { recursive: true });
  await writeFile(filePath, stored, 'utf8');
  await reapOldGenerations(safeId);

  const lines = stored.split('\n');
  const headBudget = Math.floor(budget * HEAD_RATIO);
  const tailBudget = budget - headBudget;

  let headChars = 0;
  let headEnd = 0; // exclusive line index
  while (headEnd < lines.length && headChars + lines[headEnd].length + 1 <= headBudget) {
    headChars += lines[headEnd].length + 1;
    headEnd++;
  }
  let tailChars = 0;
  let tailStart = lines.length; // inclusive line index
  while (tailStart > headEnd && tailChars + lines[tailStart - 1].length + 1 <= tailBudget) {
    tailChars += lines[tailStart - 1].length + 1;
    tailStart--;
  }

  const omitted = tailStart - headEnd;
  const offset = headEnd + 1; // Read tool offset is 1-based
  const limit = Math.min(omitted, READ_LIMIT_CAP);
  const capNote = capped ? ' (stored text capped at 2MB)' : '';

  // T5 (TOOL_RESULT_SHAPE_V1): the one truncation marker, in the middle where the lines went,
  // carrying the exact Read call that pages them back. Off: today's middle line and footer.
  if (toolResultShapeEnabled()) {
    return [
      ...lines.slice(0, headEnd),
      truncationMarker({
        omitted: `${omitted} lines`,
        from: 'middle',
        recovery:
          `The page is in ${filePath}${capNote}; read the omitted lines with ` +
          `Read(file_path="${filePath}", offset=${offset}, limit=${limit}).`,
      }),
      ...lines.slice(tailStart),
    ].join('\n');
  }

  return [
    ...lines.slice(0, headEnd),
    `… [${omitted} lines omitted] …`,
    ...lines.slice(tailStart),
    '',
    `[page truncated: showing ${headEnd} head + ${lines.length - tailStart} tail of ${lines.length} lines${capNote}. ` +
      `Full text stored at ${filePath} - page the omitted middle with the Read tool: ` +
      `Read(file_path="${filePath}", offset=${offset}, limit=${limit})]`,
  ].join('\n');
}

export async function reapTaskWebContent(taskId: string): Promise<void> {
  const safeId = sanitize(taskId);
  generations.delete(safeId);
  seeding.delete(safeId);
  try {
    const entries = await readdir(webStoreDir());
    const mine = entries.filter((f) => new RegExp(`^webfetch-${safeId}-g\\d+\\.txt$`).test(f));
    for (const f of mine) {
      await unlink(join(webStoreDir(), f)).catch(() => {});
    }
  } catch {
    // best-effort reaping only
  }
}

/** Task-teardown reap: flag-gated + never-throws (teardown must never fail on cleanup). */
export async function reapWebFetchContent(taskId: string): Promise<void> {
  if (!webFetchStoreEnabled()) return;
  try {
    await reapTaskWebContent(taskId);
  } catch {
    // best-effort
  }
}

async function reapOldGenerations(safeId: string): Promise<void> {
  try {
    const entries = await readdir(webStoreDir());
    const mine = entries
      .map((f) => {
        const m = f.match(new RegExp(`^webfetch-${safeId}-g(\\d+)\\.txt$`));
        return m ? { f, gen: Number(m[1]) } : null;
      })
      .filter((x): x is { f: string; gen: number } => x !== null)
      .sort((a, b) => b.gen - a.gen);
    for (const { f } of mine.slice(KEEP_GENERATIONS)) {
      await unlink(join(webStoreDir(), f)).catch(() => {});
    }
  } catch {
    // best-effort reaping only
  }
}
