/**
 * The pairing PROPERTY: whatever order the live loop writes the journal in, every wire
 * dialect gets each tool call's result right after it, and no result without its call.
 *
 * Live prod task 28edef30 (2026-09-28) broke that with one specific interleaving (a stale
 * approval resolved while a sibling Bash step was paused, so the forward-resume
 * breadcrumb landed between a tool_use and its later result). PR #3930 fixed that shape
 * in `project()`. This suite closes the CLASS: a seeded, deterministic generator drives
 * the REAL Journal API (and the real `orchestrateContinue`) through random interleavings
 *   - user turns, assistant rounds, tool batches whose results land in completion order;
 *   - pauses (tool_permission / composio_auth / ask_question) and `deferSuspended()`;
 *   - continues with random allow/deny, stale (deferred) ones included, resolved while a
 *     sibling pause is still open, each followed by the drive it would trigger;
 *   - aborts mid-batch (`healOrphanedToolUse`);
 *   - breadcrumbs (forward-resume, world-delta) and user messages written while paused;
 *   - half the rounds as the live Anthropic loop writes them: the assistant entry carries
 *     the sealed `anthropicBlocks` channel (signed thinking, text, every tool_use of the
 *     round; round-stream.ts settleRoundOutput), the rest as the split legacy shape;
 * and after EVERY step checks `project()` plus each provider's wire projection:
 *   - journal: a result sits in its call's UNIT (its run of uses plus the result run
 *     after it, keepToolResultsAdjacent's rule), and every call has one result;
 *   - Anthropic: every tool_use answered by the LEADING tool_result blocks of the next
 *     message, no stray results, and neither the tripwire nor the floor had to act;
 *   - Chat Completions: assistant tool_calls followed at once by one `tool` message per id;
 *   - OpenAI Responses / Gemini Interactions: each call's output inside the call's tool
 *     block (only calls/outputs between), no output without its call;
 *   - Gemini generateContent: the next content leads with one functionResponse per call.
 *
 * A failure prints the seed and the step log; replay one with PAIRING_SEED=<n>.
 */
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { JournalEntry, JournalPayload, NewEntry } from '../../contract/journal.js';
import type { InteractionKind, InteractionOutcome } from '../../contract/interaction.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { InMemoryStatePort } from '../../ports/state-port.js';
import { orchestrateContinue } from '../continue-orchestrator.js';
import { journalToAnthropicMessages } from '../native-messages.js';
import { journalToChatCompletionsMessages } from '../../transports/chat-completions-messages.js';
import { journalToOpenAIResponsesInput } from '../../transports/openai-responses-messages.js';
import { journalToGeminiContents } from '../../transports/gemini-messages.js';
import { journalToGeminiInteractionsSteps } from '../../transports/gemini-interactions-messages.js';
import type { GeminiContent } from '../request-validity.js';
import type { GeminiInteractionsStep } from '../../transports/gemini-interactions-wire.js';

const SEQUENCES = 500;
const STEPS_PER_SEQUENCE = 14;
const ONLY_SEED = process.env.PAIRING_SEED ? Number(process.env.PAIRING_SEED) : undefined;

/**
 * The JSONL store with the disk taken out: the same append/read/mtime contract the
 * Journal relies on, kept in memory so 500 journals run in a few seconds. Everything
 * above the store (the read-model, project(), reconcile, defer, heal) is the real kernel.
 */
class MemoryJsonl extends JsonlStore {
  private readonly lines: JournalEntry[] = [];
  constructor() {
    super('memory');
  }
  override async append(entry: JournalEntry): Promise<void> {
    this.lines.push(entry);
  }
  override async fsync(): Promise<void> {}
  override async mtimeMs(): Promise<number | null> {
    return this.lines.length === 0 ? null : this.lines.length;
  }
  override async *read(): AsyncIterable<JournalEntry> {
    yield* this.lines;
  }
}

// ── seeded randomness (mulberry32) ───────────────────────────────────────────

function makeRand(seed: number) {
  let a = seed >>> 0;
  const f = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number): number => Math.floor(f() * n),
    chance: (p: number): boolean => f() < p,
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(f() * xs.length)],
  };
}
type Rand = ReturnType<typeof makeRand>;

// ── the simulated live loop, writing through the real kernel ─────────────────

const PAUSE_KINDS: ReadonlyArray<{ kind: InteractionKind; toolName: string }> = [
  { kind: 'tool_permission', toolName: 'Bash' },
  { kind: 'composio_auth', toolName: 'GMAIL_SEND_EMAIL' },
  { kind: 'ask_question', toolName: 'AskUserQuestion' },
];
const TOOL_NAMES = ['Bash', 'Read', 'GMAIL_SEND_EMAIL', 'AskUserQuestion'];

interface OpenPause {
  interactionId: string;
  toolUseId: string;
  kind: InteractionKind;
  toolName: string;
}

const text = (t: string) => [{ type: 'text', text: t } as never];

/** How often each interesting shape came up across the run, so the generator cannot quietly degenerate. */
const seen = new Map<string, number>();
const note = (shape: string) => seen.set(shape, (seen.get(shape) ?? 0) + 1);

class Sim {
  readonly log: string[] = [];
  private n = 0;
  /** Pauses whose interaction is still resolved:false (live-suspended OR deferred). */
  private open: OpenPause[] = [];
  /** Tool uses answered by a deferral, so a later resolve of their card is a stale one. */
  private deferred = new Set<string>();

  constructor(readonly j: Journal, private readonly r: Rand, private readonly taskId: string) {}

  private id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  private entry(payload: JournalPayload): NewEntry {
    return {
      taskId: this.taskId, rootTaskId: this.taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' }, timestamp: '', payload,
    };
  }

  private async live(): Promise<boolean> {
    return (await this.j.liveSuspendedIds()).size > 0;
  }

  /** A person's message: the sandbox defers every live pause first (continue-alongside). */
  async userTurn(): Promise<void> {
    const deferred = (await this.live()) ? await this.j.deferSuspended('The user sent a new message before this finished.') : [];
    for (const id of deferred) this.deferred.add(id);
    if (deferred.length) note('deferred a pause');
    this.log.push(`user${deferred.length ? ` (deferred ${deferred.join(',')})` : ''}`);
    await this.j.append({ ...this.entry({ type: 'user', blocks: text(`ask ${this.n}`) }), principal: { kind: 'user', userId: 'u' } });
    await this.drive();
  }

  /** A user-role entry written straight into a paused journal, with no defer (time order, not wire order). */
  async userWhilePaused(): Promise<void> {
    this.log.push('user-raw');
    note('user message while paused');
    await this.j.append({ ...this.entry({ type: 'user', blocks: text('note while paused') }), principal: { kind: 'user', userId: 'u' } });
  }

  async breadcrumb(): Promise<void> {
    if (this.r.chance(0.5)) {
      this.log.push('world-delta breadcrumb');
      await this.j.appendWorldDeltaBreadcrumb('[System] About 3 hours passed while this task was paused.');
    } else {
      const p = this.r.pick(PAUSE_KINDS);
      this.log.push(`forward breadcrumb ${p.kind}`);
      await this.j.appendForwardResumeBreadcrumb([{ ...p, outcome: { behavior: 'allow' } }]);
    }
  }

  /** One drive: up to three model rounds, ending at a pause, an abort, or a text-only round. */
  async drive(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const k = this.r.int(4);
      const calls = Array.from({ length: k }, () => {
        const pause = this.r.chance(0.25) ? this.r.pick(PAUSE_KINDS) : undefined;
        return { id: this.id('tu'), name: pause?.toolName ?? this.r.pick(TOOL_NAMES), pause };
      });
      const said = `round ${this.n}`;
      if (this.r.chance(0.5)) {
        // The live Anthropic round: settleRoundOutput journals the provider's message as sent
        // (signed thinking, text, every tool_use of the round) BEFORE the tool batch runs.
        const thinking = { type: 'thinking', thinking: 'weighing it', signature: `sig-${this.n}` } as const;
        await this.j.append(this.entry({
          type: 'assistant', api: 'anthropic_messages', provider: 'anthropic',
          blocks: [thinking as never, ...text(said)],
          anthropicBlocks: [thinking, { type: 'text', text: said }, ...calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: { n: c.id } }))],
        }));
        note('sealed anthropic round');
        if (calls.some((c) => c.pause)) note('sealed round with a paused call');
      } else {
        await this.j.append(this.entry({ type: 'assistant', blocks: text(said) }));
      }
      if (k === 0) { this.log.push('  round: text'); return; }
      // The batch writes the way round-tool-batch does: the calls split into ordered
      // segments; a CONCURRENT run journals all its uses, then its ends (result or pause
      // marker) in completion order; a SEQUENTIAL tool journals its use, then its end.
      // A paused tool's result arrives later, from a continue or a defer.
      const events: Array<{ at: 'use' | 'end'; c: (typeof calls)[number] }> = [];
      for (let i = 0; i < calls.length;) {
        const size = 1 + this.r.int(calls.length - i);
        const seg = calls.slice(i, i + size);
        i += size;
        if (seg.length > 1 && this.r.chance(0.5)) {
          for (const c of seg) events.push({ at: 'use', c });
          const ends = [...seg];
          while (ends.length) events.push({ at: 'end', c: ends.splice(this.r.int(ends.length), 1)[0] });
        } else {
          for (const c of seg) events.push({ at: 'use', c }, { at: 'end', c });
        }
      }
      // An abort mid-batch cuts the event list short; the harness then heals what is in flight.
      const cut = this.r.chance(0.06) ? 1 + this.r.int(events.length - 1) : events.length;
      let paused = false;
      for (const { at, c } of events.slice(0, cut)) {
        if (at === 'use') {
          await this.j.append(this.entry({ type: 'tool_use', toolUseId: c.id, name: c.name, input: { n: c.id } }));
        } else if (c.pause) {
          const interactionId = this.id('i');
          await this.j.append(this.entry({
            type: 'interaction', interactionId, resolved: false,
            data: { kind: c.pause.kind, toolUseId: c.id, toolName: c.pause.toolName },
          }));
          this.open.push({ interactionId, toolUseId: c.id, ...c.pause });
          paused = true;
        } else {
          await this.j.append(this.entry({ type: 'tool_result', toolUseId: c.id, blocks: text(`out ${c.id}`), isError: false }));
        }
      }
      this.log.push(`  round: ${events.slice(0, cut).map((e) => `${e.at}:${e.c.id}${e.at === 'end' && e.c.pause ? `(pause ${e.c.pause.kind})` : ''}`).join(' ')}`);
      if (cut < events.length) {
        this.log.push('  abort → healOrphanedToolUse');
        note('abort mid-batch');
        await this.j.healOrphanedToolUse(true);
        return;
      }
      if (paused) return; // a HITL pause ends the native run
    }
  }

  /** A card is answered (possibly a stale, deferred one) → the real continue orchestration. */
  async resolve(): Promise<boolean> {
    if (this.open.length === 0) return false;
    const p = this.open.splice(this.r.int(this.open.length), 1)[0];
    const outcome: InteractionOutcome = this.r.chance(0.75)
      ? { behavior: 'allow', ...(p.kind === 'ask_question' ? { updatedInput: { answers: { q: 'blue' } } } : {}) }
      : { behavior: 'deny', reason: 'user_declined' };
    const out = await orchestrateContinue({
      taskId: this.taskId,
      payload: { taskId: this.taskId, interactionId: p.interactionId, toolUseId: p.toolUseId, kind: p.kind, outcome },
      journal: this.j,
      state: new InMemoryStatePort(),
      buildToolset: async () => ({
        tools: [{ name: 'Bash', description: 'bash', parameters: {}, execute: async () => 'bash ran' }],
        harness: { gateTool: async () => ({ behavior: 'allow' }) as never },
      }),
      drive: () => this.drive(),
      ...(this.r.chance(0.2) ? { worldDelta: { elapsedMs: 3 * 60 * 60_000 } } : {}),
    });
    this.log.push(`continue ${p.interactionId}/${p.toolUseId} ${p.kind} ${outcome.behavior} → ${out.reSuspended ? 're-suspended' : out.drove ? 'drove' : 'no-op'}`);
    const stale = this.deferred.has(p.toolUseId);
    note(stale ? 'stale card resolved' : 'live card resolved');
    // The incident: a stale card resolved while a sibling pause is still open (28edef30).
    if (stale && out.reSuspended) note('stale card resolved while another pause is open');
    if (!stale && out.reSuspended) note('one of several live cards resolved');
    return true;
  }

  async step(): Promise<void> {
    const paused = await this.live();
    const roll = this.r.int(100);
    if (roll < 40 && (await this.resolve())) return;
    if (roll < 75) return this.userTurn();
    if (roll < 88) return this.breadcrumb();
    if (paused) return this.userWhilePaused();
    return this.userTurn();
  }
}

// ── the pairing rules, one per wire dialect ──────────────────────────────────

function journalViolations(messages: JournalEntry[]): string[] {
  const out: string[] = [];
  // A call's unit: its run of consecutive uses plus the result run right after it.
  const unitEnd = new Array<number>(messages.length);
  for (let i = 0; i < messages.length;) {
    if (messages[i].payload.type !== 'tool_use') { i++; continue; }
    const start = i;
    while (i < messages.length && messages[i].payload.type === 'tool_use') i++;
    while (i < messages.length && messages[i].payload.type === 'tool_result') i++;
    for (let k = start; k < i; k++) unitEnd[k] = i;
  }
  const results = new Map<string, number[]>();
  messages.forEach((e, i) => {
    if (e.payload.type === 'tool_result') results.set(e.payload.toolUseId, [...(results.get(e.payload.toolUseId) ?? []), i]);
  });
  messages.forEach((e, i) => {
    if (e.payload.type === 'tool_use') {
      const at = results.get(e.payload.toolUseId) ?? [];
      if (at.length !== 1) out.push(`journal: tool_use ${e.payload.toolUseId} has ${at.length} results`);
      else if (at[0] < i || at[0] >= unitEnd[i]) {
        out.push(`journal: result of ${e.payload.toolUseId} is outside its call's unit`);
      }
    }
    if (e.payload.type === 'tool_result') {
      const id = e.payload.toolUseId;
      if (!messages.slice(0, i).some((m) => m.payload.type === 'tool_use' && m.payload.toolUseId === id)) {
        out.push(`journal: result ${id} has no call before it`);
      }
    }
  });
  return out;
}

function anthropicViolations(msgs: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  msgs.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    if (m.role === 'assistant') {
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id);
      const next = msgs[i + 1];
      const leading: string[] = [];
      if (next?.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b.type !== 'tool_result') break;
          leading.push(b.tool_use_id);
        }
      }
      for (const id of ids) if (!leading.includes(id)) out.push(`anthropic: tool_use ${id} not answered first by message ${i + 1}`);
      return;
    }
    const prev = msgs[i - 1];
    const calls = prev?.role === 'assistant' && Array.isArray(prev.content)
      ? prev.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id)
      : [];
    let leadingRun = true;
    for (const b of m.content) {
      if (b.type !== 'tool_result') { leadingRun = false; continue; }
      if (!leadingRun) out.push(`anthropic: tool_result ${b.tool_use_id} behind other blocks in message ${i}`);
      if (!calls.includes(b.tool_use_id)) out.push(`anthropic: tool_result ${b.tool_use_id} does not answer the previous assistant`);
    }
  });
  return out;
}

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function chatViolations(msgs: ChatMsg[]): string[] {
  const out: string[] = [];
  const claimed = new Set<number>();
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.tool_calls?.length) return;
    const ids = m.tool_calls.map((c) => c.id);
    const replies = msgs.slice(i + 1, i + 1 + ids.length);
    replies.forEach((_, k) => claimed.add(i + 1 + k));
    const got = replies.map((r) => (r.role === 'tool' ? r.tool_call_id : `<${r.role}>`));
    if ([...got].sort().join() !== [...ids].sort().join()) {
      out.push(`chat: assistant ${i} tool_calls [${ids}] followed by [${got}]`);
    }
  });
  msgs.forEach((m, i) => {
    if (m.role === 'tool' && !claimed.has(i)) out.push(`chat: tool message ${m.tool_call_id} is not a reply to the assistant before it`);
  });
  return out;
}

/** The tool-block rule for the item-list dialects: a call's output lands after it, before the block ends. */
function blockViolations(
  dialect: string,
  items: Array<{ call?: string; output?: string; boundary: boolean }>,
): string[] {
  const out: string[] = [];
  let calls = new Set<string>();
  let answered = new Set<string>();
  const close = () => {
    for (const c of calls) if (!answered.has(c)) out.push(`${dialect}: call ${c} has no output in its block`);
    calls = new Set();
    answered = new Set();
  };
  for (const it of items) {
    if (it.boundary) { close(); continue; }
    if (it.call !== undefined) calls.add(it.call);
    if (it.output !== undefined) {
      if (!calls.has(it.output)) out.push(`${dialect}: output ${it.output} without its call in the block`);
      else if (answered.has(it.output)) out.push(`${dialect}: output ${it.output} twice`);
      answered.add(it.output);
    }
  }
  close();
  return out;
}

function responsesViolations(items: OpenAI.Responses.ResponseInputItem[]): string[] {
  return blockViolations('responses', items.map((it) => {
    const type = (it as { type?: string }).type;
    if (type === 'function_call') return { call: (it as { call_id: string }).call_id, boundary: false };
    if (type === 'function_call_output') return { output: (it as { call_id: string }).call_id, boundary: false };
    return { boundary: type !== 'reasoning' };
  }));
}

function interactionsViolations(steps: GeminiInteractionsStep[]): string[] {
  return blockViolations('gemini-interactions', steps.map((s) => {
    if (s.type === 'function_call') return { call: s.id, boundary: false };
    if (s.type === 'function_result') return { output: s.call_id, boundary: false };
    return { boundary: s.type !== 'thought' };
  }));
}

function geminiViolations(contents: GeminiContent[]): string[] {
  const out: string[] = [];
  const names = (xs: string[]) => [...xs].sort().join();
  contents.forEach((c, i) => {
    if (c.role === 'model') {
      const calls = c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!.name);
      if (calls.length === 0) return;
      const next = contents[i + 1];
      const leading: string[] = [];
      for (const p of next?.role === 'user' ? next.parts : []) {
        if (!p.functionResponse) break;
        leading.push(p.functionResponse.name);
      }
      if (names(leading) !== names(calls)) out.push(`gemini: model ${i} calls [${calls}] answered by leading [${leading}]`);
      return;
    }
    const responses = c.parts.filter((p) => p.functionResponse);
    if (responses.length === 0) return;
    const prev = contents[i - 1];
    if (!prev || prev.role !== 'model' || !prev.parts.some((p) => p.functionCall)) {
      out.push(`gemini: user ${i} carries functionResponse parts with no call turn before it`);
    }
    const leadingCount = c.parts.findIndex((p) => !p.functionResponse);
    if (leadingCount !== -1 && leadingCount < responses.length) out.push(`gemini: user ${i} has a functionResponse behind other parts`);
  });
  return out;
}

/**
 * Nothing is dropped on the way to the wire: each dialect's orphan strip makes a request
 * VALID by deleting the pair it cannot place, so a valid-looking request can still have
 * lost a call and its result (Gemini did, before the unit rule in keepToolResultsAdjacent).
 */
function conservationViolations(dialect: string, projected: number, onWire: number): string[] {
  return projected === onWire ? [] : [`${dialect}: ${projected} calls projected, ${onWire} reached the wire`];
}

async function violations(j: Journal, errSpy: ReturnType<typeof vi.spyOn>): Promise<string[]> {
  errSpy.mockClear();
  const { messages } = await j.project();
  const calls = messages.filter((e) => e.payload.type === 'tool_use').length;
  const anthropic = journalToAnthropicMessages(messages);
  const chat = journalToChatCompletionsMessages(messages);
  const responses = journalToOpenAIResponsesInput(messages);
  const gemini = journalToGeminiContents(messages);
  const steps = journalToGeminiInteractionsSteps(messages);
  const out = [
    ...journalViolations(messages),
    ...anthropicViolations(anthropic),
    ...chatViolations(chat),
    ...responsesViolations(responses),
    ...geminiViolations(gemini),
    ...interactionsViolations(steps),
    ...conservationViolations('anthropic', calls, anthropic.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use').length),
    ...conservationViolations('chat', calls, chat.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : [])).length),
    ...conservationViolations('responses', calls, responses.filter((it) => (it as { type?: string }).type === 'function_call').length),
    ...conservationViolations('gemini', calls, gemini.flatMap((c) => c.parts).filter((p) => p.functionCall).length),
    ...conservationViolations('gemini-interactions', calls, steps.filter((st) => st.type === 'function_call').length),
  ];
  // project() must produce the pairing ITSELF: the Anthropic tripwire and adjacency floor are
  // defense-in-depth, and any firing means a request was built from a shape project() let through.
  for (const call of errSpy.mock.calls) {
    const line = String(call[0]);
    if (line.includes('[hitl-')) out.push(`anthropic floor fired: ${line.slice(0, 160)}`);
  }
  return out;
}

async function runSequence(seed: number, errSpy: ReturnType<typeof vi.spyOn>): Promise<string | null> {
  const taskId = `p${seed}`;
  const j = new Journal({
    taskId, workspaceId: 'w',
    jsonl: new MemoryJsonl(),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-09-28T04:41:00.000Z'),
  });
  const sim = new Sim(j, makeRand(seed), taskId);
  for (let s = 0; s < STEPS_PER_SEQUENCE; s++) {
    await sim.step();
    const bad = await violations(j, errSpy);
    if (bad.length > 0) {
      return `seed ${seed}, step ${s}:\n  ${bad.join('\n  ')}\n  steps:\n    ${sim.log.join('\n    ')}`;
    }
  }
  return null;
}

describe('history pairing property (live 28edef30 closed as a class)', () => {
  it(`every wire dialect pairs every call with its result across ${SEQUENCES} random journals`, async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seeds = ONLY_SEED !== undefined ? [ONLY_SEED] : Array.from({ length: SEQUENCES }, (_, i) => i + 1);
      for (const seed of seeds) {
        const failure = await runSequence(seed, errSpy);
        if (failure) expect.fail(failure);
      }
      if (ONLY_SEED === undefined) {
        for (const shape of [
          'deferred a pause', 'user message while paused', 'abort mid-batch', 'stale card resolved',
          'live card resolved', 'stale card resolved while another pause is open', 'one of several live cards resolved',
          'sealed anthropic round', 'sealed round with a paused call',
        ]) {
          expect(seen.get(shape) ?? 0, shape).toBeGreaterThanOrEqual(20);
        }
      }
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);
});
