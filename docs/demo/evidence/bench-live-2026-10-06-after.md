# Go replay bench (live)

**9 of 14 checks fail.**

Commit b88dcb5ac5, 2026-10-06T10:59:13.803Z. Real models and real Jev; cache numbers are the provider's own.

## Models

| Model | Chat | Reply p50 | Reply p90 | First word p50 | Typing p90 | Cache (provider) | Cache (estimate) | Cost | Wrong speak |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | goa-50 | 5.22 s | 10.44 s | 1.15 s | 5 ms | 85.9% | 85.5% | $0.2476 | 1 |
| claude-haiku-4-5 | goa-50 | 8.67 s | 8.89 s | 482 ms | 8 ms | 83.5% | 83.2% | $0.1473 | 5 |

**Suggested COMPOSER_MODEL: claude-sonnet-5-5.** It no model passes every bar; this one has the fastest reply p50 (5.22 s).

## Why Go woke

- claude-sonnet-5-5 on goa-50: Jev read 50 messages and answered 50, in 153 ms p50 and 192 ms p90; 33 read sure not for Go. Model turns by what woke them: message 15, setup 1.
- claude-haiku-4-5 on goa-50: Jev read 50 messages and answered 50, in 147 ms p50 and 173 ms p90; 28 read sure not for Go. Model turns by what woke them: message 20, setup 1.

## Checks

| Chat | Check | Value | Bar | Result |
|---|---|---|---|---|
| goa-50 (claude-sonnet-5-5) | reply p50 | 5.22 s | under 2500 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | reply p90 | 10.44 s | under 5000 ms | **FAIL** |
| goa-50 (claude-sonnet-5-5) | woke the model | 32.0% | under 25% | **FAIL** |
| goa-50 (claude-sonnet-5-5) | wrong speak | 1 | 0 | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p50 | 8.67 s | under 2500 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | reply p90 | 8.89 s | under 5000 ms | **FAIL** |
| goa-50 (claude-haiku-4-5) | cache hit (provider) | 83.5% | 85% or more | **FAIL** |
| goa-50 (claude-haiku-4-5) | woke the model | 66.0% | under 25% | **FAIL** |
| goa-50 (claude-haiku-4-5) | wrong speak | 5 | 0 | **FAIL** |
| goa-50 (claude-sonnet-5-5) | typing p90 | 5 ms | under 500 ms | pass |
| goa-50 (claude-sonnet-5-5) | cache hit (provider) | 85.9% | 85% or more | pass |
| goa-50 (claude-sonnet-5-5) | recall | 5 of 5 | at most 0 missed | pass |
| goa-50 (claude-haiku-4-5) | typing p90 | 8 ms | under 500 ms | pass |
| goa-50 (claude-haiku-4-5) | recall | 5 of 5 | at most 0 missed | pass |

## goa-50 (claude-sonnet-5-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 16 times for 50 messages (32.0%).
- Typing p50 / p90: 3 ms / 5 ms (6 lines named Go, 0 missing, 0 typing with no post after it).
- Reply p50 / p90: 5.22 s / 10.44 s (6 answers).
- Speaking: 6 asks, 6 answered; 12 posts (prompted 8, follow-up 2, greeting 1, duplicate 0, unprompted 1).
- Quiet: 19 reactions (5 where it was not fine), 12 record lines.
- Cache (estimate): 85.5% (with the first request 82.9%) over 27 composer requests. Hits 26, first 1, below minimum 0, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,949 tokens, last 7,949; on average tools 4,185, system 1,167, cached chat 561, after the cache point 1,033.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 10 requests, 10,157 tokens. Cost: $0.2476. First word p50: 1.15 s. Ran for 103.52 s.

**Unprompted posts (for review)**

- after line 19: Rahul, I searched North Goa pool villas for 5 people, 6 to 9 Nov, with a cap of ₹40k a night for the whole place (8k a head). The Palms Villa in Vagator and Vil

**Reactions where a quiet action was not fine**

- line 9: ✅
- line 19: ✅
- line 24: ✅
- line 32: ✅
- line 38: ✅

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,640 | 0 | first | 0 |
| 3 | 262 s | 6,066 | 5,352 | hit | 21 |
| 7 | 301 s | 6,191 | 5,352 | hit | 22 |
| 10 | 344 s | 6,213 | 5,352 | hit | 22 |
| 14 | 760 s | 6,426 | 5,352 | hit | 22 |
| 17 | 781 s | 6,592 | 5,352 | hit | 22 |
| 19 | 905 s | 6,646 | 5,352 | hit | 22 |
| 24 | 1,505 s | 6,935 | 5,352 | hit | 22 |
| 26 | 1,800 s | 7,068 | 6,026 | hit | 23 |
| 29 | 1,902 s | 7,251 | 6,026 | hit | 23 |
| 30 | 1,918 s | 7,468 | 6,026 | hit | 23 |
| 31 | 1,930 s | 7,483 | 6,026 | hit | 23 |
| 32 | 2,105 s | 7,647 | 6,026 | hit | 23 |
| 33 | 2,120 s | 7,759 | 6,026 | hit | 23 |
| 34 | 2,400 s | 7,801 | 6,994 | hit | 24 |
| 36 | 2,960 s | 7,949 | 6,994 | hit | 24 |

## goa-50 (claude-haiku-4-5)

- Messages from people: 50 (1 edits, 1 deletes, 1 reactions, 1 photos). Reflex: live Jev.
- Woke the model: 33 times for 50 messages (66.0%).
- Typing p50 / p90: 3 ms / 8 ms (6 lines named Go, 0 missing, 1 typing with no post after it).
- Reply p50 / p90: 8.67 s / 8.89 s (3 answers).
- Speaking: 6 asks, 3 answered; 10 posts (prompted 5, follow-up 3, greeting 0, duplicate 0, unprompted 2).
- Quiet: 26 reactions (9 where it was not fine), 10 record lines.
- Cache (estimate): 83.2% (with the first request 81.5%) over 52 composer requests. Hits 31, first 9, below minimum 12, TTL 0, delete 0, edit 0, fold 0, rules changed 0, drift 0.
- Prompt: largest 7,244 tokens, last 7,244; on average tools 2,663, system 912, cached chat 225, after the cache point 709.
- Folds: none.
- Recall: 5 of 5 (0 asked after a fold).
- Deleted text in a later prompt: none.
- Side passes: 0 requests, 0 tokens. Cost: $0.1473. First word p50: 482 ms. Ran for 108.20 s.

**Missed asks**

- line 24: Go, find us a villa with a pool in North Goa under 8k a head, near the beach. Check the reviews too
- line 33: for 5 people with luggage
- line 46: Go bhai abhi book kar de villa, Rahul ka card use kar le 😂

**Unprompted posts (for review)**

- after line 23: Found 6 villas with pools in North Goa. Top three are in Morjim, Assagao and Anjuna - all have great ratings and are way under 8k per head per night. Which ones
- after line 40: Birthday dinner on the 7th - definitely! Once we lock in the villa, we can find a nice spot in that area. Should we do a group dinner or just Meher picks and we

**Reactions where a quiet action was not fine**

- line 2: 🙌
- line 9: ✅
- line 19: ✅
- line 34: 😂
- line 38: 👍
- line 32: ✅
- line 37: ✅
- line 38: ✅
- line 41: 👍

| Request | Chat time | Tokens | Read | Result | Same blocks |
|---|---|---|---|---|---|
| 0 | 0 s | 5,640 | 0 | first | 0 |
| 1 | 38 s | 570 | 0 | below_minimum | 0 |
| 2 | 180 s | 702 | 0 | below_minimum | 0 |
| 3 | 262 s | 770 | 0 | below_minimum | 0 |
| 4 | 262 s | 6,015 | 5,352 | first | 0 |
| 8 | 301 s | 6,100 | 5,352 | hit | 21 |
| 10 | 344 s | 876 | 0 | below_minimum | 0 |
| 11 | 344 s | 6,151 | 5,352 | first | 0 |
| 12 | 760 s | 967 | 0 | below_minimum | 0 |
| 13 | 760 s | 6,286 | 5,352 | first | 0 |
| 16 | 781 s | 6,332 | 5,352 | hit | 22 |
| 18 | 790 s | 6,380 | 5,352 | hit | 22 |
| 20 | 796 s | 999 | 0 | below_minimum | 0 |
| 21 | 796 s | 6,451 | 5,352 | first | 0 |
| 22 | 812 s | 858 | 0 | below_minimum | 0 |
| 23 | 812 s | 6,476 | 5,352 | first | 0 |
| 27 | 850 s | 6,585 | 5,882 | hit | 23 |
| 28 | 1,236 s | 725 | 0 | below_minimum | 0 |
| 29 | 1,500 s | 973 | 0 | below_minimum | 0 |
| 30 | 1,505 s | 6,658 | 5,352 | first | 0 |
| 32 | 1,560 s | 6,703 | 5,883 | hit | 23 |
| 34 | 1,800 s | 6,734 | 5,883 | hit | 23 |
| 35 | 1,846 s | 6,752 | 5,883 | hit | 23 |
| 37 | 1,860 s | 1,066 | 0 | below_minimum | 0 |
| 38 | 1,860 s | 6,785 | 5,883 | first | 0 |
| 39 | 1,902 s | 6,798 | 5,883 | hit | 23 |
| 41 | 1,918 s | 6,925 | 5,883 | hit | 23 |
| 43 | 1,930 s | 6,939 | 5,883 | hit | 23 |
| 45 | 2,105 s | 7,019 | 5,883 | hit | 23 |
| 47 | 2,120 s | 1,106 | 0 | below_minimum | 0 |
| 48 | 2,400 s | 1,056 | 0 | below_minimum | 0 |
| 49 | 2,400 s | 7,166 | 5,883 | first | 0 |
| 50 | 2,960 s | 7,244 | 5,883 | hit | 23 |
