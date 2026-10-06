# Evidence: Jev's quick read

Jev is a fast model that answers closed questions with a probability. Go asks it nine questions about each message from a person (is it for Go, is it finished, is it a fact worth keeping, and so on) and reads each answer as sure or unsure against a bar. A question **acts live** only once its test set passes; until then it runs **in shadow**: Go still asks it and logs the answer (`reflex_reads`), but acts only on what code alone knows.

This page explains the recording in this folder: where it comes from, how each question is scored, and which questions act live.

## The files

- `jev-2026-10-06.json`: Jev's answers to every question for every line of the test set, as recorded, unedited. It is the same file, byte for byte, as `apps/brain/src/reflex/testsets/recorded/jev-1.13.0.json`, which CI scores on every change.
- `jev-2026-10-06.txt`: what the recording printed, unedited: one line per question at the bars Go had when it was recorded, then the bar sweep (each bar's values and what they give).
- `jev-2026-10-06-repeat.json` and `jev-2026-10-06-repeat.txt`: a second recording of the same lines about 19 minutes later, at the bars Go has now, unedited. Go does not use it; it shows how much Jev's answers move between two runs (see "Asked twice" below).

## Where the answers come from

- **Run:** jev-record run [37437189211](https://github.com/vestra-ai/go-brain/actions/runs/37437189211), job `record`, artifact `jev-record`, recorded at 2026-10-06 08:37 UTC (`recorded_at` in the file).
- **Code:** pull request #51 at `9bc86f9`, merged onto `build` at `5225799` (the run's test commit `444429e`). The pull request adds only the recording workflow and a test, so the questions asked are `build`'s; `versions` in the file holds each question's wording version, and CI marks a question stale if its wording changes.
- **Jev:** model `jev-1.13.0` at Jev's default address, the same settings as the `brain-rehearsal` service, with Vestra's staging Jev key from the repository's secrets. The key is never printed.
- **The recording runs in CI** (`.github/workflows/jev-record.yml`) when a pull request gets the label `jev-record`: one Jev call per line.

## The test set

`apps/brain/src/reflex/testsets/chat.jsonl` holds 50 chat lines in the Goa trip, 30 in English and 20 in Hinglish, each labelled by a person before any recording with what Jev should say. Each question is labelled on 6 to 14 lines. The lines are written for the test set; none comes from a real trip chat yet.

## How a question is scored

Jev's recorded answers go through the same readers Go uses live, with the bars in `apps/brain/src/reflex/thresholds.ts`.

- **Right:** the reading is sure and matches the label.
- **Wrong:** the reading is sure and does not match. For question 8 a wrong answer is a false alarm: a line raised as risky that is not.
- **Unsure** counts as not found. It is the safe outcome: Go falls back to what code knows and the main model decides.
- **Recall:** right over labelled. For question 8, the risky lines raised over the risky lines.
- **Gate:** no wrong answer (question 8: at most 2 false alarms), and recall at least the question's minimum (`GATES` in `apps/brain/src/reflex/testset.ts`).

## The result

At the bars Go has now. Recall by language is right over labelled in that language.

| # | Question | Lines | Sure | Wrong | Recall | English / Hinglish | Gate | Result |
|---|---|---|---|---|---|---|---|---|
| 1 | Is the message for Go, or chatter? | 13 | 11 | 0 | 0.85 | 0.78 / 1.00 | 0.5 | live |
| 2 | Is the message finished? | 11 | 2 | 0 | 0.18 | 0.14 / 0.25 | 0.5 | shadow |
| 3 | A quick ask, or big work? | 9 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.4 | shadow |
| 4 | Which running job is it about? | 6 | 4 | 0 | 0.67 | 0.75 / 0.50 | 0.5 | live |
| 5 | A fact about the person worth keeping? | 14 | 10 | 0 | 0.71 | 0.70 / 0.75 | 0.5 | live |
| 6 | A line for the trip record (agreed, open, doing)? | 9 | 7 | 0 | 0.78 | 1.00 / 0.33 | 0.4 | live |
| 7 | A quiet reaction (✅ 👍 🙌), or none? | 10 | 10 | 0 | 1.00 | 1.00 / 1.00 | 0.3 | live |
| 8 | Risky (spend, steering Go, a secret)? | 14 (5 risky) | 5 raised | 0 false alarms | 1.00 | 1.00 / 1.00 | 0.8 | live |
| 9 | An opening for Go (a question it could answer, a choice going round in circles, someone asked to look something up)? | 6 | 0 | 0 | 0.00 | 0.00 / 0.00 | 0.3 | shadow |

So questions 1, 4, 5, 6, 7 and 8 act live (`PASSED_SETS` in `apps/brain/src/reflex/live-gate.ts`, and `REFLEX_LIVE` defaults to `q1,q4,q5,q6,q7,q8`). The admin page's `REFLEX_LIVE` switch can narrow that list or turn Jev off, but it cannot make a question in shadow act live. Jev never gave a sure wrong answer on any question. Questions 2, 3 and 9 stay in shadow because Jev was too rarely sure on them: no value in the sweep brings them to their gate (the best, in the recording CI scores, are 0.18, 0.22 and 0.17).

The rows are the lines the second recording printed (`jev-2026-10-06-repeat.txt`), since it ran at these bars. The first recording ran before question 1's bar moved; its lines for questions 2 to 9 are the same.

### The one bar that moved

Question 1 reads a line as sure chatter when Jev's "chatter" answer is at least a bar and its "for Go" answer at most 0.2. Go took that bar, 0.9, from Bash, where it was measured on 149 lines. At 0.9 question 1 failed here (recall 0.46): Jev read the six chatter lines at 0.76 to 0.89, so none was sure. The sweep tried 0.8, 0.85, 0.9 and 0.95; 0.8 gives the best recall with no wrong answer (0.85), so the bar is 0.8. Five of the six chatter lines are now sure; "I'm veg btw" (0.76) stays unsure.

Read this with care:

- The bar was chosen on the same 13 lines it is scored on.
- Six of question 1's 11 right answers are lines that name Go, which code gets right without Jev. Jev's own part is the five chatter lines.
- The one ask that does not name Go ("can someone check trains from Mumbai on Thursday?") stayed unsure, so Go still wakes for it.

Every other bar is unchanged. The sweep also shows question 5 would reach 0.86 at 0.7 instead of 0.8, and question 8 would raise one false alarm at 0.4 or lower; neither was needed to pass, so neither moved.

### Asked twice

The second recording ([run 37439332584](https://github.com/vestra-ai/go-brain/actions/runs/37439332584), at 08:55 UTC, the same model, settings and question wording) asked Jev the same 1,118 questions again. 555 of its answers came back different, by 0.02 on average and at most 0.09. At the bars Go has now, every question's sure, wrong and recall came out exactly the same in both recordings, and so did every pass or fail. CI scores the first recording.

## What acting live changes

- **Question 1:** a message Jev is sure is chatter does not wake the main model. A message that names Go always does.
- **Questions 5, 6 and 7:** the notes pass runs at once for a sure fact or record line instead of after a quiet spell, and a sure 👍 or 🙌 goes on the message without any model. A ✅ goes on at once when questions 5 and 7 are both sure.
- **Questions 4 and 8:** no part of Go acts on these readings yet; acting live records them as acted in `reflex_reads`.
- **Question 2, in shadow:** no message reads as finished, so Go waits 2 seconds (longer while more lines keep coming, up to 6) before the main model answers.
- **Question 9, in shadow:** Go does not offer help on its own from an opening.
- **Question 3, in shadow:** no part of Go acts on it yet.

## What this does not show

- The lines are written for the test, not taken from a real trip chat, and there are only 6 to 14 per question. A wrong answer on a real chat is possible that this set did not catch.
- These are Jev's answers from two runs on one day. Jev is pinned to `jev-1.13.0`; a new version means a new recording.
- Speed is not measured here. Go waits at most 450 ms for Jev (`JEV_DEADLINE_MS`) before every question reads unsure.
