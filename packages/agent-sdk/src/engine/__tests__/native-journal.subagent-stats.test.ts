/**
 * Orchestration walls (spec D10) — the turn boundary's record.
 *
 * `flushTurnRecords` replaced a bare `cfg.journal?.flushMirror()` at the ONE turn
 * boundary in native-harness. It has to keep doing that flush unconditionally, and
 * around it count the turn's spawns onto the journal (durable), the log, and the
 * `onSubagentStats` sink the product rides to the server — then RESET, so turn 4
 * never re-reports turn 3's tree.
 *
 * The prod hole behind it: task 95076757 spawned a tree nobody could size after the
 * fact, because nothing recorded how deep it went or what the walls refused.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import { flushTurnRecords } from '../native-journal.js';
import { treeStats, resetTreeStats, type TreeStats } from '../subagent-pool.js';

const dir = join(tmpdir(), `native-journal-stats-${process.pid}`);
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const file = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId: string) => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(file(taskId)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

/** A cfg/ctx pair carrying only what flushTurnRecords reads. */
const setup = (taskId: string, extra: Partial<NativeConfig> = {}) => {
  resetTreeStats(taskId);
  const journal = make(taskId);
  const cfg = { journal, runtimeConfig: { userId: 'u' }, ...extra } as unknown as NativeConfig;
  const ctx = { taskId, config: cfg } as unknown as HarnessContext<NativeConfig>;
  return { cfg, ctx, journal };
};

const statsEntry = async (taskId: string): Promise<{ data: TreeStats } | undefined> => {
  const raw = await fs.readFile(file(taskId), 'utf8').catch(() => '');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.payload?.type === 'custom' && e.payload?.key === 'subagent_stats')?.payload;
};

describe('flushTurnRecords', () => {
  it('records a turn that spawned: journal entry, log line, sink — then resets', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: TreeStats[] = [];
    const { cfg, ctx } = setup('t-spawned', {
      subagentWalls: true,
      onSubagentStats: (s: TreeStats) => seen.push(s),
    });
    const live = treeStats('t-spawned');
    live.spawned = 4;
    live.maxDepth = 3;
    live.spawnedBySubagents = 2;
    live.refused.depth = 1;
    live.refused.leaf = 5;
    live.stopped.turn_cap = 1;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-spawned'))?.data).toMatchObject({ spawned: 4, maxDepth: 3, spawnedBySubagents: 2 });
    expect(seen).toEqual([live]);
    // R28: the line names EVERY refusal kind — a wall missing from the format is a wall
    // nobody can see was hit, and `leaf` is as real a refusal as `depth`.
    expect(info.mock.calls[0]?.[0]).toContain('[SubagentStats] task=t-spawne spawned=4 max_depth=3 by_subagents=2');
    expect(info.mock.calls[0]?.[0]).toContain('refused=depth:1,lone_child:0,concurrency:0,budget:0,leaf:5');
    expect(info.mock.calls[0]?.[0]).toContain('stopped=user:0,parent:0,turn_cap:1');

    // RESET: the next turn starts from zero, never from this turn's running total.
    expect(treeStats('t-spawned')).toMatchObject({ spawned: 0, maxDepth: 0 });
    // The handed-over object is the caller's to keep — the reset must not blank it.
    expect(seen[0]).toMatchObject({ spawned: 4, maxDepth: 3 });
  });

  it('a refusal alone is worth recording — a wall said no even though nothing spawned', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-refused', { subagentWalls: true });
    treeStats('t-refused').refused.lone_child = 2;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-refused'))?.data).toMatchObject({ spawned: 0, refused: { lone_child: 2 } });
    expect(info).toHaveBeenCalledOnce();
  });

  it('an ALLOW alone is worth recording — the wall let a declared hand-off through', async () => {
    // R128 (review B6). Usually an allow arrives beside a spawn, since the spawn is what was
    // allowed. Not always: a Weave call declaring depends_on is allowed by the root wall and
    // its script may then dispatch no node at all, so the turn's only wall event is the allow.
    // Without `allowed` in the flush guard that turn writes nothing AND has its counts
    // discarded by the reset, which is the one reading the next serial-fg drill needs most.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-allowed', { subagentWalls: true });
    treeStats('t-allowed').allowed.serial_root_dependent = 1;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-allowed'))?.data).toMatchObject({
      spawned: 0, allowed: { serial_root_dependent: 1, serial_root_allowed: 0 },
    });
    expect(info.mock.calls[0]?.[0]).toContain('allowed=serial_root_dependent:1,serial_root_allowed:0');
    expect(treeStats('t-allowed').allowed).toMatchObject({ serial_root_dependent: 0 });   // reset
  });

  it('a stop alone is worth recording — a turn that only killed a running tree', async () => {
    // Nothing spawned and nothing was refused this turn: the tree was already up, and
    // the user stopped it. Without `stopped` in the guard the turn goes silent AND the
    // reset below throws its stop counts away, so the kill is recorded nowhere.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-stopped', { subagentWalls: true });
    treeStats('t-stopped').stopped.user = 2;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-stopped'))?.data).toMatchObject({ spawned: 0, stopped: { user: 2 } });
    expect(info.mock.calls[0]?.[0]).toContain('stopped=user:2,parent:0,turn_cap:0');
  });

  it('a flat turn writes nothing — an empty tally is noise, not a reading', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: TreeStats[] = [];
    const { cfg, ctx } = setup('t-flat', {
      subagentWalls: true,
      onSubagentStats: (s: TreeStats) => seen.push(s),
    });

    await flushTurnRecords(cfg, ctx);

    expect(await statsEntry('t-flat')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('walls OFF: nothing is counted, nothing is reset — the mirror flush alone', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: TreeStats[] = [];
    const { cfg, ctx } = setup('t-dark', { onSubagentStats: (s: TreeStats) => seen.push(s) });
    treeStats('t-dark').spawned = 9;

    await flushTurnRecords(cfg, ctx);

    expect(await statsEntry('t-dark')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(treeStats('t-dark').spawned).toBe(9); // untouched: the dark path reads nothing
    resetTreeStats('t-dark');
  });

  it('still flushes the mirror — the boundary it replaced did that unconditionally', async () => {
    const { cfg, ctx, journal } = setup('t-mirror', { subagentWalls: true });
    const flushMirror = vi.spyOn(journal, 'flushMirror');
    treeStats('t-mirror').spawned = 1;

    await flushTurnRecords(cfg, ctx);
    expect(flushMirror).toHaveBeenCalledOnce();

    // …and with no journal at all it is a no-op, never a throw.
    const bare = { subagentWalls: true } as unknown as NativeConfig;
    await expect(flushTurnRecords(bare, { taskId: 't-none', config: bare } as unknown as HarnessContext<NativeConfig>))
      .resolves.toBeUndefined();
  });

  it('a TEAM message alone is worth recording — the turn spawned nothing and refused nothing', async () => {
    // Phase 3 (§4.9). A turn whose only event was one helper messaging a sibling is exactly
    // the turn this reading exists for: without the team counters in the guard it writes
    // nothing AND has its tally discarded by the reset, so the team surface would leave no
    // trace at all on the turns where it did all the work.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-team', { subagentWalls: true });
    const live = treeStats('t-team');
    live.messagesSent = 2;
    live.hopRefusals = 1;
    live.leadStops = 1;
    live.resumes = 3;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-team'))?.data).toMatchObject({
      spawned: 0, messagesSent: 2, hopRefusals: 1, leadStops: 1, resumes: 3,
    });
    // Named in the line, or a counter nobody reading the logs can see was moved.
    expect(info.mock.calls[0]?.[0]).toContain(
      'team=messages:2,hop_refused:1,lead_stops:1,resumes:3,board_claims:0,board_dones:0',
    );
    expect(treeStats('t-team')).toMatchObject({ messagesSent: 0, resumes: 0 });   // reset
  });

  it('R31 — with every team counter at zero the line is the Phase 2 line, byte for byte', async () => {
    // The engine cannot read the sandbox's HELPER_TEAMWORK_V1, so the counters gate their
    // own segment. All six at zero is what every turn reads with the team surface dark,
    // and an unconditional segment would have moved every walls-on log line on the flag-off
    // build. Pinned as the WHOLE string: a trailing space is invisible to `toContain`.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-noteam', { subagentWalls: true });
    treeStats('t-noteam').spawned = 1;

    await flushTurnRecords(cfg, ctx);

    expect(info.mock.calls[0]?.[0]).toBe(
      '[SubagentStats] task=t-noteam spawned=1 max_depth=0 by_subagents=0 '
      + 'refused=depth:0,lone_child:0,concurrency:0,budget:0,leaf:0,serial_root:0 '
      + 'allowed=serial_root_dependent:0,serial_root_allowed:0 '
      + 'stopped=user:0,parent:0,turn_cap:0',
    );
    expect(info.mock.calls[0]?.[0]).not.toContain('team=');
  });

  it('R31 — one team counter is enough to append the segment, and only the segment', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-onemsg', { subagentWalls: true });
    treeStats('t-onemsg').messagesSent = 1;

    await flushTurnRecords(cfg, ctx);

    // The Phase 2 line, unchanged, with exactly one space before the addition.
    expect(info.mock.calls[0]?.[0]).toBe(
      '[SubagentStats] task=t-onemsg spawned=0 max_depth=0 by_subagents=0 '
      + 'refused=depth:0,lone_child:0,concurrency:0,budget:0,leaf:0,serial_root:0 '
      + 'allowed=serial_root_dependent:0,serial_root_allowed:0 '
      + 'stopped=user:0,parent:0,turn_cap:0'
      + ' team=messages:1,hop_refused:0,lead_stops:0,resumes:0,board_claims:0,board_dones:0',
    );
  });

  it('a BOARD claim alone appends the segment — the counters gate it, not the message count', async () => {
    // §4.9's carry-over: the board is the sixth and seventh things a turn can do, and a turn
    // whose only event was a helper taking an item off the lead's plan spawned nothing,
    // refused nothing and sent nothing. Without them in the sum that turn goes silent.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { cfg, ctx } = setup('t-board', { subagentWalls: true });
    treeStats('t-board').boardClaims = 2;
    treeStats('t-board').boardDones = 1;

    await flushTurnRecords(cfg, ctx);

    expect((await statsEntry('t-board'))?.data).toMatchObject({
      spawned: 0, messagesSent: 0, boardClaims: 2, boardDones: 1,
    });
    expect(info.mock.calls[0]?.[0]).toContain(
      'team=messages:0,hop_refused:0,lead_stops:0,resumes:0,board_claims:2,board_dones:1',
    );
    expect(treeStats('t-board')).toMatchObject({ boardClaims: 0, boardDones: 0 }); // reset
  });
});
