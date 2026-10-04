/**
 * COMPACTION_V2 — the harness-level behavior, on all three flag axes.
 *
 *   OFF  — byte-identical: same trigger point, no lane event, no cache opt-out,
 *          no file trail, no deferred latch.
 *   ON   — the feature: fires at the preferred input ceiling, meters the summarize on the
 *          `compaction` lane, opts the one-shot out of the prompt cache, appends
 *          and accumulates the mechanical file trail, labels a previous summary.
 *   ON, base behavior — a short session still does not compact, and a model with
 *          no declared preferredMaxInputTokens still fires at the same 80%-of-window
 *          ceiling it always did.
 *
 * The headline defect: on a 1M-window model the pre-V2 trigger sat at ~800k, so a
 * long task re-read half a million tokens every round (context volume, not rate —
 * Anthropic bills the full window at standard rate). The first two tests are the
 * same conversation on each side of the flag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { COMPACTION_PREVIOUS_SUMMARY_LABEL, COMPACTION_ITERATIVE_SECTION } from '../../contract/compaction-prompt.js';
import { FILE_TRAIL_HEADER } from '../../kernel/compaction/file-trail.js';
import type { NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const SESSION_COMPACTED_EVENT = 'session:compacted';

afterEach(() => {
  delete process.env.COMPACTION_V2;
});

function doneEvent(stopReason: string | null = 'end_turn'): StreamEvent {
  return { kind: 'done', stopReason, usage: { inputTokens: 1000, outputTokens: 20 } as NormalizedUsage };
}

/** Serves scripted rounds in order; records every call's params via FakeTransport. */
class ScriptedTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly steps: StreamEvent[][]) {
    super([]);
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): StreamEvent[] {
    super.callModel(p);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    return step;
  }
  override computeCostUsd(): number {
    return 0.02;
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
  const path = join(tmpdir(), `cv2-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/**
 * Seed turns totalling roughly `targetTokens` in the ledger's heuristic — enough to
 * sit ABOVE a 1M model's 200k preferred ceiling but far BELOW its 800k window ceiling.
 * That gap is exactly where the two flag states must disagree.
 */
async function seedTokens(j: Journal, taskId: string, targetTokens: number): Promise<void> {
  // estimateTokens ≈ chars/4, so ~4 chars per token.
  const chunk = 'context '.repeat(500); // ~4000 chars ≈ 1000 tokens
  const turns = Math.ceil(targetTokens / 2000); // user + assistant per turn
  for (let i = 0; i < turns; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i} ${chunk}` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i} ${chunk}` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    });
  }
}

async function seedToolUse(j: Journal, taskId: string, name: string, input: unknown): Promise<void> {
  await j.append({
    ...base(taskId),
    payload: { type: 'tool_use', toolUseId: `tu-${Math.random().toString(36).slice(2)}`, name, input },
  });
}

async function runTurn(opts: {
  taskId: string;
  journal: Journal;
  transport: ScriptedTransport;
  model?: string;
  compaction?: NativeConfig['compaction'];
}): Promise<HarnessEvent[]> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 4,
    transport: opts.transport,
    journal: opts.journal,
    compaction: opts.compaction ?? { keepWindowTokens: 2_000 },
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-cv2',
    cwd: '/tmp',
    model: opts.model ?? 'claude-sonnet-5',
    signal: new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'continue' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

function compactions(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === SESSION_COMPACTED_EVENT);
}
function laneEvents(events: HarnessEvent[], lane: string): HarnessEvent[] {
  return events.filter((e) => e.kind === 'usage' && (e as { lane?: string }).lane === lane);
}
function summaryTextOf(events: HarnessEvent[]): string {
  const c = compactions(events)[0] as { data?: { summary?: string } } | undefined;
  return c?.data?.summary ?? '';
}

// ─── AXIS 1 + 2: the trigger, on each side of the flag ───────────────────────

describe('COMPACTION_V2 — trigger economics', () => {
  const script: StreamEvent[][] = [
    [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
    [{ kind: 'text', text: 'answer' }, doneEvent()],
  ];

  it('OFF: a 260k-token context on a 1M model does NOT compact — the old 800k trigger', async () => {
    const taskId = 'cv2-off';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 260_000);
    const transport = new ScriptedTransport([[{ kind: 'text', text: 'answer' }, doneEvent()]]);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(0);
    expect(transport.calls).toBe(1); // no summarize call happened
  });

  it('ON: the SAME context compacts — it crossed the 200k preferred ceiling', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-on';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 260_000);
    const transport = new ScriptedTransport(script);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(1);
    expect(transport.calls).toBe(2); // summarize + the real round
  });

  it('ON, base sane: a SHORT session still does not compact', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-short';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 4_000);
    const transport = new ScriptedTransport([[{ kind: 'text', text: 'answer' }, doneEvent()]]);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(0);
    expect(transport.calls).toBe(1);
  });

  it('ON, base sane: a model with NO declared preferred ceiling keeps the 80% window ceiling (haiku, 200k → 160k)', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-haiku';
    const j = makeJournal(taskId);
    // 60k: over sonnet-5's 180k preferred bound? No — and well under haiku's 160k ceiling.
    await seedTokens(j, taskId, 60_000);
    const transport = new ScriptedTransport([[{ kind: 'text', text: 'answer' }, doneEvent()]]);
    const events = await runTurn({ taskId, journal: j, transport, model: 'claude-haiku-4-5' });

    expect(compactions(events)).toHaveLength(0);
  });
});

// ─── The summarize call: cache posture, metering, prompt ─────────────────────

describe('COMPACTION_V2 — summarize call hygiene', () => {
  const script: StreamEvent[][] = [
    [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
    [{ kind: 'text', text: 'answer' }, doneEvent()],
  ];

  it('ON: the summarize one-shot asks for NO prompt-cache write; the real round does not', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-cache';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 260_000);
    const transport = new ScriptedTransport(script);
    await runTurn({ taskId, journal: j, transport });

    // Call 0 is the summarize (it runs at the round head, before the model round).
    expect(transport.noCacheWrites[0]).toBe(true);
    expect(transport.noCacheWrites[1]).toBeUndefined();
  });

  it('OFF: no call ever opts out — the request shape is byte-identical to today', async () => {
    const taskId = 'cv2-cache-off';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 900_000); // over the 800k ceiling so it compacts even OFF
    const transport = new ScriptedTransport(script);
    await runTurn({ taskId, journal: j, transport });

    expect(transport.noCacheWrites.every((v) => v === undefined)).toBe(true);
  });

  it('ON: the summarize is metered on the `compaction` lane', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-lane';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 260_000);
    const transport = new ScriptedTransport(script);
    const events = await runTurn({ taskId, journal: j, transport });

    const lane = laneEvents(events, 'compaction');
    expect(lane).toHaveLength(1);
    const usage = (lane[0] as { usage?: NormalizedUsage; laneStatus?: string });
    expect(usage.laneStatus).toBe('ok');
    expect(usage.usage?.inputTokens).toBe(1000); // the summarize call's real usage
  });

  it('OFF: no lane event — the pre-V2 books are unchanged', async () => {
    const taskId = 'cv2-lane-off';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 900_000);
    const transport = new ScriptedTransport(script);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(1); // it DID compact
    expect(laneEvents(events, 'compaction')).toHaveLength(0); // but metered nothing
  });
});

// ─── The mechanical file trail ───────────────────────────────────────────────

describe('COMPACTION_V2 — the file trail is mechanical and cumulative', () => {
  const script: StreamEvent[][] = [
    [{ kind: 'text', text: 'SUMMARY OF EARLIER WORK' }, doneEvent()],
    [{ kind: 'text', text: 'answer' }, doneEvent()],
  ];

  it('ON: read + modified paths are appended to the summary from the tool calls themselves', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-trail';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 260_000);
    await seedToolUse(j, taskId, 'Read', { file_path: '/repo/read-me.ts' });
    await seedToolUse(j, taskId, 'Write', { file_path: '/repo/wrote-me.ts' });
    // RE-RULED by T9b (fixture only): two ordinary turns are seeded AFTER the tool
    // calls. The boundary set is now {user, assistant}, so the cut stops at the
    // assistant boundary the raw token-walk reaches instead of snapping forward past
    // it to the trailing user turn — which means trailing tool calls now land on the
    // KEPT side, where their paths are still in context verbatim and a trail entry
    // would be redundant. Putting them behind two more turns keeps them in the
    // DROPPED span, which is what this test is about.
    await seedTokens(j, taskId, 4_000);
    const events = await runTurn({ taskId, journal: j, transport: new ScriptedTransport(script) });

    const summary = summaryTextOf(events);
    expect(summary).toContain(FILE_TRAIL_HEADER);
    expect(summary).toContain('/repo/read-me.ts');
    expect(summary).toContain('/repo/wrote-me.ts');
    // The model produced only the prose; the paths came from the journal.
    expect(summary).toContain('SUMMARY OF EARLIER WORK');
  });

  it('OFF: no trail block — the summary is exactly what the model returned', async () => {
    const taskId = 'cv2-trail-off';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 900_000);
    await seedToolUse(j, taskId, 'Read', { file_path: '/repo/read-me.ts' });
    const events = await runTurn({ taskId, journal: j, transport: new ScriptedTransport(script) });

    expect(summaryTextOf(events)).not.toContain(FILE_TRAIL_HEADER);
  });
});

// ─── Iterative summarization ─────────────────────────────────────────────────

describe('COMPACTION_V2 — iterative summarization', () => {
  it('ON: a SECOND compaction labels the previous summary and asks the model to carry it forward', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-iterative';
    const j = makeJournal(taskId);

    // First compaction.
    await seedTokens(j, taskId, 260_000);
    await seedToolUse(j, taskId, 'Read', { file_path: '/first/a.ts' });
    // RE-RULED by T9b (fixture only): two ordinary turns are seeded AFTER the tool
    // calls. The boundary set is now {user, assistant}, so the cut stops at the
    // assistant boundary the raw token-walk reaches instead of snapping forward past
    // it to the trailing user turn — which means trailing tool calls now land on the
    // KEPT side, where their paths are still in context verbatim and a trail entry
    // would be redundant. Putting them behind two more turns keeps them in the
    // DROPPED span, which is what this test is about.
    await seedTokens(j, taskId, 4_000);
    const t1 = new ScriptedTransport([
      [{ kind: 'text', text: 'FIRST SUMMARY' }, doneEvent()],
      [{ kind: 'text', text: 'ok' }, doneEvent()],
    ]);
    const first = await runTurn({ taskId, journal: j, transport: t1 });
    expect(compactions(first)).toHaveLength(1);
    // The FIRST summarize saw no previous summary, so its system prompt is the
    // evaluated one — the iterative section must be absent.
    expect(t1.systems[0]).not.toContain(COMPACTION_ITERATIVE_SECTION);

    // Grow past the preferred bound again, touching a NEW file, then compact a second time.
    await seedTokens(j, taskId, 260_000);
    await seedToolUse(j, taskId, 'Write', { file_path: '/second/b.ts' });
    await seedTokens(j, taskId, 4_000); // same T9b fixture re-rule as above
    const t2 = new ScriptedTransport([
      [{ kind: 'text', text: 'SECOND SUMMARY' }, doneEvent()],
      [{ kind: 'text', text: 'ok' }, doneEvent()],
    ]);
    const second = await runTurn({ taskId, journal: j, transport: t2 });

    expect(compactions(second)).toHaveLength(1);
    // The system prompt now carries the iterative section...
    expect(t2.systems[0]).toContain(COMPACTION_ITERATIVE_SECTION);
    // ...and the trail ACCUMULATED: the first compaction's file survives into the
    // second summary even though the span that produced it has been dropped.
    const summary = summaryTextOf(second);
    expect(summary).toContain('/first/a.ts');
    expect(summary).toContain('/second/b.ts');
  });

  it('the previous-summary label is a distinct, non-empty marker the model can see', () => {
    // A guard on the constant itself: an empty or whitespace label would silently
    // turn the iterative path back into "an anonymous user turn".
    expect(COMPACTION_PREVIOUS_SUMMARY_LABEL.trim().length).toBeGreaterThan(20);
  });
});

// ─── The deferred (truncated-stop) overflow latch + its two guards ───────────

describe('COMPACTION_V2 — deferred overflow recovery', () => {
  /** A round that TRUNCATES on context: the request SUCCEEDS, nothing throws. */
  const truncated: StreamEvent[] = [
    { kind: 'text', text: 'a half-written ans' },
    doneEvent('model_context_window_exceeded'),
  ];

  it('ON: a truncated round arms the latch; the NEXT round head force-compacts', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-truncate';
    const j = makeJournal(taskId);
    // Deliberately BELOW the preferred bound: only the latch can explain a compaction here.
    await seedTokens(j, taskId, 20_000);
    const transport = new ScriptedTransport([
      truncated,
      [{ kind: 'text', text: 'RECOVERY SUMMARY' }, doneEvent()],
      [{ kind: 'text', text: 'done' }, doneEvent()],
    ]);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(1);
  });

  it('OFF: the same truncated round compacts nothing — the class is invisible pre-V2', async () => {
    const taskId = 'cv2-truncate-off';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 20_000);
    const transport = new ScriptedTransport([truncated, [{ kind: 'text', text: 'done' }, doneEvent()]]);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(0);
  });

  it('ON: max_tokens is NOT treated as an overflow — a long answer must not force-compact', async () => {
    process.env.COMPACTION_V2 = '1';
    const taskId = 'cv2-maxtokens';
    const j = makeJournal(taskId);
    await seedTokens(j, taskId, 20_000);
    const transport = new ScriptedTransport([
      [{ kind: 'text', text: 'a very long answer' }, doneEvent('max_tokens')],
      [{ kind: 'text', text: 'done' }, doneEvent()],
    ]);
    const events = await runTurn({ taskId, journal: j, transport });

    expect(compactions(events)).toHaveLength(0);
  });
});
