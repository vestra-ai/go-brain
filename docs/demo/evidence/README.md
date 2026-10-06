# Evidence: the fast bench

This folder holds measured evidence about Go. `bench-2026-10-06.json` is the report of Go's fast bench from one CI run, unedited. This page explains every number in it: what it measures, how, the bar it is held to, and the value in this run.

The folder also holds Jev's recorded answers for the quick read, and which questions act live because of them: see [jev.md](jev.md).

It also holds three runs of the live bench, with the real model and real Jev: the first on `goa-50` and `goa-300`, then `goa-50` after the fixes it led to, and a final `goa-50` run with every fix. See [Live run](#live-run).

## Where the report comes from

- **Run:** CI run [37457731194](https://github.com/vestra-ai/go-brain/actions/runs/37457731194), job `build-and-test`, artifact `bench-report`, written at 2026-10-06 11:45 UTC. The same run's test counts, and its demo transcript ([`docs/demo/transcript.md`](../transcript.md)), are the ones the other pages cite.
- **Code:** `build` at commit `ad71bca`, with pull request #81 merged on top (GitHub's test commit `e22f9d2`, which the report names). At that point pull request #81 changed only documents, so the code measured is `build`'s. CI runs on pull requests and on `main`, not on pushes to `build`, so this is how a run of `build`'s code is made.
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
| Typing p90 | How soon Go shows "typing" after a line that asks it something. | under 500 ms | 6 / 4 / 4 ms |
| Go's own time to reply, p90 | How long Go takes from a person's last line of an ask to Go's message in the room. | under 1,500 ms | 39 / 36 / 29 ms |
| Cache hit | The share of each prompt read from the provider's cache. | 85% or more, on `goa-2000` only | 88.9% / 83.8% / 87.8% |
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

Go sends the model a long prompt every turn: the tools (on average 4,185 tokens here), Go's rules (1,303 tokens), the chat so far, and what is new. Most of it is the same as last time, and a provider charges far less for the part it can read from its cache. The cache hit is the share of all prompt tokens that would be read from the cache, over every composer request except the first (the first always starts cold). With the first request included: 80.8% / 82.5% / 87.6%.

The estimate follows the provider's rules: the prompt is read in the order tools, system, messages; a read lands only where an earlier request marked a cache point; each cache point looks back at most 20 blocks; nothing under the model's minimum size is cached. Tokens are counted as bytes divided by 4. It also assumes the tools and rules stay cached between this trip's turns because other trips use them in production.

The 85% bar applies to `goa-2000` only, the chat long enough to have prompts the size the bar is for. `goa-50` and `goa-300` are reported without a bar, which is why `goa-300` passes at 83.8%.

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
| 135 | 19,989 | 13,220 | 13,750 | 7,271 |
| 207 | 21,097 | 13,721 | 14,999 | 7,825 |

"Before" is the request just before the fold and "after" the first request that carries the story; both are in tokens. The chat is the cached part of the trip's messages, up to the cache point, the story included. The request after each fold read the cache again: requests 136 and 208 read 12,759 of 13,282 and 13,313 of 13,762 tokens from it.

## Other numbers in the report

These are measured but not held to a bar.

- **Prompt size:** the largest prompt was 6,681 / 9,368 / 21,097 tokens, and the last 6,681 / 9,368 / 13,762. On average a first-round prompt held the tools (4,185 tokens), the rules (1,303), the cached chat (208 / 1,599 / 8,736) and the part after the cache point (625 / 593 / 625).
- **Side passes:** Go's smaller model takes notes and writes the story in the background: 8 / 7 / 11 requests, 6,096 / 4,738 / 27,356 tokens.
- **First word:** the scripted model's first word arrived in 1 ms (p50), so it adds nothing to the reply times.
- **Cost:** $0.0443 / $0.2282 / $1.4000 per chat. It is every request Go sent (model turns and side passes), priced with Go's price table ([`apps/brain/src/composer/anthropic-helpers.ts`](../../../apps/brain/src/composer/anthropic-helpers.ts#L44)) for each request's model, from the estimated token counts. It is an estimate of what the chat would cost, not a bill.
- **Run time:** 12.7 / 54.0 / 98.6 seconds of real time to replay each chat.

## The proof board (`boards`)

After each replay, the bench reads Go's own proof board: the numbers Go works out from its own database (its record of every turn), the same numbers the board page shows. They check that Go measures itself the way the bench measures it.

| | `goa-50` | `goa-300` | `goa-2000` |
|---|---|---|---|
| Woke the model | 10 of 50 | 51 of 300 | 198 of 2,000 |
| Cache hit | 80.8% | 82.5% | 87.6% |
| Typing p90 (turns timed) | 4 ms (6) | 3 ms (12) | 3 ms (45) |
| Reply p50 / p90 | 32 / 2,539 ms | 26 / 49 ms | 27 / 2,026 ms |
| Model cost for the trip | $0.0381 | $0.2233 | $1.3722 |
| Payments without both keys | 0 | 0 | 0 |

How they relate to the bench's numbers:

- **Woke the model** is the same count.
- **Cache hit** matches the bench's figure with the first request included, because the usage Go recorded for each turn came from the same estimate.
- **Typing** counts every turn that included a message marked as naming Go, which in `goa-2000` is 45 turns against the bench's 13 asks.
- **Reply** starts its clock at the first message in a turn that named Go; the bench starts at the last line of the ask. When an ask comes in more than one line, the board's figure includes the time until the ask was finished: Go holds a message its quick read is not sure is complete for 2 seconds (longer while more lines keep coming, up to 6) before it answers. That is where the board's p90 of 2,539 and 2,026 ms comes from; the bench's figure leaves that time out.
- **Model cost** counts model turns only; the bench's cost adds the side passes.
- **Payments without both keys** counts bookings Go recorded without the Server's signed approval, over all time. No chat here pays for anything, so 0 shows only that none slipped in.

## Live run

`bench-live-2026-10-06.json` is one run of the live bench, unedited, and `bench-live-2026-10-06.md` is the summary the same run wrote. It replays `goa-50` and `goa-300` through Go as the fast bench does, but with the real model writing Go's turns and real Jev reading every message. It is the first run on record of Go with a real model; a second run on `goa-50`, after the fixes it led to, is [below](#after-the-fixes-goa-50-again), and the definitive run on the final build is [last](#definitive-live-run-the-final-build-18-asks).

- **Run:** bench-live run [37442728267](https://github.com/vestra-ai/go-brain/actions/runs/37442728267), job `live`, artifact `live-bench`, written at 2026-10-06 10:12 UTC. It ran for 48 minutes.
- **Code:** `build` at commit `50fe0ab`, with pull request #61 merged on top (GitHub's test commit `5616f7f`, which the report names). At that point the pull request changed only how the live bench is started and which of Jev's questions it lets act, so the Go measured is `build`'s.
- **Models:** each chat ran twice, once with `claude-sonnet-5-5` writing Go's turns (the model the bars are judged on) and once with `claude-haiku-4-5`. The notes pass and the fold ran on `claude-haiku-4-5` both times. Real calls, on Vestra's staging key.
- **Jev:** real calls to `jev-1.13.0`. The questions acting live are Go's own default, the ones whose test sets passed: `q1,q4,q5,q6,q7,q8` (see [jev.md](jev.md)).
- **Verdict:** 7 of 28 checks pass; no model passes every bar (`verdict.ok` is `false`). The run suggests `claude-sonnet-5-5`, the faster of the two.

What is still simulated in it:

- **The Server:** the simulator plays it, as in the fast bench, and people's lines come from the chat files.
- **Travel:** the test inventory, not ixigo (`TRAVEL_MODE` is not set, so it is `fake`). Prices and options are test data.
- **Jobs on Go's computer:** none. The `/v1` settings are not set, so the jobs lane stays off.
- **Payments and calls:** the fake rail; calls off.
- **Time:** the chat's clock skips quiet hours, but every model and Jev call takes its real time.

### The numbers

Next to the fast bench's scripted run above, for `goa-50` / `goa-300`. The live numbers are `claude-sonnet-5-5`'s unless a row says otherwise.

| | Scripted (fast bench) | Live, `claude-sonnet-5-5` | Live bar |
|---|---|---|---|
| Typing p90 | 6 / 4 ms | 5 / 5 ms | under 500 ms |
| Reply p50 | 30 / 25 ms | 4.39 / 4.84 s | under 2.5 s |
| Reply p90 | 39 / 36 ms | 13.47 / 9.87 s | under 5 s |
| Model's first word, p50 | 1 / 1 ms | 1.27 / 1.17 s | none |
| Cache hit | 88.9% / 83.8% (estimated) | 83.8% / 88.2% (the provider's own) | 85% or more |
| Woke the model | 20.0% / 17.0% | 86.0% / 90.3% | under 25% |
| Asks answered | 6 of 6 / 12 of 12 | 6 of 6 / 12 of 12 | every one |
| Posts nobody asked for | 0 of 7 / 0 of 13 | 5 of 21 / 37 of 98 | none on `goa-50` (no wrong speak); under 1 in 50 on `goa-300` |
| Recall | 5 of 5 / 7 of 7 | 4 of 5 / 3 of 7 | no misses |
| Cost of the chat | $0.0443 / $0.2282 (priced from estimated tokens) | $0.5314 / $2.9514 (priced from the provider's usage) | none |

With `claude-haiku-4-5`: typing p90 5 / 4 ms, reply p50 5.39 / 16.57 s and p90 12.60 / 54.09 s, 5 of 6 / 11 of 12 asks answered, posts nobody asked for 8 of 23 / 19 of 46, recall 5 of 5 / 4 of 7, cost $0.2671 / $1.3002. The whole run cost $5.05.

How the live numbers are measured:

- **Reply** runs from a person's last line of an ask to Go's post, as in the fast bench, so here it includes the model's time: its first word (p50 about 1.2 seconds with `claude-sonnet-5-5`) and any tool rounds before the post. `goa-50` made 66 requests to the model for 43 turns; the other 23 are later rounds of a turn, after a tool's answer.
- **Cache hit** is the provider's own count from each response's usage (`cache_read_input_tokens` over all input tokens), over every request for Go's turns but the first. The bench's estimate from the same requests is next to it in the run's summary (83.0% / 87.7%).
- **Cost** is every request priced from the provider's usage, with Go's price table ([`apps/brain/src/composer/anthropic-helpers.ts`](../../../apps/brain/src/composer/anthropic-helpers.ts#L44)).
- **Woke the model** is model turns over messages from people, as in the fast bench: every turn counts, whatever woke it.

### Where the live run misses a bar

It misses most of them, and each miss is a finding about Go, not about the bench.

- **Reply time (all four):** the bars, 2.5 seconds at p50 and 5 at p90, are below what a real model takes here. `claude-sonnet-5-5`'s first word alone takes about 1.2 seconds, and some turns run a search before they post.
- **Woke the model (all four):** 86% and 90% with `claude-sonnet-5-5`, against 20% and 17% scripted. In the scripted run the chat's labels answer for Jev and read most chatter as sure; live, question 1 decides on Jev's real answers at its 0.85 bar, and question 2 (is the message finished) is in shadow. The run does not keep Jev's answers per message (they are in the run's own database, which is thrown away), so it cannot say how many chatter lines Jev read as sure.
- **Cache hit on `goa-50`:** 83.8%, just under 85%. The fast bench holds only `goa-2000` to this bar; the live bars hold every chat to it. `goa-300` passes at 88.2%.
- **Posts nobody asked for:** with a real model Go also answers some lines nobody asked it about: it replies "Noted, Priya, window seat" where a quiet ✅ was expected, welcomes people back, and wishes Meher a happy birthday. The bench counts each as unprompted for a person to review. This run predates pull request #64 (`db914a9`: one person's preference gets a ✅ and no post, and Go never tells the room about its tools), which passed 3 of 3 drills with the real model, so these counts are from before that fix.
- **Recall:** 4 of 5 and 3 of 7. With a real side model the notes pass saves facts, and recall puts facts first: a fact stands in for the message it came from, and every fact about the person a question names comes back. So facts like "Bring helmet" fill the five answers ahead of the message that answers "What is Meher allergic to?"; "Who can't take early flights?" finds Arjun's message, but as the fact "No flights before 9 am", without the words the bench looks for; and some facts carry a different message number than the line the bench asks about.
- **`claude-haiku-4-5` only:** it missed one ask in each chat, and its reply p90 on `goa-300` was 54 seconds.

One measurement to read with care: the bench tells Go's turns from the side passes by the model's name. With `claude-haiku-4-5` writing Go's turns, the side passes run on the same model, so they count as turns too. That is why `claude-haiku-4-5` "woke the model" more than once per message (118% and 101%) and shows no side passes; its wake rate, request count and cache hit are not comparable with `claude-sonnet-5-5`'s, and the table above leaves them out.

### After the fixes: `goa-50` again

`bench-live-2026-10-06-after.json` (and its summary, `bench-live-2026-10-06-after.md`) is a second live run, unedited, on `goa-50` only. It ran after the fixes the run above led to: recall puts the best answer first and gives each fact its proof (#71), a line Jev is sure no one spoke to Go in wakes no model (#72), and one person's preference gets a ✅ and no post (#64).

- **Run:** bench-live run [37452902475](https://github.com/vestra-ai/go-brain/actions/runs/37452902475), job `live`, artifact `live-bench`, written at 2026-10-06 10:59 UTC. Its two replays took 3.5 minutes and cost $0.39.
- **Code:** `build` at commit `aedc4ce` (with #64, #66, #68, #71 and #72), with pull request #74 merged on top (GitHub's test commit `b88dcb5`, which the report names). At that point the pull request added only what the run records about why Go woke and the label that picks the chat, so the Go measured is `build`'s.
- **Models and Jev:** as above, both models on `goa-50`, real Jev, the same questions acting live.
- **Verdict:** 5 of 14 checks pass (`verdict.ok` is `false`).

`claude-sonnet-5-5` on `goa-50`, the first run against this one:

| | Before the fixes | After | Live bar |
|---|---|---|---|
| Typing p90 | 5 ms | 5 ms | under 500 ms |
| Reply p50 | 4.39 s | 5.22 s | under 2.5 s |
| Reply p90 | 13.47 s | 10.44 s | under 5 s |
| Model's first word, p50 | 1.27 s | 1.15 s | none |
| Cache hit (the provider's own) | 83.8% | 85.9% | 85% or more |
| Woke the model | 86.0% (43 turns for 50 messages) | 32.0% (16 turns) | under 25% |
| Asks answered | 6 of 6 | 6 of 6 | every one |
| Posts nobody asked for | 5 of 21 | 1 of 12 | none (no wrong speak) |
| Recall | 4 of 5 | 5 of 5 | no misses |
| Cost of the chat | $0.5314 | $0.2476 | none |

Why Go woke, from the run's own tables (the "Why Go woke" line of its summary): Jev answered all 50 messages, in 153 ms at p50 and 192 ms at p90, and read 33 of them as sure not for Go. Of the 16 model turns, 15 were woken by messages and 1 by the trip's setup. The lines Jev read as not for Go are the ones the chat labels as quiet, plus "wait" and "one more thing", two unfinished lines the labels leave either way; no line labelled for Go was among them.

Where it still misses a bar, plainly:

- **Reply time:** 5.22 seconds at p50, against 2.5. At least 2 seconds of it is Go holding the ask: question 2 (is the message finished) is in shadow, so Go waits 2 seconds after a line in case more come, before the model starts. The model's first word then takes 1.15 seconds at p50, and the rest is the model writing its answer and any tool rounds (27 requests to the model for 16 turns).
- **Woke the model:** 32%, against 25%. Every turn counts: all 16 were for a message or the setup.
- **Posts nobody asked for:** 1, against none on this hand-labelled chat.

With `claude-haiku-4-5`: reply p50 8.67 s and p90 8.89 s, recall 5 of 5, cost $0.1473, and it answered 3 of the 6 asks. Jev read two of the three it missed as for Go and the third as unsure, so Go woke the model for them, but no answer reached the room. Its wake rate (66%) counts its side passes, as explained above.

### Measured offline since

Two more changes, measured on the chats and the 50 labelled lines before they were built. The final run below ran with both.

- **No wait for an ask that ends.** A message that names Go and ends with ?, !, one full stop or an emoji goes to the model at once; one that trails off ("@Go can you") still waits 2 seconds for the rest. Asks whose last line ends that way, by the bench's own grouping of asks: 3 of 6 on `goa-50`, 8 of 12 on `goa-300`, 8 of 13 on `goa-2000`. Asks that would be answered before their next line arrived, from the chats' timestamps: none; in every multi-line ask the line that names Go has no end mark. Of the 22 labelled lines that name Go, code calls 6 finished, and none of them is labelled unfinished. The case the chats do not have: "@Go flights to Goa?" then "from Delhi". A second line that lands before Go posts joins the same turn (one more round, tested); one that lands after it gets its own.
- **A line about money always wakes the model.** An amount that is plainly money (₹500, 3,200, 8k) or a word for paying or owing wakes Go even when Jev is sure no one spoke to it, so an expense is recorded and an unclear one gets its question. The wakes it adds: 2 of the 50 labelled lines, in both recordings; 1 on `goa-50` with the after run's own Jev answers ("agreed, pool villa it is. Under 8k a head"), 0 in its `claude-haiku-4-5` run; and at most 1 on `goa-300` and 2 on `goa-2000`, the lines there that look like money and do not name Go.

### Final run: `goa-50` with every fix

`bench-live-2026-10-06-final.json` (and its summary, `bench-live-2026-10-06-final.md`) is the third live run, unedited, on `goa-50` only, on the code that also has the two changes measured offline above: no wait for an ask that ends (#77), and a line about money always waking the model (#79).

- **Run:** bench-live run [37457403482](https://github.com/vestra-ai/go-brain/actions/runs/37457403482), job `live`, artifact `live-bench`, written at 2026-10-06 11:39 UTC. Its two replays took 3.6 minutes and cost $0.46.
- **Code:** `build` at commit `ad71bca`, with pull request #80 merged on top (GitHub's test commit `9f2379c`, which the report names). The pull request adds only documents, so the Go measured is `build`'s. Between the after run and this one, `build` also took #73, #75, #76 and #78, which change what Go says and keeps (the year in dates, a turn keeping an answer it already paid for, one ✅ for a recorded expense, a correction about yourself getting a ✅ and no post).
- **Verdict:** 5 of 14 checks pass (`verdict.ok` is `false`). The run suggests `claude-haiku-4-5`, whose reply p50 was the lower of the two this time.

`claude-sonnet-5-5` on `goa-50`, the three runs side by side:

| | First | After | Final | Live bar |
|---|---|---|---|---|
| Typing p90 | 5 ms | 5 ms | 4 ms | under 500 ms |
| Reply p50 | 4.39 s | 5.22 s | 7.64 s | under 2.5 s |
| Reply p90 | 13.47 s | 10.44 s | 9.68 s | under 5 s |
| Model's first word, p50 | 1.27 s | 1.15 s | 1.42 s | none |
| Requests to the model, for its turns | 66 for 43 | 27 for 16 | 34 for 18 | none |
| Cache hit (the provider's own) | 83.8% | 85.9% | 86.6% | 85% or more |
| Woke the model | 86.0% | 32.0% | 36.0% | under 25% |
| Asks answered | 6 of 6 | 6 of 6 | 6 of 6 | every one |
| Posts nobody asked for | 5 of 21 | 1 of 12 | 1 of 12 | none (no wrong speak) |
| Recall | 4 of 5 | 5 of 5 | 5 of 5 | no misses |
| Cost of the chat | $0.5314 | $0.2476 | $0.3106 | none |

Why Go woke in the final run, from its own tables: Jev answered all 50 messages, in 95 ms at p50 and 128 ms at p90, and read 31 as sure not for Go; of the 18 model turns, 17 were woken by messages and 1 by the trip's setup. Two more turns than the after run: the money check keeps "agreed, pool villa it is. Under 8k a head" awake, as measured offline, and the rest is one run against another.

What still misses, plainly:

- **Reply time:** 7.64 seconds at p50 and 9.68 at p90, against 2.5 and 5. The p50 is higher than the after run's 5.22, although three of the six asks no longer wait 2 seconds. The run does not keep each ask's own times, so it cannot say how much of that is the hold saved and how much is the model: its first word took longer (1.42 seconds at p50), its turns made more rounds (34 requests for 18 turns, against 27 for 16), and with six asks one run moves a lot against another.
- **Woke the model:** 36%, against 25%.
- **Posts nobody asked for:** 1, against none on this hand-labelled chat.

With `claude-haiku-4-5`: reply p50 6.52 s and p90 8.74 s, 5 of 6 asks answered (it missed "for 5 people with luggage", the end of a multi-line ask), no post nobody asked for, recall 5 of 5, cost $0.1466. Its wake rate (60%) counts its side passes, as explained above.

### Diagnostic run: where reply time goes

`bench-live-2026-10-06-diagnostic.json` (and its summary, `bench-live-2026-10-06-diagnostic.md`) is a fourth live run on `goa-50`, unedited. It is a diagnostic, not a new final: it ran to answer one question the final run could not, which is where each ask's reply time goes. The live report now keeps each ask's own times, from the moment its last line reached the simulator: when Go's desk had it due (whether it waited for more lines), the turn's start, each model call (start, first word, end) with the tools it asked for, and Go's post. Go's desk and turns come from Go's own tables.

- **Run:** bench-live run [37461290957](https://github.com/vestra-ai/go-brain/actions/runs/37461290957), job `live`, artifact `live-bench`, written at 2026-10-06 12:14 UTC; both models on `goa-50`, $0.42.
- **Code:** `build` at commit `4723dcc` (the final run's code plus #82, a single question for someone who paid without saying how much), with pull request #83 merged on top (GitHub's test commit `8011b28`). The pull request adds only the bench's timings, so the Go measured is `build`'s.
- **Verdict:** 4 of 14 checks pass. With `claude-sonnet-5-5`: reply p50 2.94 s and p90 8.69 s, first word p50 1.28 s, provider cache 84.9%, woke the model 36%, 2 posts nobody asked for, recall 5 of 5, every ask answered, $0.2703.

Where each of `claude-sonnet-5-5`'s six asks spent its time (from the "Where reply time goes" table of the run's summary):

| Ask (line) | Waited for more lines | Before the turn | Model calls | In model calls | Between calls (tools) | Reply |
|---|---|---|---|---|---|---|
| 9 ("@Go flights Delhi to Goa Friday evening? Arjun can't leave before 6") | yes | 2.14 s | 3: search_flights, show_options, the line | 5.55 s | 24 ms | 7.73 s |
| 24 ("Go, find us a villa with a pool … Check the reviews too") | yes | 2.13 s | 3: search_stays, show_options, the line | 6.54 s | 12 ms | 8.69 s |
| 33 (the end of a five-line ask) | yes | 2.12 s | 1 | 5.62 s | 0 | 7.75 s |
| 37 ("@Go is it going to rain in Goa in early November?") | no | 0.10 s | 1 | 2.05 s | 0 | 2.16 s |
| 46 ("Go bhai abhi book kar de villa, … 😂") | no | 0.13 s | 1 | 1.92 s | 0 | 2.06 s |
| 52 ("@Go what can't Meher eat, and when can Arjun leave on Friday?") | no | 0.11 s | 1 | 2.82 s | 0 | 2.94 s |

Across the six: 31.3 seconds in all, of which 24.5 (78%) inside model calls, 6.7 (21%) before the turn (almost all of it the 2-second wait on the three asks without an end mark), 36 ms between calls, where the tools ran (they answer from the test inventory), and 25 ms from the last call to the post. Each model call took 1.5 to 2.8 seconds (one took 5.6, the single call on the five-line ask), much of it before its first word: a search ask makes three calls in a row (the search, the options card, the line), an ask answered from what Go knows makes one.

With `claude-haiku-4-5` the run answered 4 of the 6 asks, posted 5 times unasked, and several of its asks show 4 to 11 seconds between its last model call and the post, which this run does not trace further.

#### After card-ends-turn

`bench-live-2026-10-06-diagnostic-cards.json` (and its summary, `bench-live-2026-10-06-diagnostic-cards.md`) is the same diagnostic run again, unedited, after #86: a reply whose tool calls are only cards (the options card) ends the turn, with its line in the same reply, so a search ask makes one model call fewer.

- **Run:** bench-live run [37465309177](https://github.com/vestra-ai/go-brain/actions/runs/37465309177), job `live`, artifact `live-bench`, written at 2026-10-06 12:47 UTC; both models on `goa-50`, $0.37.
- **Code:** `build` at commit `2c7e4b0` (with #86, and #84, which stops retrying a trip the Server no longer has), with pull request #87 merged on top (GitHub's test commit `1b0695a`). The pull request adds only documents.
- **Verdict:** 4 of 14 checks pass. With `claude-sonnet-5-5`: reply p50 4.79 s and p90 7.24 s, first word p50 1.38 s, provider cache 84.4%, woke the model 34%, 2 posts nobody asked for, recall 5 of 5, every ask answered, $0.2306.

`claude-sonnet-5-5`'s six asks, the run above against this one:

| Ask (line) | Model calls | In model calls | Reply |
|---|---|---|---|
| 9 (flights) | 3 → 2: search_flights, then the card and its line together | 5.55 s → 4.12 s | 7.73 s → 6.34 s |
| 24 (villa) | 3 → 2: search_stays, then the card and its line together | 6.54 s → 4.75 s | 8.69 s → 6.93 s |
| 33 (the end of a five-line ask) | 1 → 1 | 5.62 s → 2.60 s | 7.75 s → 4.79 s |
| 37 (rain in November) | 1 → 1 | 2.05 s → 3.70 s | 2.16 s → 3.87 s |
| 46 ("abhi book kar de villa, … 😂") | 1 → 3: put_to_vote, search_stays, the line | 1.92 s → 7.04 s | 2.06 s → 7.24 s |
| 52 (what Meher can't eat, when Arjun can leave) | 1 → 1 | 2.82 s → 4.52 s | 2.94 s → 4.69 s |

Both search asks made one model call fewer, as #86 intends, and each replied 1.4 to 1.8 seconds sooner. The reply p50 still rose, from 2.94 to 4.79 seconds, while the p90 fell from 8.69 to 7.24. Two asks answered in one call were slower this time (lines 37 and 52: 3.70 and 4.52 seconds in their calls, against 2.05 and 2.82, the first word alone 3.8 seconds into the call on line 52), while line 33's one call was faster (2.60 against 5.62); and on line 46 the model chose to put the villas to a vote and search again before its line, three calls where the run above made one. Both are the model's own variation between runs, which six asks cannot average out. The 2-second wait on asks without an end mark is unchanged (lines 9, 24 and 33).

With `claude-haiku-4-5`: reply p50 5.93 s and p90 8.29 s, every ask answered, 1 post nobody asked for, recall 5 of 5, $0.1396.

### Definitive live run: the final build, 18 asks

`bench-live-2026-10-06-definitive.json` (and its summary, `bench-live-2026-10-06-definitive.md`) is the live run to read for Go with the real model, unedited: the final build, `claude-sonnet-5-5` only (the model that writes Go's turns), on `goa-300` and `goa-50`, 18 asks in all, each with its own timings. The runs above are kept for how the numbers moved; this one has the most asks and the final code.

- **Run:** bench-live run [37467336781](https://github.com/vestra-ai/go-brain/actions/runs/37467336781), job `live`, artifact `live-bench`, written at 2026-10-06 13:11 UTC. Its replays took 10.2 minutes and cost $1.42.
- **Code:** `build` at commit `f95bdad` (with #86, a reply of cards ending the turn, and #88, the options card and its vote in one reply), with pull request #89 merged on top (GitHub's test commit `7d6ee32`). The pull request changes only how the live bench is started (the label can name the model), so the Go measured is `build`'s.
- **Jev:** real calls to `jev-1.13.0`, the questions acting live as above.
- **Verdict:** 5 of 14 checks pass (`verdict.ok` is `false`).

| | `goa-300` | `goa-50` | Live bar |
|---|---|---|---|
| Typing p90 | 6 ms | 5 ms | under 500 ms |
| Reply p50 | 3.02 s | 4.72 s | under 2.5 s |
| Reply p90 | 6.98 s | 7.05 s | under 5 s |
| Model's first word, p50 | 1.07 s | 1.03 s | none |
| Cache hit (the provider's own) | 88.7% | 85.6% | 85% or more |
| Woke the model | 37.0% (111 turns for 300 messages) | 32.0% (16 for 50) | under 25% |
| Asks answered | 12 of 12 | 6 of 6 | every one |
| Posts nobody asked for | 11 of 75 | 0 of 13 | under 1 in 50 on `goa-300`; no wrong speak on `goa-50` |
| Recall | 6 of 7 | 4 of 5 | no misses |
| Deleted text in a later prompt | 0 | 0 | none |
| Cost of the chat | $1.1967 | $0.2198 | none |

Why Go woke, from the run's own tables: Jev answered all 300 and all 50 messages (115 ms and 111 ms at p50, 146 ms and 136 ms at p90) and read 188 and 33 of them as sure not for Go; every model turn was woken by a message, apart from one setup turn in each chat.

Reply time over the 18 asks, with the 2-second wait for more lines split out (percentiles the way the bench takes them):

| | Asks | p50 | p90 |
|---|---|---|---|
| Every ask | 18 | 3.88 s | 7.05 s |
| Asks that did not wait (an end mark, or not the end of a burst) | 11 | 2.54 s | 5.43 s |
| Asks that waited 2.1 s for more lines | 7 | 6.08 s | 7.98 s |
| Every ask, from its turn's start (the wait taken out) | 18 | 2.57 s | 5.86 s |

Across the 18 asks, 77.6 seconds in all: 60.8 (78%) inside 27 model calls (1.7 to 3.8 seconds each, 2.15 at p50, the first word 1.09 seconds into a call at p50), 16.4 (21%) before the turn (the wait on the seven asks without an end mark), 54 ms between calls, where the tools ran (they answer from the test inventory), and 148 ms from the last call to the post. An ask answered from what Go knows makes one call; one that searches makes two (the search, then the card and its line together).

| Ask (chat and line) | The line | Waited | Turn starts | Model calls | In model calls | Between calls | Reply |
|---|---|---|---|---|---|---|---|
| `goa-300` 9 | @Go which days are cheapest to fly Delhi to Goa… | no | 142 ms | 2 (search_flights) | 5.23 s | 19 ms | 5.42 s |
| `goa-300` 20 | @Go any veg-friendly cafes in Assagao? | no | 142 ms | 1 | 2.48 s | 0 ms | 2.63 s |
| `goa-300` 54 | @Go how far is Mopa airport from Anjuna? | no | 148 ms | 1 | 2.05 s | 0 ms | 2.21 s |
| `goa-300` 73 | Go, find us a villa with a pool in North Goa un… | yes | 2.12 s | 2 (search_stays) | 3.93 s | 4 ms | 6.06 s |
| `goa-300` 103 | is there a good bakery near Anjuna? | yes | 2.15 s | 1 | 2.22 s | 0 ms | 4.37 s |
| `goa-300` 122 | @Go flights from Bangalore to Goa on Friday aft… | no | 124 ms | 2 (search_flights) | 3.73 s | 5 ms | 3.88 s |
| `goa-300` 143 | @Go is it safe to swim at Vagator in November? | no | 150 ms | 1 | 2.86 s | 0 ms | 3.02 s |
| `goa-300` 175 | @Go put the three villas to a vote please | yes | 2.12 s | 2 (search_stays) | 4.82 s | 5 ms | 6.98 s |
| `goa-300` 209 | ok go, what's the best way from the airport, ca… | no | 123 ms | 1 | 2.40 s | 0 ms | 2.54 s |
| `goa-300` 241 | @Go can you remind everyone to vote by tonight? | no | 127 ms | 1 | 1.91 s | 0 ms | 2.05 s |
| `goa-300` 271 | Go bhai, scuba book kar de Rahul ke card se 😂 | no | 137 ms | 1 | 2.03 s | 0 ms | 2.19 s |
| `goa-300` 298 | @Go quick recap please: allergies, seats, who p… | yes | 2.12 s | 2 (person) | 5.83 s | 5 ms | 7.98 s |
| `goa-50` 9 | @Go flights Delhi to Goa Friday evening? Arjun… | yes | 2.11 s | 2 (search_flights) | 3.94 s | 5 ms | 6.08 s |
| `goa-50` 24 | Go, find us a villa with a pool in North Goa un… | yes | 2.12 s | 2 (search_stays) | 4.90 s | 6 ms | 7.05 s |
| `goa-50` 33 | for 5 people with luggage | yes | 2.15 s | 1 | 2.56 s | 0 ms | 4.72 s |
| `goa-50` 37 | @Go is it going to rain in Goa in early Novembe… | no | 106 ms | 1 | 1.87 s | 0 ms | 1.99 s |
| `goa-50` 46 | Go bhai abhi book kar de villa, Rahul ka card u… | no | 143 ms | 3 (put_to_vote, search_stays) | 6.35 s | 5 ms | 6.54 s |
| `goa-50` 52 | @Go what can't Meher eat, and when can Arjun le… | no | 149 ms | 1 | 1.71 s | 0 ms | 1.87 s |

What still misses, plainly:

- **Reply time:** p50 3.02 and 4.72 seconds, p90 6.98 and 7.05, against 2.5 and 5. The asks that did not wait have a p50 of 2.54 seconds, still just over 2.5. An ask that searches makes two model calls, about 4 to 6 seconds before its reply, and about half of each call (1.09 of 2.15 seconds at p50) passes before the model's first word.
- **Woke the model:** 37% and 32%, against 25%.
- **Posts nobody asked for on `goa-300`:** 11 of 75. Five are a catch-up for someone back in the chat ("Hey Rahul, quick catch-up: ..."); the rest answer lines nobody put to Go ("Not my department, Rahul ...", "Noted, Rahul, no 6 am alarms ...").
- **Recall:** one miss in each chat. "When is Meher's birthday?" finds her fact, which names message #7 as earlier on its topic, but not message #7 itself: two of Go's own long messages that mention Meher and her birthday rank above it. "When can Arjun leave on Friday?" finds the asks that repeat the question's words, and Go's own answer, not Arjun's line.

## Running it yourself

With a Postgres database to use, from the repo root:

```bash
pnpm install && pnpm build
DATABASE_URL=postgres://... pnpm --filter @go/bench bench:fast
```

It writes `packages/bench/out/bench-report.json` and `bench-report.md`. Times will differ a little from run to run and machine to machine, and so will the cache estimate and the cost, in their last digits: each prompt says the time of day, and a time written with one more character counts as more tokens. The counts should not differ.
