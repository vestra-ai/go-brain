# Evidence: the fast bench

This folder holds measured evidence about Go. `bench-2026-10-06.json` is the report of Go's fast bench from one CI run, unedited. This page explains every number in it: what it measures, how, the bar it is held to, and the value in this run.

The folder also holds Jev's recorded answers for the quick read, and which questions act live because of them: see [jev.md](jev.md).

## Where the report comes from

- **Run:** CI run [37437605711](https://github.com/vestra-ai/go-brain/actions/runs/37437605711), job `build-and-test`, artifact `bench-report`, written at 2026-10-06 08:46 UTC. The same run's test counts, and its demo transcript ([`docs/demo/transcript.md`](../transcript.md)), are the ones the other pages cite.
- **Code:** `build` at commit `5225799`, with pull request #50 merged on top (GitHub's test commit `de25e65`, which the report names). Pull request #50 changes documents and the demo test's transcript, which the bench does not run, so the code measured is `build`'s. CI runs on pull requests and on `main`, not on pushes to `build`, so this is how a run of `build`'s code is made.
- **Verdict:** all 28 checks passed (`verdict.ok` is `true`).

## What the fast bench is

The fast bench replays three made-up chats of the Goa trip through Go: `goa-50`, `goa-300` and `goa-2000`, named for how many messages people send in them. Five people chat about a trip; some lines ask Go for something, most do not. Go runs as it does in production: the same code, its own Postgres database, every lane registered, and a simulated Server (the FakeServer) delivering each line as the Server would.

Three things are stand-ins, and every number below should be read with them in mind:

- **The model is scripted.** It answers at once when a line asks Go, and otherwise tells Go to stay quiet. So the reply times here are Go's own time (reading the message, building the prompt, posting), not the model's thinking. A real model adds its own time; the live bench and the rehearsals measure that. The same scripted model writes the fold's story, one line long.
- **The quick read is labels, not Jev.** Each line in a chat file carries labels saying whether it is for Go and whether it is complete. The bench answers Go's quick read from those labels (`reflexSource: "labels"`).
- **The cache figures are estimates.** No provider was called, so nothing reported real cache use. The bench works out what the provider would have cached from the requests Go built, using the provider's rules. The costs are priced from those estimated token counts.

Each chat runs on a simulated clock, so a week of chat replays in seconds or minutes. Times like "typing" and "reply" are measured on the real clock.

## The checks

The bars come from `packages/bench/bars.json`. Values are in the order `goa-50` / `goa-300` / `goa-2000`.

| Check | What it measures | Bar | This run |
|---|---|---|---|
| Typing p90 | How soon Go shows "typing" after a line that asks it something. | under 500 ms | 6 / 4 / 3 ms |
| Go's own time to reply, p90 | How long Go takes from a person's last line of an ask to Go's message in the room. | under 1,500 ms | 30 / 30 / 29 ms |
| Cache hit | The share of each prompt read from the provider's cache. | 85% or more, on `goa-2000` only | 87.1% / 81.6% / 87.0% |
| Cache breaks | Cache misses with no good reason. | 0 | 0 / 0 / 0 |
| Woke the model | How often a message from a person led to a model call. | under 25% | 20.0% / 17.0% / 9.9% |
| Wrong speak | Asks Go missed, plus posts nobody asked for, plus repeated posts. | 0 on `goa-50`; for review on the others | 0 / 0 / 0 |
| Duplicate posts | The same post twice. | 0 (`goa-300`, `goa-2000`) | 0 / 0 |
| Wrong quiet reactions | Reactions Go put on lines that should get none. | 0 (`goa-50`) | 0 |
| Deleted text in a later prompt | A deleted message's words reaching the model afterwards. | 0 | 0 / 0 / 0 |
| Recall | Questions about earlier messages that Go's memory answers with the right message. | no misses | 5 of 5 / 7 of 7 / 10 of 10 |
| Folds | Go summarising a long chat so its prompt stays small. | at least 1 on `goa-2000` | 2 |

### Typing p90

For every line that asks Go something, the bench times the gap between handing the line to the simulated Server and Go's "typing" notice arriving there, within a 10 second window. p90 means 9 of 10 lines were at or under this time. This run timed 6, 12 and 13 such lines, and none was missing a typing notice.

### Go's own time to reply, p90

Lines from one person at most 5 seconds apart (by the chat's clock) count as one ask, because people often ask in two or three lines. The clock runs from the last line of the ask to Go's post. Every ask was answered: 6 of 6, 12 of 12, 13 of 13. Because the model answers at once, this is Go's own overhead; the bar of 1.5 seconds keeps that overhead small next to the model's time.

### Cache hit

Go sends the model a long prompt every turn: the tools (on average 3,620 tokens here), Go's rules (964 tokens), the chat so far, and what is new. Most of it is the same as last time, and a provider charges far less for the part it can read from its cache. The cache hit is the share of all prompt tokens that would be read from the cache, over every composer request except the first (the first always starts cold). With the first request included: 79.3% / 80.5% / 86.9%.

The estimate follows the provider's rules: the prompt is read in the order tools, system, messages; a read lands only where an earlier request marked a cache point; each cache point looks back at most 20 blocks; nothing under the model's minimum size is cached. Tokens are counted as bytes divided by 4. It also assumes the tools and rules stay cached between this trip's turns because other trips use them in production.

The 85% bar applies to `goa-2000` only, the chat long enough to have prompts the size the bar is for. `goa-50` and `goa-300` are reported without a bar, which is why `goa-300` passes at 81.6%.

Why the other requests missed the cache, from the report (`scores[].cache.results`):

| | Read the cache | First request | Quiet too long | A cached message deleted | A cached message edited | A fold |
|---|---|---|---|---|---|---|
| `goa-50` | 9 | 1 | 0 | 0 | 0 | 0 |
| `goa-300` | 31 | 1 | 17 | 1 | 1 | 0 |
| `goa-2000` | 169 | 1 | 24 | 1 | 1 | 2 |

"Quiet too long" means the chat went quiet for longer than the cached part lives, by the simulated clock (overnight, say). A deleted or edited message that was already in the cached part has to leave the prompt, so the cache rebuilds from there. A fold replaces the oldest chat with a short story, so the cache rebuilds from the story on; the request after it reads the cache again.

### Cache breaks

A miss that none of the reasons above explains: the cached part changed although nothing in the chat did (`drift`), or Go's rules or tools changed between requests (`rules changed`). Either would be a bug that costs money on every turn. This run has none.

### Woke the model

The number of model turns Go started, over the number of messages from people: 10 of 50, 51 of 300 and 198 of 2,000. Most of a group chat is not for Go, and the quick read lets Go skip the model for chatter. Lower is cheaper; the bar is under one in four.

### Wrong speak, duplicate posts and wrong quiet reactions

The bench sorts each of Go's posts: an answer to an ask, a follow-up, the greeting, a duplicate, or unprompted. This run: 7, 13 and 14 posts, each one an answer to an ask plus Go's greeting; no duplicates and nothing unprompted.

`goa-50` is labelled by hand, so its labels are trusted: a missed ask, an unprompted post or a duplicate fails it, and so does a reaction on a line not labelled as fine for one (Go reacted 7 times there, all on lines where a reaction was fine). `goa-300` and `goa-2000` were labelled by a generator, so their wrong-speak count is listed for a person to review rather than enforced; duplicates are still enforced there.

### Deleted text in a later prompt

For each deleted message of 12 characters or more, the bench searches every model request made more than 1 second after the delete for the message's first 30 characters. A hit would mean Go kept showing the model something a person deleted. None was found.

### Recall

The chats include questions about earlier messages ("What is Meher allergic to?", "When can Arjun leave on Friday?") together with the message that answers each one. The bench asks Go's memory each question and counts a pass when the answering message, by its number and the answer's words, is among what memory returns. All passed: 5, 7 and 10 questions.

In `goa-2000` the questions come near the end, about messages from the first two days ("Where did we agree the villa should be?", "How much a head did Rahul want to spend on the villa?"). By then the chat has folded: those messages have left Go's prompt and only the story stands for them, yet memory finds each one word for word in the trip's messages. All 10 of its questions were asked after a fold.

### Folds

When the chat part of Go's prompt passes its budget, Go folds: a smaller model summarises the oldest part (about half) into "the story so far", which takes that part's place in the prompt. The fold runs in the background, right after Go posts once the chat passes its budget, or after a quiet minute (at most 10 minutes in a busy chat). In production the budget is about 60,000 tokens; `goa-2000` runs with it set low (`FOLD_AT_TOKENS=12000`) so that it must fold, and the check is required (`bars.json` has `requireMemory: true`).

This run folded `goa-2000` twice (`scores[].cache.folds` and `scores[].turns`):

| Request | Prompt before | Prompt after | Chat before | Chat after |
|---|---|---|---|---|
| 135 | 19,083 | 12,315 | 13,750 | 7,271 |
| 207 | 20,191 | 12,815 | 14,999 | 7,825 |

"Before" is the request just before the fold and "after" the first request that carries the story; both are in tokens. The chat is the cached part of the trip's messages, up to the cache point, the story included. The request after each fold read the cache again: requests 136 and 208 read 11,855 of 12,377 and 12,409 of 12,857 tokens from it.

## Other numbers in the report

These are measured but not held to a bar.

- **Prompt size:** the largest prompt was 5,776 / 8,463 / 20,191 tokens, and the last 5,776 / 8,463 / 12,857. On average a first-round prompt held the tools (3,620 tokens), the rules (964), the cached chat (208 / 1,599 / 8,736) and the part after the cache point (621 / 591 / 623).
- **Side passes:** Go's smaller model takes notes and writes the story in the background: 8 / 7 / 11 requests, 6,096 / 4,738 / 27,356 tokens.
- **First word:** the scripted model's first word arrived in 1 ms (p50), so it adds nothing to the reply times.
- **Cost:** $0.0403 / $0.2167 / $1.3615 per chat. It is every request Go sent (model turns and side passes), priced with Go's price table ([`apps/brain/src/composer/anthropic-helpers.ts`](../../../apps/brain/src/composer/anthropic-helpers.ts#L44)) for each request's model, from the estimated token counts. It is an estimate of what the chat would cost, not a bill.
- **Run time:** 13.1 / 54.4 / 96.7 seconds of real time to replay each chat.

## The proof board (`boards`)

After each replay, the bench reads Go's own proof board: the numbers Go works out from its own database (its record of every turn), the same numbers the board page shows. They check that Go measures itself the way the bench measures it.

| | `goa-50` | `goa-300` | `goa-2000` |
|---|---|---|---|
| Woke the model | 10 of 50 | 51 of 300 | 198 of 2,000 |
| Cache hit | 79.3% | 80.5% | 86.9% |
| Typing p90 (turns timed) | 4 ms (6) | 2 ms (12) | 2 ms (45) |
| Reply p50 / p90 | 27 / 2,538 ms | 25 / 31 ms | 26 / 2,023 ms |
| Model cost for the trip | $0.0341 | $0.2118 | $1.3337 |
| Payments without both keys | 0 | 0 | 0 |

How they relate to the bench's numbers:

- **Woke the model** is the same count.
- **Cache hit** matches the bench's figure with the first request included, because the usage Go recorded for each turn came from the same estimate.
- **Typing** counts every turn that included a message marked as naming Go, which in `goa-2000` is 45 turns against the bench's 13 asks.
- **Reply** starts its clock at the first message in a turn that named Go; the bench starts at the last line of the ask. When an ask comes in more than one line, the board's figure includes the time until the ask was finished: Go holds a message its quick read is not sure is complete for 2 seconds (longer while more lines keep coming, up to 6) before it answers. That is where the board's p90 of 2,538 and 2,023 ms comes from; the bench's figure leaves that time out.
- **Model cost** counts model turns only; the bench's cost adds the side passes.
- **Payments without both keys** counts bookings Go recorded without the Server's signed approval, over all time. No chat here pays for anything, so 0 shows only that none slipped in.

## Running it yourself

With a Postgres database to use, from the repo root:

```bash
pnpm install && pnpm build
DATABASE_URL=postgres://... pnpm --filter @go/bench bench:fast
```

It writes `packages/bench/out/bench-report.json` and `bench-report.md`. Times will differ a little from run to run and machine to machine, and so will the cache estimate and the cost, in their last digits: each prompt says the time of day, and a time written with one more character counts as more tokens. The counts should not differ.
