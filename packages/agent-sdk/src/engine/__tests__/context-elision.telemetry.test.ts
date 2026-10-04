/**
 * CONTEXT_ELISION_V1 — the turn's elision decision is a QUERYABLE fact.
 *
 * The mechanism shipped armed and unobservable. A live-fire drill on staging
 * proved it fires — 9 results elided, 472KB spilled, `request_bytes` flat across a
 * conversation holding all that output — but it could only prove it by listing
 * spill files on the sandbox's disk, because `elidedResults` / `elidedImages` /
 * `freedTokens` were computed, parked on `rc.elision`, and read by nothing. There
 * were zero elision rows in `log_events`. "Did elision fire on this turn?" had no
 * answer in any durable record.
 *
 * The load-bearing assertions here are the two that a "a row was written" test
 * would pass without:
 *
 *   1. The row carries the SAME numbers as the frozen decision. A row of zeros is
 *      indistinguishable from no elision at all, and would make every rate the
 *      consumer computes silently wrong rather than absent.
 *   2. A turn that elides NOTHING writes NO row. Without that, row COUNT is not a
 *      signal — and row count is exactly what the consumer's darkness detector,
 *      and the "how many turns did it fire on" denominator, are built from.
 *
 * Runs over the real machinery — a real Journal, the real cut, the real
 * elideProjection — reusing the fixture shape of context-elision.rewrite-release.
 */

import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { prepareElision } from '../context-elision.js';
import { createRunContext } from '../run-context.js';
import type { NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';

/**
 * BOTH flags are stubbed at the module, never via process.env.
 *
 * Vitest runs test files concurrently in threads that SHARE `process.env`, so a
 * file that sets `COMPACTION_V2` for its own lifetime turns off the "OFF" cases of
 * native-harness.compaction-v2.test.ts running beside it — observed, not feared:
 * an env-mutating draft of this file reddened exactly those two tests and nothing
 * else. A module stub is scoped to THIS file's module graph, so it cannot reach
 * another file at all.
 *
 * V2 has to be on because `resolveCompactionBudget` otherwise returns the far
 * larger `ceilingTokens`, and at this fixture size that budget puts the cut at zero
 * — elision could not fire whatever the elision flag said.
 */
let elisionOn = true;
vi.mock('../../policy/feature-flags.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/feature-flags.js')>()),
  contextElisionEnabled: () => elisionOn,
  compactionV2Enabled: () => true,
}));

const KEEP_WINDOW_TOKENS = 20_000;
/** ~15,000 estimated tokens of tool output per turn. */
const fatBody = 'result-line-of-output '.repeat(2_700);

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(
    tmpdir(),
    `elide-telemetry-${process.pid}-${Math.random().toString(36).slice(2)}`,
    `${taskId}.jsonl`,
  );
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

async function seedTurns(j: Journal, taskId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { file_path: `/f${i}` } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: `tu-${i}`,
        blocks: [{ type: 'text', text: fatBody } as ContentBlock],
      },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'fake-model',
      },
    });
  }
}

function harness(taskId: string, j: Journal): { ctx: HarnessContext<NativeConfig>; cfg: NativeConfig } {
  const cfg = {
    journal: j,
    compaction: { keepWindowTokens: KEEP_WINDOW_TOKENS },
    workingDir: join(tmpdir(), `elide-tel-${process.pid}-${Math.random().toString(36).slice(2)}`),
  } as unknown as NativeConfig;
  return {
    cfg,
    ctx: {
      taskId,
      sessionId: 's',
      cwd: '/tmp',
      model: 'claude-sonnet-5',
      signal: new AbortController().signal,
      config: cfg,
    } as HarnessContext<NativeConfig>,
  };
}

/** Every `context_elision` row on the journal, in append order. */
async function elisionRows(j: Journal): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of await j.snapshot()) {
    if (e.payload.type === 'custom' && e.payload.key === 'context_elision') {
      out.push(e.payload.data as Record<string, unknown>);
    }
  }
  return out;
}

describe('prepareElision — context_elision telemetry', () => {
  it('records the turn’s decision with the SAME numbers the turn froze', async () => {
    elisionOn = true;
    const taskId = 't-elision-telemetry';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const { ctx, cfg } = harness(taskId, j);
    const rc = createRunContext(taskId);
    rc.billing.roundCounter.value = 7;

    const frozen = await prepareElision(ctx, cfg, rc);
    expect(frozen).not.toBeNull();
    expect(frozen!.elidedResults).toBeGreaterThan(0);

    const rows = await elisionRows(j);
    // ONE PER TURN — prepareElision freezes once and every round reuses the map.
    expect(rows).toHaveLength(1);
    // A row of zeros would be indistinguishable from "elision never fired".
    expect(rows[0]).toMatchObject({
      round: 7,
      model: 'claude-sonnet-5',
      elidedResults: frozen!.elidedResults,
      elidedImages: frozen!.elidedImages,
      freedTokens: frozen!.freedTokens,
      resultCutTokens: frozen!.cut.resultCutTokens,
      strideTokens: frozen!.cut.strideTokens,
    });
    expect(rows[0].freedTokens as number).toBeGreaterThan(0);
  });

  it('writes NO row when the turn elides nothing — so row COUNT is a real signal', async () => {
    elisionOn = true;
    const taskId = 't-elision-quiet';
    const j = makeJournal(taskId);
    // Two turns is far below the cut — computeElisionCut returns zero, and
    // prepareElision returns before it could record anything.
    await seedTurns(j, taskId, 2);

    const { ctx, cfg } = harness(taskId, j);
    expect(await prepareElision(ctx, cfg, createRunContext(taskId))).toBeNull();
    expect(await elisionRows(j)).toHaveLength(0);
  });

  it('writes NO row with the flag off — an unarmed mechanism reports nothing, not zeros', async () => {
    elisionOn = false;
    const taskId = 't-elision-flag-off';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const { ctx, cfg } = harness(taskId, j);
    expect(await prepareElision(ctx, cfg, createRunContext(taskId))).toBeNull();
    expect(await elisionRows(j)).toHaveLength(0);
  });

  it('is CONTEXT_POLICY:false — the row never replays into the model’s context', async () => {
    elisionOn = true;
    const taskId = 't-elision-noncontext';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 20);

    const { ctx, cfg } = harness(taskId, j);
    await prepareElision(ctx, cfg, createRunContext(taskId));
    expect(await elisionRows(j)).toHaveLength(1);

    const projected = (await j.project()).messages;
    expect(
      projected.filter((e) => e.payload.type === 'custom' && e.payload.key === 'context_elision'),
    ).toHaveLength(0);
  });
});
