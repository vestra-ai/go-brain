/**
 * memory-sweep — the Nami P2 OFF-LOOP end-of-task memory sweep
 * (spec: docs/specs/2026-08-04-nami-offloop-sweep.md).
 *
 * P1 staged the sweep as an invisible `control:'memory'` turn on the live loop
 * and paid for it with an invisibility apparatus (stream suppression, uuid
 * windows, projection strips) — the machinery every contamination bug lived in
 * (prod task 20b112b2). P2's ruling: memory sync is not a turn, and caching is
 * orthogonal.
 *
 * The sweep is now a SIDE model call at the terminal, on the
 * maybeSuggestNextPrompt pattern — with one deliberate difference. The
 * suggestion call swaps in its own tiny system prompt and forfeits the cache;
 * the sweep reuses the main loop's BYTE-IDENTICAL prefix (same system string,
 * same provider tools, the same WIRE projection) and appends the sweep prompt as
 * the only trailing user message. Provider prompt caches key on content, so the
 * side call rides the warm prefix the loop just wrote: P1's cache economics
 * without P1's turn.
 *
 * "The same projection as the loop" is therefore a claim about the WIRE, not
 * about the journal: with CONTEXT_ELISION_V1 on, the loop's prefix is the ELIDED
 * view, so a sweep that re-projected the journal raw would ship full bodies where
 * the last round shipped stubs and miss the very cache this design exists to hit.
 * The projection goes through projectWire and the turn's frozen elision is a
 * REQUIRED dep — see OffloopSweepDeps.elision.
 *
 * The projection was never the whole wire, though. Measured 2026-10-01 the sweep read
 * 0-13% of its input from cache on the OpenAI lanes, 34% on Fireworks and 47% on Gemini
 * while the loop read 74-89%: it rebuilt its request from its own hand list, so it sent
 * no `prompt_cache_key` / `x-session-affinity` (another cache machine), a 'low' reasoning
 * effort (every provider keys its cache on the effort) and an unsplit system. With
 * SWEEP_PREFIX_PARITY_V1 on, the sweep sends the loop's LAST request verbatim
 * (OffloopSweepDeps.loopRequest) with only its own history and output cap.
 *
 * Tool schemas ride along for prefix bytes only — the sweep call parses text and
 * never dispatches a tool_use (a model that emits one anyway just ends a round
 * with zero FACT lines).
 *
 * Never throws, never bills the turn, bounded by a hard timeout: a slow or
 * failed sweep loses one capture, never a turn. Its usage IS reported (see
 * OffloopSweepResult) — the call is metered on the `lane:'sweep'` usage rail so
 * it stops being an invisible cost, but it is still never folded into the
 * turn's billing.
 */
import { wireMessages, type FrozenElision } from './context-elision.js';
import type { JournalEntry } from '../contract/journal.js';
import type { NormalizedUsage } from '../contract/events.js';
import type { Journal } from '../kernel/journal/journal.js';
import type { ProviderHistory, ProviderTool, Transport } from './transport.js';
import type { LoopRequest } from './round-engine.js';
import { resolveCapabilities, type ModelCapabilities } from '../contract/model-capabilities.js';
import { readsCacheAtBoundaries } from '../contract/openai-cache-boundaries.js';
import { resolveFamilyRate } from './native-pricing.js';
import { projectTokenCount } from '../kernel/journal/token-ledger.js';

/** Mirrors the wire constant in @bash/shared EVENTS.NAMI_REMEMBER_DEPOSIT. */
export const NAMI_REMEMBER_DEPOSIT_EVENT = 'nami:remember_deposit';

const SWEEP_MAX_TOKENS = 2048;
export const SWEEP_TIMEOUT_MS = 30_000;
/**
 * The reasoning FLOOR for this call (Transport.callModel `reasoningEffort`). The sweep rides the
 * task's model, and on the top-effort default 54% of 858 prod sweeps (09-03 to 09-25) spent the
 * whole budget reasoning and wrote no FACT line. Writing lines about a transcript it has already
 * read needs no deliberation.
 */
const SWEEP_REASONING_EFFORT = 'low';
/**
 * The output cap when the sweep rides the loop's request (SWEEP_PREFIX_PARITY_V1). That
 * request carries no reasoning floor (the floor above is part of every provider's cache key,
 * probes 2026-10-01), so the reply reasons at the loop's effort first: prod gpt-6-luna at
 * 'low' already reasoned 989 tokens p50 and hit 2048 on 11% of sweeps. On the budgeted
 * Anthropic rows the cap also sets `thinking.budget_tokens`, and 8192 keeps the loop's
 * default budget (4000) where 2048 cut it to 1024, which is another cache key. The 30 s
 * timeout still bounds the call.
 */
export const SWEEP_PARITY_MAX_TOKENS = 8192;

/**
 * Which efforts deliberate at length, one entry per effort level the registry can carry, so a
 * new level fails the typecheck here until someone decides.
 */
const DELIBERATES: Readonly<Record<NonNullable<ModelCapabilities['thinking']['effort']>, boolean>> = {
  low: false,
  medium: false,
  high: true,
  max: true,
  xhigh: true,
};

/**
 * Does riding the loop's request pay on this model (SWEEP_PREFIX_PARITY_V1)? Not on an
 * Anthropic row that thinks at high effort or above (claude-fable-5-1, claude-mythos-5,
 * the Opus 4 rows): parity drops the sweep's 'low' floor, so the sweep would reason at the
 * loop's effort at up to $50 per million output tokens, which can cost more than the cache
 * saves on a prefix under ~15-30K tokens. Those rows keep today's floored request. Read off
 * the capability registry (the effort the Anthropic transport sends), never a list of ids.
 */
export function sweepParityPaysOff(model: string): boolean {
  const { provider, thinking } = resolveCapabilities(model);
  return !(provider === 'anthropic' && thinking.effort !== undefined && DELIBERATES[thinking.effort]);
}

/**
 * SWEEP_EFFORT_MESSAGE_V1: can the parity sweep lower its own turn to 'low' without leaving the
 * loop's cache? Yes on a row that takes a per-message effort change (registry
 * thinking.perMessageEffort): the request stays the loop's, plus that one message, so the
 * question sweepParityPaysOff answers never arises there.
 */
export function sweepTakesEffortMessage(model: string): boolean {
  return resolveCapabilities(model).thinking.perMessageEffort === true;
}

/**
 * SWEEP_PARITY_BY_PREFIX_V1: the rows sweepParityPaysOff turns down that CANNOT take a per-message
 * effort change (Anthropic at high effort or above without thinking.perMessageEffort: Fable 5,
 * Mythos 5, the Opus 4 rows) ride the loop's request anyway when the history a floored sweep would
 * rewrite is worth more than the parity sweep's thinking. A row that takes the change never comes
 * here: it rides parity with its own turn lowered (SWEEP_EFFORT_MESSAGE_V1), which needs no
 * break-even (sweepParityPlan).
 *
 * FITTED, NOT EXPLAINED (prod, 30 days to 2026-10-04, 8 claude-fable-5-1 floored sweeps): on a
 * first turn the floored sweep read the whole input, and on a longer conversation it read only
 * ~50-60K (system, tools, the first ask) and rewrote everything after, 32K to 106K tokens. The
 * mechanism is unproven (the #4381 review, MED-2: the loop itself restarted at the same point on
 * those tasks) and no high-effort parity sweep has run yet, so the flip waits for a measured
 * sweep row (cache_read close to the loop's last input, lane_status ok), not this formula.
 *
 * THE BREAK-EVEN, per row from the provider's real rates (native-pricing.ts): parity costs at most
 * the floored sweep when the rewritten tokens times (cache write - cache read) exceed the parity
 * sweep's output priced at its WHOLE cap (SWEEP_PARITY_MAX_TOKENS, thinking included). Both sides
 * pay the same tail (the final reply and the prompt), so it cancels. Conservative on every
 * term: the write is the 5-minute rate (the 1-hour rate the proxy writes is higher), the floored
 * sweep's own output is taken as free, and the parity sweep is assumed to think to its cap, so a
 * prefix this rule sends to parity is cheaper even in the worst case. On the 8 prod sweeps: 4 go
 * to parity, $3.83 becomes at most $2.40 (37% less; about 70% at a realistic 2K output).
 */
export function parityBreakEvenTokens(model: string): number {
  const { rate, isDefault } = resolveFamilyRate(model);
  // An id with no family of its own prices at the default (Sonnet's) rate: no break-even from that.
  if (isDefault) return Number.POSITIVE_INFINITY;
  const saving = rate.cacheWrite - rate.cacheRead;
  return saving > 0 ? Math.ceil((SWEEP_PARITY_MAX_TOKENS * rate.out) / saving) : Number.POSITIVE_INFINITY;
}

/**
 * The history a floored sweep would rewrite: the wire projection of what the floored request sends
 * (no engine context updates: the floored request drops them), from the model's first output (an
 * assistant or tool_use entry) up to (not including) the LAST assistant entry, the final reply,
 * which both requests pay for, as they pay for anything after it. In the ledger's chars/4 estimate
 * with images at its flat 1,200 (both undercount, so it errs toward the floored sweep). 0 on a
 * single-round first turn; a multi-round first turn measures its own earlier rounds.
 */
export function floorRewriteTokens(messages: JournalEntry[], elision: FrozenElision | null): number {
  const wire = wireMessages(messages.filter((e) => !isContextUpdate(e)), elision);
  const first = wire.findIndex((e) => e.payload.type === 'assistant' || e.payload.type === 'tool_use');
  let end = wire.length - 1;
  while (end > first && wire[end]!.payload.type !== 'assistant') end--;
  return first < 0 || end <= first ? 0 : projectTokenCount(wire.slice(first, end), { countImages: true }).messages;
}

/**
 * How the sweep rides the loop's request on `model` (SWEEP_PREFIX_PARITY_V1 on), or null for
 * today's floored request. One decision, read off the registry:
 *  - a row that takes a per-message effort change (sweepTakesEffortMessage), with
 *    SWEEP_EFFORT_MESSAGE_V1: parity with its own turn lowered to 'low'. No break-even: the
 *    request is the loop's plus one message, so the whole cache is read at the floor effort;
 *  - a row where parity pays off (sweepParityPaysOff, below high effort): parity, as before;
 *  - a high-effort row WITHOUT the capability, with SWEEP_PARITY_BY_PREFIX_V1: parity past the
 *    row's break-even (parityBreakEvenTokens);
 *  - otherwise null, a capable high-effort row with SWEEP_EFFORT_MESSAGE_V1 off among them: the
 *    break-even is never its rule.
 */
export function sweepParityPlan(
  model: string,
  flags: { effortMessage: boolean; byPrefix: boolean },
): Pick<OffloopSweepDeps, 'parityEffort' | 'parityMinRewriteTokens'> | null {
  const capable = sweepTakesEffortMessage(model);
  if (capable && flags.effortMessage) return { parityEffort: 'low' };
  if (sweepParityPaysOff(model)) return {};
  if (!capable && flags.byPrefix) return { parityMinRewriteTokens: parityBreakEvenTokens(model) };
  return null;
}

/**
 * The provider's count of the loop's last request (RunContext.lastRoundInput): its whole input
 * (cached and not) and its output. Read only to estimate what a parity sweep cost when it is cut
 * before the provider reports usage.
 */
export interface SweepLoopInput {
  inputTokens: number;
  outputTokens: number;
}

/** The chars-per-token the estimate uses (the engine's usual heuristic). */
const CHARS_PER_TOKEN = 4;

/**
 * The fastest a sweep its own bound cut is assumed to have written, in output tokens (thinking
 * included) per second after its first token. Measured on prod (agent_turns, 45 days to
 * 2026-10-04, the 24 single-round Anthropic turns with over 200 output tokens): 76 tokens/s at the
 * median and 103 at the most, Fable 71 at the most. The fastest, so a timed-out row errs high.
 */
export const SWEEP_CUT_OUTPUT_TOKENS_PER_S = 103;
/** The first stretch of a call writes nothing while the provider reads the prefix (2-5 s on a warm 100K+ prefix). */
export const SWEEP_CUT_FIRST_TOKEN_MS = 2_000;

/**
 * What a parity sweep cut before `done` most likely cost, for its usage row (the provider bills
 * a cut stream; reporting zero under-meters it). Read only when the provider reported nothing.
 *  - The prefix: the loop's last request, read from the cache it just wrote.
 *  - The tail (the loop's final reply and the sweep prompt): on Anthropic a cache WRITE, booked as
 *    a real row books it (the aggregate write, no 5m/1h split); elsewhere fresh input.
 *  - The output, thinking included at the output rate: what streamed (text and thinking deltas at
 *    CHARS_PER_TOKEN). On a row its own bound cut (`timedOut`, where thinking dominates and
 *    streams only as a summary or not at all), never less than SWEEP_CUT_OUTPUT_TOKENS_PER_S over
 *    the bound after SWEEP_CUT_FIRST_TOKEN_MS. A row the next message or the run's abort cut meters
 *    what streamed: it is usually cut inside the first-token wait. Capped at the request's own
 *    output cap, past which the provider bills nothing.
 * A missed cache is still priced as a hit. Undefined when the loop's count is unknown.
 */
export function estimateSweepSpend(
  loop: SweepLoopInput | undefined,
  cut: { model: string; promptChars: number; streamedChars: number; timedOut: boolean },
): NormalizedUsage | undefined {
  if (!loop) return undefined;
  const tail = loop.outputTokens + Math.ceil(cut.promptChars / CHARS_PER_TOKEN);
  const streamed = Math.ceil(cut.streamedChars / CHARS_PER_TOKEN);
  const thinking = cut.timedOut
    ? Math.ceil(((SWEEP_TIMEOUT_MS - SWEEP_CUT_FIRST_TOKEN_MS) / 1000) * SWEEP_CUT_OUTPUT_TOKENS_PER_S)
    : 0;
  const input =
    resolveCapabilities(cut.model).provider === 'anthropic' ? { inputTokens: 0, cacheCreationInputTokens: tail } : { inputTokens: tail };
  return { ...input, cacheReadInputTokens: loop.inputTokens, outputTokens: Math.min(SWEEP_PARITY_MAX_TOKENS, Math.max(streamed, thinking)) };
}

/**
 * The stop reasons a transport reports when the OUTPUT cap cut the reply. Anthropic, Chat
 * Completions and Gemini map theirs to 'max_tokens'; Responses reports its incomplete reason.
 */
const OUTPUT_CAP_STOPS = new Set(['max_tokens', 'max_output_tokens', 'incomplete']);

/** A leading list marker the model may put before a line ("- ", "* ", "• ", "1. ", "2) "). */
const LEADING_BULLET = /^(?:[-*•]|\d+[.)])\s*/;

/** The opener for a turn that finished, before its paragraph break. */
const SWEEP_OPENER_FINISHED_TEXT =
  'The task above is finished and the user already has their answer. Now do a silent ' +
  'end-of-task memory sweep. You lived through this whole task, so you have just learned things ' +
  'about the user and their world. Capture them before the session closes.';
const SWEEP_OPENER_FINISHED = SWEEP_OPENER_FINISHED_TEXT + '\n\n';
/**
 * SWEEP_PREFIX_PARITY_V1 drops the 'low' reasoning floor (it is part of every provider's cache
 * key), so the sweep reasons at the loop's effort; this line asks it not to. It rides the
 * trailing sweep message, outside the cached prefix, so it costs no cache.
 */
const NO_DELIBERATION = 'Reply directly; no deliberation is needed.';

/**
 * Everything after the opener: shared by every variant, so a rule can never differ between
 * them. Product copy rules: no vendor names, no em dashes (pinned in memory-sweep.parse.test.ts).
 */
const SWEEP_BODY =
  'Go back over the entire conversation and pull out the durable facts about the USER that would ' +
  'still be useful weeks or months from now. Look especially for:\n' +
  '- The people and organizations in their world, and how each one relates to the user: a ' +
  'founding engineer, a teammate, a manager, an investor they email, a client, a friend, a ' +
  'company they work at or are building. Capture the person or organization AND the relationship.\n' +
  '- What the user is building, working on, deciding, or dealing with right now.\n' +
  '- Their preferences, tastes, and how they like things done.\n' +
  '- Their commitments, plans, and deadlines; who they are, where they are, the tools and ' +
  'products they use.\n' +
  '- Anything in this task that corrects or updates what you previously believed about them.\n' +
  // THE DATE IS THE ORE. The moments fold routes on a date and keeps the bullet WITH it,
  // so a swept fact that drops "on June 24" arrives undated and routes as plain state.
  // Measured 08-21: the pool skewed to undated project_state, and moments_md starved.
  '- When something happened or will happen on a date (a symptom, a promise, a deadline, a ' +
  'milestone), keep the date IN the sentence (for example "on June 24", "by Friday the 22nd"). ' +
  'Never invent a date.\n\n' +
  'The task itself is your richest source: the people the user named, who they asked you to ' +
  'write to or look up, the projects and products they mentioned, what they care about. If the ' +
  'user named a person or a project in this task, that is almost always worth capturing.\n\n' +
  'Be generous. If a fact could plausibly matter to the user later, capture it; saving a little ' +
  'too much is fine because it gets reconciled downstream, but losing something real is not. Do ' +
  'NOT capture how you carried out the task, transient or mechanical steps, tool output, or ' +
  'anything about yourself. That rule is about your own mechanics; it never covers a rule the ' +
  'user gave you about how their work must be delivered.\n\n' +
  // THE GROUNDING LESSON (2026-08-22). A drill ran the same "summarize this and email it"
  // task three times; the sweep read the AGENT's own repeated action as the user's standing
  // preference, and hours later the agent emailed the founder unasked on a read-only task.
  'What you did yourself is never evidence of what the user wants. If you sent an email, wrote ' +
  'a file, or chose a format because this task asked you to, that is the task, not a standing ' +
  'preference. Write a procedure line only when the user said or chose how they want that kind ' +
  'of work done, and never turn one instruction into a rule for a whole class of tasks.\n\n' +
  // THE DELIVERY RULE (2026-09-25, tell-it-once). A cofounder told the agent fifteen times
  // across four tasks to post each reply in its matching thread, one by one; the paragraph
  // before the grounding lesson read it as task mechanics and nothing was ever written down.
  'A rule the user states about how their work is delivered IS a procedure, even when it sounds ' +
  'like a step: where things go, in what order, one at a time or in bulk, and what never to do. ' +
  'For example "reply in the matching thread, not the main channel", "send them one by one, ' +
  'never in bulk", "never post on the public site". Keep the user\'s own key words in the ' +
  'sentence and keep the scope they gave it, no wider. If they had to correct you, that ' +
  'correction is the most important line you can write.\n\n' +
  'Output format, follow it exactly. Write ONE fact per line, each optionally followed by one ' +
  'QUOTE line as described below, and nothing else: no preamble, no summary, no reply to the ' +
  'user, no tool calls. Each fact line must be:\n' +
  'FACT [type] (source) one plain sentence about the user, in your own words, keeping real ' +
  'names, dates, and numbers\n' +
  'where type is one of: identity, relationship, commitment, preference, project_state, ' +
  'procedure, correction, other. For example a line begins "FACT [relationship] " followed by ' +
  'who someone is to the user, or "FACT [procedure] " followed by how the user wants something ' +
  'done: "deploys only after the staging soak".\n' +
  'The (source) says where the fact came from and is optional: write (user_direct) when the ' +
  'person said or chose it themselves, or (tool_observed) when an email, a document, a calendar ' +
  'entry, or other tool output showed it to you. Leave it out when you worked it out yourself. ' +
  'A procedure with no source is kept as an ordinary fact rather than as a rule.\n' +
  // D-7 (2026-09-25): an ask relayed by the assistant arrives in ITS words, with the person's own
  // after this label (apps/server person-words.ts THEIR_WORDS_LEAD; both sides pin the phrase).
  'A message may end with the user\'s own words after "In their words:". Those are exactly what ' +
  'the user said; the rest of that message was written for you by the assistant that passed ' +
  'their ask on, so it is never a quote.\n' +
  'When a (user_direct) line is a procedure, a preference, or a correction, put the user\'s own ' +
  'words on the next line, copied exactly from one of their messages, at least four words long; ' +
  'when they said always, never, from now on or the like, keep those words in the quote:\n' +
  'QUOTE "their exact words"\n' +
  'For example:\n' +
  'FACT [procedure] (user_direct) Wants each drafted reply posted in its matching thread, one at ' +
  'a time, never in bulk.\n' +
  'QUOTE "post each reply in the matching thread, one by one, never in bulk"\n' +
  'Copy their words exactly. Never write a quote they did not type, and never quote yourself, a ' +
  'tool, or a helper. If you cannot find their exact words, leave the QUOTE line out.\n\n' +
  'If, after a genuine look, nothing about the user actually came up, output a single line: NONE';

/** The sweep instruction for a turn that finished. */
export const MEMORY_SWEEP_PROMPT = SWEEP_OPENER_FINISHED + SWEEP_BODY;

/**
 * CONTEXT_APPEND_V1: a `<context_update>` entry is the engine re-telling the model its own
 * standing context (memory included), never the person speaking. Off the parity path the sweep
 * drops it from its history by its `injected` field; on the parity path it must stay (the sweep
 * rides the loop's prefix byte for byte), so the prompt says so instead. Appended only when one
 * is in view, so every other sweep's prompt is byte-identical.
 */
export const SWEEP_CONTEXT_UPDATE_NOTE =
  '\n\nA <context_update> message is your own instructions being refreshed, never the user\'s ' +
  'words: never capture a fact from it.';

/**
 * RESPONSES_MEMORY_INPUT_V1: on a boundary-cache build the loop's request carries the person's
 * memory as a leading user item (injected-user-text.ts fenceSessionMemory), and the parity sweep
 * rides that request byte for byte, so the prompt says what the item is. Appended only then, so
 * every other sweep's prompt is byte-identical.
 */
export const SWEEP_SESSION_MEMORY_NOTE =
  '\n\nA <session_memory> message is standing context the system recalled for you, never the ' +
  'user\'s words: never capture a fact from it.';

const isContextUpdate = (e: JournalEntry): boolean => e.payload.type === 'user' && e.payload.injected === 'context_update';
/** The same instruction when the sweep rides the loop's request (SWEEP_PREFIX_PARITY_V1). */
export const MEMORY_SWEEP_PROMPT_PARITY = `${SWEEP_OPENER_FINISHED_TEXT} ${NO_DELIBERATION}\n\n` + SWEEP_BODY;

/** A durable fact harvested from the sweep reply, ready to deposit. */
export interface SweptFact {
  /** What kind of fact this is; 'other' when unclassified. */
  epistemic: string;
  /** One plain sentence about the user or their world. */
  observation: string;
  /**
   * WHOSE ACTION THE FACT RESTS ON, when the model stated it. ABSENT is the honest
   * default and the safe one: it floors at 'agent_inferred' downstream, and an
   * agent_inferred procedure is demoted rather than admitted as a standing rule
   * (groundEpistemic, @bash/shared). Present only for a token the model actually
   * wrote, never inferred from the sentence.
   */
  source?: string;
  /**
   * The person's OWN words for this fact, copied from one of their messages, when the model wrote
   * a QUOTE line under it (tell-it-once, 2026-09-25). A CLAIM, never a proof: the server checks it
   * against the rows the person signed (apps/server nami-quote-verify.ts), and only a verified
   * quote can make the row the person's. Absent is the default and changes nothing downstream.
   */
  quote?: string;
}

/**
 * The types the sweep may MINT, member-for-member with the prompt's type list above. The two
 * must agree in both directions: a member here the prompt never names is unreachable, and a
 * type the prompt names but this set omits silently downgrades to 'other' — which is how
 * `procedure` was blocked until 2026-08-21 (the 9-member union in @bash/shared always allowed
 * it; only this local set and the prompt's vocabulary did not, so every procedural fact
 * deposited as 'other' and landed in the profile/moments slice instead of the procedures lane).
 *
 * `retraction` is DELIBERATELY EXCLUDED though the shared union carries it. A retraction is a
 * KILL signal for a fact already in the file, and the sweep only ever adds: it never sees the
 * projection it would be deleting from. `correction` already covers "this changed", and the
 * fold resolves it against the file under the authority ladder. A swept retraction would let
 * an end-of-task guess delete a durable fact nobody asked to delete.
 */
const EPISTEMIC_SET = new Set([
  'identity',
  'relationship',
  'commitment',
  'preference',
  'project_state',
  'procedure',
  'correction',
  'other',
]);

/**
 * The sources the SWEEP may state, curated to what the AGENT can actually be. The full
 * 5-member union (@bash/shared NAMI_SOURCES) also carries 'upload' and 'screen', which
 * belong to non-agent depositors (an upload handler, a screen pipeline) and can never be
 * true of a line the model wrote about its own task. Member-for-member with the three the
 * `remember` tool offers, for the same reason.
 *
 * EXPORTED so a test can hold it against the real NAMI_SOURCES union. This set is a
 * MIRROR of a subset of that union, and a mirror that drifts off-union is not a
 * cosmetic bug: the server narrows the wire `source` with isNamiSource and QUARANTINES
 * anything off-union, dropping the whole deposit. A token minted here that the union
 * does not carry would silently delete every fact on that line.
 */
export const SWEEP_SOURCES = new Set(['user_direct', 'tool_observed', 'agent_inferred']);

/** Runaway guard: a sweep reply yields at most this many facts. */
const MAX_FACTS_PER_SWEEP = 20;

/** A QUOTE line: the person's own words for the FACT line directly above it (lenient shape). */
const QUOTE_LINE = /^QUOTE\b\s*:?\s*(.*)$/i;
/**
 * The inline form, tolerated only strictly: uppercase QUOTE, then a quote CLOSED by its mark at
 * the END of the line (only a trailing period, comma or semicolon may follow). An uppercase QUOTE
 * mid-sentence ('needs a QUOTE "by Friday" for Acme.') is sentence text, never a cut point.
 */
const INLINE_QUOTE = /\s+QUOTE:?\s*(["“][^"”]*["”])[.,;]?\s*$/;
const QUOTE_MARKS = /^["“”'‘’«»]+|["“”'‘’«»]+$/g;

function cleanQuote(raw: string): string | undefined {
  const q = raw.trim().replace(QUOTE_MARKS, '').trim();
  return q === '' ? undefined : q;
}

/**
 * Parse a sweep reply into facts, one `FACT [type] (source) sentence` line at a time, each
 * optionally followed by one `QUOTE "their exact words"` line that attaches to the FACT line
 * directly above it (blank lines aside; any other line breaks the pairing).
 * Deliberately LENIENT (a real fact must never be dropped over formatting):
 * bracketed, bare-with-colon, or missing type (then 'other'); leading bullets
 * tolerated; non-FACT lines and the NONE sentinel ignored; dedup by
 * observation; capped as a runaway guard. A fact with no quote carries no
 * `quote` key, so its deposit is byte-identical to P1's; `quote` is the one
 * optional field this adds to the deposit contract (see depositEventData).
 */
export function parseMemorySweep(text: string | undefined | null): SweptFact[] {
  const out: SweptFact[] = [];
  const seen = new Set<string>();
  // The one fact a QUOTE line may attach to: the FACT line directly above it (blank lines aside).
  let open: SweptFact | null = null;
  for (const rawLine of (text ?? '').split('\n')) {
    const line = rawLine.trim().replace(LEADING_BULLET, '');
    if (!line) continue;
    const quoteLine = line.match(QUOTE_LINE);
    if (quoteLine) {
      const quote = cleanQuote(quoteLine[1]);
      if (open && open.quote === undefined && quote !== undefined) open.quote = quote;
      open = null;
      continue;
    }
    open = null;
    if (out.length >= MAX_FACTS_PER_SWEEP) break;
    const marker = line.match(/^FACT\b\s*(.*)$/i);
    if (!marker) continue;
    let rest = marker[1].trim();
    if (!rest || rest.toUpperCase() === 'NONE') continue;

    let epistemic = 'other';
    const bracket = rest.match(/^\[\s*([a-z_]+)\s*\]\s*[:.\-]?\s*(.*)$/i);
    const bare = rest.match(/^([a-z_]+)\s*[:.\-]\s*(.*)$/i);
    if (bracket) {
      const t = bracket[1].toLowerCase();
      if (EPISTEMIC_SET.has(t)) epistemic = t;
      rest = bracket[2].trim();
    } else if (bare && EPISTEMIC_SET.has(bare[1].toLowerCase())) {
      epistemic = bare[1].toLowerCase();
      rest = bare[2].trim();
    } else {
      rest = rest.replace(/^[:.\-]\s*/, '').trim();
    }

    // The optional grounding token, right after the type. CLOSED vocabulary, exactly
    // like the type bracket: an unrecognized parenthetical is sentence text, never a
    // tag. Eating a real opening clause ("(as he put it) keep the deck short") would
    // corrupt the fact, and minting a source the model did not write would be the very
    // fiction this token exists to end.
    let source: string | undefined;
    const grounding = rest.match(/^\(\s*([a-z_]+)\s*\)\s*(.*)$/i);
    if (grounding && SWEEP_SOURCES.has(grounding[1].toLowerCase())) {
      source = grounding[1].toLowerCase();
      rest = grounding[2].trim();
    }

    // The person's words, when the model wrote them on the same line anyway.
    let quote: string | undefined;
    const inline = rest.match(INLINE_QUOTE);
    if (inline && inline.index !== undefined && inline.index > 0) {
      quote = cleanQuote(inline[1]);
      rest = rest.slice(0, inline.index).trim();
    }
    if (!rest) continue;

    const key = rest.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const fact: SweptFact = {
      epistemic,
      ...(source !== undefined && { source }),
      observation: rest,
      ...(quote !== undefined && { quote }),
    };
    out.push(fact);
    open = fact;
  }
  return out;
}

/** How a sweep that returned ended, as its usage row records it (see sweepOutcome). */
export type SweepOutcome = 'ok' | 'none' | 'capped' | 'empty';

const NONE_LINE = /^(?:FACT\s*)?NONE\.?$/i;

/**
 * The honest outcome of a sweep that returned. `capped` first: a reply the output cap cut was
 * not finished, whatever it managed to write. Then `ok` for at least one fact, `none` when the
 * model looked and said so, and `empty` for a reply with neither.
 */
export function sweepOutcome(reply: string, facts: readonly SweptFact[], stopReason: string | null): SweepOutcome {
  if (stopReason !== null && OUTPUT_CAP_STOPS.has(stopReason)) return 'capped';
  if (facts.length > 0) return 'ok';
  const saidNone = reply.split('\n').some((l) => NONE_LINE.test(l.trim().replace(LEADING_BULLET, '')));
  return saidNone ? 'none' : 'empty';
}

/**
 * The part of a reply that was finished. A capped reply's last line was cut mid-write unless the
 * reply ended on a newline, and a cut FACT line is a wrong fact, not a short one: on 2026-09-15
 * one deposited as "Shubham wants Vestra". An uncapped reply is kept whole.
 */
export function completeLines(reply: string, capped: boolean): string {
  if (!capped || reply.endsWith('\n')) return reply;
  const cut = reply.lastIndexOf('\n');
  return cut === -1 ? '' : reply.slice(0, cut + 1);
}

/**
 * Phase 0's trivial-turn classifier, engine copy (the sandbox copy folds into a
 * re-export when P1 retires). True for user messages carrying no semantic
 * signal; anchored so words that merely start with a trivial word ("k8s",
 * "yolo") never match; bare "yes"/"no" stay NON-trivial (corrective signal).
 */
const TRIVIAL_WORD =
  '(?:ok(?:ay)?|k+|cool|nice|great|sure|got it|thanks?|thank you|thx|ty|hi|hello|hey|yo|lol|lmao|haha|wow)';
const TRIVIAL_USER_MESSAGE_RE = new RegExp(`^\\s*(?:${TRIVIAL_WORD})?[\\s!?.…]*$`, 'i');
const SLASH_COMMAND_RE = /^\s*\/[a-z][\w-]*\s*$/i;

export function isTrivialUserMessage(text: string): boolean {
  return TRIVIAL_USER_MESSAGE_RE.test(text) || SLASH_COMMAND_RE.test(text);
}

export interface OffloopSweepDeps {
  transport: Transport;
  journal: Journal;
  model: string;
  /** The main loop's system string, verbatim — the cache-prefix contract. */
  system: string;
  /** The main loop's provider tools, verbatim — the cache-prefix contract. */
  providerTools: ProviderTool[];
  /**
   * The turn's FROZEN elision, verbatim — the third leg of the cache-prefix
   * contract, alongside `system` and `providerTools`. Required, never optional:
   * an omitted elision would silently default to the RAW journal, which is the
   * one thing this call must not send. `null` is the real answer whenever the
   * flag is off or nothing was elidable, and it makes the projection
   * byte-identical to the historic raw one.
   */
  elision: FrozenElision | null;
  /** The run's abort signal; a user abort cancels the sweep immediately. */
  signal?: AbortSignal;
  /**
   * SWEEP_PREFIX_PARITY_V1 — the main loop's last request (RunContext.lastRequest). When
   * present the sweep sends it verbatim, and `model` / `system` / `providerTools` above are
   * not read: the request is the loop's, plus this call's own history and output cap, and
   * no reasoning floor. Absent (the flag off, or no main round yet) ⇒ today's request.
   */
  loopRequest?: LoopRequest;
  /** With `loopRequest`: the provider's count of that request, for estimateSweepSpend. */
  loopInput?: SweepLoopInput;
  /**
   * SWEEP_EFFORT_MESSAGE_V1, with `loopRequest`: the effort the sweep's own turn reasons at,
   * sent as a per-message change after the loop's prefix (Transport.callModel `turnEffort`), so
   * the request keeps the loop's top-level effort and reads its cache. Set only for a row where
   * sweepTakesEffortMessage holds. Absent ⇒ the loop's effort, as before.
   */
  parityEffort?: 'low';
  /**
   * SWEEP_PARITY_BY_PREFIX_V1: with `loopRequest`, ride it only when floorRewriteTokens is over
   * this (parityBreakEvenTokens for the row); otherwise send today's floored request. Absent ⇒
   * `loopRequest` is ridden whenever present, as before.
   */
  parityMinRewriteTokens?: number;
}

/**
 * What one sweep cost and what it caught. `status` is what its usage row's `lane_status` says:
 *  - 'ok' | 'none' | 'capped' | 'empty' : the call returned; `usage` is what it really cost, and
 *                the status is how it ended (see sweepOutcome). Until 2026-09-25 all four read
 *                'ok', which is how a sweep that wrote nothing looked like a capture.
 *  - 'error'   : a call WAS made and failed/timed out. Zero usage, but the
 *                attempt is real and must surface as a row, not a gap.
 *  - 'timeout' : SWEEP_PREFIX_PARITY_V1 only: the parity sweep ran into SWEEP_TIMEOUT_MS. Real
 *                spend: `usage` is what the provider reported, else estimateSweepSpend.
 *  - 'skipped' : no provider call happened at all (already-aborted run,
 *                projection failure before the request). Nothing was spent, so
 *                the caller emits nothing.
 */
export interface OffloopSweepResult {
  facts: SweptFact[];
  status: SweepOutcome | 'error' | 'timeout' | 'skipped';
  /** Present only when the call returned: what the provider reported for this call. */
  usage?: NormalizedUsage;
  /** The model the call was issued against (for the usage row's `model`). */
  model: string;
  /**
   * On 'error' only: usage the provider reported before the failure (see SideCallResult.spent).
   * On the parity path, estimateSweepSpend when it reported none, so a cut ('cancelled') row
   * is never zero.
   */
  spent?: NormalizedUsage;
}

/**
 * ONE bounded side call: project the journal through the WIRE seam exactly as the
 * loop would, append the sweep prompt as the only trailing user message, stream
 * the reply, parse FACT lines. Never throws — a failure returns status 'error'
 * with no facts, so a slow or broken sweep still loses only one capture, never a
 * turn.
 *
 * The `done` usage is now CAPTURED rather than discarded (it used to be dropped
 * as absorbed product cost, which is what made this call invisible to every cost
 * table). Capturing it is metering only: the engine still never folds it into
 * rc.billing, so the turn's claimed cost is unchanged.
 */
export async function runOffloopSweep(deps: OffloopSweepDeps): Promise<OffloopSweepResult> {
  let model = deps.loopRequest?.model ?? deps.model;
  let parity = deps.loopRequest !== undefined;
  let prompt = parity ? MEMORY_SWEEP_PROMPT_PARITY : MEMORY_SWEEP_PROMPT;
  let history: ProviderHistory;
  try {
    // The wire projection (projectWire's own composition), minus the engine's context updates
    // off the parity path: what the person said, never the model's re-told standing context.
    const messages = (await deps.journal.project()).messages;
    // SWEEP_PARITY_BY_PREFIX_V1: below the row's break-even the floored request is the cheaper one.
    if (parity && deps.parityMinRewriteTokens !== undefined && floorRewriteTokens(messages, deps.elision) <= deps.parityMinRewriteTokens) {
      parity = false;
      model = deps.model;
      prompt = MEMORY_SWEEP_PROMPT;
    }
    history = deps.transport.historyFromJournal(wireMessages(parity ? messages : messages.filter((e) => !isContextUpdate(e)), deps.elision));
    if (parity && messages.some(isContextUpdate)) prompt += SWEEP_CONTEXT_UPDATE_NOTE;
    if (parity && deps.loopRequest?.systemMemorySpan && readsCacheAtBoundaries(model)) prompt += SWEEP_SESSION_MEMORY_NOTE;
    deps.transport.pushUser(history, prompt);
  } catch {
    // Nothing was sent to a provider — no cost to report.
    return { facts: [], status: 'skipped', model };
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (deps.signal) {
    if (deps.signal.aborted) return { facts: [], status: 'skipped', model };
    deps.signal.addEventListener('abort', onAbort, { once: true });
  }
  // Set only when the bound itself cut the call: a cut that came first (the next message, the
  // run's abort) stays a cut even if the bound passes while the stream lets go.
  let timedOut = false;
  const timer = setTimeout(() => {
    if (ac.signal.aborted) return;
    timedOut = true;
    ac.abort();
  }, SWEEP_TIMEOUT_MS);
  let usage: NormalizedUsage | undefined;
  // Text and thinking that streamed: the output estimate when the call is cut before `done`.
  let streamedChars = 0;
  try {
    const stream = parity && deps.loopRequest
      ? deps.transport.callModel({
          ...deps.loopRequest,
          maxTokens: SWEEP_PARITY_MAX_TOKENS,
          history,
          signal: ac.signal,
          ...(deps.parityEffort && { turnEffort: deps.parityEffort }),
        })
      : deps.transport.callModel({
          model,
          maxTokens: SWEEP_MAX_TOKENS,
          reasoningEffort: SWEEP_REASONING_EFFORT,
          system: deps.system,
          tools: deps.providerTools,
          history,
          signal: ac.signal,
        });
    let reply = '';
    let stopReason: string | null = null;
    for await (const ev of deps.transport.readStream(stream)) {
      if (ev.kind === 'text') {
        reply += ev.text;
        streamedChars += ev.text.length;
      } else if (ev.kind === 'thinking') streamedChars += ev.text.length;
      else if (ev.kind === 'done') {
        usage = ev.usage;
        stopReason = ev.stopReason;
      }
    }
    const capped = stopReason !== null && OUTPUT_CAP_STOPS.has(stopReason);
    const facts = parseMemorySweep(completeLines(reply, capped));
    return {
      facts,
      status: sweepOutcome(reply, facts, stopReason),
      ...(usage !== undefined && { usage }),
      model,
    };
  } catch {
    // Flag off this is `usage` alone, as before. On the parity path a call cut mid-stream reports
    // what it most likely cost, and one its own bound cut says so. A refusal before anything
    // streamed (a 4xx, a dead lane) was never billed, so it estimates nothing.
    const billed = ac.signal.aborted || streamedChars > 0;
    const spent =
      usage ??
      (parity && billed ? estimateSweepSpend(deps.loopInput, { model, promptChars: prompt.length, streamedChars, timedOut }) : undefined);
    if (parity && timedOut) return { facts: [], status: 'timeout', model, ...(spent !== undefined && { usage: spent }) };
    return { facts: [], status: 'error', model, ...(spent !== undefined && { spent }) };
  } finally {
    clearTimeout(timer);
    if (deps.signal) deps.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Payload shape for the deposit raw event (field-for-field the P1 server contract).
 *
 * `source` used to be the LITERAL 'agent_inferred' for every swept fact. That constant is
 * what made the pool's authority ladder a dead letter on the procedures lane: the sweep is
 * the only agent-side producer of `procedure`, so every procedure in the system entered at
 * the bottom rung and the fold's "the user said it" rung was unreachable. Same shape as the
 * `task_firsthand` incident this vocabulary was written to cure, one field along.
 *
 * The floor is unchanged and deliberate: an UNSTATED source is 'agent_inferred', the lowest
 * rung, so a model that ignores the token loses a procedure rather than inventing one. A
 * claim of authority must be written, never defaulted.
 *
 * `quote` rides only when the model wrote one; the server decides what it proves.
 */
export function depositEventData(
  taskId: string,
  fact: SweptFact,
): { taskId: string; source: string; epistemic: string; observation: string; quote?: string } {
  return {
    taskId,
    source: fact.source ?? 'agent_inferred',
    epistemic: fact.epistemic,
    observation: fact.observation,
    ...(fact.quote !== undefined && { quote: fact.quote }),
  };
}
