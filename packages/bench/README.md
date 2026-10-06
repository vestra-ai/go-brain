# packages/bench: the replay bench

The bench replays recorded trip chats through the real Go and checks the numbers against fixed bars, so how fast and how quiet Go is, and whether it remembers, is measured, not claimed. It starts Go in-process with the shared test harness (`apps/brain/src/testing/start-room.ts`: its own database schema, every lane, the simulator playing the Server), plays each line of a chat into the room, and records every request Go sends to the model and every frame it sends to the Server.

## Main parts

| Part | What it does |
|---|---|
| `chats/` | The recorded chats: the Goa trip in 50, 300 and 2,000 messages, one JSON line per message or change, with labels a person wrote (should Go post here, is a quiet reaction fine, what should recall find later). `src/chat.ts` loads and checks them. |
| `src/generate.ts`, `src/skeletons/`, `scripts/gen-chats.ts` | Long chats from a short hand-written skeleton: the lines that matter are written by hand, and seeded filler fills the quiet stretches. Same skeleton and seed, same bytes. |
| `src/replay.ts`, `src/sim-port.ts` | Plays a chat through Go with the simulator, cutting long idle gaps but keeping the chat's own time for the cache's expiry. |
| `src/policy-model.ts`, `src/bench-reflex.ts` | The fast bench's stand-ins: a scripted model that answers only when a new line calls Go and otherwise stays silent, and a reflex that answers from recorded Jev reads or the chat's hand labels. |
| `src/score.ts`, `src/cache-estimate.ts`, `src/requests.ts` | The scores: did Go speak when it should and stay quiet when it should, time to typing and to the reply, the share of messages that woke the model, the cache hit the provider would give (from the exact request bodies), whether recall found the right message, and whether a deleted message came back in a later prompt. |
| `bars.json`, `src/compare.ts` | The bars and the verdict: every check with its value, its bar, and why it passed. |
| `src/run-fast.ts`, `src/run-live.ts` | The fast bench (no keys, on every pull request) and the live bench (real models and real Jev, by hand or nightly), which also compares composer models and can post its numbers to the proof board. |

## The bars (fast bench)

From [`bars.json`](bars.json): typing at most 500 ms at p90, Go's own time to reply at most 1.5 s at p90 (the scripted model answers at once, so this measures Go), a cache hit of at least 85% on the 2,000-message chat, at most 25% of messages waking the model, no wrong speak or stay-quiet on the labelled 50-message chat, no recall miss, no deleted text in a later prompt, and no broken cache.

## How the tests prove it

- `fast-bench.test.ts` replays all three chats through Go in CI and fails if any bar is missed. Its report (`out/bench-report.md`) is added to the CI job's summary and kept with the run.
- `chat.test.ts`, `goa-50.test.ts` and `generate.test.ts`: the chats are well formed, labelled, and generated the same way every time.
- `score.test.ts`, `cache-estimate.test.ts` and `compare.test.ts`: the scoring, the cache rules (a delete, a fold or a gap past the cache's lifetime shows as a miss with its reason) and the verdict.
- `replay.test.ts`, `stand-ins.test.ts` and `live.test.ts`: the replay clock, the stand-ins, and the live bench's settings and its post to the board.

`DATABASE_URL=... pnpm --filter @go/bench test` runs them; `pnpm --filter @go/bench bench:fast` runs the fast bench on its own.
