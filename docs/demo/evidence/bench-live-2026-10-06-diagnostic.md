# Go replay bench (live)

**10 of 14 checks fail.**

Commit 8011b28c48, 2026-10-06T12:14:25.003Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-50 | 2.94 s | 8.69 s | 1.28 s | 7 ms | 84.9% | 84.7% | $0.2703 | 2 |
| claude-haiku-4-5 | goa-50 | 5.91 s | 7.47 s | 508 ms | 5 ms | 83.5% | 83.4% | $0.1464 | 7 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (2.94 s).

## Why Go woke

- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 106 ms p50 and 138 ms p90; 31 read sure not for Go. Model turns by what woke them: message 17, setup 1.
- claude-haiku-4-5 on goa-50: Jev read 50 messages and answered 50, in 95 ms p50 and 127 ms p90; 29 read sure not for Go. Model turns by what woke them: message 19, setup 1.

## Where reply time goes

Per ask, in time after its last line reached the simulator: whether it waited for more lines, typing, the turn's start, the model calls (and the tools they asked for), the first call's first word, the time inside model calls, the time between them (the tools ran there), from the last call to the post, and the post.

| Model | Ask (line) | Waited | Typing | Turn starts | Model calls | First word | In model calls | Between calls | Last call to post | Post |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 9 | yes (due at 2.13 s) | 7 ms | 2.14 s | 3 (search_flights, show_options) | 3.09 s | 5.55 s | 24 ms | 7 ms | 7.73 s |
| claude-sonnet-5-5 | 24 | yes (due at 2.12 s) | 6 ms | 2.13 s | 3 (search_stays, show_options) | 3.02 s | 6.54 s | 12 ms | 4 ms | 8.69 s |
| claude-sonnet-5-5 | 33 | yes (due at 2.11 s) | 2.50 s | 2.12 s | 1 | 6.58 s | 5.62 s | 0 ms | 3 ms | 7.75 s |
| claude-sonnet-5-5 | 37 | no | 3 ms | 100 ms | 1 | 1.22 s | 2.05 s | 0 ms | 3 ms | 2.16 s |
| claude-sonnet-5-5 | 46 | no | 4 ms | 125 ms | 1 | 1.27 s | 1.92 s | 0 ms | 4 ms | 2.06 s |
| claude-sonnet-5-5 | 52 | no | 4 ms | 106 ms | 1 | 2.22 s | 2.82 s | 0 ms | 4 ms | 2.94 s |
| claude-haiku-4-5 | 9 | yes (due at 2.09 s) | 4 ms | 2.10 s | 3 (search_flights, show_options) | n/a | 3.79 s | 11 ms | 5 ms | 5.91 s |
| claude-haiku-4-5 | 24 | yes (due at 2.13 s) | 4 ms | 2.14 s | 3 (search_stays, show_options) | n/a | 5.31 s | 10 ms | 5 ms | 7.47 s |
| claude-haiku-4-5 | 33 | yes (due at 2.11 s) | 2.50 s | 2.12 s | 2 (search_buses) | n/a | 2.69 s | 5 ms | 10.78 s | 15.61 s |
| claude-haiku-4-5 | 37 | no | 4 ms | 128 ms | 1 | n/a | 1.91 s | 0 ms | 4.35 s | 6.40 s |
| claude-haiku-4-5 | 46 | no | 4 ms | 97 ms | 1 | 587 ms | 2.13 s | 0 ms | 5.14 s | 7.38 s |
| claude-haiku-4-5 | 52 | no | 4 ms | 138 ms | 2 (person) | n/a | 4.01 s | 5 ms | 3 ms | 4.17 s |

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-50 (claude-sonnet-5-5) | reply p50 | 2.94 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 8.69 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 84.9% | 85% or more | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 36.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | wrong speak | 2 | 0 | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p50 | 5.91 s | under 2500 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p90 | 7.47 s | under 5000 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | cache hit (provider) | 83.5% | 85% or more | **FAIL** |
| goa-50 (claude-haiku-4-5) | woke the model | 62.0% | under 25% | **FAIL** |
| goa-50 (claude-haiku-4-5) | wrong speak | 7 | 0 | **FAIL** |
| goa-50 (claude-sonnet-5-5) | typing p90 | 7 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |
| goa-50 (claude-haiku-4-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-50 (claude-haiku-4-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 18 times for 50 messages (36.0%).
- Typing p50 / p90: 4 ms / 7 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 2.94 s / 8.69 s (6 answers).
- Speaking: 6 asks, 6 answered; 13 posts (prompted 9, follow-up 1, greeting 1, duplicate 0, unprompted 2).
- Quiet: 18 reactions (5 where it was not fine), 9 record lines.
- Cache (estimate): 84.7% (with the first request 82.5%) over 31 composer requests. Hits 29, first 1, below minimum 0, TTL 0, delete 0, edit 1, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,988 tokens, last 7,988; on average tools 4,185, system 1,303, cached chat 510, after the cache point 1,057.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 13 requests, 12,870 tokens. Cost: $0.2703. First word p50: 1.28 s. Ran for 111.84 s.

**Unprompted posts (for review)**

- after line 23: Budget check: 8k a head for 5 people is about 40k per night, so all of these fit. I'll show the top picks and put them to a vote.
- after line 23: Vote: Which pool villa for 6 to 9 Nov? The Palms Villa ₹36,600, Villa Sol ₹38,400, Villa Verde ₹34,500, Casa Azul ₹43,800, Casa Mareia ₹50,700. Open Go to vote.

**Reactions where a quiet action was not fine**

- line 9: ✅
- line 19: ✅
- line 38: ✅
- line 41: ✅
- line 47: 👍

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,778 | 0 | first | 0 |
| 4 | 262 s | 6,259 | 5,488 | hit | 21 |
| 7 | 301 s | 6,350 | 5,488 | hit | 22 |
| 9 | 344 s | 6,393 | 5,488 | hit | 22 |
| 11 | 760 s | 6,489 | 5,488 | hit | 22 |
| 14 | 781 s | 6,605 | 5,488 | hit | 22 |
| 18 | 812 s | 6,698 | 5,488 | hit | 22 |
| 22 | 850 s | 6,927 | 5,488 | hit | 22 |
| 27 | 1,505 s | 7,088 | 5,488 | edit | 22 |
| 29 | 1,572 s | 7,244 | 6,106 | hit | 23 |
| 30 | 1,800 s | 7,249 | 6,106 | hit | 23 |
| 33 | 1,902 s | 7,398 | 6,106 | hit | 23 |
| 35 | 1,918 s | 7,590 | 6,106 | hit | 23 |
| 37 | 1,930 s | 7,605 | 6,106 | hit | 23 |
| 38 | 2,105 s | 7,626 | 6,106 | hit | 23 |
| 40 | 2,400 s | 7,770 | 6,106 | hit | 23 |
| 42 | 2,460 s | 7,930 | 6,900 | hit | 24 |
| 43 | 2,960 s | 7,988 | 6,900 | hit | 24 |

## goa-50 (claude-haiku-4-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 31 times for 50 messages (62.0%).
- Typing p50 / p90: 4 ms / 5 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 5.91 s / 7.47 s (4 answers).
- Speaking: 6 asks, 4 answered; 13 posts (prompted 6, follow-up 2, greeting 0, duplicate 0, unprompted 5).
- Quiet: 23 reactions (7 where it was not fine), 12 record lines.
- Cache (estimate): 83.4% (with the first request 81.8%) over 52 composer requests. Hits 31, first 10, below minimum 11, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,743 tokens, last 7,743; on average tools 2,700, system 1,006, cached chat 292, after the cache point 783.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $0.1464. First word p50: 508 ms. Ran for 105.11 s.

**Missed asks**

- line 33: for 5 people with luggage
- line 46: Go bhai abhi book kar de villa, Rahul ka card use kar le 😂

**Unprompted posts (for review)**

- after line 19: The Palms Villa in Vagator is the cheapest and closest to the beach (you loved Vagator last time!), or Villa Verde in Siolim if you want to go lower. Pick one o
- after line 20: Pool noted! Still waiting on which of the villas you all prefer, and which flight works best for everyone.
- after line 23: Still waiting on which villa you all want, The Palms in Vagator or Villa Verde in Siolim, and which flight works for everyone.
- after line 40: Two quick votes: pick your flight and villa before they're gone! Tap when you're ready.
- after line 40: Vote: Which flight works best for everyone? Friday evening Delhi to Goa, 6:30 pm or later.

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 9: ✅
- line 19: ✅
- line 38: 👍
- line 31: ✅
- line 37: ✅
- line 26: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,778 | 0 | first | 0 |
| 1 | 38 s | 570 | 0 | below_minimum | 0 |
| 2 | 262 s | 767 | 0 | below_minimum | 0 |
| 3 | 262 s | 6,128 | 5,488 | first | 0 |
| 6 | 301 s | 6,235 | 5,488 | hit | 21 |
| 8 | 344 s | 873 | 0 | below_minimum | 0 |
| 9 | 344 s | 6,257 | 5,488 | first | 0 |
| 13 | 760 s | 997 | 0 | below_minimum | 0 |
| 14 | 760 s | 6,490 | 5,488 | first | 0 |
| 18 | 781 s | 6,562 | 5,488 | hit | 22 |
| 20 | 796 s | 968 | 0 | below_minimum | 0 |
| 21 | 812 s | 867 | 0 | below_minimum | 0 |
| 22 | 812 s | 6,691 | 5,488 | first | 0 |
| 24 | 850 s | 6,794 | 5,488 | hit | 22 |
| 27 | 1,210 s | 6,888 | 6,051 | hit | 23 |
| 28 | 1,236 s | 778 | 0 | below_minimum | 0 |
| 29 | 1,505 s | 6,917 | 5,488 | first | 0 |
| 31 | 1,560 s | 6,961 | 6,053 | hit | 23 |
| 32 | 1,800 s | 6,940 | 6,053 | hit | 23 |
| 33 | 1,846 s | 7,010 | 6,053 | hit | 23 |
| 35 | 1,860 s | 1,261 | 0 | below_minimum | 0 |
| 36 | 1,860 s | 6,998 | 6,053 | first | 0 |
| 38 | 1,902 s | 1,026 | 0 | below_minimum | 0 |
| 39 | 1,902 s | 7,206 | 6,053 | first | 0 |
| 42 | 1,918 s | 7,479 | 6,053 | hit | 23 |
| 43 | 1,930 s | 7,494 | 6,053 | hit | 23 |
| 45 | 2,105 s | 7,560 | 6,053 | hit | 23 |
| 47 | 2,120 s | 1,210 | 0 | below_minimum | 0 |
| 48 | 2,400 s | 7,661 | 6,621 | first | 0 |
| 49 | 2,400 s | 1,100 | 0 | below_minimum | 0 |
| 50 | 2,960 s | 7,743 | 6,621 | first | 0 |
