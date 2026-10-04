/**
 * The GPT-6 compaction usage, at the wire — the prod billing gap pinned by its own payload.
 *
 * PROD (BILLING_SERVER_REPRICE_V1 on, so the SERVER's per-message sum is what bills): every
 * gpt-6-luna / gpt-5.6-luna compaction row in task_turn_usage read input 3, cached 0,
 * written 0, output 4096, for a summarize of a ~245K-token span, and on every such turn the
 * runner's claimed total sat above the billed server total (16 turns, 10 tasks, 2026-08-28 to
 * 2026-09-28, $0.881 of provider cost never charged). The cause: GPT-6 reports a summarize's
 * prompt almost entirely as `input_tokens_details.cache_write_tokens` (the request carries
 * no prompt_cache_key, so the provider writes the whole prefix), the Responses transport
 * subtracts that bucket from `input_tokens` (the one exclusive convention), and the
 * compaction fold on main (`compactionUsage = { inputTokens, outputTokens }`) kept only input
 * and output. The claimed cost priced the whole usage; the usage EVENT the server re-prices
 * carried 3 tokens of input. Fixed on staging by #3986 (b99515d95b, the bucket-by-bucket
 * `addUsage`); staging's compaction rows since read input 3 / written 175,122 and claimed =
 * server on every compaction turn. Prod gets it at the next promote.
 *
 * #3986's own test drives a FakeTransport with a hand-built NormalizedUsage. This one drives
 * the REAL OpenAIResponsesTransport with the payload shape the provider sends (a staging
 * gpt-6-luna compaction row, 2026-09-29), so the lane that broke is the lane under test.
 *
 * Revert-proof: put main's input/output-only fold back in runCompaction and every assertion
 * after the first fails (the event loses the 175,122 written tokens, the server price falls
 * to ~2% of the claim).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type OpenAI from 'openai';
import { runRecoveryCompaction, compactionUsageEvent, type CompactionDeps } from '../compaction-run.js';
import type { NormalizedUsage } from '../../contract/events.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import { priceUsageUsd } from '../../contract/usage-pricing.js';
import { OpenAIResponsesTransport } from '../../transports/openai-responses-transport.js';

const MODEL = 'gpt-6-luna';
const BODY = 'word '.repeat(400);
const SUMMARY = 'The person asked for a file audit; steps 0 to 7 read /f0 to /f7.';

/** A staging gpt-6-luna compaction row (2026-09-29), as the provider reported it. */
const PROVIDER_USAGE = {
  input_tokens: 175_125,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 175_122 },
  output_tokens: 1_079,
  output_tokens_details: { reasoning_tokens: 640 },
  total_tokens: 176_204,
};

const dirs: string[] = [];
beforeEach(() => {
  process.env.COMPACTION_V2 = '1';
});
afterEach(async () => {
  delete process.env.COMPACTION_V2;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});

/** One ask, then `rounds` tool rounds: the agentic shape a round-head compaction cuts. */
async function oneAskJournal(taskId: string, rounds: number): Promise<Journal> {
  const dir = await mkdtemp(join(tmpdir(), `compaction-wire-${process.pid}-`));
  dirs.push(dir);
  const j = new Journal({
    taskId, workspaceId: 'w', jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(), clock: sequentialClock('2026-09-29T00:00:00.000Z'),
  });
  await j.append({ ...base(taskId), principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text: `audit the files ${BODY}` } as ContentBlock] } });
  for (let i = 0; i < rounds; i++) {
    await j.append({ ...base(taskId), payload: { type: 'assistant', blocks: [{ type: 'text', text: `step ${i} ${BODY}` } as ContentBlock], api: 'openai_responses', provider: 'openai', model: MODEL } });
    await j.append({ ...base(taskId), payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { path: `/f${i}` } } });
    await j.append({ ...base(taskId), payload: { type: 'tool_result', toolUseId: `tu-${i}`, blocks: [{ type: 'text', text: `result ${i} ${BODY}` } as ContentBlock] } });
  }
  return j;
}

/** The real Responses transport; its client plays the summarize with the provider's usage. */
function summarizingResponses(): OpenAIResponsesTransport {
  const message = { id: 'msg_s', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: SUMMARY, annotations: [] }] };
  const client = {
    baseURL: 'https://capture.invalid/v1',
    responses: {
      stream: () => (async function* () {
        yield { type: 'response.output_text.delta', item_id: 'msg_s', output_index: 0, content_index: 0, delta: SUMMARY };
        yield { type: 'response.output_item.done', output_index: 0, item: message };
        yield { type: 'response.completed', response: { status: 'completed', output: [message], usage: PROVIDER_USAGE } };
      })(),
    },
  } as unknown as OpenAI;
  return new OpenAIResponsesTransport({ client });
}

function deps(journal: Journal, taskId: string, transport: OpenAIResponsesTransport): CompactionDeps {
  const cfg = { journal, compaction: { keepWindowTokens: 2_000 }, runtimeConfig: { sessionId: 's', userId: 'u' } };
  return {
    ctx: { taskId, model: MODEL, config: cfg },
    transport,
    dispatcher: { dispatch: async () => [] },
    compactionBase: () => base(taskId),
    runSignal: () => new AbortController().signal,
  } as unknown as CompactionDeps;
}

/** What the server prices a usage event from (turn-reprice normalizeAgentUsage over the sink's wire). */
const serverPrice = (u: NormalizedUsage): number =>
  priceUsageUsd(MODEL, {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens ?? 0,
    cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
  })!.usd;

describe('GPT-6 compaction usage at the Responses wire: the event the server bills carries every bucket', () => {
  it('the written prefix reaches the usage event, so the server bills what the runner claims', async () => {
    const taskId = 'compaction-wire-luna';
    const j = await oneAskJournal(taskId, 8);
    const result = await runRecoveryCompaction(deps(j, taskId, summarizingResponses()));
    expect(result).not.toBeNull();
    const event = compactionUsageEvent(result!, taskId, 6) as { lane: string; usage: NormalizedUsage };
    expect(event.lane).toBe('compaction');

    // The provider's numbers, bucket by bucket: 3 fresh tokens, the rest WRITTEN to its cache.
    expect(event.usage.inputTokens).toBe(3);
    expect(event.usage.cacheReadInputTokens).toBe(0);
    expect(event.usage.cacheCreationInputTokens).toBe(175_122);
    expect(event.usage.outputTokens).toBe(1_079);
    expect(event.usage.reasoningTokens).toBe(640);
    // Every prompt token in exactly one bucket.
    expect(event.usage.inputTokens + (event.usage.cacheReadInputTokens ?? 0) + (event.usage.cacheCreationInputTokens ?? 0))
      .toBe(PROVIDER_USAGE.input_tokens);

    // No recomputation drift: the server's price of the event IS the claimed compaction cost.
    expect(result!.compactionCostUsd).toBeGreaterThan(0);
    expect(serverPrice(event.usage)).toBeCloseTo(result!.compactionCostUsd, 12);

    // The prod defect, priced: the input/output-only fold on main bills about 2% of the call.
    const mainFold = serverPrice({ inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens });
    expect(mainFold / result!.compactionCostUsd).toBeLessThan(0.05);
  });
});
