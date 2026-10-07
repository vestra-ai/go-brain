# Go replay bench (live)

**10 of 14 checks fail.**

Commit 1b0695a6b4, 2026-10-06T12:47:51.548Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-50 | 4.79 s | 7.24 s | 1.38 s | 6 ms | 84.4% | 84.0% | $0.2306 | 2 |
| claude-haiku-4-5 | goa-50 | 5.93 s | 8.29 s | 548 ms | 6 ms | 83.5% | 83.4% | $0.1396 | 1 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (4.79 s).

## Why Go woke

- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 159 ms p50 and 199 ms p90; 31 read sure not for Go. Model turns by what woke them: message 16, setup 1.
- claude-haiku-4-5 on goa-50: Jev read 50 messages and answered 50, in 155 ms p50 and 184 ms p90; 30 read sure not for Go. Model turns by what woke them: message 18, setup 1.

## Where reply time goes

Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn's start, the model calls (and the tools they asked for), the first call's first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.

| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 9 | yes (due at 2.17 s) | 6 ms | 2.17 s | 2 (search_flights) | 3.24 s | 4.12 s | 13 ms | 22 ms | 6.34 s |
| claude-sonnet-5-5 | 24 | yes (due at 2.15 s) | 5 ms | 2.15 s | 2 (search_stays) | 3.76 s | 4.75 s | 4 ms | 14 ms | 6.93 s |
| claude-sonnet-5-5 | 33 | yes (due at 2.17 s) | 2.50 s | 2.17 s | 1 | 3.44 s | 2.60 s | 0 ms | 3 ms | 4.79 s |
| claude-sonnet-5-5 | 37 | no | 4 ms | 159 ms | 1 | 2.98 s | 3.70 s | 0 ms | 3 ms | 3.87 s |
| claude-sonnet-5-5 | 46 | no | 3 ms | 162 ms | 3 (put_to_vote, search_stays) | 1.18 s | 7.04 s | 6 ms | 18 ms | 7.24 s |
| claude-sonnet-5-5 | 52 | no | 4 ms | 153 ms | 1 | 4.00 s | 4.52 s | 0 ms | 3 ms | 4.69 s |
| claude-haiku-4-5 | 9 | yes (due at 2.16 s) | 4 ms | 2.17 s | 4 (search_flights) | n/a | 6.08 s | 10 ms | 9 ms | 8.29 s |
| claude-haiku-4-5 | 24 | yes (due at 2.16 s) | 4 ms | 2.16 s | 2 (search_stays) | n/a | 3.74 s | 3 ms | 15 ms | 5.93 s |
| claude-haiku-4-5 | 33 | yes (due at 2.15 s) | 2.50 s | 2.16 s | 2 (call_business) | n/a | 3.40 s | 2 ms | 4 ms | 5.58 s |
| claude-haiku-4-5 | 37 | no | 4 ms | 172 ms | 1 | n/a | 1.95 s | 0 ms | 4.04 s | 6.17 s |
| claude-haiku-4-5 | 46 | no | 6 ms | 165 ms | 1 | 631 ms | 2.13 s | 0 ms | 4.30 s | 6.61 s |
| claude-haiku-4-5 | 52 | no | 4 ms | 201 ms | 2 (person) | n/a | 3.06 s | 3 ms | 3 ms | 3.28 s |

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-50 (claude-sonnet-5-5) | reply p50 | 4.79 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 7.24 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 84.4% | 85% or more | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 34.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | wrong speak | 2 | 0 | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p50 | 5.93 s | under 2500 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p90 | 8.29 s | under 5000 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | cache hit (provider) | 83.5% | 85% or more | **FAIL** |
| goa-50 (claude-haiku-4-5) | woke the model | 60.0% | under 25% | **FAIL** |
| goa-50 (claude-haiku-4-5) | wrong speak | 1 | 0 | **FAIL** |
| goa-50 (claude-sonnet-5-5) | typing p90 | 6 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |
| goa-50 (claude-haiku-4-5) | typing p90 | 6 ms | under 500 ms | pass |
| goa-50 (claude-haiku-4-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 17 times for 50 messages (34.0%).
- Typing p50 / p90: 4 ms / 6 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 4.79 s / 7.24 s (6 answers).
- Speaking: 6 asks, 6 answered; 12 posts (prompted 8, follow-up 1, greeting 1, duplicate 0, unprompted 2).
- Quiet: 20 reactions (7 where it was not fine), 8 record lines.
- Cache (estimate): 84.0% (with the first request 81.0%) over 23 composer requests. Hits 22, first 1, below minimum 0, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,831 tokens, last 7,831; on average tools 4,213, system 1,331, cached chat 420, after the cache point 962.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 11 requests, 9,885 tokens. Cost: $0.2306. First word p50: 1.38 s. Ran for 113.39 s.

**Unprompted posts (for review)**

- after line 40: Meher is asking about a birthday dinner on the 7th, which is a preference, but she's asking a question, so a short reply with a couple of ideas is useful. I don
- after line 47: All three fit under 8k a head for 5 people (the priciest, Casa Mareia, is about ₹3,380 a head per night). I'll open the vote from the card.

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 9: ✅
- line 19: ✅
- line 33: ✅
- line 26: ✅
- line 38: ✅
- line 41: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,834 | 0 | first | 0 |
| 4 | 262 s | 6,324 | 5,544 | hit | 21 |
| 6 | 301 s | 6,365 | 5,544 | hit | 22 |
| 8 | 344 s | 6,397 | 5,544 | hit | 22 |
| 10 | 760 s | 6,510 | 5,544 | hit | 22 |
| 12 | 781 s | 6,566 | 5,544 | hit | 22 |
| 15 | 850 s | 6,651 | 5,544 | hit | 22 |
| 18 | 1,505 s | 6,814 | 5,544 | hit | 22 |
| 20 | 1,572 s | 6,895 | 6,078 | hit | 23 |
| 21 | 1,800 s | 6,963 | 6,078 | hit | 23 |
| 24 | 1,902 s | 7,082 | 6,078 | hit | 23 |
| 25 | 1,918 s | 7,316 | 6,078 | hit | 23 |
| 26 | 1,930 s | 7,330 | 6,078 | hit | 23 |
| 27 | 2,105 s | 7,507 | 6,078 | hit | 23 |
| 28 | 2,400 s | 7,647 | 6,078 | hit | 23 |
| 31 | 2,460 s | 7,715 | 6,078 | hit | 23 |
| 33 | 2,960 s | 7,831 | 6,977 | hit | 24 |

## goa-50 (claude-haiku-4-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 30 times for 50 messages (60.0%).
- Typing p50 / p90: 4 ms / 6 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 5.93 s / 8.29 s (6 answers).
- Speaking: 6 asks, 6 answered; 14 posts (prompted 9, follow-up 3, greeting 1, duplicate 0, unprompted 1).
- Quiet: 24 reactions (8 where it was not fine), 6 record lines.
- Cache (estimate): 83.4% (with the first request 81.6%) over 48 composer requests. Hits 28, first 9, below minimum 11, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,489 tokens, last 7,489; on average tools 2,668, system 1,014, cached chat 287, after the cache point 682.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $0.1396. First word p50: 548 ms. Ran for 97.83 s.

**Unprompted posts (for review)**

- after line 23: 3 stays: Pool villas in North Goa, 6-9 Nov, under ₹8k per head, from ₹11,500 per night

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 2: ✅
- line 9: ✅
- line 19: ✅
- line 35: 😂
- line 38: 👍
- line 37: ✅
- line 47: 👍

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,834 | 0 | first | 0 |
| 1 | 52 s | 642 | 0 | below_minimum | 0 |
| 2 | 241 s | 801 | 0 | below_minimum | 0 |
| 3 | 262 s | 826 | 0 | below_minimum | 0 |
| 4 | 262 s | 6,286 | 5,544 | first | 0 |
| 8 | 301 s | 6,322 | 5,544 | hit | 22 |
| 10 | 344 s | 6,355 | 5,544 | hit | 22 |
| 12 | 760 s | 1,009 | 0 | below_minimum | 0 |
| 13 | 760 s | 6,476 | 5,544 | first | 0 |
| 15 | 781 s | 6,568 | 5,544 | hit | 22 |
| 17 | 790 s | 848 | 0 | below_minimum | 0 |
| 18 | 812 s | 824 | 0 | below_minimum | 0 |
| 19 | 812 s | 6,616 | 5,544 | first | 0 |
| 22 | 850 s | 6,687 | 5,544 | hit | 22 |
| 24 | 1,236 s | 735 | 0 | below_minimum | 0 |
| 25 | 1,505 s | 6,836 | 5,544 | first | 0 |
| 27 | 1,572 s | 1,071 | 0 | below_minimum | 0 |
| 28 | 1,572 s | 6,952 | 6,093 | first | 0 |
| 30 | 1,800 s | 6,958 | 6,093 | hit | 23 |
| 31 | 1,846 s | 7,029 | 6,093 | hit | 23 |
| 33 | 1,860 s | 916 | 0 | below_minimum | 0 |
| 34 | 1,860 s | 7,023 | 6,093 | first | 0 |
| 35 | 1,930 s | 7,131 | 6,093 | hit | 23 |
| 37 | 2,105 s | 7,188 | 6,093 | hit | 23 |
| 39 | 2,120 s | 1,051 | 0 | below_minimum | 0 |
| 40 | 2,120 s | 7,278 | 6,093 | first | 0 |
| 42 | 2,131 s | 984 | 0 | below_minimum | 0 |
| 43 | 2,400 s | 7,395 | 6,596 | first | 0 |
| 44 | 2,460 s | 7,395 | 6,596 | hit | 24 |
| 46 | 2,960 s | 7,489 | 6,596 | hit | 24 |
