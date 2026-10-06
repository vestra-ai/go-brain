import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compareFast, loadBars } from '../compare.js';
import { writeReport } from '../report-md.js';
import { FAST_CHATS, fastReport, OUT_DIR, runFastChat } from '../run-fast.js';
import type { ChatScore } from '../score.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (process.env['CI'] !== undefined && DATABASE_URL === undefined) throw new Error('The replay bench needs DATABASE_URL in CI (the Postgres service).');

const BoardCache = z.object({ cache: z.object({ status: z.string(), hit: z.number().nullable() }) });
const scores: ChatScore[] = [];
const boards: Record<string, unknown> = {};

describe.skipIf(DATABASE_URL === undefined)('the fast replay bench', () => {
  for (const c of FAST_CHATS) {
    it(`replays ${c.name} through Go and meets the bars`, async () => {
      const { score, board } = await runFastChat(c, DATABASE_URL ?? '');
      scores.push(score);
      boards[c.name] = board;
      const failing = compareFast([score], loadBars().fast).checks.filter((x) => !x.ok);
      expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
      const b = BoardCache.safeParse(board);
      if (b.success && b.data.cache.status === 'ok' && b.data.cache.hit !== null && score.cache.hitRateAll !== null)
        expect(Math.abs(b.data.cache.hit - score.cache.hitRateAll), 'the board (from turns) and the bench (from request bodies) disagree on the cache: check how turns stores input, cache reads and cache writes').toBeLessThan(0.02);
    }, c.timeoutMs);
  }
  afterAll(() => {
    if (scores.length > 0) writeReport(fastReport(scores, boards), OUT_DIR, 'bench-report');
  });
});
