# Replay fixtures

Real staging journals, redacted, that drive the kernel loop **keylessly** in CI
(`src/engine/replay/__tests__/replay.test.ts`). Each fixture must replay to a journal
semantically identical to itself (ids, seq, timestamps and cost stripped) with zero
reconstruction mismatches. The rule every future fix PR is held to:

> this fix ships with `__fixtures__/replay/<n>-<name>.jsonl`, which fails on the parent
> commit and passes on this one.

## Format

JSONL. Every line is either

- a **journal entry** — a row of `kernel_journal_mirror`, exactly as the engine wrote it
  (the harvest never invents, rewrites or reorders entries; it only drops and redacts), or
- a **replay directive** — `{"replay": {...}}`: something the provider did that the journal
  does not record. The only directive today is an in-stream error frame:

  ```json
  {"replay":{"kind":"stream_error","error":{"type":"overloaded_error","message":"Overloaded"}}}
  ```

  It sits immediately before the assistant round it precedes. On that round's model call
  the replay transport throws exactly what `@anthropic-ai/sdk` builds for an SSE
  `event: error` frame — `new APIError(undefined, body, undefined, headers, type)`, no HTTP
  status — on the first read, so the round engine's pre-commit retry belt
  (`startStreamWithRetry`) classifies and re-issues it the way production would. Two
  consecutive directives = two failed attempts before the real round.

Entry kinds kept: `user`, `assistant`, `tool_use`, `tool_result`, `usage`, `compact_boundary`
(what the bare engine writes deterministically). Product-plane kinds (`custom`
construction params / nami capture, `plan`, `interaction`, …) are dropped at harvest —
a keyless replay does not reproduce them. The invisible memory-pass turn
(`control:'memory'` and its chain) is dropped the way the projection drops it.

What is **not** replayable yet (a recording containing it will not replay to equality):
subagent-scoped entries (`agentPath`), image-bearing tool results, engine-appended
mid-turn user entries that ride host seams the replay does not wire (steer, recall fences,
hook context), and a fault that arrives *after* partial content (the severed-belt shape:
partial assistant entry + `STREAM_SEVERED_CONTINUE_MARKER`). The runaway-guard terminal
directive (W3-3) IS replayable: the engine regenerates it deterministically from the
recorded failing results, so replaySession excludes it from turn-start detection exactly
like the severed marker.

## Harvest (scripted redaction — never by hand)

```bash
node scripts/replay/harvest.mjs pull <taskId> <out.jsonl> [--redact name1,name2] [--env apps/server/.env]
node scripts/replay/harvest.mjs redact <in.jsonl> <out.jsonl> [--redact name1,name2]   # re-run redaction in place
node scripts/replay/harvest.mjs inject <in.jsonl> <out.jsonl> --before-round N [--error overloaded_error]
```

`pull` reads STAGING only (the Supabase URL must be the staging project; anything else —
prod above all — is refused before a byte is read) and redacts: emails →
`user@example.com`, `/Users/<x>` and `/home/<x>` → `/workspace`, secret-shaped values
(API keys, JWTs, bearer tokens, `key=value` credentials) → `[redacted]`, `--redact`
literals → `[redacted]`, the real task / workspace / user ids → fixed placeholder uuids
(inside strings too), and every other uuid-shaped string (entry ids, other tasks' journal
file names, session transcript ids) → a stable counter placeholder — no foreign identifier
survives. Redaction is idempotent. It prints counts, never content. Re-run
`node packages/agent-sdk/scripts/lint-journal-secrets.mjs` and
`grep -c "@" packages/agent-sdk/src/__fixtures__/replay/*.jsonl` before committing a new
fixture.

## The fixtures

| Fixture | Lane | Shape |
|---|---|---|
| `01-plain-text-turn.jsonl` | `openai_chat_completions` / deepseek-v4-flash (the drill default) | one user turn → one assistant round with an unsigned thinking block + text; no tools |
| `02-read-grep-tools.jsonl` | `anthropic_messages` / claude-sonnet-5 | two user turns, ten assistant rounds: signed thinking, tool-only rounds, a two-call round; Bash, Grep, Read, Edit and `remember` calls including two `isError` results |
| `03-multi-round-with-error-frame.jsonl` | 02 + a directive | **synthesised** from 02: an `overloaded_error` stream-error directive before the second assistant round. Anthropic cannot be made to overload on demand, so the frame is injected; the journal entries are 02's, untouched |
| `04-concurrent-read-grep-batch.jsonl` | `anthropic_messages` / claude-sonnet-5 | **synthesised** (W3-2): one round issuing Read + Grep as ONE batch, recorded in the CONCURRENT two-phase journal shape — both `tool_use` entries land before either `tool_result`, results in wire order. Its test passes `concurrencySafe`-marked tools through `opts.tools`; the default stubs stay UNMARKED (fail-closed), which is also why 02 — recorded pairwise-sequential — keeps replaying sequentially. A build without the concurrencySafe rail replays 04 pairwise and fails equality |
| `05-runaway-identical-failures.jsonl` | `anthropic_messages` / claude-sonnet-5 | **synthesised** (W3-3): one WebSearch call failing identically 8 rounds — the parent runaway guard trips, appends the terminal directive as a user entry, REFUSES both grace rounds' calls at the gate (the recorded denial `tool_result`s carry the directive text; no tool runs), then force-completes. A build without the parent guard asks for an 11th round (`ReplayExhausted`) and never writes the directive — the fixture pins trip + steer + force-complete |
| `06-tainted-webfetch.jsonl` | `anthropic_messages` / claude-sonnet-5 | **synthesised** (W4-1): one WebFetch call whose page content ends with an instruction-shaped sentence. The recorded `tool_result` is FENCE-WRAPPED (`<untrusted_external_content>…</untrusted_external_content>`) and carries `taint:'external'`. Its test passes an `untrustedContent`-declaring WebFetch shell through `opts.tools`; the replay answerer strips the frame so the dispatcher RE-MINTS it. A build without the taint rail journals the raw text with no `taint` field and fails equality |
| `07-tainted-fetch-then-send.jsonl` | `anthropic_messages` / claude-sonnet-5 | **synthesised** (W4-2): a tainted WebFetch followed by a Composio send in the SAME turn — the shadow-screen trigger shape (turn carries taint AND the next tool is side-effecting). The page content *describes* a forward-shaped sentence, it never carries one. Its test replays once with NO seam (equality — shadow changes no bytes) and once with a recording seam built from the real pure pieces (`collectTurnTaintSpans` + `classifySideEffect`): exactly ONE screen request fires, for the send, carrying the fetch span — and the journal STILL replays to equality with the seam active. Fixture 02 under the same seam fires ZERO requests (a turn with no taint pays nothing) |
| `08-openai-responses-reasoning-tool-rounds.jsonl` | `openai_responses` / gpt-5.6-luna | the FIRST Responses recording on the rail. One user turn, three rounds: two tool-only (Read, then Bash) whose text-empty assistant entry carries no reasoning — the round's encrypted reasoning rides the `tool_use` (§4.3a) and is echoed before the `function_call` — then a text-bearing round whose reasoning rides the assistant entry as HEAD reasoning (PR4 P2). It exists because `historyFromJournal` used to answer `journalToAnthropicMessages` for EVERY recording: a gpt fixture added before that switch would have been projected through the Anthropic dialect and passed no matter what the Responses projection did |
| `09-openai-responses-hitl-ask-pause.jsonl` | `openai_responses` / gpt-5.6-luna | the first recording carrying the HITL **pause plane**. A real staging turn: two `AskUserQuestion` rounds (the first rejected for invalid args), a PAUSE on the second, the human's answer, a resumed round, then a second user turn. `interaction` entries used to be dropped by the harvester as product-plane, so every earlier fixture replayed a paused turn as a turn that never paused — and `suspendPending` (which drops a tool_use bound to an unresolved interaction) is the ONE thing that changes what the wire is allowed to contain. The rail re-enacts both halves from the recording: the pause through a policy that answers `needs_human` for exactly the calls an interaction is bound to, the resume through `reconcileInteractions` with the recorded outcome, driven as a NEW run off the SAME journal the way a warm `_driveContinuation` is |

The journal is provider-neutral (`ContentBlock[]` + `tool_use`/`tool_result` entries), so
01's Flash recording replays through the same loop as 02's Anthropic one; the replay
transport stamps each fixture's own `api`/`provider` onto the entries it writes.

The journal is neutral, but the WIRE is not. `ReplayTransport` picks its dialect from the
recording's own `api`: an `openai_responses` recording projects through
`journalToOpenAIResponsesInput` and pushes the Responses input shapes; everything else
keeps the Anthropic dialect. This matters because the reconstruction check compares the
wire against `historyFromJournal` — project a recording through the wrong dialect and the
check compares the wrong two things and passes regardless. A new fixture on a lane with no
arm yet (`gemini`, and `openai_chat_completions`, which 01 still replays through the
Anthropic dialect) needs its arm added at the same time, or its green means nothing.
