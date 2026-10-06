# Evidence: the fast bench

This folder holds measured evidence about Go. `bench-2026-10-06.json` is the report of Go's fast bench from one CI run, unedited. This page explains every number in it: what it measures, how, the bar it is held to, and the value in this run.

## Where the report comes from

- **Run:** CI run [TBD](https://github.com/vestra-ai/go-brain/actions/runs/TBD), job `build-and-test`, artifact `bench-report`, written at 2026-10-06 TBD UTC.
- **Code:** `build` at commit `9c8556a`, with pull request #TBD merged on top (GitHub's test commit `TBD`, which the report names). Pull request #TBD changes only documents, so the code measured is `build`'s. CI runs on pull requests and on `main`, not on pushes to `build`, so this is how a run of `build`'s code is made.
- **Verdict:** all TBD checks passed (`verdict.ok` is `true`).

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
| Typing p90 | How soon Go shows "typing" after a line that asks it something. | under 500 ms | TBD |
| Go's own time to reply, p90 | How long Go takes from a person's last line of an ask to Go's message in the room. | under 1,500 ms | TBD |
| Cache hit | The share of each prompt read from the provider's cache. | 85% or more, on `goa-2000` only | TBD |
| Cache breaks | Cache misses with no good reason. | 0 | TBD |
| Woke the model | How often a message from a person led to a model call. | under 25% | TBD |
| Wrong speak | Asks Go missed, plus posts nobody asked for, plus repeated posts. | 0 on `goa-50`; for review on the others | TBD |
| Duplicate posts | The same post twice. | 0 (`goa-300`, `goa-2000`) | TBD |
| Wrong quiet reactions | Reactions Go put on lines that should get none. | 0 (`goa-50`) | TBD |
| Deleted text in a later prompt | A deleted message's words reaching the model afterwards. | 0 | TBD |
| Recall | Questions about earlier messages that Go's memory answers with the right message. | no misses | TBD |
| Folds | Go summarising a long chat so its prompt stays small. | at least 1 on `goa-2000` | TBD |

### Typing p90

For every line that asks Go something, the bench times the gap between handing the line to the simulated Server and Go's "typing" notice arriving there, within a 10 second window. p90 means 9 of 10 lines were at or under this time. This run timed TBD such lines, and none was missing a typing notice.

### Go's own time to reply, p90

Lines from one person at most 5 seconds apart (by the chat's clock) count as one ask, because people often ask in two or three lines. The clock runs from the last line of the ask to Go's post. Every ask was answered: TBD. Because the model answers at once, this is Go's own overhead; the bar of 1.5 seconds keeps that overhead small next to the model's time.

### Cache hit

Go sends the model a long prompt every turn: the tools (on average TBD tokens here), Go's rules (TBD tokens), the chat so far, and what is new. Most of it is the same as last time, and a provider charges far less for the part it can read from its cache. The cache hit is the share of all prompt tokens that would be read from the cache, over every composer request except the first (the first always starts cold). With the first request included: TBD.

The estimate follows the provider's rules: the prompt is read in the order tools, system, messages; a read lands only where an earlier request marked a cache point; each cache point looks back at most 20 blocks; nothing under the model's minimum size is cached. Tokens are counted as bytes divided by 4. It also assumes the tools and rules stay cached between this trip's turns because other trips use them in production.

The 85% bar applies to `goa-2000` only, the chat long enough to have prompts the size the bar is for. `goa-50` and `goa-300` are reported without a bar, which is why `goa-300` passes at TBD.

Why the other requests missed the cache, from the report (`scores[].cache.results`):

| | Read the cache | First request | Quiet too long | A cached message deleted | A cached message edited | A fold |
|---|---|---|---|---|---|---|
| `goa-50` | TBD | TBD | TBD | TBD | TBD | TBD |
| `goa-300` | TBD | TBD | TBD | TBD | TBD | TBD |
| `goa-2000` | TBD | TBD | TBD | TBD | TBD | TBD |

"Quiet too long" means the chat went quiet for longer than the cached part lives, by the simulated clock (overnight, say). A deleted or edited message that was already in the cached part has to leave the prompt, so the cache rebuilds from there. A fold replaces the oldest chat with a short story, so the cache rebuilds from the story on; the request after it reads the cache again.

### Cache breaks

A miss that none of the reasons above explains: the cached part changed although nothing in the chat did (`drift`), or Go's rules or tools changed between requests (`rules changed`). Either would be a bug that costs money on every turn. This run has none.

### Woke the model

The number of model turns Go started, over the number of messages from people: TBD. Most of a group chat is not for Go, and the quick read lets Go skip the model for chatter. Lower is cheaper; the bar is under one in four.

### Wrong speak, duplicate posts and wrong quiet reactions

The bench sorts each of Go's posts: an answer to an ask, a follow-up, the greeting, a duplicate, or unprompted. This run: TBD posts, each one an answer to an ask plus Go's greeting; no duplicates and nothing unprompted.

`goa-50` is labelled by hand, so its labels are trusted: a missed ask, an unprompted post or a duplicate fails it, and so does a reaction on a line not labelled as fine for one (Go reacted TBD times there, all on lines where a reaction was fine). `goa-300` and `goa-2000` were labelled by a generator, so their wrong-speak count is listed for a person to review rather than enforced; duplicates are still enforced there.

### Deleted text in a later prompt

For each deleted message of 12 characters or more, the bench searches every model request made more than 1 second after the delete for the message's first 30 characters. A hit would mean Go kept showing the model something a person deleted. None was found.

### Recall

The chats include questions about earlier messages ("What is Meher allergic to?", "When can Arjun leave on Friday?") together with the message that answers each one. The bench asks Go's memory each question and counts a pass when the answering message, by its number and the answer's words, is among what memory returns. All passed: TBD questions.

In `goa-2000` the questions come near the end, about messages from the first two days ("Where did we agree the villa should be?", "How much a head did Rahul want to spend on the villa?"). By then the chat has folded: those messages have left Go's prompt and only the story stands for them, yet memory finds each one word for word in the trip's messages. TBD of the questions were asked after a fold.

### Folds

When the chat part of Go's prompt passes its budget, Go folds: a smaller model summarises the oldest part (about half) into "the story so far", which takes that part's place in the prompt. The fold runs in the background, right after Go posts once the chat passes its budget, or after a quiet minute (at most 10 minutes in a busy chat). In production the budget is about 60,000 tokens; `goa-2000` runs with it set low (`FOLD_AT_TOKENS=12000`) so that it must fold, and the check is required (`bars.json` has `requireMemory: true`).

This run folded `goa-2000` TBD times (`scores[].cache.folds` and `scores[].turns`):

| Request | Prompt before | Prompt after | Chat before | Chat after |
|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD |

"Before" is the request just before the fold and "after" the first request that carries the story; both are in tokens. The chat is the cached part of the trip's messages, up to the cache point, the story included. The request after each fold read the cache again (TBD).

## Other numbers in the report

These are measured but not held to a bar.

- **Prompt size:** the largest prompt was TBD tokens. On average a first-round prompt held the tools (TBD tokens), the rules (TBD), the cached chat (TBD) and the part after the cache point (TBD).
- **Side passes:** Go's smaller model takes notes and writes the story in the background: TBD requests, TBD tokens.
- **First word:** the scripted model's first word arrived in TBD (p50), so it adds nothing to the reply times.
- **Cost:** TBD per chat. It is every request Go sent (model turns and side passes), priced with the agent SDK's price table for each request's model, from the estimated token counts. It is an estimate of what the chat would cost, not a bill.
- **Run time:** TBD seconds of real time to replay each chat.

## The proof board (`boards`)

After each replay, the bench reads Go's own proof board: the numbers Go works out from its own database (its record of every turn), the same numbers the board page shows. They check that Go measures itself the way the bench measures it.

| | `goa-50` | `goa-300` | `goa-2000` |
|---|---|---|---|
| Woke the model | TBD | TBD | TBD |
| Cache hit | TBD | TBD | TBD |
| Typing p90 (turns timed) | TBD | TBD | TBD |
| Reply p50 / p90 | TBD | TBD | TBD |
| Model cost for the trip | TBD | TBD | TBD |
| Payments without both keys | TBD | TBD | TBD |

How they relate to the bench's numbers:

- **Woke the model** is the same count.
- **Cache hit** matches the bench's figure with the first request included, because the usage Go recorded for each turn came from the same estimate.
- **Typing** counts every turn that included a message marked as naming Go, which in `goa-2000` is TBD turns against the bench's TBD asks.
- **Reply** starts its clock at the first message in a turn that named Go; the bench starts at the last line of the ask. When an ask comes in more than one line, the board's figure includes the time until the ask was finished: Go holds a message its quick read is not sure is complete for 2 seconds (longer while more lines keep coming, up to 6) before it answers. That is where the board's p90 of TBD comes from; the bench's figure leaves that time out.
- **Model cost** counts model turns only; the bench's cost adds the side passes.
- **Payments without both keys** counts bookings Go recorded without the Server's signed approval, over all time. No chat here pays for anything, so 0 shows only that none slipped in.

## Running it yourself

With a Postgres database to use, from the repo root:

```bash
pnpm install && pnpm build
DATABASE_URL=postgres://... pnpm --filter @go/bench bench:fast
```

It writes `packages/bench/out/bench-report.json` and `bench-report.md`. Times will differ a little from run to run and machine to machine; the counts and the cache estimate should not.
