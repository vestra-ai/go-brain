# Go replay bench (live)

**9 of 14 checks fail.**

Commit 9f2379c26d, 2026-10-06T11:39:59.467Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-50 | 7.64 s | 9.68 s | 1.42 s | 4 ms | 86.6% | 86.3% | $0.3106 | 1 |
| claude-haiku-4-5 | goa-50 | 6.52 s | 8.74 s | 531 ms | 3 ms | 84.7% | 84.6% | $0.1466 | 1 |

**Suggested COMPOSER_MODEL: claude-haiku-4-5.** It no model passes every bar; this one has the fastest reply p50 (6.52 s).

## Why Go woke

- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 95 ms p50 and 128 ms p90; 31 read sure not for Go. Model turns by what woke them: message 17, setup 1.
- claude-haiku-4-5 on goa-50: Jev read 50 messages and answered 50, in 92 ms p50 and 123 ms p90; 29 read sure not for Go. Model turns by what woke them: message 19, setup 1.

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-50 (claude-sonnet-5-5) | reply p50 | 7.64 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 9.68 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 36.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | wrong speak | 1 | 0 | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p50 | 6.52 s | under 2500 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p90 | 8.74 s | under 5000 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | cache hit (provider) | 84.7% | 85% or more | **FAIL** |
| goa-50 (claude-haiku-4-5) | woke the model | 60.0% | under 25% | **FAIL** |
| goa-50 (claude-haiku-4-5) | wrong speak | 1 | 0 | **FAIL** |
| goa-50 (claude-sonnet-5-5) | typing p90 | 4 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 86.6% | 85% or more | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |
| goa-50 (claude-haiku-4-5) | typing p90 | 3 ms | under 500 ms | pass |
| goa-50 (claude-haiku-4-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 18 times for 50 messages (36.0%).
- Typing p50 / p90: 3 ms / 4 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 7.64 s / 9.68 s (6 answers).
- Speaking: 6 asks, 6 answered; 12 posts (prompted 8, follow-up 2, greeting 1, duplicate 0, unprompted 1).
- Quiet: 20 reactions (5 where it was not fine), 11 record lines.
- Cache (estimate): 86.3% (with the first request 84.2%) over 34 composer requests. Hits 32, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 8,064 tokens, last 8,064; on average tools 4,185, system 1,303, cached chat 523, after the cache point 1,028.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 12 requests, 12,471 tokens. Cost: $0.3106. First word p50: 1.42 s. Ran for 117.63 s.

**Unprompted posts (for review)**

- after line 23: Pool is a must for everyone, so here are the pool villas, all sleeping 5 or more and well under 8k a head per night for the five of you. The Palms Villa in Vaga

**Reactions where a quiet action was not fine**

- line 9: ✅
- line 19: ✅
- line 32: ✅
- line 38: ✅
- line 41: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,778 | 0 | first | 0 |
| 3 | 262 s | 6,206 | 5,488 | hit | 21 |
| 6 | 301 s | 6,337 | 5,488 | hit | 22 |
| 9 | 344 s | 6,359 | 5,488 | hit | 22 |
| 11 | 760 s | 6,563 | 5,488 | hit | 22 |
| 14 | 781 s | 6,652 | 5,488 | hit | 22 |
| 17 | 812 s | 6,701 | 5,488 | hit | 22 |
| 21 | 850 s | 6,860 | 5,488 | hit | 22 |
| 25 | 1,505 s | 6,999 | 5,488 | edit | 22 |
| 28 | 1,572 s | 7,113 | 6,092 | hit | 23 |
| 29 | 1,800 s | 7,177 | 6,092 | hit | 23 |
| 32 | 1,902 s | 7,328 | 6,092 | hit | 23 |
| 33 | 1,918 s | 7,542 | 6,092 | hit | 23 |
| 34 | 1,930 s | 7,556 | 6,092 | hit | 23 |
| 35 | 2,105 s | 7,662 | 6,092 | hit | 23 |
| 37 | 2,400 s | 7,804 | 6,092 | hit | 23 |
| 42 | 2,460 s | 8,007 | 7,016 | hit | 24 |
| 44 | 2,960 s | 8,064 | 7,016 | hit | 24 |

## goa-50 (claude-haiku-4-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 30 times for 50 messages (60.0%).
- Typing p50 / p90: 3 ms / 3 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 6.52 s / 8.74 s (5 answers).
- Speaking: 6 asks, 5 answered; 10 posts (prompted 7, follow-up 3, greeting 0, duplicate 0, unprompted 0).
- Quiet: 23 reactions (7 where it was not fine), 8 record lines.
- Cache (estimate): 84.6% (with the first request 82.9%) over 51 composer requests. Hits 32, first 9, below minimum 10, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,259 tokens, last 7,259; on average tools 2,790, system 1,024, cached chat 212, after the cache point 685.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $0.1466. First word p50: 531 ms. Ran for 100.89 s.

**Missed asks**

- line 33: for 5 people with luggage

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 9: ✅
- line 19: ✅
- line 34: 😂
- line 38: ✅
- line 31: ✅
- line 37: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,778 | 0 | first | 0 |
| 1 | 38 s | 570 | 0 | below_minimum | 0 |
| 2 | 180 s | 702 | 0 | below_minimum | 0 |
| 3 | 262 s | 770 | 0 | below_minimum | 0 |
| 4 | 262 s | 6,156 | 5,488 | first | 0 |
| 7 | 301 s | 6,221 | 5,488 | hit | 21 |
| 9 | 344 s | 863 | 0 | below_minimum | 0 |
| 10 | 344 s | 6,282 | 5,488 | first | 0 |
| 11 | 760 s | 953 | 0 | below_minimum | 0 |
| 12 | 760 s | 6,373 | 5,488 | first | 0 |
| 14 | 781 s | 6,430 | 5,488 | hit | 22 |
| 16 | 790 s | 6,475 | 5,488 | hit | 22 |
| 18 | 812 s | 960 | 0 | below_minimum | 0 |
| 19 | 812 s | 6,523 | 5,488 | first | 0 |
| 21 | 850 s | 6,570 | 5,488 | hit | 22 |
| 25 | 1,236 s | 707 | 0 | below_minimum | 0 |
| 26 | 1,505 s | 6,709 | 5,488 | first | 0 |
| 28 | 1,560 s | 6,743 | 5,978 | hit | 23 |
| 30 | 1,800 s | 6,714 | 5,978 | hit | 23 |
| 31 | 1,846 s | 6,792 | 5,978 | hit | 23 |
| 33 | 1,860 s | 1,126 | 0 | below_minimum | 0 |
| 34 | 1,860 s | 6,764 | 5,978 | first | 0 |
| 36 | 1,902 s | 6,873 | 5,978 | hit | 23 |
| 38 | 1,918 s | 6,946 | 5,978 | hit | 23 |
| 39 | 1,930 s | 6,960 | 5,978 | hit | 23 |
| 41 | 2,105 s | 7,037 | 5,978 | hit | 23 |
| 43 | 2,120 s | 1,015 | 0 | below_minimum | 0 |
| 44 | 2,400 s | 7,074 | 5,978 | first | 0 |
| 46 | 2,400 s | 979 | 0 | below_minimum | 0 |
| 49 | 2,960 s | 7,259 | 5,978 | first | 0 |
