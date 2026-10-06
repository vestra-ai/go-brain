# @vestra/agent-sdk research for the Go composer: query() native harness vs a direct Messages loop

Repo: `~/workspace/agents/go-brain-worktrees/plan-week/packages/agent-sdk` (abbreviated `SDK/` below; every path
is relative to it). Copied 2026-10-04 from vestra-ai/bash@e3010f4 (`PROVENANCE.md`). Read only: nothing was built,
run or tested.

## 0. Verdict

**Write a direct Anthropic Messages tool loop of about 150 lines for the composer.** Reuse a few SDK pieces: pricing,
usage normalisation, the capability registry and error classification. Do not run the composer on `query()`. Three
reasons decide it:
1. **Cache control.** The native harness sends a user turn as ONE string, and it places every `cache_control`
   itself: on the tools tail, on the system, a rolling breakpoint on the last block of the last message, and
   sometimes a secondary one. A caller cannot put a breakpoint between part 2 (the chat) and part 3 ("right now").
   §3 and §4 show why that breakpoint is the only way to reach 85%+.
2. **Latency knobs are hard-wired.** `maxTokens` is the registry cap (128k). Thinking is always adaptive with
   `display:'summarized'` at effort `medium` for Sonnet 5.5. Haiku 4.5 always gets a 4000-token thinking budget.
   No per-run switch reaches `low` effort or `between_tools` (thinking off). Every tool also gets a forced
   `narration` parameter, which costs output tokens on every call.
3. **No clean "stay silent".** An empty end_turn triggers up to 3 empty-recovery re-calls, then a canned fallback
   line. The only way to end a turn from inside a tool is a HITL "pause" (`markPausedHalt`), which stamps
   `paused:true` and ends the run.

## 1. Running one turn with `query()`

### 1.1 Signature (`src/query/index.ts`)
```ts
// :20
export type BuiltInHarnessId = 'native';
// :34-49
export interface QueryOptions<TConfig> {
  harness: BuiltInHarnessId | Harness<TConfig>;
  model: string;                       // threaded into HarnessContext.model
  prompt: AsyncIterable<UserTurn>;     // the user-turn stream
  config: TConfig;                     // NativeConfig for 'native'
  taskId?: string; sessionId?: string; cwd?: string;   // default ''
}
// :62-64
export interface QueryHandle extends AsyncIterable<HarnessEvent> { interrupt(): void; }
// :76
export function query<TConfig>(opts: QueryOptions<TConfig>): QueryHandle
```
- `query()` creates an `AbortController`. When `config.signal === undefined` it injects
  `{...config, signal: ac.signal}` (:88-92). It always sets `ctx.signal = ac.signal` (:102). `interrupt()` calls
  `ac.abort()` (:109).
- Import it from the subpath `@vestra/agent-sdk/query` (package.json `exports`). The root is the I/O-free contract.
  `./engine` holds NativeHarness, FakeTransport, NativeConfig and pricing. `./transports` holds the concrete
  provider transports.

### 1.2 `UserTurn` (`src/contract/harness.ts:76-155`)
`{ text: string; images?: ImageBlock[]; media?: MediaBlock[]; system?: boolean; continueInteraction?: boolean;
uuid?; priority?: 'now'|'next'|'later'; shouldQuery?: boolean; origin?: MessageOrigin; control?: 'compact'|'memory'; … }`
**Only one `text` string.** There is no block list and no per-block cache flag.

### 1.3 `NativeConfig` (`src/engine/native-config.ts:52-736`)
REQUIRED: `onAttached: (handle: unknown) => void` (:61, fires at the end of the prologue) and `maxTurns: number`
(:127, the maximum number of tool-use rounds per user turn; when it is exhausted the turn ends with outcome
`max_turns`).
Effectively required: `transport?: Transport` (:243). `run()` throws `'NativeConfig.transport is required'`
(native-harness.ts:193-194).
Optional fields relevant to Go:
| field | line | meaning |
|---|---|---|
| `systemPrompt?: string` | :63 | used verbatim (`cfg.systemPrompt ?? ''`, native-harness.ts:521) |
| `toolHost?: ToolHost` | :678 | `buildTools(ctx) → {tools: RawToolOptions[], onAuthHalt}`; default `EmptyToolHost` (no tools) |
| `signal?: AbortSignal` | :104 | abort; query() fills it in |
| `drainTimeoutMs?` | :121 | wait for an in-flight tool after an abort; default `DRAIN_DEFAULT_MS = 5_000` (abort-drain.ts:19) |
| `journal?: Journal` | :236 | absent means in-memory history only (no disk, no compaction, no resume) |
| `retry?: {maxAttempts, backoffMs, fallbackModel}` | :265 | real default `{maxAttempts: 4, backoffMs: 750}` (round-engine.ts:126; the doc comment's "2" is stale) |
| `turnHeadNote?: () => Promise<string\|null>` | :301 | one extra user message pushed after the turn's text (see §4) |
| `systemFleetPrefixChars?` | :79 | splits the system into 2 cached blocks (CACHE_TIERING) |
| `runtimeConfig?: RuntimeConfig` | :656 | `makeRuntimeConfig({systemPrompt, userId?, workingDir?})` (ports/runtime-config.ts:18); `userId` keys the OpenAI `prompt_cache_key` |
| `policy?` / `interaction?` / `toolDisplay?` / `state?` | :672-680 | defaults AllowAllPolicyPort / UnconfiguredInteractionPort / Noop / InMemory |
| `suggestNextPrompt?`, `namiOffloopSweep?`, `compaction?`, `subagent*`, `video?`, `recall?`, `contextPort?`, `injectionScreen?`, `registerHooks?` | various | all off when absent |

### 1.4 Event stream (`HarnessEvent`, `src/contract/events.ts:213-492`)
Kinds: `block` (:214), `thinking_start` (:227), `usage` (:276), `context_usage` (:336), `interaction` (:340),
`turn_end` (:353), `session_state_changed` (:456), `hook` (:465), `raw` (:492).
- **Text arrives live** as `{kind:'block', block:{type:'text', text: delta}}`, one event per provider delta
  (round-stream.ts:259). Thinking arrives as `{kind:'block', block:{type:'thinking', thinking}}` (:269).
  Tool calls arrive as `block` `{type:'tool_use', toolUseId, toolName, toolInput}` and results as
  `{type:'tool_result', toolUseId, content, isError, toolName}` (round-tool-batch.ts:173,192;
  round-tool-sequential.ts:224,412).
- **Usage arrives once per model round** (round-stream.ts:583-603):
  `{kind:'usage', usage: NormalizedUsage, messageId, turnNumber, model, ttftMs, latencyMs?, firstTextMs?, beforeSendMs?, afterSendMs?, attempts?, roundKind?, requestMeta, promptBreakdown?}`.
  `NormalizedUsage` (transport.ts:17-51) is `{inputTokens /* EXCLUSIVE of cache */, outputTokens, cacheReadInputTokens?, cacheCreationInputTokens?, cacheCreation5mInputTokens?, cacheCreation1hInputTokens?}`.
  So yes, cache read and write tokens come out on every round.
- **Exactly one `turn_end` per user turn**:
  `{kind:'turn_end', outcome: TurnOutcome, blocks, stopReason, exitReason, paused?, billing:{cumulativeCostUsd, modelUsage, turnDeltaUsd?, …}}`.
  `outcome.kind === 'completed'` carries `summary` (all rounds' text joined), `answer` (last round's text, or null),
  `costUsd`, `numTurns`, `durationMs`, `modelUsage` (turn-outcome.ts:100-121). The other kinds are `max_turns`,
  `user_aborted`, `hook_blocked`, `rate_limited`, `model_error`, `network_error`, … (:123-260).

### 1.5 Abort and timeout
- Call `handle.interrupt()`, or pass your own `config.signal` (e.g. `AbortSignal.timeout(8000)`). Contract
  (harness.ts:287-295): an aborted signal yields exactly one `user_aborted` turn_end within `drainTimeoutMs`, even
  mid-tool, with a truthful synthetic tool_result.
- No per-turn wall clock exists other than the signal. `budget?: TurnBudget` (native-config.ts:112) is not exported
  from `./engine` (turn-budget.ts is absent from engine/index.ts), so it cannot be used from outside.
- Stream stall guard: `DEFAULT_STREAM_STALL_MS = 180_000` (stream-stall-guard.ts:42, env `STREAM_STALL_MS`).
- The model response timeout applies only with `NETWORK_WAIT_V1` (error-authority.ts:448).

### 1.6 Smallest real test setup (verbatim, `src/query/__tests__/query.test.ts:24-47, 116-133`)
```ts
import { query, HARNESS_REGISTRY } from '../index.js';
import { FakeTransport, type StreamEvent } from '../../engine/transport.js';
import type { NativeConfig } from '../../engine/native-config.js';
import { makeRuntimeConfig } from '../../ports/runtime-config.js';

/** A single scripted assistant turn that ends with `end_turn`. */
function scriptedEndTurn(text = 'hello'): StreamEvent[] {
  return [
    { kind: 'text', text },
    { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** A minimal NativeConfig built from ONLY SDK pieces. The engine fills the port
 *  defaults (AllowAllPolicyPort / EmptyToolHost / …) when they are absent. */
function minimalNativeConfig(overrides: Partial<NativeConfig> = {}): NativeConfig {
  return {
    onAttached: () => {},
    maxTurns: 5,
    runtimeConfig: makeRuntimeConfig({ systemPrompt: '' }),
    transport: new FakeTransport(scriptedEndTurn()),
    ...overrides,
  };
}

/** A single-turn user prompt stream. */
async function* oneTurn(text: string): AsyncIterable<UserTurn> {
  yield { text };
}
...
    const handle = query<NativeConfig>({
      harness: 'native',
      model: 'claude-sonnet-4-6',
      prompt: oneTurn('hi'),
      config: minimalNativeConfig(),
      taskId: 't1',
      sessionId: 's1',
      cwd: '/tmp',
    });
    const events = await collect(handle);
    const ends = turnEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome.kind).toBe('completed');
```
Multi-round with tools (verbatim, `src/engine/__tests__/native-harness.final-answer.test.ts:29-66, 86-94, 115`):
```ts
class ScriptTransport extends FakeTransport {
  calls = 0;
  constructor(private readonly rounds: StreamEvent[][]) { super([]); }
  override callModel(): StreamEvent[] {
    const r = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    return r as StreamEvent[];
  }
  override computeCostUsd(_u: NormalizedUsage): number { return 0.0001; }
}
const usage: NormalizedUsage = { inputTokens: 1, outputTokens: 1 };
function toolRound(id: string, name: string, input: unknown, leadText?: string): StreamEvent[] {
  return [
    ...(leadText ? [{ kind: 'text', text: leadText } as StreamEvent] : []),
    { kind: 'tool_use', toolUse: { id, name, input } } as StreamEvent,
    { kind: 'done', stopReason: 'tool_use', usage } as StreamEvent,
  ];
}
function textRound(text: string): StreamEvent[] {
  return [ { kind: 'text', text } as StreamEvent, { kind: 'done', stopReason: 'end_turn', usage } as StreamEvent ];
}
function toolHostOf(tools: RawToolOptions[]): ToolHost {
  return { async buildTools() { return { tools, onAuthHalt: async () => {} }; } };
}
  const cfg = { onAttached: () => {}, maxTurns: opts.maxTurns ?? 30, transport,
    toolHost: toolHostOf(opts.tools), journal: opts.journal } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = { taskId: opts.taskId, sessionId: 's-answer', cwd: '/tmp',
    model: 'fake-model', signal: new AbortController().signal, config: cfg };
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);

const note: RawToolOptions = { name: 'look_up', description: 'look up', parameters: z.object({ ref: z.string() }), execute: async () => 'found' };
```
(That test passes a Journal. `journal` is optional: omit it and the in-memory path is used.)

## 2. Tools

### 2.1 `RawToolOptions` (`src/tools/tool-types.ts:266-364`)
```ts
export interface RawToolOptions {
  name: string;
  description: string;
  parameters: unknown;            // a zod schema at runtime (or plain JSON Schema, or null)
  strict?: boolean;
  execute: (args: unknown, context: ToolExecuteContext) => unknown | Promise<unknown>;
  returnsContentBlocks?: boolean; // unwrap {content:[text|image]} (browser tools only)
  deferrable?: boolean;           // TOOL_DEFER_V1 (off by default)
  deferrableWide?: boolean;
  concurrencySafe?: boolean;      // may run concurrently with adjacent safe calls
  concurrency?: 'shared' | 'exclusive';   // read only with TOOL_CONCURRENCY_CLASSES_V1
  untrustedContent?: boolean | ((input: unknown) => boolean);  // fence the result in <untrusted_external_content>
  progressExempt?: boolean;
  resultTrailer?: (input: unknown, text: string) => string | null;
}
```
`ToolExecuteContext` (tool-types.ts:12-99) contains `toolCallId?`, `signal?`, `pushEvent?`, `addCostUsd?`,
`markPausedHalt?`, `noteProgress?`, plus subagent and weave fields.

### 2.2 Schemas
`parameters` is a **zod 4** schema. `toToolJsonSchema()` (contract/tool-json-schema.ts:46) converts it with
`z.toJSONSchema(p, {target:'draft-2020-12', unrepresentable:'any'})`. Plain objects pass through, and null becomes
`{type:'object', properties:{}, additionalProperties:false}`. `toToolJsonSchema` is NOT a public export, but
`withNarrationParam` / `toAnthropicTool` are exported from `./engine` (tool-dispatcher.ts:95,121).

**Every tool gets a `narration` string property injected** (tool-dispatcher.ts:73-107): "One short present-tense
sentence… Always include it." `strict` tools get it in `required` too. There is no switch to turn this off. A tool
that declares its own `narration` property is left as is. The dispatcher strips `narration` before `execute`
(:275-278).

### 2.3 Dispatch (`gateAndDispatchTool`, tool-dispatcher.ts:173)
1. `coerceStringifiedToolArgs` (OSS models send nested JSON as strings).
2. Strip `narration`.
3. **Validate** with `parameters.safeParse` (tool-arg-validate.ts:48). On failure the model sees
   `isError:true, text:"Invalid arguments for X: <issues>. Fix the arguments and call the tool again."` (:67).
   `execute` receives the raw, validated input, **not** the zod-parsed value.
4. Gate: PreToolUse hooks plus `policy.gate`. AllowAll by default.
5. `execute`.
6. Shape the result: a string is used as is, anything else goes through `JSON.stringify` (:588). The result is then
   run through `classifyComposioToolResult` (:612), plus offload, fence and output guard.
- **Errors**: if `execute` throws, the model gets `{isError:true, text: err.message}` (catch at :466). Alternatively
  `return toolError(code, msg)` (tool-types.ts toolError). That sentinel is treated as `isError` only when
  `cfg.toolErrorTaxonomy` is set; otherwise it is unwrapped to plain text with `isError:false`.

### 2.4 Parallel tool calls
The model may emit several tool_use blocks. Execution is **sequential unless** consecutive calls are all
`concurrencySafe: true` (or `concurrency:'shared'` with TOOL_CONCURRENCY_CLASSES_V1). Those run concurrently
through the `:turnbatch` pool (batch-shape.ts:30-39). Results are journaled in wire order. Without a journal, the
transport pushes one user message per tool_result (anthropic-transport.ts:515); the API merges consecutive user
messages.

### 2.5 Ending a turn early (stay_silent)
There is no "terminal tool" concept. A round loop breaks only on these (native-iterate-round.ts:462-514):
- `ctx.markPausedHalt()` from a tool: `pausedHalt` ends the turn **and the run**, and the turn_end carries
  `paused:true` (native-harness.ts:281, 360). It is a HITL-suspension semantic.
- A `PostToolBatch` hook returning `decision:'halt'` (via `registerHooks`), which also sets pausedHalt.
- A PermissionRequest hook with `interrupt:true`, giving `hook_blocked`.
- Otherwise every tool round is followed by **another model call**, so a stay_silent tool costs one more round
  trip (about 1 s). And an empty end_turn with no thinking triggers **empty recovery**: up to
  `MAX_EMPTY_RECOVERY_ATTEMPTS = 3` re-calls with a nudge, then `EMPTY_RESPONSE_FALLBACK_TEXT = "I wasn't able to
  produce a response just now. Please try again."` (empty-recovery.ts:22-85; decision at :113-125, called from
  native-iterate-round.ts:353). A thinking-only round counts as "complete", so Sonnet 5.5 with thinking on escapes
  this, and a thinking-off model does not.

## 3. Transports and prompt caching

### 3.1 `Transport` interface (`src/engine/transport.ts:129-348`)
`api`, `provider`, `emptyHistory()`, `historyFromJournal(entries)`, `pushAssistant(h, blocks, replay?)`,
`pushToolResult(h, r)`, `pushUser(h, text, images?, media?)`, `buildTools(raw)`, `prewarm?(model)`,
`fallBackLane?`, `reasoningEffort?`,
`callModel({model, system, tools, history, signal?, maxTokens, outputFormat?, cachePrefixHint?, systemFleetPrefixChars?, systemMemorySpan?, cacheKey?, noCacheWrite?, reasoningEffort?: 'low', turnEffort?: 'low'})`,
`readStream(stream): AsyncIterable<StreamEvent>` (ends with exactly one `done`), `computeCostUsd`,
`pricedAtFailClosed?`, `buildModelUsage`, `classifyError`, `classifyTermination`, `defaultModel()`.

### 3.2 Concrete transports (`src/transports/index.ts`, exported from `@vestra/agent-sdk/transports`). All stream.
| class | file:line | api | ctor options | provider routing / auth | cache mechanism |
|---|---|---|---|---|---|
| `AnthropicMessagesTransport` | anthropic-transport.ts:406 | `anthropic_messages` | `{client?: Anthropic; createClient?: (baseOverride?) => Anthropic}` (:396-404) | env `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`; `maxRetries: 0` (:72-87) | explicit `cache_control` (below) |
| `OpenAIResponsesTransport` | openai-responses-transport.ts:129 | `openai_responses` | `{client?: OpenAI; createClient?(provider, base?)}` (:109-117) | `openAIClientFor(provider)` (openai-endpoints.ts:144) | automatic prefix; `prompt_cache_key: p.cacheKey` (:439); `store:false` |
| `ChatCompletionsTransport` | chat-completions-transport.ts:197 | `openai_chat_completions` | `{client?: OpenAI; createClient?(provider, base?)}` (:169-178) | per model `resolveCapabilities(model).provider`: openai / fireworks / xai / meta / deepseek (`OPENAI_COMPATIBLE_ENDPOINTS`, openai-endpoints.ts:69-98: `FIREWORKS_API_KEY`/`FIREWORKS_BASE_URL`, …) | automatic; `prompt_cache_key` only for `openai` (:150); Fireworks gets header `x-session-affinity: cacheKey` (:481); `stream_options.include_usage` (:464) |
| `GeminiTransport` / `GeminiInteractionsTransport` | gemini-transport.ts:212 / gemini-interactions-transport.ts:197 | `gemini` / `gemini_interactions` | `GeminiTransportOptions` (:207) / (:181) | `GEMINI_API_KEY` | implicit |
| `FakeTransport` / `UnsetTransport` | engine/transport.ts:351 / :508 | `fake` / `unset` | `new FakeTransport(events: StreamEvent[])` | none | records `cacheKeys`, `cachePrefixHints`, `noCacheWrites`, `systems`, `maxTokensSeen` |

**There is no Baseten transport or provider.** `ModelProvider = 'anthropic'|'openai'|'google'|'fireworks'|'meta'|'xai'|'deepseek'`
(model-capabilities.ts:42). Baseten (an OpenAI-compatible endpoint) would need a new `OPENAI_COMPATIBLE_ENDPOINTS`
row, a `ModelProvider` member and a capability row.

### 3.3 Anthropic `cache_control` placement: exactly what the SDK does
Policy from the registry (model-capabilities.ts:87-99): `ANTHROPIC_CACHE_POLICY = {minCacheableTokens:1024, ttl:'5m', breakpointBudget:4, lookbackBlocks:20, intermediateBlocks:15}`.
Haiku-class gets `minCacheableTokens: 2048`. Sonnet 5.5 overrides it to 512 (:371). The marker is always
`const EPHEMERAL = { type: 'ephemeral' }` (anthropic-transport.ts:110), so the TTL is 5m. The Vestra proxy rewrote
these to 1h. A direct-to-Anthropic Go deploy stays on 5m unless it says `ttl:'1h'`.

`callModel` (anthropic-transport.ts:593-817) places up to 4 breakpoints:
```ts
// [A] tools tail: the last non-deferred tool (anthropic-tool-defer.ts:109)
const tools = shapedTools.length && !noCacheWrite ? withToolsTailBreakpoint(shapedTools, EPHEMERAL) : shapedTools;
// [B] system: one block, or two when systemFleetPrefixChars splits it (:780-791)
system: (noCacheWrite ? [{ type:'text', text:p.system }]
  : tierSystem ? [ {type:'text', text: p.system.slice(0, fleetChars), cache_control: EPHEMERAL},
                   {type:'text', text: p.system.slice(fleetChars),   cache_control: EPHEMERAL} ]
  : [ { type: 'text', text: p.system, cache_control: EPHEMERAL } ]),
// [C]+[D] messages (:685-695)
const prefixBreakpoints = (p.system ? (tierSystem ? 2 : 1) : 0) + (p.tools?.length ? 1 : 0);
const messages = noCacheWrite ? p.history
  : applyMessageCacheBreakpoints(p.history, cachePolicy, p.cachePrefixHint, basePrefixTokens,
                                 cachePolicy.breakpointBudget - prefixBreakpoints);
```
`applyMessageCacheBreakpoints` (:219-300) does two things:
- **Rolling**: always put `cache_control` on the LAST content block of the LAST message (`withTailBreakpoint`,
  :163-175). A bare string becomes `[{type:'text', text, cache_control}]`. An empty string gets no marker.
- **At most one secondary**: if `hint.summaryLeading` (compaction), it goes on the first message where the
  cumulative prefix clears `minCacheableTokens`. Otherwise, if **trailing blocks across ALL messages > 20**, it goes
  about 15 blocks back from the tail. It is skipped when `maxMessageBreakpoints < 2`.
- **It does not count `cache_control` markers already present in `history`.** A caller that pre-places one can push
  the request to 5 breakpoints, which the API rejects with a 400.

`cache-prefix-hint.ts` (contract/cache-prefix-hint.ts:15-21) is only `interface CachePrefixHint { summaryLeading: boolean }`.
The loop sets it when the projected history leads with a compaction summary, and it moves the secondary
breakpoint onto that summary. **It cannot express "put a breakpoint after block N of the user turn".**

Other cache facts:
- `guardSystemPrefix` (:576-591) warns `[CACHE_PROMPT_MUTATED]` once per transport instance if the system hash
  drifts.
- `noCacheWrite: true` drops every marker (:631-695).
- `cacheKey` is ignored on Anthropic.
- `openai-cache-boundaries.ts:22` `readsCacheAtBoundaries(model)` covers GPT-5.6+ (`OPENAI_BOUNDARY_CACHE_POLICY`):
  only developer-block boundaries are read.

**Usage reports cache reads.** `readStream` ends with
`yield {kind:'done', stopReason: final.stop_reason, usage: normalizeAnthropicUsage(final.usage), replay?}`
(:900-906). `normalizeAnthropicUsage` (engine/native-pricing.ts:247-262) maps
`cache_read_input_tokens → cacheReadInputTokens` and `cache_creation_input_tokens → cacheCreationInputTokens`, plus
the 5m/1h split from `usage.cache_creation`. OpenAI's `input_tokens_details.cached_tokens` is normalised in
contract/responses-usage.ts:43-48, and Chat Completions' `prompt_tokens_details.cached_tokens` in
chat-completions-messages.ts:510-534. Input is always made exclusive of cache.

**Streaming detail.** `readStream` (:819-907) yields `text` deltas live while the SDK stream runs. `tool_use`
events come only after the whole stream finishes (the accumulator), unless `TOOLS_MIDSTREAM_V1` is on, in which
case `tool_ready` heads-ups arrive early. `done` comes after `await s.finalMessage()`.

### 3.4 Why the Go cache boundary needs a mid-user-turn breakpoint
Anthropic facts, from the claude-api skill `shared/prompt-caching.md` §API reference / §20-block lookback:
- Max 4 breakpoints.
- Render order is tools, then system, then messages.
- "Each breakpoint walks backward **at most 20 positions** to find a prior cache entry".
- "Reads can only land on positions where a previous request wrote a breakpoint".
- Minimum cacheable prefix: **512** on Sonnet 5.5, Opus 5.5 and Fable 5/5.1; 1024 on Sonnet 5 and Opus 4.8;
  **4096 on Haiku 4.5**. The SDK's `HAIKU_CACHE_POLICY` 2048 is stale; it only affects the SDK's floor guard.
- A cache entry becomes readable only once the first response starts streaming.

What this means for the composer: the chat (part 2) grows each wake. A read needs the previous wake's write point
to be a block boundary in this wake's request, with identical bytes before it. So part 2 must be a sequence of
**append-only text blocks**, for example one block per wake holding the lines that arrived since the previous wake
(last wake's part 4 becomes this wake's newest part-2 block). The `cache_control` goes on the last part-2 block, and
parts 3 and 4 sit after it. A single growing string, which is what `UserTurn.text` forces, can never be read back:
the old write point falls mid-block. Through `query()` as it stands, the only read across wakes is tools + system.

## 4. Multi-block first user message with per-block `cache_control`
**Not supported.** Here is how the text reaches the wire:
- `UserTurn.text` (string)
- `ingestUserTurn` (engine/native-run-turn.ts:369)
- no journal: `transport.pushUser(inMemoryHistory, mergedText, images, media)` (:450)
- `AnthropicMessagesTransport.pushUser` pushes `{role:'user', content: text}`, a bare string (anthropic-transport.ts:534-547)
- with a journal instead: `appendUserEntry`, then `journalToAnthropicMessages` (native-messages.ts), which is also
  one text block.

The only extra user content is `turnHeadNote` (native-run-turn.ts:461), which pushes a **second** user message
`{role:'user', content: note}`. That gives a two-message split, `[user: part2][user: part3+4]`. But the rolling
marker lands on the note (part 3+4), and nothing marks the end of part 2, so the split by itself caches nothing
across wakes.

Smallest changes, from least to most invasive:
1. **No SDK edit (a Go-side subclass).** Write `class GoAnthropicTransport extends AnthropicMessagesTransport` and
   override `pushUser(h, text, images, media)`. On the turn's first push, emit
   `{role:'user', content:[...chatBlocks.map(t => ({type:'text', text:t})), last chat block with cache_control:{type:'ephemeral'}, {type:'text', text: part3}, {type:'text', text: part4}]}`
   from a per-wake plan held on the instance (one transport per wake), and fall back to `super.pushUser` otherwise.
   The base `withTailBreakpoint` keeps earlier markers.
   **Risk**: the count is tools(1) + system(1) + Go's(1) + rolling(1) = 4. Once trailing blocks across the history
   exceed `lookbackBlocks` (20), `applyMessageCacheBreakpoints` adds a 5th, and the request fails with a 400. The
   chat would have to be capped at about 12 blocks, with a periodic refold that costs one full rewrite.
2. **Minimal SDK fix** (anthropic-transport.ts, `callModel` around :685). Count the markers already in
   `p.history`, subtract them, and skip the rolling breakpoint when nothing is left:
   ```ts
   const preplaced = countCacheControl(p.history);   // new ~6-line helper
   ... applyMessageCacheBreakpoints(..., cachePolicy.breakpointBudget - prefixBreakpoints - preplaced)
   // and in applyMessageCacheBreakpoints: if (maxMessageBreakpoints < 1) return out;  (before the rolling line)
   ```
   With option 1's subclass this is safe. Also consider dropping the redundant tools-tail breakpoint when the
   system is static: `system` renders after `tools`, so the system breakpoint already covers both.
3. **First-class support** means three edits:
   - add `UserTurn.blocks?: Array<{text: string; cacheBreakpoint?: boolean}>` (contract/harness.ts:76);
   - thread it through `ingestUserTurn` and `Transport.pushUser`, a signature change in all 6 transports;
   - make it work on the journal path too: `appendUserEntry` and the journal entry schema (contract/journal.ts),
     then `journalToAnthropicMessages`.
   That is about 8 files plus wire-schema tests.

## 5. FakeTransport and test helpers
- `new FakeTransport(events: StreamEvent[])` (transport.ts:351-489). `callModel` returns **the same array on every
  call** (:411-434), so multi-round tests subclass it (the `ScriptTransport` pattern in §1.6). It appears in at
  least 15 engine tests: `native-harness.*.test.ts`, `turn-spend-ceiling`, `turn-end-initiative-stamp`, …
- It has no real history: `pushUser` pushes `{role:'user', text}` and `buildTools` returns the raw tools.
  `computeCostUsd` returns 0.001 and `classifyTermination` returns `completed`.
- **Exact `StreamEvent` shapes** (transport.ts:54-105):
```ts
{ kind: 'text', text: string }
{ kind: 'thinking_start' }
{ kind: 'thinking', text: string }
{ kind: 'thinking_block', thinking: string, signature?: string }
{ kind: 'tool_use', toolUse: { id: string, name: string, input: unknown, thoughtSignature?: string } }
{ kind: 'tool_ready', toolUse: { id, name, input } }            // TOOLS_MIDSTREAM_V1 only
{ kind: 'done', stopReason: string | null, usage: NormalizedUsage, replay?: ProviderReplay }
// e.g. { kind:'done', stopReason:'end_turn', usage:{ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 9000, cacheCreationInputTokens: 300 } }
```
- **To test the Anthropic wire body without the network**, inject a fake client and capture what `stream()`
  receives. Verbatim from `src/transports/__tests__/anthropic-transport.sonnet-5-5-wire.test.ts:17-36`:
```ts
const client = { messages: { stream(params: Record<string, unknown>) { body = params;
  return { async *[Symbol.asyncIterator]() {}, async finalMessage() { return {}; } }; } } } as unknown as Anthropic;
new AnthropicMessagesTransport({ client }).callModel({ model: 'claude-sonnet-5-5', system: 'S',
  tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
  history: [{ role: 'user', content: 'go' }], maxTokens: 8192 });
```
  The same fake-client trick works for a direct Go loop: assert `cache_control` positions and the `thinking` /
  `output_config` fields on the captured body. Other placement tests worth copying:
  `anthropic-transport.adaptive-cache.test.ts`, `.cache-tiering.test.ts`, `.no-cache-write.test.ts`,
  `.cache-ttl-split.test.ts`.
- Replay: `src/engine/replay/replay-transport.ts` plus `src/__fixtures__/replay/*.jsonl` replay a recorded journal
  with no API key.

## 6. Model ids and speed quirks (`src/contract/model-capabilities.ts`, `resolveCapabilities(model)` is a root export)
Matching is a first-substring scan in SEED order (`match` keys below).

| id (match) | line | provider/api | thinking row | wire effect (thinking-support.ts:96-145) |
|---|---|---|---|---|
| `claude-sonnet-5-5` (`sonnet-5-5`) | :351 | anthropic | `always_on`, effort `medium`, perMessageEffort | always sends `thinking:{type:'adaptive', display:'summarized'}` + `output_config:{effort:'medium'}`. Never sends `between_tools` (no thinking) or `low` on the main loop; only side calls (`reasoningEffort:'low'`) get low. `NATIVE_THINKING=off` omits both, so the API falls back to its own defaults (adaptive, effort high). cache floor 512 |
| `claude-haiku-4-5` (`haiku-4-5`) | :417 | anthropic | `enabled`, no effort | **always** sends `thinking:{type:'enabled', budget_tokens:4000 (NATIVE_THINKING_BUDGET, min 1024), display:'summarized'}` + beta `interleaved-thinking-2025-05-14`. Only the process-global `NATIVE_THINKING=off` removes it. 200k context; registry floor 2048 (the API's is 4096) |
| `claude-fable-5-1` / `claude-fable-5` | :436 / :452 | anthropic | `always_on`, effort `high` | adaptive + summarized at effort high: slow, Opus-plus pricing ($10/$50) |
| `claude-opus-5-5` | :290 | anthropic | `always_on` | thinking cannot be disabled |
| `gpt-5.4-mini` | :906 | openai (Responses) | `reasoning`, medium | `OPENAI_REASONING_EFFORT` env override (clamped); `OPENAI_REASONING` kill switch |
| `gpt-6-luna` | :837 | openai | `reasoning`, effort **max** | slow by design; boundary cache |
| `gpt-6.1-sol` / `gpt-6-sol` | :834-835 | openai | reasoning, medium (6.1) | boundary cache |
| `deepseek-v4.1-flash` / `deepseek-v4-flash` | :604 / :619 | fireworks, `openai_chat_completions` | `reasoning`, effort `high`, replaysReasoning | Fireworks `reasoning_effort` accepts 'none'/'high'; text-only; cache via `x-session-affinity` |
| `glm-5.2` | :643 | fireworks, chat | reasoning high | **`available:false`**: Fireworks retired it on 2026-10-04. No GLM-5.3 and no Baseten row in this copy |
| `gemini-3.8-flash` | :960 | google, `gemini_interactions` | reasoning, medium | `GEMINI_THINKING_LEVEL` env |
| also present | | | | `claude-sonnet-5`, `-4-6`, `-4-5`, `opus-5/-4-8/-4-7/-4-6/-4-5`, `mythos-*`, `deepseek-v4-pro` (unavailable), `muse-spark-1.3*`, `grok-4.5/4.6/4.7`, `gpt-6-astra`, `gpt-5.6-*`, `gpt-5.5`, `gpt-5.4` |

Per-request `maxTokens` is always `resolveCapabilities(model).maxOutputTokens` (round-stream.ts:186), which is
128k for Sonnet 5.5. It is not a latency cost, but it cannot be changed. Speed knobs Go needs on the direct path:
- **Sonnet 5.5**: `thinking:{type:'between_tools'}` (thinking off, effort ≤ high; no other thinking field allowed),
  or adaptive at `output_config.effort:'low'`. Forced `tool_choice` any/tool returns 400; use `auto`.
- **Haiku 4.5**: omit `thinking`.

## 7. What the native harness adds that Go does not want, and how to turn each off
Most product features are **opt-in env flags**, off unless set (`optInEnabled` in policy/feature-flags.ts). Leave
these unset: TOOL_DEFER, TOOL_SEARCH, CONTEXT_ELISION, COMPACTION_V2, POST_TURN_OFF_PATH, CONTEXT_APPEND,
VIDEO_UNDERSTANDING, WARM_CONNECTIONS, TOOLS_MIDSTREAM, LANE_FALLBACK, HOOK_PARITY, SILENT_DEATHS,
NETWORK_WAIT, and the others.

| thing | default with a bare NativeConfig | how to disable |
|---|---|---|
| journal files on disk | none without `journal` | omit `journal` |
| compaction (thresholds, summarize) | needs `journal` + `compaction` | omit both |
| next-prompt suggestion side call | off | leave `suggestNextPrompt` unset |
| Nami memory sweep | off | leave `namiOffloopSweep` unset |
| sub-agents (Agent tool) / skills / abilities | only if `toolHost` supplies them | do not supply them |
| permission prompts / HITL | `AllowAllPolicyPort`; `UnconfiguredInteractionPort` throws only if a pause happens | default |
| hooks dispatcher + security floor | always created (`createNativeHookDispatcher`, native-harness.ts:544); with no callbacks every seam is a no-op | cannot remove; cheap |
| `narration` param on every tool | **always on** | not switchable (tool-dispatcher.ts:95) |
| empty-response recovery (≤3 re-calls + fallback text) | **always on** | not switchable |
| Composio auth-result scan on every tool result | always on | not switchable; cheap |
| retry 4×, 750 ms linear backoff | on | `retry: {maxAttempts: 1}` |
| thinking (adaptive/summarized, effort medium on Sonnet 5.5; a 4000-token budget on Haiku 4.5) | on | only the process-global `NATIVE_THINKING=off` |
| system-prefix drift warning, context_usage snapshot, per-round `usage` + request byte metering (one `JSON.stringify` per round) | on | not switchable; ms-scale |
| SessionStart / SessionEnd / Stop / PostToolBatch lifecycle dispatch | on (no-ops) | not switchable |

## 8. Recommendation: direct Anthropic Messages loop, about 150 lines

| criterion | `query()` native harness | direct loop |
|---|---|---|
| cache breakpoint control | no mid-user-turn breakpoint; fixed tools + system + rolling (+ secondary) placement; Go's 85% target needs §4 option 1 plus option 2 (an SDK edit) | full: [1] end of system (covers tools+system), [2] end of the last chat block, [3] rolling marker on the last block during tool rounds, [4] spare |
| latency overhead | small CPU cost, but: forced narration tokens on every call, thinking pinned on, no `between_tools` / `low` effort, a stay_silent tool needs an extra round or a fake "pause", empty recovery can add up to 3 calls | one request per round; thinking off or low effort; a stay_silent tool ends the loop locally with no extra call |
| testability | FakeTransport + `StreamEvent` scripts are good, but they **bypass the Anthropic transport**, so they cannot check cache placement | inject a fake `client.messages.stream` (the §5 pattern): check the exact wire body (cache_control positions, thinking) and script the stream events |
| code size | about 40 lines of Go glue, plus the §4 subclass and an SDK patch; it drags 50k+ lines of product engine (Composio, HITL, weave, subagents, policy) along | about 150 lines, all of them Go's |
| first token streaming | yes (`block` text events are live) | yes (`content_block_delta.text_delta` from `client.messages.stream`); plus control over thinking, which decides time to first word |

**Direct loop shape**: `@anthropic-ai/sdk` 0.93.0, `client.messages.stream({...})`.
- Request: `model`; `max_tokens` about 1024 to 2048; `system:[{type:'text', text: RULES, cache_control:{type:'ephemeral'}}]`;
  `tools` built from zod via `z.toJSONSchema(schema, {target:'draft-2020-12'})`.
- `messages: [{role:'user', content:[...chatBlocks /* last one carries cache_control */, {type:'text', text: rightNow}, {type:'text', text: newSince}]}]`.
- Thinking: `{type:'between_tools'}` or effort low on Sonnet 5.5.
- Loop up to N rounds:
  - stream text deltas out;
  - on `tool_use`, run the tools with `Promise.all` (each with `AbortSignal`);
  - push `{role:'assistant', content: final.content}` verbatim, then ONE user message holding every `tool_result`
    (`is_error` on failure);
  - a `stay_silent` / `reply` tool returns a sentinel that breaks the loop without another call.
- Wrap the whole turn in `AbortSignal.timeout(...)`. Collect `usage` for every round.

**Agent-sdk pieces still worth reusing** (all on public subpaths):
- `resolveCapabilities(model)` (root): `contextWindow`, `maxOutputTokens`, `cache.minCacheableTokens`. Note the
  stale Haiku floor (2048; the API's is 4096).
- `computeAnthropicCostUsd(u: AnthropicUsage, model)` (root, native-pricing.ts:222). Also from `./engine`:
  `normalizeAnthropicUsage` / `denormalizeAnthropicUsage` / `chargeableAnthropicUsage` (:234-262) for cost and the
  5m/1h write split. `priceUsageUsd(modelId, NormalizedTokenUsage)` (contract/usage-pricing.ts:180, root) is the
  provider-neutral pricer.
- `classifyAnthropicError(err)` (`./engine`, native-termination.ts:183) maps SDK errors onto `TurnOutcome` kinds
  (rate_limited / network_error / …) for retry decisions.
- `fenceUntrustedText` / `UNTRUSTED_CONTENT_INSTRUCTION` (root, tool-types.ts) for any tool returning third-party
  text, such as web or place search.
- `withToolsTailBreakpoint` (`./transports`, anthropic-tool-defer.ts:109) if a tools-tail breakpoint is wanted.
- The fake-client test pattern from `anthropic-transport.*.test.ts` (§5).
- **Skip**: `toAnthropicTool` / `withNarrationParam` (they inject narration), `FakeTransport` (it never touches the
  wire body), and `NativeHarness`.

**If the team still picks `query()`**, here is the exact config:
```ts
import { query } from '@vestra/agent-sdk/query';
import { AnthropicMessagesTransport } from '@vestra/agent-sdk/transports';
import { makeRuntimeConfig, type UserTurn } from '@vestra/agent-sdk';
import type { NativeConfig } from '@vestra/agent-sdk/engine';
const transport = new GoAnthropicTransport(plan);           // §4 option 1 subclass (+ option 2 SDK patch)
const handle = query<NativeConfig>({
  harness: 'native', model: 'claude-sonnet-5-5', taskId: tripId, sessionId: wakeId, cwd: '',
  prompt: (async function* (): AsyncIterable<UserTurn> { yield { text: '' /* subclass supplies blocks */ }; })(),
  config: {
    onAttached: () => {}, maxTurns: 4, transport, systemPrompt: RULES,
    runtimeConfig: makeRuntimeConfig({ systemPrompt: RULES, userId: tripId }),
    toolHost: { async buildTools() { return { tools: goTools, onAuthHalt: async () => {} }; } },
    retry: { maxAttempts: 2, backoffMs: 300 }, drainTimeoutMs: 1000,
    signal: AbortSignal.timeout(15_000),
    // no journal / compaction / suggestNextPrompt / namiOffloopSweep / registerHooks
  },
});
for await (const ev of handle) { /* block{type:'text'} → stream; usage → cache metrics; turn_end → done */ }
```
Two caveats on that config:
- An empty `text` string gets no rolling marker (`withTailBreakpoint` skips an empty string). The subclass must
  build the content array itself.
- stay_silent needs `markPausedHalt()`, and that sets `turn_end.paused === true`; Go would have to read that as
  "silent". Otherwise it accepts one extra model round.

## 9. Versions pinned (go-brain root)
- `~/workspace/agents/go-brain-worktrees/plan-week/package.json`: `pnpm.overrides = { zod: "4.3.6", openai: "6.39.1", yaml: "2.9.0" }`;
  `packageManager: pnpm@10.29.1`; `engines.node >=22`.
- **`@anthropic-ai/sdk` has no override.** `packages/agent-sdk/package.json` declares `^0.93.0` and the lockfile
  resolves `@anthropic-ai/sdk@0.93.0(zod@4.3.6)` (pnpm-lock.yaml:18-20, 71, 779). It also declares
  `openai ^6.39.1`, `undici 7.30.0`, `yaml ^2.9.0` and `zod ^4.0.0`.
- `packages/contract/package.json` declares `zod ^4.0.0`, resolved to 4.3.6 by the override.
- Workspace packages: `packages/agent-sdk`, `packages/contract`, `packages/contract-py` (`pnpm-workspace.yaml`:
  `packages/*`, `apps/*`).
