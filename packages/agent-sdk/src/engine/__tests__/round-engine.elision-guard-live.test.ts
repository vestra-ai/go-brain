/**
 * The reconstruction guard is LIVE on the real turn path under CONTEXT_ELISION_V1.
 *
 * `checkRoundReconstruction` gates itself on
 *   `canProject = deps.elision !== undefined || !contextElisionEnabled()`
 * and SKIPS when the flag is on but `elision` was not threaded — deliberately, so
 * it does not cry wolf against a raw projection the wire was not built from
 * (reconstruction-invariant.test.ts pins both branches of that decision).
 *
 * That gate FAILS OPEN, and the thing it depends on is a single optional property
 * on the deps object `iterateTurn` hands `runOneRound`. `elision` is declared
 * `elision?: FrozenElision | null`, so a refactor that stops threading it
 * TYPECHECKS CLEAN and silently retires the one guard that would catch an elision
 * desync — the repo's most-documented defect shape, a check whose failure mode is
 * silence. Verified by mutation: dropping `elision` at the call site passed
 * `tsc --noEmit` and all 1191 engine tests before this file existed.
 *
 * This test closes that hole from the outside, without changing the gate's
 * behaviour. It drives the REAL `NativeHarness.run()` path with the flag ON and
 * asserts the check actually projected, by counting the extra
 * `historyFromJournal` call the check makes on top of the turn's own wire build.
 * Drop `elision` at the call site and `canProject` goes false, the check skips,
 * the extra projection disappears, and this goes red.
 *
 * Making the gate fail CLOSED is deliberately NOT done here: `elision: undefined`
 * is a modeled, separately-tested state, and the guard's own contract is that a
 * failure inside it never costs a turn. See the task report's follow-up note.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type NormalizedUsage, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';

const FLAG = 'CONTEXT_ELISION_V1';

afterEach(() => {
  delete process.env[FLAG];
});

/** Counts every wire projection built through the transport. */
class CountingTransport extends FakeTransport {
  projections = 0;
  constructor() {
    super([
      { kind: 'text', text: 'ok' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } as NormalizedUsage },
    ]);
  }
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    this.projections += 1;
    return super.historyFromJournal(entries);
  }
  override computeCostUsd(): number {
    return 0;
  }
}

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
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(
      join(tmpdir(), `elision-guard-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`),
    ),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** One prior user → assistant round, so the projection has something to compare. */
async function seed(j: Journal, taskId: string): Promise<void> {
  await j.append({
    ...base(taskId),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text: 'q0' } as ContentBlock] },
  });
  await j.append({
    ...base(taskId),
    payload: {
      type: 'assistant',
      blocks: [{ type: 'text', text: 'a0' } as ContentBlock],
      api: 'anthropic_messages',
      provider: 'anthropic',
      model: 'fake-model',
    },
  });
}

/** Drive one real turn through NativeHarness.run() and report the projection count. */
async function runTurn(taskId: string, mode: 'warn' | 'off'): Promise<number> {
  const journal = makeJournal(taskId);
  await seed(journal, taskId);
  const transport = new CountingTransport();
  const cfg = {
    onAttached: () => {},
    maxTurns: 2,
    transport,
    journal,
    workingDir: join(tmpdir(), `elision-guard-wd-${process.pid}-${Math.random().toString(36).slice(2)}`),
    reconstructionCheck: mode,
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId,
    sessionId: 's-elision-guard',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'next question' };
  })();
  for await (const _ev of new NativeHarness().run(input, ctx)) void _ev;
  return transport.projections;
}

describe('reconstruction guard stays live under CONTEXT_ELISION_V1 (the call site threads `elision`)', () => {
  it('with the flag ON, the check still projects — proving iterateTurn threaded `elision` into runOneRound', async () => {
    process.env[FLAG] = '1';

    // 'off' is the floor: the turn's own wire build, with no check on top.
    const floor = await runTurn('t-guard-off', 'off');
    // 'warn' is the production default: the check adds ONE projection per round.
    const withCheck = await runTurn('t-guard-warn', 'warn');

    expect(floor).toBeGreaterThan(0); // the turn really ran
    // THE DISCRIMINATOR. If `elision` stops being threaded at the runOneRound call
    // site, `canProject` is false under this flag, the check silently skips, and
    // this equality-with-floor is what you get instead.
    expect(withCheck).toBeGreaterThan(floor);
  });

  it('the guard is flag-independent: with the flag OFF the check projects too (raw IS the wire seam)', async () => {
    delete process.env[FLAG];

    const floor = await runTurn('t-guard-off-flagoff', 'off');
    const withCheck = await runTurn('t-guard-warn-flagoff', 'warn');

    expect(floor).toBeGreaterThan(0);
    expect(withCheck).toBeGreaterThan(floor);
  });
});
