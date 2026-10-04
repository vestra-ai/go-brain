import type Anthropic from '@anthropic-ai/sdk';
import type { RawClaim, ClaimSource } from './claims.js';
import type { Extractor, CaptureJudge } from './curator.js';
import { serializeEpisode } from './episode.js';
import { extractJsonValue } from './llm-json.js';

/** Production capture judge prompt. MOVED VERBATIM from nami-curator.service.ts:131-148.
 *  This file is the single source of truth; the server and the eval both import it. */
export const CAPTURE_EXTRACTION_SYSTEM_PROMPT = `You decide what, if anything, from a finished task is worth remembering long-term about THIS user's world. THE RULE (the only rule): capture a fact only if it is a DURABLE fact about the user's own world that would plausibly help a FUTURE, unrelated task — who/what is in their world, how they operate, what they've decided, what they're tracking.

DO NOT capture: general knowledge ("capital of France"); topical chatter that merely flowed through this task ("we discussed prompt caching"); one-off task-local details; the assistant's own actions/outputs. Most tasks contain NOTHING worth remembering — an empty list is the correct, expected outcome for the majority of tasks. Do not invent facts to seem useful.

Corrections are the highest-value capture: when the user corrects a fact, preference, or prior decision, record it and supersedes what it replaces.

You are given the facts already known (the dedup list). Do NOT re-emit a known fact; emit only NEW facts or UPDATES/CORRECTIONS to known ones.

Output JSON: [{ subject, predicate, object, entity_type, confidence, supersedes? }]. entity_type is a SHORT free-form label you choose ("person", "service", "policy", "device", "manuscript" — whatever fits; there is NO fixed list). Empty array if nothing durable.

These examples illustrate THE RULE across very different people and very different SHAPES of fact. They are illustrative, NOT an exhaustive list of valid subjects, domains, or shapes — capture durable facts of ANY shape, including ones unlike these:
- [relationship] clinician's recurring patient -> {subject:"patient Dana Or", predicate:"has condition", object:"type-1 diabetes", entity_type:"patient"}
- [entity-attribute] a service's quirk -> {subject:"billing-service", predicate:"requires deploy flag", object:"--prod", entity_type:"service"}
- [process/rule] how the user operates -> {subject:"the user", predicate:"sends investor updates", object:"first Monday monthly", entity_type:"routine"}
- [environmental] a hard constraint -> {subject:"the user's build", predicate:"fails on", object:"ARM; use x86 CI", entity_type:"environment"}
- [temporal correction] {subject:"project Atlas deadline", predicate:"is", object:"March 15", entity_type:"project", supersedes:"<prior id>"}
- [nothing] "what's the capital of France?" -> []
- [nothing] a task that refactored code with no durable fact stated -> []`;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** JSON -> RawClaim[]. Byte-behavior-identical to production's JudgeClaimExtractor
 *  parse loop (nami-curator.service.ts:199-225). Tolerates prose around the JSON
 *  (extractJsonValue); returns [] when the value is undefined or not an array.
 *  Per item: trims subject/predicate/object and skips the item if any is empty after
 *  trim; clamps confidence to [0,1]; reads a valid decay class; ignores all other
 *  fields (entity_type, supersedes). */
export function parseRawClaims(text: string, source: ClaimSource): RawClaim[] {
  const parsed = extractJsonValue(text);
  if (parsed === undefined || !Array.isArray(parsed)) return [];
  const out: RawClaim[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const subject = typeof rec.subject === 'string' ? rec.subject.trim() : '';
    const predicate = typeof rec.predicate === 'string' ? rec.predicate.trim() : '';
    const object = typeof rec.object === 'string' ? rec.object.trim() : '';
    if (!subject || !predicate || !object) continue;

    const claim: RawClaim = { subject, predicate, object, source };
    if (typeof rec.confidence === 'number') {
      claim.confidence = Math.max(0, Math.min(1, rec.confidence));
    }
    if (rec.decay === 'immutable' || rec.decay === 'semi-stable' || rec.decay === 'transient') {
      claim.decay = rec.decay;
    }
    out.push(claim);
  }
  return out;
}

/** Build a real production-fidelity Extractor. `meter` is optional: production
 *  passes it (to bill), the eval omits it (no billing). `model`/`maxTokens`/
 *  `timeoutMs` are optional overrides: production resolves them from its judge
 *  lane (an open Fireworks model by default — no Haiku in any live lane); the
 *  defaults below only preserve the offline eval's original Anthropic behavior. */
export function makeCaptureExtractor(
  client: Anthropic,
  opts: {
    taskId: string;
    dedupList?: string;
    meter?: (usage: Anthropic.Messages.Usage) => void;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
  },
): Extractor {
  return {
    async extract({ transcript, now }) {
      const known = (opts.dedupList ?? '').trim() || '(none)';
      const user = `FINISHED TASK TRANSCRIPT:\n${transcript}\n\nFACTS ALREADY KNOWN (the dedup list — do NOT re-emit these; emit only NEW facts or corrections):\n${known}`;
      const source: ClaimSource = { kind: 'task', ref: opts.taskId, date: now };
      try {
        const res = await Promise.race([
          client.messages.create({
            model: opts.model ?? HAIKU_MODEL,
            max_tokens: opts.maxTokens ?? 600,
            system: CAPTURE_EXTRACTION_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: user }],
          }),
          new Promise<null>((_, rej) =>
            setTimeout(() => rej(new Error('nami curator extraction timeout')), opts.timeoutMs ?? 8000),
          ),
        ]);
        if (!res) return [];
        if (res.usage && opts.meter) opts.meter(res.usage);
        const text = res.content[0];
        if (!text || text.type !== 'text') return [];
        return parseRawClaims(text.text, source);
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// nami brain v2 §3c — counterfactual predict-then-residual capture judge.
//
// ADDED ALONGSIDE the v1 extractor above (NOT a replacement). The NAMI_CAPTURE_V2
// flag (Task 8) selects between them; flag-OFF keeps the byte-identical v1 path,
// so a v2 regression rolls back cleanly. v1 is removed in a post-rollout cleanup.
// ---------------------------------------------------------------------------

/** Sentinel the skills track emits for "no reusable procedure here". When it LEAKS
 *  into the capture judge's output (the live bug — Haiku echoed it with surrounding
 *  prose and the code saved an "Untitled skill"), the WHOLE output is rejected. It is
 *  matched as a SUBSTRING anywhere in the text, never with `===`. */
export const NOT_A_SKILL = 'NOT_A_SKILL';

/** An object longer than this that appears verbatim in the journal is transcript
 *  leakage (the model parroting its input), not a durable fact — dropped. */
const LEAK_MIN_LEN = 40;

/** Subjects that name the agent itself, not the user's world — self-reference, dropped. */
const SELF_SUBJECTS = new Set(['assistant', 'agent', 'ai', 'claude']);

/** Predicates describing a reusable multi-step PROCEDURE (the skills track, not a fact
 *  about the user's world) — dropped here. */
const PROCEDURAL_PREDICATE = /^(steps to|how to|procedure for)/i;

/** The v2 predict-then-residual capture judge prompt. Single source of truth; the
 *  eval and the dream both import it verbatim. Authored from the Slice 1 spec. */
export const CAPTURE_JUDGE_V2_SYSTEM_PROMPT = `You read a finished agent episode and decide what, if anything, is worth remembering long-term about THIS user's world.

Work in two passes, and reason about the FULL journal — user turns, assistant turns, tool calls, tool results, and HITL interactions (corrections live in tool feedback and in what the user denied or redirected, not only in prose).

PASS 1 - PREDICT. Before you read what actually happened at each pivot, predict what a capable model with NO memory of this user would have expected the user, the tool, or the world to say.

PASS 2 - RESIDUAL. Emit ONLY where reality differed from your prediction - the prediction error:
- corrections the user made to a fact, preference, or prior decision  (highest value; label claimType "correction" ONLY on the claim carrying the corrected value, never on companion facts)
- non-obvious facts about THIS user's world (who/what is in it, how they operate, what they decided, what they track)
- things the model got wrong and the user or a tool then fixed
- outcomes that violated a stated expectation

For each surviving item, self-score noveltyToFrontier 0..1: "would a fresh model WITHOUT this memory regenerate this on its own?" 1 = impossible to predict (e.g. who the user's cofounder is); 0 = a frontier model already knows it.

OPEN LOOPS are first-class captures. When the episode states one, emit it with the matching claimType:
- claimType "commitment": the user promised something to someone ("board deck to Sasha by Friday"). Set due_at (ISO 8601) when a deadline is stated or clearly implied by the episode.
- claimType "expectation": something in the user's world is expected to happen ("Orion renewal around Aug 15, net-60"). Set due_at when dated.
- claimType "rhythm": a recurring pattern in how the user operates ("board sync every Monday 09:00", "invoices at month end"). Set recurrence to a short human-readable rule ("every Monday 09:00").
Do not invent dates: omit due_at entirely when no date is stated or implied. A completed or past event is NOT an open loop - do not emit it as one. Emit the open loop itself, not derived side-facts about its parties ("Ravenna is an investor") unless the episode states them outright.

SELF-CONTAINMENT GATE (rewrite-or-discard): every claim must be understandable months from now WITHOUT this episode. Rewrite pronouns and episode-relative references ("she", "this project", "tomorrow") into the absolute, named forms the episode gives you ("Sasha", "project Atlas"). NEVER fabricate what the episode does not state: if it says "March 15" with no year, write "March 15" - do not invent a year, date, or name. Keep the user as the subject of their own preferences, corrections, and decisions ("the user prefers ...") - do not rewrite them into impersonal policy statements. If a claim cannot be rewritten to stand alone, DISCARD it.

ENTITY-SURFACING: when the episode explicitly introduces WHO an entity is in the user's world ("Sasha is my cofounder"), emit the identification in BOTH directions - {subject:"Sasha", predicate:"is", object:"the user's cofounder"} AND {subject:"the user's cofounder", predicate:"is", object:"Sasha"} - so a future question phrased either way can find it. This applies ONLY to identity/role introductions, never to ordinary attribute facts; and emit ONE claim per stated fact otherwise - do not decompose a single stated fact into several claims.

DROP, before output:
- anything a frontier model would already produce without this note (general knowledge, the capital of France)
- topical chatter that merely flowed through the task ("we discussed prompt caching")
- the assistant's own actions and outputs
- any item already in the dedup list (re-emit ONLY as a correction/update, never as a new fact)
- any object that is a verbatim substring of the journal longer than a short phrase (transcript leakage)
- anything that is a multi-step reusable PROCEDURE rather than a fact about the user's world - those are skills, not memories; if the ENTIRE episode is only a procedure, return [] (do not invent a fact)

Most episodes contain NOTHING worth remembering. An empty array is the correct, expected outcome for the majority.

Output JSON only: [{ subject, predicate, object, claimType, noveltyToFrontier, confidence, due_at?, recurrence? }]
- claimType is a SHORT free-form label you choose (person, service, policy, routine, project, correction, preference, commitment, expectation, rhythm, ...); there is NO fixed list.
- due_at (ISO 8601) and recurrence appear ONLY on open-loop claims that state them.
- If nothing survives, output exactly: []`;

/** A judged candidate claim: a RawClaim plus the judge's self-scored novelty. The §3d
 *  ledger will thread `noveltyToFrontier` onto the persisted Claim as a TIE-BREAKER
 *  signal (never a gate); until then it rides on the emitted object. Extends RawClaim
 *  so it stays assignable everywhere a RawClaim is expected, and RawClaim/Claim stay
 *  untouched (this slice owns no claims.ts edits). */
export interface CandidateClaim extends RawClaim {
  noveltyToFrontier?: number;
}

/**
 * Normalize a judge-emitted `due_at` string to a stored ISO-Z instant, or `undefined`
 * to DROP it (the claim is still captured, just without a deadline).
 *
 * F3 (adjudicated review blocker): V8's `Date.parse("September 20")` fabricates YEAR
 * 2001, which was being stored as a real deadline. A no-year month+day is instead
 * resolved FORWARD from the capture timestamp (`captureIso`, forward-INCLUSIVE: a date
 * that equals the capture calendar day is "today", not next year). Rules:
 *  - explicit year in the string (a 4-digit token, or a 3-component numeric date like
 *    "9/20/25" whose 2-digit year V8 honors)  -> trust the parse as-is (no forward-shift);
 *  - month+day, no year                        -> next occurrence at/after the capture day;
 *  - unparseable, or capture time unusable     -> `undefined` (drop; never fabricate 2001).
 *
 * We do NOT build an NLP date parser — we only re-year the shapes V8 already parses
 * (the year-fabrication class). Month/day are recovered from the fabricated parse with
 * LOCAL getters (V8 parses a bare "September 20" as local midnight), and the resolved
 * date is emitted at UTC midnight so the stored value is timezone-stable. The
 * forward-inclusive "today" comparison reads the capture instant's UTC calendar day —
 * a deliberate strict-UTC choice (no user TZ is available at the parser), pinned by test.
 */

/** 3-component numeric date ("9/20/25", "3-1-28", "9.20.2025"): V8 honors the final
 *  component as a year (2-digit included), so the string is EXPLICIT — it must not
 *  take the no-year path, which would discard that year. Pure "9/20" doesn't match. */
const NUMERIC_YMD_3 = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/;

function resolveDueAt(raw: string, captureIso: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return undefined; // unparseable -> drop

  // Explicit year present (4-digit token, or a 3-component numeric date whose 2-digit
  // year V8 honors): trust the string exactly as before (no forward-shift).
  if (/\d{4}/.test(s) || NUMERIC_YMD_3.test(s)) return new Date(parsed).toISOString();

  // No year -> V8 fabricated one (2001). Resolve forward from the capture day.
  const cap = new Date(captureIso);
  if (Number.isNaN(cap.getTime())) return undefined; // can't resolve forward -> drop
  const fabricated = new Date(parsed);
  const month = fabricated.getMonth(); // local getters: recover the parsed calendar day
  const day = fabricated.getDate();
  const captureDayUTC = Date.UTC(cap.getUTCFullYear(), cap.getUTCMonth(), cap.getUTCDate());
  let year = cap.getUTCFullYear();
  // A month/day recurs every year, so at most one bump lands it at/after the capture day.
  if (Date.UTC(year, month, day) < captureDayUTC) year += 1;
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/** Stable, dependency-free djb2 fingerprint (matches the curator's id hash) of the
 *  evidence span, so the same triple always hashes to the same short token. */
function spanHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * JSON -> CandidateClaim[] for the v2 judge — the hardened parser. Beyond v1's
 * trim/empty-skip/confidence-clamp/decay it:
 *  - rejects the ENTIRE output if the NOT_A_SKILL sentinel leaked anywhere (substring);
 *  - drops self-referential subjects (the agent, not the user's world);
 *  - drops PROCEDUREs (claimType 'procedure' or a procedural predicate) — skills track;
 *  - drops transcript leakage (object is a > LEAK_MIN_LEN verbatim substring of the journal);
 *  - carries claimType, noveltyToFrontier (clamped 0..1), sourceTaskId, evidenceSpanHash.
 * `noveltyToFrontier` is a §3d tie-breaker only — a low self-score is NEVER a drop reason
 * here. Tolerates prose around the JSON and NEVER throws (degrades to []).
 */
export function parseCandidateClaims(text: string, source: ClaimSource, serializedEpisode: string): CandidateClaim[] {
  if (text.includes(NOT_A_SKILL)) return [];
  const parsed = extractJsonValue(text);
  if (parsed === undefined || !Array.isArray(parsed)) return [];

  const out: CandidateClaim[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const subject = typeof rec.subject === 'string' ? rec.subject.trim() : '';
    const predicate = typeof rec.predicate === 'string' ? rec.predicate.trim() : '';
    const object = typeof rec.object === 'string' ? rec.object.trim() : '';
    if (!subject || !predicate || !object) continue;

    // self-reference: the agent's own actions are not facts about the user's world.
    if (SELF_SUBJECTS.has(subject.toLowerCase())) continue;

    // procedures belong to the skills track, not the fact ledger.
    const claimType = typeof rec.claimType === 'string' ? rec.claimType.trim() : '';
    if (claimType === 'procedure' || PROCEDURAL_PREDICATE.test(predicate)) continue;

    // transcript leakage: a long object copied verbatim out of the journal is parroting.
    if (object.length > LEAK_MIN_LEN && serializedEpisode.includes(object)) continue;

    const claim: CandidateClaim = {
      subject,
      predicate,
      object,
      source,
      sourceTaskId: source.ref,
      evidenceSpanHash: spanHash(`${subject}|${predicate}|${object}`),
    };
    if (claimType) claim.claimType = claimType;
    if (typeof rec.confidence === 'number') claim.confidence = Math.max(0, Math.min(1, rec.confidence));
    if (typeof rec.noveltyToFrontier === 'number') {
      claim.noveltyToFrontier = Math.max(0, Math.min(1, rec.noveltyToFrontier));
    }
    if (rec.decay === 'immutable' || rec.decay === 'semi-stable' || rec.decay === 'transient') {
      claim.decay = rec.decay;
    }
    // P2-M3 open-loop passthrough: due_at normalizes to ISO-Z (P1's timestamptz
    // column). F3: a no-year date resolves FORWARD from the capture timestamp
    // (source.date) rather than storing V8's fabricated year-2001; an unparseable
    // date is DROPPED, never stored as garbage.
    const dueAtRaw = typeof rec.due_at === 'string' ? rec.due_at : '';
    const dueAt = resolveDueAt(dueAtRaw, source.date);
    if (dueAt) claim.dueAt = dueAt;
    const recurrence = typeof rec.recurrence === 'string' ? rec.recurrence.trim() : '';
    if (recurrence) claim.recurrence = recurrence;
    out.push(claim);
  }
  return out;
}

/**
 * Build a v2 CaptureJudge. Mirrors makeCaptureExtractor (Promise.race 8s timeout,
 * optional meter, degrade-safe catch -> []) but consumes the full-fidelity
 * CaptureEpisode (serialized as a causal journal) and parses via parseCandidateClaims.
 * The kernel stays pure: `meter` and `onError` are optional callbacks supplied by the
 * caller (server bills via `meter`; surfaces a persistent auth/billing failure via
 * `onError` — without it a 400/401 is indistinguishable from "episode had no facts").
 * `taskId` is optional and falls back to the episode's own taskId.
 */
export function makeCaptureJudge(
  client: Anthropic,
  opts: {
    taskId?: string;
    dedupList?: string;
    meter?: (usage: Anthropic.Messages.Usage) => void;
    onError?: (err: unknown) => void;
    // Model/budget/timeout are injectable so the server can route the judge to a
    // non-Anthropic lane (e.g. GLM 5.2 via Fireworks) through a compatible client.
    // Defaults preserve the Haiku behavior EXACTLY (byte-identical when unset).
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
  },
): CaptureJudge {
  const model = opts.model ?? HAIKU_MODEL;
  const maxTokens = opts.maxTokens ?? 600;
  const timeoutMs = opts.timeoutMs ?? 8000;
  return {
    async judge({ episode, dedupList, now }) {
      const serialized = serializeEpisode(episode);
      const known = (dedupList ?? opts.dedupList ?? '').trim() || '(none)';
      const user = `FINISHED EPISODE JOURNAL:\n${serialized}\n\nFACTS ALREADY KNOWN (the dedup list — do NOT re-emit these; emit only NEW facts or corrections):\n${known}`;
      const source: ClaimSource = { kind: 'task', ref: opts.taskId ?? episode.taskId, date: now };
      try {
        const res = await Promise.race([
          client.messages.create({
            model,
            max_tokens: maxTokens,
            system: CAPTURE_JUDGE_V2_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: user }],
          }),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('nami curator v2 judge timeout')), timeoutMs)),
        ]);
        if (!res) return [];
        if (res.usage && opts.meter) opts.meter(res.usage);
        const text = res.content[0];
        if (!text || text.type !== 'text') return [];
        return parseCandidateClaims(text.text, source, serialized);
      } catch (err) {
        // Degrade-safe: the brain never breaks on a judge failure. But hand the error
        // to the caller (if it cares) so a PERSISTENT auth/billing 400 is observable
        // instead of silently emitting [] for every episode.
        opts.onError?.(err);
        return [];
      }
    },
  };
}
