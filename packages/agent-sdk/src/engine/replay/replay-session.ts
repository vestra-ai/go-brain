/**
 * replay-session.ts — drive the REAL kernel loop (NativeHarness.run) from a fixture,
 * keylessly: the recorded rounds answer the model calls (ReplayTransport), the
 * recorded results answer the tool dispatches (ReplayTools), and a fresh journal
 * captures what the loop writes. The contract a fixture pins: the produced journal
 * equals the recording modulo volatile fields, with zero reconstruction mismatches.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageBlock } from '../../contract/blocks.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ScreenshotPrunePolicy } from '../../kernel/compaction/prune-screenshots.js';
import { Journal, liveSuspendedToolUseIds } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';
import type { NativeConfig } from '../native-config.js';
import type { TurnBudget } from '../turn-budget.js';
import { NativeHarness } from '../native-harness.js';
import type { ReconstructionMismatch } from '../reconstruction-invariant.js';
import type { Transport } from '../transport.js';
import { STREAM_SEVERED_CONTINUE_MARKER } from '../severed-stream.js';
import { SUBAGENT_RUNAWAY_DIRECTIVE } from '../subagent-watchdog.js';
import { parseFixture } from './fixture.js';
import { ReplayInteractions, recordingHasPause } from './replay-interactions.js';
import { ReplayTools } from './replay-tools.js';
import { ReplayTransport } from './replay-transport.js';

export interface ReplaySessionOptions {
  /** Default 'throw': a replay exists to prove the invariant, so a mismatch ends the turn loudly. */
  reconstructionCheck?: 'warn' | 'throw';
  /** Real tool definitions to wrap (names/schemas on the wire); absent → stubs synthesized from the recording. */
  tools?: RawToolOptions[];
  /**
   * SCREENSHOT_PRUNE_CACHE_V1: the policy the product's Journal ran under (sandbox screenshotPruneDeps),
   * so a recording made with the flag on re-projects with the same stubs. Absent → the legacy prune.
   */
  screenshotPrune?: ScreenshotPrunePolicy;
  /**
   * W4-2 — build the shadow injection-screen seam over the replay's own journal
   * (a factory because the journal is created inside this function, exactly as
   * the product factory closes over the per-task journal). Absent → no seam →
   * byte-identical replay; a fixture test threads a recording seam here to pin
   * WHICH dispatches the screen fires for.
   */
  injectionScreen?: (journal: Journal) => NonNullable<NativeConfig['injectionScreen']>;
  /**
   * The harness bench's seams (packages/agent-sdk/bench). `transport` wraps the replay
   * transport (the recording still answers every model call; the wrapper builds and
   * measures the real request a wire format would send); `systemPrompt` and `model`
   * replace the 'replay' prompt and the recording's model. Absent → byte-identical.
   */
  transport?: (replay: ReplayTransport) => Transport;
  systemPrompt?: string;
  model?: string;
  /** L5 — the turn's owner, as the product driver mints it (turn-budget.ts). Absent → byte-identical. */
  budget?: TurnBudget;
}

export interface ReplaySessionResult {
  journal: JournalEntry[];
  mismatches: ReconstructionMismatch[];
  events: HarnessEvent[];
  transport: { calls: number; faultsThrown: number; remaining: number };
}

type UserPayload = Extract<JournalPayload, { type: 'user' }>;

/** A recorded turn cannot pause-and-resume unboundedly; a runaway resume loop is a bug, not a replay. */
const MAX_DRIVE_PASSES = 8;

/**
 * A user entry that STARTS a turn (what run() ingests), as opposed to one the engine
 * itself appended mid-turn. The severed continuation marker and the runaway-guard
 * terminal directive (W3-3) are engine-authored user texts the replay itself
 * regenerates (a replayed fault / a replayed trip); steer / recall / hook-context
 * entries are engine-authored too but ride seams a keyless replay does not wire, so
 * a recording that contains them will not replay to equality (documented in the
 * fixture README).
 */
function isTurnStart(e: JournalEntry): e is JournalEntry & { payload: UserPayload } {
  if (e.payload.type !== 'user' || e.payload.control !== undefined) return false;
  // An ENGINE-injected user entry (recalled memory, a resume breadcrumb) is written by
  // the loop mid-turn, not supplied by the driver — replaying it as a turn start would
  // invent a user turn the recording never had.
  if (e.payload.injected !== undefined) return false;
  const text = e.payload.blocks.find((b) => b.type === 'text')?.text;
  return text !== STREAM_SEVERED_CONTINUE_MARKER && text !== SUBAGENT_RUNAWAY_DIRECTIVE;
}

function toUserTurn(e: JournalEntry & { payload: UserPayload }): UserTurn {
  const text = e.payload.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = e.payload.blocks.filter((b): b is ImageBlock => b.type === 'image');
  return { text, ...(images.length ? { images } : {}) };
}

export async function replaySession(fixturePath: string, opts: ReplaySessionOptions = {}): Promise<ReplaySessionResult> {
  const { entries, directives } = parseFixture(await fs.readFile(fixturePath, 'utf8'));
  const first = entries[0];
  if (!first) throw new Error(`replay: ${fixturePath} holds no journal entries`);
  const firstAssistant = entries.find((e) => e.payload.type === 'assistant')?.payload as
    | Extract<JournalPayload, { type: 'assistant' }>
    | undefined;
  const turns = entries.filter(isTurnStart).map(toUserTurn);
  if (!turns.length) throw new Error(`replay: ${fixturePath} holds no user turn to drive`);

  const dir = await fs.mkdtemp(join(tmpdir(), 'vestra-replay-'));
  try {
    // The same identity the recording carries, so every replayed entry's
    // taskId / workspaceId / principal equals the recording's without stripping.
    const journal = new Journal({
      taskId: first.taskId,
      workspaceId: first.workspaceId,
      jsonl: new JsonlStore(join(dir, 'journal.jsonl')),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock(first.timestamp || '2026-01-01T00:00:00.000Z'),
      ...(opts.screenshotPrune ? { screenshotPrune: opts.screenshotPrune } : {}),
    });
    const transport = new ReplayTransport(entries, { directives });
    const systemPrompt = opts.systemPrompt ?? 'replay';
    const replayTools = new ReplayTools(entries);
    const mismatches: ReconstructionMismatch[] = [];
    // The HITL pause plane, OPT-IN BY DATA: a recording with no `interaction` entry
    // gets no port and drives exactly the path it drove before the arm existed.
    const interactions = recordingHasPause(entries) ? new ReplayInteractions(entries) : undefined;
    const config: NativeConfig = {
      onAttached: () => {},
      // A recorded turn is bounded by however many rounds it took; the recording, not
      // the product's cap, is the bound here (past its last round the transport throws).
      maxTurns: 200,
      systemPrompt,
      transport: opts.transport ? opts.transport(transport) : transport,
      journal,
      abilities: [],
      toolHost: {
        buildTools: async () => ({
          tools: replayTools.wrap(opts.tools ?? replayTools.stubsFor()),
          onAuthHalt: async () => {},
        }),
      },
      // Production retry budget; only the backoff is shortened (a replay waits for nothing).
      retry: { backoffMs: 1 },
      runtimeConfig: makeRuntimeConfig({ userId: first.workspaceId, systemPrompt }),
      reconstructionCheck: opts.reconstructionCheck ?? 'throw',
      onReconstructionMismatch: (m) => mismatches.push(m),
      // W4-2 — thread the (test-built) shadow-screen seam like the product does.
      ...(opts.injectionScreen !== undefined ? { injectionScreen: opts.injectionScreen(journal) } : {}),
      // The pause plane: `onPause` mints the id the recording used, so the replayed
      // `interaction` entry equals the recorded one.
      ...(interactions !== undefined ? { interaction: interactions.port(), policy: interactions.policy() } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    };
    const ctx: HarnessContext<NativeConfig> = {
      taskId: first.taskId,
      sessionId: 'replay',
      cwd: dir,
      model: opts.model ?? firstAssistant?.model ?? 'replay',
      signal: new AbortController().signal,
      config,
    };
    /** The product's step-3 re-check, read the way orchestrateContinue reads it (off disk). */
    const liveSuspended = async (): Promise<Set<string>> => {
      const all: JournalEntry[] = [];
      for await (const e of journal.read()) all.push(e);
      return liveSuspendedToolUseIds(all);
    };
    const events: HarnessEvent[] = [];
    // A HITL pause ENDS run() (native-harness.ts: `pausedHalt` breaks the user-turn
    // loop), exactly as it ends the product's run — the resume is a NEW run driven by
    // `_driveContinuation`. So the rail drives PASSES: each pass hands the harness the
    // turns still owed, and a pass that ends paused is followed by the resume
    // (orchestrateContinue steps 2–4) and a fresh pass carrying one continue turn.
    // The journal and the transport are shared across passes — the WARM continue, the
    // path a pause-turn desync lives on. Without a pause the first pass consumes
    // everything and the loop exits after one iteration (byte-identical to the
    // single-run rail).
    const owed: UserTurn[] = [...turns];
    for (let pass = 0; pass < MAX_DRIVE_PASSES && owed.length > 0; pass++) {
      const batch = owed.splice(0, owed.length);
      let consumed = 0;
      const input = (async function* (): AsyncIterable<UserTurn> {
        for (const t of batch) {
          consumed++;
          yield t;
        }
      })();
      for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
      owed.unshift(...batch.slice(consumed)); // whatever the paused run never pulled
      if (!interactions) break;
      if ((await liveSuspended()).size === 0) continue; // the pass did not end suspended
      await journal.reconcileInteractions(interactions.resolver());
      if ((await liveSuspended()).size > 0) break; // partial resolution → stays suspended
      owed.unshift({ text: '', continueInteraction: true });
    }
    const produced: JournalEntry[] = [];
    for await (const e of journal.read()) produced.push(e);
    return {
      journal: produced,
      mismatches,
      events,
      transport: { calls: transport.calls, faultsThrown: transport.faultsThrown, remaining: transport.remaining },
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
