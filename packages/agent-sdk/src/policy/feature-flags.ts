/**
 * P0 safety-floor feature flags — agent-sdk local accessors.
 *
 * kill-switch-strict semantics: ON unless the value is exactly '0' or 'false' (default
 * ON; unset stays ON). This is the THIRD registry semantics — distinct from the plain
 * kill-switch (`!== 'false'`), which they disagree with on the string '0'.
 *
 * These three flags are RECORDED in the shared registry (@bash/shared FLAG_REGISTRY,
 * semantics 'kill-switch-strict') so it stays the single SoT for the graduation lint +
 * manifest tripwire. The engine reads NO `@bash/*` (agent-sdk sits below @bash/shared;
 * importing it would be the forbidden circular dep), so the accessor is mirrored here.
 * Identity with the registry is pinned by the table test in
 * __tests__/feature-flags.test.ts, which runs the SAME input matrix
 * (['1','true','false','0',undefined,'']) the shared registry test uses — the
 * mirror+conformance precedent from capture-signal.ts.
 */
function killSwitchStrict(name: string): boolean {
  const v = process.env[name];
  return v !== '0' && v !== 'false';
}
export function bashAstGateEnabled(): boolean { return killSwitchStrict('VESTRA_BASH_AST_GATE'); }
export function webFetchGuardEnabled(): boolean { return killSwitchStrict('VESTRA_WEBFETCH_GUARD'); }
export function webFetchStoreEnabled(): boolean { return killSwitchStrict('VESTRA_WEBFETCH_STORE'); }

/**
 * CONTINUITY_JOURNAL_V1 (continue anywhere, opt-in): read `=== 'true'`, the one shape every runner read
 * site uses (apps/sandbox services/continuity.ts), so the engine and the runner never disagree on '1'.
 */
export function continuityJournalEnabled(): boolean { return process.env.CONTINUITY_JOURNAL_V1 === 'true'; }

/**
 * OPT-IN semantics: OFF unless the value is exactly '1' or 'true'. The INVERSE of
 * the kill-switches above — a NEW feature ships dark (default OFF), so unset/'0'/
 * 'false'/junk are all OFF and OFF must stay byte-identical to today's behavior.
 */
function optInEnabled(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/**
 * ACCESS_LEVELS_V1 — the permissions v2 access-level ladder (side-effect
 * classifier → hard/soft floor). Default OFF: with it off, decideToolGate uses
 * the legacy sensitivity-floor path byte-identically. The shared FLAG_REGISTRY
 * entry (semantics 'opt-in') lands via the @bash/shared side (A2); the engine
 * cannot import @bash/shared, so the accessor is mirrored here like the P0 flags.
 */
export function accessLevelsEnabled(): boolean { return optInEnabled('ACCESS_LEVELS_V1'); }

/**
 * NATIVE_STREAM_SEVERED_RETRY — deploy-seam ladder 1. A severed mid-stream model
 * response (every Railway restart kills all in-flight native streams at the
 * /api/proxy/anthropic seam — incident a7ea0665) classifies as the RETRYABLE
 * 'network_error' kind with raw.subtype 'stream_severed', and the engine seals the
 * partial round and re-issues (bounded) instead of terminating with model_error.
 * Default OFF: with it off, classification and the round loop are byte-identical
 * to today. Recorded in the shared FLAG_REGISTRY (the engine imports no @bash/*).
 */
export function severedStreamRetryEnabled(): boolean { return optInEnabled('NATIVE_STREAM_SEVERED_RETRY'); }

/**
 * Media-refs S1 lane flags (spec §Rule 3) — each lane's request-build
 * materialization is independently gated: Anthropic url source → Files API
 * file_id; OpenAI Responses input_image → uploaded file_id (purpose vision);
 * Chat Completions vision → edge-inlined data: URL and blind-model notes that
 * NAME the omitted image; Gemini url-only blocks → edge fetch-and-inline.
 * Default OFF: with a flag off, that lane's wire body is byte-identical to
 * today. Recorded in the shared FLAG_REGISTRY (the engine imports no @bash/*,
 * so the accessors are mirrored here like the P0 flags above).
 */
export function mediaFileIdAnthropicEnabled(): boolean { return optInEnabled('MEDIA_FILE_ID_ANTHROPIC_V1'); }

/**
 * EDIT_HARDEN_V1 — Edit repairs the two ways a model wastes a billed round-trip on
 * a failed edit: malformed argument shapes (a JSON-string argument object, an
 * `edits` array, Anthropic/pi key names, a stringified `replace_all`) are upgraded
 * silently, and an `old_string` that misses EXACTLY is retried once in a fixed
 * normalized space (NFKC, smart quotes/dashes/spaces → ASCII, trailing whitespace
 * per line, CR dropped) before the miss is reported. OFF (default): argument
 * handling and matching are byte-identical to today, error strings included. ON,
 * the exact-match path is still tried FIRST and is unchanged — normalization runs
 * only where today's code would already have failed.
 */
export function editHardenEnabled(): boolean { return optInEnabled('EDIT_HARDEN_V1'); }

/**
 * CONTEXT_ELISION_V1 — the native harness projects an ELIDED view of the journal
 * onto the wire: old, large tool_result bodies become a one-line stub naming the
 * tool and the spill file that still holds the full bytes, and old images become a
 * text placeholder. The journal itself keeps full fidelity forever.
 *
 * OFF (default): the projection is the raw journal, byte-identical to today,
 * including the pre-existing measurement-only prune tier.
 * ON: the elided view is BOTH what rides the wire AND what the compaction ledger
 * measures — the two can never disagree (see maybeCompact's coherence note).
 *
 * NOTE for the flip: the cut is quantized to a stride grid, so it advances a few
 * times per long task rather than every turn. Each advance rewrites history once
 * and busts the prompt cache once; the prefix then re-stabilizes and every later
 * turn rides the smaller wire. Expect one cache write per step, not per turn.
 */
export function contextElisionEnabled(): boolean { return optInEnabled('CONTEXT_ELISION_V1'); }

/**
 * TOOL_OUTPUT_TOKEN_BUDGET_V1 (harness-to-nine C2) — every tool result is held to the running
 * model's budget in TOKENS (a model row's `toolOutputTokenBudget`, else 10,000): over it, the
 * output is spilled to the `.kernel-offload/` file and the model gets head and tail filled to
 * the budget plus the path. Bash's byte cap rises from 50 KB to 2 MB, so an output up to 2 MB
 * is spilled whole and a larger one as a 2 MB head and tail. While on, the budget is the one
 * spill trigger: CONTEXT_OFFLOAD_THRESHOLD_CHARS is ignored.
 * OFF (default): the character limits alone apply, byte-identical to today.
 */
export function toolOutputTokenBudgetEnabled(): boolean { return optInEnabled('TOOL_OUTPUT_TOKEN_BUDGET_V1'); }

/**
 * TOOL_DEFER_V1 — the Anthropic lane ships `deferrable` tool schemas with
 * `defer_loading: true` and adds the `tool_search_tool_regex_20251119` server
 * tool so the model can pull them in on first use. OFF (default): no tool
 * carries `defer_loading`, no search tool is appended, byte-identical to today.
 *
 * The flag is NECESSARY but not SUFFICIENT — the transport also requires
 * `modelSupportsToolSearch(model)`, so flipping this on a lane whose model lacks
 * the capability is a no-op rather than a 400. Non-Anthropic lanes ignore it
 * entirely (no protocol analogue).
 *
 * NOTE for the flip: deferral withholds schemas from the CONTEXT prefix, not from
 * the request — every deferred definition is still sent on every turn, because the
 * API needs it server-side to expand a discovered `tool_reference`. So expect
 * billed input tokens to drop while request bytes tick slightly UP (the flags plus
 * the search tool). Anyone measuring this by request size will read it backwards.
 */
export function toolDeferEnabled(): boolean { return optInEnabled('TOOL_DEFER_V1'); }

/**
 * TOOL_SEARCH_V1 — the CLIENT-side deferred-tool rail: a small resident
 * `ToolSearch` tool whose RESULT carries the matched tools' full JSON Schemas,
 * after which those tools ride the provider tools array for the rest of the
 * session. OFF (default): no search tool is registered on the wire, no tool is
 * withheld, no index layer renders — byte-identical to today on every lane.
 *
 * THIS IS THE COMPLEMENT OF TOOL_DEFER_V1, NOT A DUPLICATE. That flag hands
 * deferral to Anthropic's server (`defer_loading`), which is strictly cheaper but
 * exists only on tool-search-capable Anthropic models. This one covers everything
 * else — chat-completions (GLM / DeepSeek / Grok), Gemini, OpenAI Responses, and
 * ineligible Anthropic models. `resolveToolSearchRail` gives the native rail
 * priority per model, so with BOTH flags on a capable Anthropic model still rides
 * `defer_loading` and this rail stays dark for it.
 *
 * NOTE for the flip: unlike TOOL_DEFER_V1, this one shrinks BOTH billed tokens and
 * request bytes — a withheld schema is genuinely not sent. The cost is one cache
 * write per tool the model actually loads (loads append to the tools array), plus
 * the round-trip the search itself spends. That trade is only worth it for a group
 * a typical turn never touches, which is exactly what `deferrable` marks.
 */
export function toolSearchEnabled(): boolean { return optInEnabled('TOOL_SEARCH_V1'); }

/**
 * TOOL_DEFER_WIDE_V1 (harness to nine, T1b) — the wide deferral policy: a small resident
 * core stays in the prefix and every tool the product marked `deferrableWide` (all MCP and
 * Composio tools, the rarely used built-ins) is deferred too, and the deferred list is
 * rendered from the BUILT catalog, names only for Anthropic models. Effective only with
 * TOOL_SEARCH_V1 or TOOL_DEFER_V1 on (engine/tool-search.ts wideDeferralActive). OFF: the
 * marker is inert and every request is byte-identical.
 */
export function toolDeferWideEnabled(): boolean { return optInEnabled('TOOL_DEFER_WIDE_V1'); }

/**
 * TOOL_DESC_TRIM_V1 (harness to nine, T3) — the resident core's heaviest tools (Agent, Grep,
 * AskUserQuestion, Bash, Monitor, TodoUpdate, Read) advertise trimmed descriptions and
 * parameter text, and every Zod-built schema drops the safe-integer bounds zod adds to
 * `.int()` (no information: dispatch still validates with zod). Read when a tool is BUILT,
 * never at module load. OFF: every description and schema byte-identical.
 */
export function toolDescTrimEnabled(): boolean { return optInEnabled('TOOL_DESC_TRIM_V1'); }

/**
 * TOOL_DESC_LEAN_V1 (harness to nine, T1b to 12K) — the safe subset of TOOL_DESC_TRIM_V1 for
 * the resident core: only what a tool says twice goes (Grep's restated parameter list and its
 * ripgrep notes, Bash's restated timeout clause; Read's words untouched), and the safe-integer bounds leave a schema only where that leaves its
 * OpenAI strict status unchanged (the strict flips were TOOL_DESC_TRIM_V1's schema-level
 * behaviour change). Every behavioural instruction stays. TOOL_DESC_TRIM_V1, when on, wins.
 * Read when a tool is BUILT (texts) and at every schema conversion (bounds). OFF: byte-identical.
 */
export function toolDescLeanEnabled(): boolean { return optInEnabled('TOOL_DESC_LEAN_V1'); }

/**
 * SHELL_SESSION_V1 (harness to nine, T4): a shell session that hands back. Bash takes
 * `yield_ms` and returns the output so far after that long while the command keeps running
 * as a background job; the `process` tool's read returns only what is new since the last
 * read (a waiting prompt included), and its write and submit return the reply; `process`
 * joins the resident core. Read when a tool is BUILT. OFF: every schema, description and
 * result byte-identical.
 */
export function shellSessionEnabled(): boolean { return optInEnabled('SHELL_SESSION_V1'); }

/**
 * TOOL_SCHEMA_COMPACT_V1 (harness to nine, T1b finish): a nullable primitive field goes on the
 * wire as `type: [T, "null"]` instead of `anyOf: [{type: T}, {type: "null"}]`, the same JSON
 * Schema in fewer tokens (contract/tool-json-schema.ts compactNullableTypes); the Gemini lanes
 * send their own form, one `type` plus `nullable: true`. Read at every conversion. OFF: every
 * schema byte-identical.
 */
export function toolSchemaCompactEnabled(): boolean { return optInEnabled('TOOL_SCHEMA_COMPACT_V1'); }

/**
 * TOOL_CONCURRENCY_CLASSES_V1 (harness to nine, L2) — every tool's `concurrency` class
 * ('shared' | 'exclusive', default exclusive) decides which calls in a batch overlap:
 * reads, web search and fetch, Nami reads, MCP search, ToolSearch and the Agent tool run
 * together; an exclusive call waits for all of them and runs alone. OFF (default): only
 * the W3-2 `concurrencySafe` marker decides, byte-identical batch shapes. Read per round
 * (batch-shape.ts sharedToolNames); never on the wire.
 */
export function toolConcurrencyClassesEnabled(): boolean { return optInEnabled('TOOL_CONCURRENCY_CLASSES_V1'); }

/**
 * TOOLS_MIDSTREAM_V1 (harness to nine, L1) — tools start while the model is still
 * streaming. Each transport emits a `tool_ready` stream event the moment one call's
 * arguments are complete and parse, and the main loop starts that call then, if it
 * would have run first anyway: a shared call with nothing but shared calls before it
 * (engine/tool-early-start.ts). The gate decides then; a pause or an auth card waits
 * until the call's turn in the batch. Blocks, journal entries and results stay in call
 * order. OFF (default): no transport emits `tool_ready`, every call starts after the
 * stream ends, byte-identical. Read per stream and per round; never on the wire.
 */
export function toolsMidstreamEnabled(): boolean { return optInEnabled('TOOLS_MIDSTREAM_V1'); }

/**
 * LANE_FALLBACK_V1 (harness to nine, LOOP) — once a request's lane has failed its cause's whole
 * bounded schedule with a lane fault (a dropped connection, or a bodyless 5xx: an edge answering
 * for a proxy that is briefly gone), the transport moves that model's requests to the second route
 * to the same provider (the same credential-proxy path on the API plane,
 * transports/lane-fallback.ts) and the request gets a fresh budget there, once. The move holds
 * LANE_FALLBACK_HOLD_MS (the sandbox replays it, with the hold that is left, for the session's
 * next runs), then requests go back to the lane. OFF (default): byte-identical. Read per request.
 */
export function laneFallbackEnabled(): boolean { return optInEnabled('LANE_FALLBACK_V1'); }

/**
 * NETWORK_WAIT_V1 (harness to nine, LOOP) — a dropped connection on the main loop's model
 * request is not the provider's error: once its bounded retries are spent, the request keeps
 * waiting for the network (5 s doubling to 60 s, no attempt cap) with one live "waiting for the
 * network" line per wait, until it answers, the person stops the turn, or the waits would pass
 * NETWORK_WAIT_CEILING_MS (error-authority.ts networkWaitMs, round-engine.ts
 * startStreamWithRetry); each model stream also gets MODEL_RESPONSE_TIMEOUT_MS. Subagents and
 * every other cause keep their bounded schedules. OFF (default): byte-identical. Read per request.
 */
export function networkWaitEnabled(): boolean { return optInEnabled('NETWORK_WAIT_V1'); }

/**
 * TOOLS_MIDSTREAM_RW_V1 (harness to nine, LOOP) — on top of L1, a fair read/write gate per
 * round (engine/tool-early-start.ts): a shared call starts unless an earlier exclusive call
 * has not settled, an exclusive call starts once every earlier call has settled, later calls
 * queue behind it. A round that ends before the batch takes its calls journals the started
 * prefix when an exclusive call in it started (round-engine.ts journalStartedPrefix). Requires
 * TOOLS_MIDSTREAM_V1. OFF (default): L1's door, byte-identical. Read per round.
 */
export function toolsMidstreamRwEnabled(): boolean { return optInEnabled('TOOLS_MIDSTREAM_RW_V1'); }

/**
 * TOOL_RESULT_SHAPE_V1 (harness to nine, T5) — every cut tool result carries the ONE
 * truncation marker (tools/result-shape.ts truncationMarker: `...[OUTPUT TRUNCATED: <n> <unit>
 * omitted from the <where>, <what is> shown. <recovery>]...`): the last-resort character cap,
 * the offload preview (now naming the absolute spill path), the command-output cap, Bash's
 * 8 MB stop, WebFetch's clip and its stored-page window, and the process read window. OFF
 * (default): each keeps today's notice, byte-identical. The token-budget marker (C2) is the
 * target and is unchanged either way. The same flag moves the tools' plain-string failures onto
 * the error channel (result-shape.ts softFail), a behaviour change: execute_code's bridge then
 * raises ToolError in the script. Read per result; never on the wire.
 */
export function toolResultShapeEnabled(): boolean { return optInEnabled('TOOL_RESULT_SHAPE_V1'); }

/**
 * COMPACTION_V2 — compaction that fires on ECONOMICS rather than on a fraction of
 * the window, recovers from a provider overflow, and costs a flat amount per fire.
 *
 * OFF (default): the trigger is 80% of the model window measured through the
 * pre-existing (measurement-only) prune tier, the summarize call re-reads the whole
 * span with a cache breakpoint on it, and an overflow observed as a clean truncated
 * stop is invisible. Byte-identical to today.
 *
 * ON, four things change:
 *   1. TRIGGER — the ledger is measured off the bytes that actually ride the wire
 *      (the elision seam, raw when elision is off) and compared against
 *      min(80% of the window, the model's preferred input ceiling). On a 1M-window
 *      model whose preferred ceiling is 200k, compaction now fires around 180k
 *      instead of at ~800k. (Not a price bound — Anthropic bills the full 1M at
 *      standard rate; see kernel/compaction/trigger.ts for why the bound exists.)
 *   2. PRUNE TIER — dies. It only ever shrank the number the trigger read while the
 *      full bytes rode the wire; elision is the mechanism that actually shrinks both.
 *   3. OVERFLOW — a provider overflow or a truncated stop strips the failed assistant
 *      message from the wire view, force-compacts, and retries ONCE, behind a
 *      model-switch guard and a post-compaction staleness guard.
 *   4. SUMMARIZE — iterative (previous summary + only the new span), file trails
 *      appended mechanically, no prompt-cache write, and a `compaction` lane row in
 *      the books.
 *
 * NOTE for the flip: firing at the preferred ceiling means MORE compactions per long
 * task, each rewriting history once and busting the prompt cache once. That is the
 * trade being bought — a cache re-write on a ~20k post-compaction context is far
 * cheaper than every later request re-reading a 200k+ prompt (standard rate on every
 * token, plus the prefill latency and answer-quality cost a prompt that long carries).
 */
export function compactionV2Enabled(): boolean { return optInEnabled('COMPACTION_V2'); }
export function mediaFileIdOpenAIEnabled(): boolean { return optInEnabled('MEDIA_FILE_ID_OPENAI_V1'); }
export function mediaInlineChatEnabled(): boolean { return optInEnabled('MEDIA_INLINE_CHAT_V1'); }
export function mediaInlineGeminiEnabled(): boolean { return optInEnabled('MEDIA_INLINE_GEMINI_V1'); }

/**
 * VIDEO_UNDERSTANDING_V1 — uploaded video/audio/PDF reach the model. The user
 * turn carries a `media` block; the Gemini lane sends a Files API reference
 * natively; every other model gains the `watch` tool. OFF: no block, no tool,
 * byte-identical wires. Spec: specs/2026-09-04-video-understanding-design.md.
 */
export function videoUnderstandingEnabled(): boolean { return optInEnabled('VIDEO_UNDERSTANDING_V1'); }

/**
 * SHELL_CREDENTIAL_BROKER_V1 (harness to nine, S1): commands (Bash, background processes,
 * Monitor) get a per-session placeholder instead of the live sandbox bearer, and a loopback route
 * that swaps it back only on the way to our own API and proxy hosts. Ability command hooks and a
 * company's setup script and repo clone get a placeholder that works nowhere.
 * OFF: child envs byte-identical. See tools/credential-broker.ts.
 */
export function credentialBrokerEnabled(): boolean { return optInEnabled('SHELL_CREDENTIAL_BROKER_V1'); }

/**
 * WARM_CONNECTIONS_V1 (harness to nine, L4): model requests ride one keep-alive pool
 * per provider host, shared by every session in the runner, and each turn head opens
 * the connection (TCP + TLS, no request) before the turn's prompt is built. OFF: the
 * provider clients are built with today's options and the Gemini `fetch` init is
 * unchanged, so every request rides the built-in fetch's default pool as before.
 * Read by transports/warm-connections.ts.
 */
export function warmConnectionsEnabled(): boolean { return optInEnabled('WARM_CONNECTIONS_V1'); }

/**
 * SILENT_DEATHS_V1 — two failures on the turn path that used to vanish become visible
 * (harness to nine L5, harvest of #3332): a Composio Connect card that could not be
 * raised is an explicit tool error the model reads (engine/tool-dispatcher.ts), never a
 * pause with no card; and a torn SSE frame on either Gemini lane is a severed stream
 * (transports/sse-frame.ts), never a frame silently skipped: re-issued under
 * NATIVE_STREAM_SEVERED_RETRY, else a visible terminal model_error. OFF: both keep
 * today's behaviour byte-identical. Read per call, and the ONE read: the runner
 * (apps/sandbox native-tools.ts) imports this accessor too.
 */
export function silentDeathsEnabled(): boolean { return optInEnabled('SILENT_DEATHS_V1'); }

/**
 * RETRY_BY_CAUSE_V1 — the model-call retry boundary sorts each failure by cause
 * (engine/error-authority.ts retryCause): a usage limit is never retried, a rate limit
 * waits the provider's hint or a full-jitter backoff from 500 ms, an overload keeps
 * today's schedule and then the configured fallback model, a dropped connection re-asks
 * on a fresh connection. OFF: today's four linear attempts, byte-identical.
 */
export function retryByCauseEnabled(): boolean { return optInEnabled('RETRY_BY_CAUSE_V1'); }

/**
 * HOOK_PARITY_V1 (harness to nine, X1): the native arm answers hooks the way Claude Code
 * documents them. PermissionRequest fires when a permission card is about to show, only
 * where a standing allow rule could silence it (never payments, dangerous deletes, the
 * person's ask rules), and may answer it (allow, with an `updatedInput` rewrite re-gated
 * first; deny refuses the tool); a `permission_prompt` Notification fires when the card does
 * show; a PreToolUse hook's rewrite is re-gated; a Stop `decision:"block"` (or exit 2) keeps
 * the turn going with the reason as the next instruction, and says so
 * (`agent:hook_stop_continued`); a PostToolUse block reason reaches the model beside the
 * result; a PreToolUse top-level `decision:"block"` denies the one tool instead of stopping
 * the turn. The X1 gaps: matchers read the documented way (native-hooks.ts), context beside
 * the tool result, a PermissionRequest `interrupt`, SubagentStart seeding and SubagentStop
 * continuing a helper, a PreCompact block, SessionStart "resume" / "compact", SessionEnd
 * "other", and the MCP question card's Notification types. OFF: none of these fire or apply,
 * byte-identical. Read by engine/hook-parity.ts, engine/tool-gate-verdict.ts and
 * engine/native-hooks.ts.
 */
export function hookParityEnabled(): boolean { return optInEnabled('HOOK_PARITY_V1'); }

/**
 * SECURITY_PATTERNS_V2 (harness to nine, S5b): the dangerous-command rules that were text
 * regexes (the three rm rules, `chown -R … /`, `chmod 777 /`, `curl|wget … | sh`) run as
 * exact catalog membership over parsed argv instead (policy/command-catalogs.ts). OFF: the
 * regex table runs exactly as today, byte-identical.
 */
export function securityPatternsV2Enabled(): boolean { return optInEnabled('SECURITY_PATTERNS_V2'); }

/**
 * MCP_INVOKE_RESOLVED_GATE_V1 (harness to nine, B6): an `mcp_invoke` call is judged as the MCP
 * tool it runs (server, tool name and the server's declared annotations), never as the wrapper:
 * the side-effect classifier resolves it (side-effect-classifier.ts), so the access level, the
 * hard floor and the injection screen see a send, a delete or a read for what it is, and every
 * deny/ask rule sees the inner tool (apps/sandbox permission-rules-loader innerViewRulesFor).
 * OFF: the wrapper classifies as a workspace write, byte-identical.
 */
export function mcpInvokeResolvedGateEnabled(): boolean { return optInEnabled('MCP_INVOKE_RESOLVED_GATE_V1'); }

/**
 * GITHUB_APP_V1 (engineer teammates, Git train G2): the box's git can get a GitHub token from
 * the Vestra server (apps/sandbox/bin/vestra-git-credential). Only then is there a token for the
 * agent to extract, so only then does the security gate refuse the commands that would hand it
 * over (git-command-catalog gitCredentialExtraction). OFF: those commands keep their pre-G2
 * verdicts byte for byte (a person pushing with their own token is untouched). STRICT `=== 'true'`,
 * like the box's other two read sites, and NOT optInEnabled: the flag crosses env.schema as a
 * boolean (so OFF never enters the env hash), which would turn a '1' into OFF on its way here.
 */
export function githubAppEnabled(): boolean { return process.env.GITHUB_APP_V1 === 'true'; }

/**
 * SANDBOX_DISK_GUARD_V1 (the disk guard, off | dry | on): only 'on' refuses. The registry parses
 * the value (@bash/shared sandbox/disk-guard.ts parseDiskGuardMode, which the engine cannot
 * import); this mirrors the one position that changes what a media download does. 'dry' and
 * everything else leave the download exactly as before.
 */
export function diskGuardRefuses(): boolean { return process.env.SANDBOX_DISK_GUARD_V1 === 'on'; }

/**
 * TOOL_PROGRESS_WATCHDOG_V1 (harness to nine L5, the redo of #3333): off | shadow | true.
 * A tool is cut only after a long window with NO progress (engine/tool-progress-watch.ts),
 * never on time alone. A VALUE flag, not opt-in: 'shadow' is its own position (log
 * `[tool-watchdog] would-cut ...`, cut nothing), 'true' cuts, and anything else (unset,
 * 'off', '1', a typo) is off: nothing is armed and dispatch is byte-identical. Read at call
 * time so a test can stub it.
 */
export type ToolProgressWatchdogMode = 'off' | 'shadow' | 'on';
export function toolProgressWatchdogMode(): ToolProgressWatchdogMode {
  const v = process.env.TOOL_PROGRESS_WATCHDOG_V1;
  if (v === 'true') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/**
 * POST_TURN_OFF_PATH_V1 (harness to nine, speed V0): a follow-up never waits on post-turn
 * work. The next-prompt suggestion and the Nami memory sweep run while the loop already
 * listens for the next message; a message that arrives first cancels the suggestion (its
 * chip is never shown) and defers the sweep to the next completed turn, where one sweep
 * covers both. The suggestion also takes the sweep's 'low' reasoning floor. OFF: both are
 * awaited before the next message is read, byte-identical. Read by engine/native-harness.ts.
 */
export function postTurnOffPathEnabled(): boolean { return optInEnabled('POST_TURN_OFF_PATH_V1'); }

/**
 * COMPACTION_POST_TURN_V1 (harness to nine, the Codex borrow: core/src/session/turn.rs:716) — a
 * turn that ends with its measured input at 85% or more of the compaction budget compacts in
 * the idle wait for the next message, so the next turn starts under budget instead of
 * compacting at a round head mid-work. Billed on the off-loop 'post_turn_compaction' lane. Also
 * stamps every compaction's usage event with what it did (reason, strategy, tokens before and
 * after) for the O1 rail. Needs COMPACTION_V2. OFF: byte-identical.
 */
export function compactionPostTurnEnabled(): boolean { return optInEnabled('COMPACTION_POST_TURN_V1'); }

/**
 * BILL_CACHE_WRITE_1H_V1: whether an Anthropic 1-hour cache write is CHARGED at its real price (2x
 * input), not whether it is RECORDED. The 5m/1h split rides every Anthropic usage row whatever this
 * says (the row's truth); this decides only the price a CHARGE puts on it: the runner's claim
 * (engine/native-pricing.ts chargeableAnthropicUsage), the server's turn re-price and the off-loop
 * charge (contract/usage-pricing.ts chargeableTokenUsage), so the three agree in both states. The
 * price check against Anthropic's cost report prices the truth always. OFF: every write prices at
 * the 5-minute rate (1.25x), the charge prod has always made. The founder decides prod pricing.
 * Read per call in BOTH processes: the server's env, delivered to runners (FEATURE_ENV_FLAGS).
 */
export function billCacheWrite1hEnabled(): boolean { return optInEnabled('BILL_CACHE_WRITE_1H_V1'); }

/**
 * SWEEP_PREFIX_PARITY_V1: the Nami memory sweep sends the main loop's LAST request verbatim
 * (system, tools, cache key, system split, and no reasoning override, so the transport
 * resolves the loop's own effort) with the journal projection plus its prompt as history and
 * its own output cap. Every provider keys its prompt cache on the effort and on the routing
 * key the old sweep dropped (probes 2026-10-01), so off, the sweep reads almost none of the
 * cache the turn just wrote. OFF: today's sweep request, byte-identical. Read by
 * engine/post-turn-off-path.ts sweepCall.
 */
export function sweepPrefixParityEnabled(): boolean { return optInEnabled('SWEEP_PREFIX_PARITY_V1'); }

/**
 * SWEEP_EFFORT_MESSAGE_V1: on top of SWEEP_PREFIX_PARITY_V1, on a row that takes a per-message
 * effort change (registry thinking.perMessageEffort), the memory sweep rides the loop's request
 * plus one effort-only message that lowers its own turn to 'low': the loop's cache is read in
 * full and the sweep does not reason at the loop's effort. Such a row rides parity whatever its
 * effort. OFF: SWEEP_PREFIX_PARITY_V1 exactly as before. Read by engine/post-turn-off-path.ts
 * sweepCall.
 */
export function sweepEffortMessageEnabled(): boolean { return optInEnabled('SWEEP_EFFORT_MESSAGE_V1'); }

/**
 * SWEEP_PARITY_BY_PREFIX_V1 (with SWEEP_PREFIX_PARITY_V1): the high-effort Anthropic rows that
 * cannot take a per-message effort change (Fable 5, Mythos 5, the Opus 4 rows) ride the loop's
 * request when the history a floored sweep would rewrite is over the row's break-even
 * (engine/memory-sweep.ts sweepParityPlan, parityBreakEvenTokens). OFF: byte-identical.
 */
export function sweepParityByPrefixEnabled(): boolean { return optInEnabled('SWEEP_PARITY_BY_PREFIX_V1'); }

/**
 * SUBAGENT_USAGE_LEDGER_V1 (harness to nine, C5): an in-process subagent's rounds emit their
 * usage on the 'subagent' lane, so the token ledger (task_turn_usage) carries the provider's
 * numbers for every model call and the server's re-priced turn total includes the children's
 * cost, which the runner's claimed total always did (prod: server = claimed - child cost on
 * every subagent turn). OFF: subagent rounds emit no usage, byte-identical. Read by
 * engine/round-stream.ts emitRoundUsage.
 */
export function subagentUsageLedgerEnabled(): boolean { return optInEnabled('SUBAGENT_USAGE_LEDGER_V1'); }

/**
 * CONTEXT_APPEND_V1 (harness to nine, C1): the prefix is never rewritten mid-session. The
 * first run of a session freezes a base; later runs serve the system prompt from it and tell
 * the model an APPEND change (memory, the tool index, SessionStart context) as ONE appended
 * item, while a REBUILD change (identity, accounts, workspace instructions, abilities) serves
 * a fresh prompt. C7: a model change rebuilds, an effort change is appended, and a warm run built
 * for another model is retired at the turn boundary (apps/sandbox turn-router). The flag decides
 * only NEW freezes: a frozen session stays held. OFF and
 * never frozen: every run re-renders the system prompt from the live world, byte-identical.
 * Read by engine/context-append.ts.
 */
export function contextAppendEnabled(): boolean { return optInEnabled('CONTEXT_APPEND_V1'); }

/**
 * CHAT_TAIL_AFTER_TOOLS_V1 (speed race, item D): a main-loop request on a Chat Completions model
 * carries where the run's memory blocks sit in its system prompt (RunContext.systemMemorySpan,
 * measured once at run open), and the transport sends the memory as a second system message on
 * the builds that render tools after the first (fireworks-wire.ts TOOLS_AFTER_SYSTEM_WIRE_IDS),
 * so a new task reads the tools from cache. Read per round by engine/round-stream.ts
 * buildRoundRequest. OFF: no field on the request, every body byte-identical.
 */
export function chatTailAfterToolsEnabled(): boolean { return optInEnabled('CHAT_TAIL_AFTER_TOOLS_V1'); }

/**
 * RESPONSES_MEMORY_INPUT_V1 (speed race, item C'): a main-loop request on an OpenAI Responses
 * model carries the same memory span, and on the builds that read the cache only at lookup
 * boundaries (registry `cache.readsAtBoundaries`: GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra) the
 * memory rides as the first user input item, fenced as recall is (injected-user-text.ts
 * fenceSessionMemory), so `instructions` holds only what a person's tasks share and a new task
 * reads it from cache. Read per round by engine/round-stream.ts buildRoundRequest. OFF:
 * byte-identical.
 */
export function responsesMemoryInputEnabled(): boolean { return optInEnabled('RESPONSES_MEMORY_INPUT_V1'); }

/**
 * SCREENSHOT_PRUNE_CACHE_V1 (prod incident 10-03, task 28edef30): the screenshot prune touches
 * only the host's screenshot tools (exact names) and stubs in batches of SCREENSHOT_PRUNE_BATCH,
 * so an image Read never edits the middle of the history and a browser run edits it once a
 * batch (kernel compaction/prune-screenshots.ts). Read by the host when it builds a task's
 * Journal (sandbox query-manager.ts). OFF: the legacy prune, byte-identical.
 */
export function screenshotPruneCacheEnabled(): boolean { return optInEnabled('SCREENSHOT_PRUNE_CACHE_V1'); }
