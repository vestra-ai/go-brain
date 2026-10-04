/**
 * T9c — the summarizer must never mistake ITS OWN instruction for the conversation.
 *
 * THE DRILL (staging task fe222a7a, runner build e4bb8de3e). A one-ask agentic task
 * crossed the compaction trigger at round 23. The kernel cut correctly — T9b working —
 * and then the SUMMARY's first section read:
 *
 *   ## Latest request — "Produce the structured summary of the conversation above now,
 *   using the section format from your instructions. Output only the summary."
 *
 * `COMPACTION_USER` is the trailing user turn appended to the summarize request, so it
 * IS the last user-role message the summarizer sees, and schema section 1 asks for "the
 * user's most recent unfulfilled message". The model answered the question it was asked.
 * The loop then resumed, read that section as the live objective, replied with a
 * structured summary, and the task ended `completed` at file 23 of 30 — abandoned, with
 * a summary as its answer.
 *
 * Why T9b exposed it: before T9b a compaction cut at a `user` entry, so the real ask sat
 * near the tail. T9b makes the ONE-ASK compaction ordinary, and there the only real user
 * message is far back — the instruction is the closest user-role message by a wide margin.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. Byte pins are the CEILING for prompt text: they
 * prove the clause is present and composes, never that a model obeys it. The behavioural
 * gate is the fact-recall eval (`scripts/compaction-eval`, GATE 0.90) plus its one-ask
 * fixture, whose expected facts include "latest request = the ask" and explicitly exclude
 * the instruction text. These pins exist so the clause cannot be deleted silently.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPACTION_SYSTEM,
  COMPACTION_USER,
  COMPACTION_SPLIT_TURN_SECTION,
  withSplitTurnInstructions,
} from '../compaction-prompt.js';

describe('COMPACTION_USER — the instruction says it is not the conversation', () => {
  it('names the span above as the conversation and the directive below as a system one', () => {
    // pi's framing (compaction.ts:467 "The messages above are a conversation to
    // summarize…") made explicit: the span is the conversation, the directive is not.
    expect(COMPACTION_USER).toContain('The conversation to summarize is above.');
    expect(COMPACTION_USER.toLowerCase()).toContain('system directive');
  });

  it('says in so many words that it is never the user\'s open request', () => {
    expect(COMPACTION_USER.toLowerCase()).toContain('never the user');
    expect(COMPACTION_USER.toLowerCase()).toContain('open request');
  });

  it('disowns THE INSTRUCTION, never "this message" — the merged-block hazard', () => {
    // `withTrailingUserEntry` MERGES this text onto a span that already ends user-side,
    // so on the chat split-turn shape it shares ONE wire message with the user's real
    // request. "THIS message is not something the user said" would disown the user's own
    // ask in the same request that tells the model to carry that ask forward.
    expect(COMPACTION_USER).toContain('The instruction that follows');
    expect(COMPACTION_USER.toLowerCase()).not.toContain('this message');
  });

  it('still ENDS on the produce-the-summary directive — the trailing user turn is load-bearing', () => {
    // The request must end on a user turn or Claude models with thinking on reject it
    // as assistant prefill (400). The new framing leads; the directive still closes.
    expect(COMPACTION_USER.trimEnd().endsWith('Output only the summary.')).toBe(true);
  });
});

describe('COMPACTION_SYSTEM section 1 — the instruction is never the open request', () => {
  it('carries the exclusion clause', () => {
    expect(COMPACTION_SYSTEM).toContain('is never the open request');
  });

  it('section 1 is titled "Open request" — a state, never "Latest request", which reads as the user asking', () => {
    // finding 7: the summary is re-read as a user-role document; its first heading must
    // not read as an instruction. Mutation: restore "Latest request" → fails here.
    expect(COMPACTION_SYSTEM).toContain('1. Open request');
    expect(COMPACTION_SYSTEM).not.toContain('Latest request');
  });

  it('names the one-ask shape: the ask IS the latest request, still unfulfilled', () => {
    // The drill's exact shape — one ask, then tool work, no second user message.
    expect(COMPACTION_SYSTEM).toContain('single ask followed by tool work');
    expect(COMPACTION_SYSTEM).toContain('still unfulfilled');
  });

  it('keeps the clause inside section 1, before the "None" escape hatch', () => {
    // Placement is the point: a clause after the schema reads as a footnote. It has to
    // qualify "the user's most recent unfulfilled message" where that phrase is stated.
    const sectionOne = COMPACTION_SYSTEM.indexOf('1. Open request');
    const sectionTwo = COMPACTION_SYSTEM.indexOf('2. Goal and intent');
    const clause = COMPACTION_SYSTEM.indexOf('is never the open request');
    const noneEscape = COMPACTION_SYSTEM.indexOf('Write "None" only if');
    expect(sectionOne).toBeGreaterThan(-1);
    expect(clause).toBeGreaterThan(sectionOne);
    expect(clause).toBeLessThan(noneEscape);
    expect(noneEscape).toBeLessThan(sectionTwo);
  });
});

describe('COMPACTION_SPLIT_TURN_SECTION — the turn carries its own request forward', () => {
  it('names the opening user message (or the previous summary) as the request to carry', () => {
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('the user message that opened it');
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('previous summary');
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('open request');
  });

  it('keeps T9b\'s claims: prefix, retained, not-finished, still in progress', () => {
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('PREFIX');
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('retained');
    expect(COMPACTION_SPLIT_TURN_SECTION.toLowerCase()).toContain('not describe');
    expect(COMPACTION_SPLIT_TURN_SECTION).toContain('still in progress');
  });

  it('a NON-split compaction is byte-identical — the eval still measures its own prompt', () => {
    // The whole reason this section lives outside COMPACTION_SYSTEM. A chat-shaped cut
    // must ship the exact bytes the 0.90 recall gate was calibrated against.
    expect(withSplitTurnInstructions(COMPACTION_SYSTEM, false)).toBe(COMPACTION_SYSTEM);
  });
});
