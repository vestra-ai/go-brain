/**
 * W4-2 (shadow injection screen) — the pure turn-taint collector + family gate.
 *
 * Ring 2 of the injection rail: BEFORE a side-effecting tool executes in a turn
 * that carries third-party content, the runner asks the server's shadow screener
 * "is this action instructed by the content rather than by the user". This module
 * is the PURE half every caller shares: what counts as tainted in the current
 * turn, and which side-effect families are worth screening. The I/O half (journal
 * snapshot, server POST) lives with the provider that assembles the seam
 * (apps/sandbox); the dispatcher only awaits an injected callback, fail-open.
 *
 * AUTHORITY: a span exists only because of the journal `taint: 'external'` FIELD
 * (W4-1, minted at the dispatcher from the tool's own declaration) or the
 * offload-read PATH rule below. NEVER because bytes look fenced — a page can emit
 * marker-shaped text (exact or near-miss); it cannot forge a journal field. The
 * collector therefore does no marker matching to DECIDE TAINT at all:
 * `splitUntrustedFence` is used only to unwrap the canonical frame from an
 * already-authoritative span's excerpt, and a near-miss lookalike inside content
 * passes through verbatim.
 *
 * The one place bytes are read is `injectedUserUuids`, which decides where the
 * turn BEGINS. The asymmetry that makes that acceptable holds for the WINDOW, and
 * only for the window: a wrong taint call is unsafe in both directions (content
 * that forges a span, or hides one), whereas mistaking a real ask for an injection
 * moves the boundary EARLIER and over-screens. Only the reverse mistake closes the
 * window, and that is the failure this module guards against.
 *
 * It does NOT hold for the ASK, and the argument must not be borrowed for it. A
 * skipped user entry is not merely lost — the ask would fall back to the PREVIOUS
 * turn's, which can be MORE PERMISSIVE than the one it replaced. Turn 1 "email the
 * numbers to my contact list", turn 2 "just read the page, send nothing": skip
 * turn 2 and the screener weighs an attacker-driven send against a standing
 * permission to send, never seeing the restriction.
 *
 * So the ask does NOT skip: `collectTurnUserAsk` reads what is left of a
 * byte-excluded entry after the fence closes, and only falls back when there is
 * nothing there. An engine-minted recall entry is the fence and nothing else, so
 * it still falls back — correctly, since it carries no user words. A person who
 * pasted the fence and then spoke keeps their own words as the ask. THE RULE it
 * serves: an ask from a turn the user has already watched complete should never be
 * silently reused to authorise a later turn's actions.
 *
 * The rule is delivered for the FENCE and not yet for the other three markers.
 * `userTextAfterRecallFence` returns '' for anything not fence-led, so a person
 * whose message is byte-exactly the severance marker or the runaway directive, or
 * which leads with the schema-retry prefix, still has their ask substituted.
 * Accepted residue, and much narrower than the fence case: those two are matched
 * by EXACT equality, so a quote inside a longer message keeps its boundary (pinned
 * by test), and the prefix one is an engine sentence nobody types. Extending the
 * remainder-recovery to them would mean inventing a frame none of them has.
 *
 * That fallback can only cross a turn boundary in the paste case, and the reason
 * is structural: every ENGINE injector is minted mid-turn, after the turn's real
 * ask, so excluding one leaves the ask where it was. Only excluding a genuine
 * turn-START — which is exactly what a paste is — walks the search into an
 * earlier turn.
 */

import type { JournalEntry, JournalPayload } from '../contract/journal.js';
import {
  isEngineInjectedUserText,
  userTextAfterRecallFence,
} from '../contract/injected-user-text.js';
import { splitUntrustedFence } from '../tools/tool-types.js';
import type { ToolCall } from '../contract/harness.js';
import type { SideEffectFamily } from './side-effect-classifier.js';

/** Excerpt budget per span — enough for a cheap screener to judge intent, small
 *  enough that a many-span turn stays a bounded request. */
export const INJECTION_SCREEN_EXCERPT_CHARS = 400;

/** User-ask budget for the screen request (the "what the user actually asked" side). */
export const INJECTION_SCREEN_USER_ASK_CHARS = 600;

/**
 * The dispatcher's belt around one seam call: the provider owns its real request
 * timeout; this ceiling only guarantees a hung provider can never stall a turn.
 *
 * OUTERMOST rung of the budget chain, and each rung is strictly inside the next:
 * flash 4s < runner request 5s < this belt 6s. A user is waiting behind this
 * await for their send to happen, so the ceiling is set by what a person will
 * tolerate, not by what the model might want. The admin card renders screen
 * p50/p95, so the drill says whether a shorter budget costs verdicts.
 */
export const INJECTION_SCREEN_BELT_TIMEOUT_MS = 6_000;

/**
 * One tainted region of the current turn, as evidence for the screener.
 * `origin: 'declared'` = the result's journal entry carries `taint: 'external'`;
 * `origin: 'offload_read'` = a Read under `.kernel-offload/` (ring 1 stores
 * oversized tainted results fenced on disk, and a Read of that file produces a
 * tool_result with NO taint field by design — the path is the signal).
 */
export interface InjectionTaintSpan {
  toolUseId: string;
  toolName: string;
  origin: 'declared' | 'offload_read';
  /** Bounded, canonical-fence-stripped text of the tainted result. */
  excerpt: string;
  /** Full (pre-bound) character count of the stripped result text. */
  chars: number;
}

/**
 * The screen's answer vocabulary — ONE declaration, and all three halves of the
 * rail speak it: the server mints a verdict, the runner carries it across the
 * wire, the dispatcher reads it.
 *
 * It lives in the SDK because the SEAM's return type is built from it, and the
 * SDK is the only package all three can import: `@bash/shared` depends on the
 * SDK (never the reverse) so the wire schema imports this list, and the server's
 * own `InjectionScreenVerdict` is an alias of it. Three writers, one list; a
 * fifth verdict is a compile error at every reader rather than a string one of
 * them silently fails to recognise.
 *
 *   - `clean`       — the step serves the user's own request.
 *   - `instructed`  — the step follows directions found in third-party content.
 *   - `unavailable` — no verdict: the lane went dark, or the ask never landed.
 *   - `unparseable` — a reply arrived and could not be read as a verdict.
 */
export const INJECTION_SCREEN_VERDICTS = ['clean', 'instructed', 'unavailable', 'unparseable'] as const;

export type InjectionScreenVerdict = (typeof INJECTION_SCREEN_VERDICTS)[number];

/**
 * WHERE an intended screen died. Closed, because the load-bearing split is one
 * predicate: `model` reached the classifier (a latency or model problem) and
 * `runner` never reached it (a transport or configuration problem), and
 * collapsing those two into one "unavailable" bucket is the exact mistake the
 * availability diagnosis was written to prevent
 * (bash-notes/injection-screen-availability-2026-08-22.md §4). The server's
 * `ScreenFaultStage` and the `fault_stage` column are aliases of this list, so
 * the wire and the table cannot drift apart.
 */
export const INJECTION_SCREEN_FAULT_STAGES = ['model', 'service', 'route', 'runner'] as const;

export type InjectionScreenFaultStage = (typeof INJECTION_SCREEN_FAULT_STAGES)[number];

/**
 * Why a screen produced no usable verdict. `stage` is the closed list above;
 * `code` is the WRITER's own code carried verbatim — this module never matches
 * on it, because the distinctions it draws belong to whichever half wrote it
 * (the flash lane's `timeout`/`no_api_key`, the runner's
 * `RUNNER_SCREEN_FAULT_CODES`). Carried rather than collapsed so that making
 * the verdict legible does not flatten the fault accounting behind it.
 */
export interface InjectionScreenFaultRef {
  stage: InjectionScreenFaultStage;
  code: string;
}

/**
 * What the dispatcher LEARNS about one call from the screen.
 *
 * This type is the channel. Before it, `maybeScreen` returned `Promise<void>`:
 * the verdict was computed, transmitted, and thrown away, and the wait for it
 * was paid anyway. The reading closes that — the dispatcher now holds the answer
 * at the moment before the side effect. It does not act on it (see the seam's
 * doc); it is legible so the enforcement decision can be a branch rather than a
 * project.
 *
 * THREE STATES, AND THE THIRD IS NOT THE FIRST. `unparseable` folds into
 * `unavailable` deliberately — from here both mean "no usable verdict", and an
 * enforce predicate that has to enumerate two of those is a place to forget one
 * — but the CAUSE survives in `fault`, so nothing the availability rail counts
 * is lost. What must never fold is `unavailable` into `clean`: today they are
 * indistinguishable downstream only because nothing reads either, and a
 * representation that keeps them apart is the whole point of building this
 * before the decision rather than after it.
 *
 * `undefined` (no reading at all) is a FOURTH state and the one most easily
 * misread: it means no screen was ASKED FOR — the turn carried no third-party
 * content, the call was not side-effecting, or the round was already stopped.
 * That is a turn with nothing to judge, not a judgement of "fine". An
 * unanswered screen is `unavailable` with a fault, never `undefined`.
 *
 * `block` (S4) is the PROVIDER's instruction, set only in block mode and only on
 * `instructed`: the dispatcher refuses the call instead of running it
 * (policy/injection-guard.ts). Absent on every shadow reading, so shadow is unchanged.
 */
export type InjectionScreenReading =
  | { verdict: 'clean' }
  | { verdict: 'instructed'; reason: string; block?: true }
  | { verdict: 'unavailable'; fault: InjectionScreenFaultRef };

/**
 * What the belt reads when it releases a screen that never settled.
 *
 * NOT `undefined`. A screen was wanted here — the seam decides that internally
 * and a hung seam cannot tell us either way — so recording it as "no screen"
 * would restore the blind spot in the one place the channel was built to close.
 * Stage `runner` rather than a fifth `dispatcher` stage because the seam's own
 * beacon already records this fault under `runner` with this exact code
 * (`RUNNER_SCREEN_FAULT_CODES.belt_timeout` in @bash/shared, which the SDK
 * cannot import — the sandbox suite, which imports both, pins the two together).
 */
export const BELT_TIMEOUT_READING: InjectionScreenReading = {
  verdict: 'unavailable',
  fault: { stage: 'runner', code: 'belt_timeout' },
};

/**
 * The injected seam the dispatcher awaits before executing a tool call. The
 * provider (apps/sandbox) implements the whole policy — collect spans, classify
 * the call, POST the server — and must itself never throw; the dispatcher still
 * wraps the await in a belt (timeout + swallow) so a misbehaving provider is
 * fail-open by construction.
 *
 * SHADOW, AND THE WORD MOVED. The seam now RETURNS its verdict
 * (`InjectionScreenReading`) instead of `void`, so the dispatcher can read what
 * it already waited for. Shadow no longer means "there is no channel" — it means
 * the dispatcher does not branch on what comes back. Four things guaranteed the
 * action proceeded before; three still do (the belt swallows every throw, the
 * route answers 200 on fault, the runner is fail-open at every fault), and the
 * fourth — nothing to return the verdict ON — is what this closes. The
 * dispatcher's own guarantee is now a plain fact about its code: nothing between
 * the await and `execute()` reads the reading, and the only thing that reads it
 * afterwards stamps it on the result as an observation. So a `clean`, an
 * `instructed` and a missing verdict dispatch identically.
 */
export interface InjectionScreenSeam {
  /**
   * `signal` is the ROUND's abort signal. A screen outlives nothing: if the user
   * stopped the turn, the step it was asked about is not going to happen, so
   * completing the screen would bill a verdict and pop a banner about a step
   * that never ran. Providers must not start once it is aborted and must abort
   * in flight; the dispatcher races it too, so an inattentive provider still
   * cannot hold a cancelled turn open.
   *
   * RETURNS the verdict, or nothing. Nothing (`void`/`undefined`) means NO SCREEN
   * WAS WANTED — the turn carried no third-party content, the call was not
   * side-effecting, or the round was stopped. It does NOT mean the screen came
   * back fine: a screen that was wanted and could not be completed must answer
   * `{verdict:'unavailable', fault}` so the caller can tell a judgement from a
   * silence. Providers still never throw; a throw is read as nothing.
   */
  maybeScreen(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<InjectionScreenReading | void> | InjectionScreenReading | void;

  /**
   * The dispatcher stopped waiting: the belt timeout released a screen that never
   * settled, and the tool proceeded with no verdict. Optional, `void`, and
   * fire-and-forget — it exists ONLY so that failure is countable, never so the
   * screen can act. Called exactly once per belted call, and never when the seam
   * answered (it can account for itself) or when the round was stopped (a stopped
   * round is not a fault). Must not throw; the dispatcher belts it anyway.
   *
   * Without this the belt is the one fault with no witness on either side: the
   * seam never settles, so no row is written and the turn's silence reads as
   * coverage.
   */
  onBeltTimeout?(call: ToolCall): void;
}

/**
 * The families worth screening: actions on the outside world (sends, external
 * mutations, payments) plus irreversible deletes. Workspace-local writes and
 * reads are deliberately excluded — the injection risk being screened is the
 * agent ACTING OUTWARD on behalf of planted content.
 *
 * TOTAL on purpose, not a Set: a seventh family added to `SideEffectFamily` is a
 * compile error here rather than a family that silently screens nothing. Whoever
 * adds it has to state the answer, and `false` is a decision on the record.
 */
const SCREENED_FAMILIES: Record<SideEffectFamily, boolean> = {
  readonly: false,
  workspace_write: false,
  external_send: true,
  external_mutation: true,
  dangerous_delete: true,
  // Screened: a call we cannot read is exactly the one an injected instruction
  // would hide behind.
  unknown: true,
  protected_remote: true,
  payment: true,
};

export function isSideEffectingFamily(family: SideEffectFamily): boolean {
  return SCREENED_FAMILIES[family] === true;
}

/** The path fragment that marks ring 1's offloaded-result store. */
const OFFLOAD_PATH_FRAGMENT = '.kernel-offload/';

/** A user payload's text blocks, joined — what the model was shown as its text. */
function userTextOf(payload: Extract<JournalPayload, { type: 'user' }>): string {
  return payload.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * The uuids of user entries the ENGINE minted — text the loop injected, never a
 * person speaking. FOUR recovery routes, because a `user` payload reaches the
 * journal by four different doors and no single signal covers them all:
 *
 *   - BY PRINCIPAL — `principal.kind !== 'user'`. Two entries skip
 *     `appendUserEntry` altogether and are appended by the KERNEL:
 *     `Journal.appendForwardResumeBreadcrumb` and
 *     `Journal.appendWorldDeltaBreadcrumb` (HITL T5/T3). Both take a user-role
 *     SLOT — the only slot a provider accepts as the latest message — while
 *     stamping `{kind:'system'}` precisely so they are "never mistaken for a user
 *     message", which is their own docstrings' wording. This arm simply believes
 *     them. It is exact (every path a person's words take stamps `{kind:'user'}`)
 *     and, unlike the field, RETROACTIVE — no warm-resume gap.
 *
 *     ON AN ABSENT `principal`: the arm neither classifies nor fails open, because
 *     the case cannot reach here. `principal` is required on the type (so every
 *     in-process append is compile-checked), and BOTH loaders run
 *     `validateJournalEntry`, which rejects an entry whose `principal.kind` is not
 *     one of user|agent|system — the cold read QUARANTINES the line and the mirror
 *     hydrate DROPS it. There is no journal vintage that arrives without one; an
 *     old entry lacking it was already being refused before this arm existed. That
 *     is a guarantee rather than an assumption, so it is pinned by a test in this
 *     module's suite. A `?.` here would look prudent and would in fact pick a
 *     silent answer (absent ⇒ injected ⇒ a real ask suppressed) for a shape the
 *     loaders never hand us; if that gate is ever relaxed, the right response is to
 *     decide deliberately, not to have inherited a default from a defensive
 *     operator. Should one arrive anyway, the read throws and the dispatcher's belt
 *     swallows it — fail-open, the same posture this module already has for
 *     `e.payload`, and unchanged by this arm.
 *   - BY FIELD — `payload.injected`, stamped by `appendInjectedUserEntry` at the
 *     six `appendUserEntry` mints that are the loop rather than a person. Those
 *     all stamp `{kind:'user'}`, so principal cannot see them; and it is the only
 *     signal that reaches the two hook-authored sites.
 *   - BY UUID — the COMPACTION SUMMARY (`engine/compaction-run.ts`), which is
 *     `{kind:'user'}` and fieldless. The `compact_boundary` written alongside it
 *     names the summary entry, so that one needs no marker at the mint.
 *   - BY BYTES — the markers the engine authors itself; the pre-field fallback.
 *     The list, the per-marker matching discipline, and the judgement of which
 *     `appendUserEntry` call sites are the engine and which are the user live in
 *     `contract/injected-user-text.ts`.
 *
 * ONE turn-boundary predicate deliberately stays outside all of this:
 * `engine/replay/replay-session.ts`'s own `isTurnStart`, which reads two markers
 * by bytes and nothing else. Narrower ON PURPOSE — a keyless replay regenerates
 * exactly those two and wires none of the seams the rest come from — but it is the
 * one such predicate the registry does not own, so it is the place drift would
 * appear. Named here rather than left to be rediscovered.
 *
 * NOT a closed set, and saying so is the point. An earlier draft of this comment
 * said "nine call sites" and "THE one place a new injector gets added"; the two
 * kernel breadcrumbs above were already live and neither sentence was true. A
 * registry that claims completeness it does not have is worse than one that names
 * its boundary: the four doors are `appendUserEntry`, the kernel breadcrumbs,
 * `compaction-run`, and whatever the next one is. Check the principal, the field,
 * and the bytes — and when adding a fifth, extend this list rather than assuming
 * an existing arm already covers it.
 *
 * Bytes are not redundant now the field exists, because the field cannot be
 * retroactive: a warm task resumes across a deploy, and every entry it wrote
 * beforehand will never have one. Field ∪ bytes, not either/or. Reading bytes at
 * all is justified in the header's AUTHORITY note — including where that argument
 * stops.
 *
 * The rule is per-injector and never blanket. A mid-turn STEER
 * (`[User steered mid-task]: …`) is a person speaking and MUST stay a boundary;
 * the registry says so and the policy suite guards it.
 *
 * WHY THE FIELD HAD TO EXIST. Two sites append a hook's `continueContext`
 * (`engine/native-harness.ts`: the Stop re-feed and the PostToolBatch context).
 * That text is the hook's `additionalContext` trimmed and otherwise verbatim — no
 * prefix, no wrapper — so no byte recogniser can key on it, by construction. They
 * also matter more than the rest: the PostToolBatch hook is handed
 * `tool_response`, the raw tool-result bytes with tainted content included, so a
 * hook echoing any of it puts attacker-influenced text into a `user` entry and
 * thence into the trusted half of the screen prompt as the ask. No shipped hook
 * produces `additionalContext` today, and the only user-facing hook-authoring
 * surface (ability/skill `hooks:` frontmatter) is registration-gated to
 * `scope='system'` — but the gate's own reason string schedules its removal, and
 * its event allowlist already contains both PostToolBatch and Stop.
 *
 * Two things break if the screen cannot tell any of these from a real ask, and
 * both put non-user text where the screen assumes the user's:
 *
 *   1. THE ASK. Prose from a transcript, a memory store, or a hook, treated as
 *      the block the screen prompt calls the only authoritative statement of what
 *      the user wanted.
 *   2. THE WINDOW. Treated as a turn boundary, it hides everything before it — so
 *      a turn that reads a hostile page, then recalls / compacts / re-issues a
 *      severed stream, then sends, collects ZERO spans and is never screened at
 *      all. Recall and the severance marker both make that an ORDINARY shape
 *      rather than a long-turn edge case: recall consults at every round head,
 *      and a severed round is resealed and re-issued mid-turn, so either lands
 *      between the fetch and the send in a two-round research-then-act turn. And
 *      a turn that is never screened writes no row, so its silence reads as
 *      coverage rather than as a blind spot — the one failure here that is
 *      invisible downstream.
 */
function injectedUserUuids(entries: readonly JournalEntry[]): Set<string> {
  const uuids = new Set<string>();
  for (const e of entries) {
    if (e.payload.type === 'compact_boundary') uuids.add(e.payload.summaryUuid);
    else if (
      e.payload.type === 'user' &&
      (e.principal.kind !== 'user' ||
        e.payload.injected !== undefined ||
        isEngineInjectedUserText(userTextOf(e.payload)))
    ) {
      uuids.add(e.uuid);
    }
  }
  return uuids;
}

/**
 * A user entry that starts a turn: real user text, not an invisible control
 * turn, and not an engine injection (see `injectedUserUuids`).
 */
function isTurnStart(e: JournalEntry, injectedUuids: ReadonlySet<string>): boolean {
  return e.payload.type === 'user' && e.payload.control === undefined && !injectedUuids.has(e.uuid);
}

/** Index of the entry that started the current turn; -1 when there is none (scan whole). */
function turnStartIndex(entries: readonly JournalEntry[]): number {
  const injectedUuids = injectedUserUuids(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isTurnStart(entries[i], injectedUuids)) return i;
  }
  return -1;
}

/**
 * S4 — which turn the screen window belongs to: the uuid of the entry that started it
 * ('' before any). The SAME boundary `collectTurnTaintSpans` uses, so the guard's
 * per-turn refusal count can never disagree with the window that was screened.
 */
export function currentTurnKey(entries: readonly JournalEntry[]): string {
  const i = turnStartIndex(entries);
  return i < 0 ? '' : entries[i].uuid;
}

/** Flatten a tool_result's text blocks (the journal stores fenced bytes; take
 *  the fenced body so the screener judges content, not framing, and never a
 *  harness trailer after the close marker, S6). */
function resultText(e: JournalEntry): string {
  if (e.payload.type !== 'tool_result') return '';
  const text = e.payload.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return splitUntrustedFence(text).body;
}

/** Does this tool_use look like a Read of the offload store? Path-based by
 *  design (see interface doc); input shapes outside {file_path: string} never match. */
function isOffloadRead(name: string, input: unknown): boolean {
  if (name !== 'Read') return false;
  if (input === null || typeof input !== 'object') return false;
  const filePath = (input as Record<string, unknown>)['file_path'];
  return typeof filePath === 'string' && filePath.includes(OFFLOAD_PATH_FRAGMENT);
}

/**
 * Collect the tainted spans of the CURRENT turn: entries after the last real
 * user entry (an invisible control turn is not a boundary; a journal with no
 * user entry at all scans whole — safe over-screen). Subagent-scoped entries
 * count: a researcher child reading a hostile page taints the parent's turn.
 */
export function collectTurnTaintSpans(entries: readonly JournalEntry[]): InjectionTaintSpan[] {
  const start = turnStartIndex(entries) + 1;

  // toolUseId -> name for the turn's tool_use entries (pairs results to names),
  // plus the offload-read set (their results are tainted by the PATH rule).
  const toolNames = new Map<string, string>();
  const offloadReads = new Set<string>();
  for (let i = start; i < entries.length; i++) {
    const p = entries[i].payload;
    if (p.type !== 'tool_use') continue;
    toolNames.set(p.toolUseId, p.name);
    if (isOffloadRead(p.name, p.input)) offloadReads.add(p.toolUseId);
  }

  const spans: InjectionTaintSpan[] = [];
  for (let i = start; i < entries.length; i++) {
    const p = entries[i].payload;
    if (p.type !== 'tool_result') continue;
    const declared = p.taint === 'external';
    const offload = offloadReads.has(p.toolUseId);
    if (!declared && !offload) continue;
    const text = resultText(entries[i]);
    spans.push({
      toolUseId: p.toolUseId,
      toolName: toolNames.get(p.toolUseId) ?? 'unknown',
      origin: declared ? 'declared' : 'offload_read',
      excerpt: text.slice(0, INJECTION_SCREEN_EXCERPT_CHARS),
      chars: text.length,
    });
  }
  return spans;
}

/**
 * The latest real user ask (bounded) — the "what the user actually asked" the
 * screener weighs the action against. Undefined when the journal has none.
 *
 * NOT simply the last turn start. An injected entry is excluded from the WINDOW
 * unconditionally (fail-safe: over-screen), but for the ASK it is read first: a
 * fence-led entry that still has words after the frame closes is a PERSON who
 * pasted a recall block and then spoke, and skipping them substitutes an earlier,
 * already-completed turn's ask for the restriction they just stated. An
 * engine-minted entry has nothing after the frame, so it falls through to the
 * last real ask exactly as before — and one carrying `payload.injected` is not
 * read at all, because that field settles authorship outright.
 *
 * `maxChars` (S4): the guard reads the ask uncapped to tell a whole ask from one the
 * screener only saw the start of. Every other caller keeps the default bound.
 */
export function collectTurnUserAsk(entries: readonly JournalEntry[], maxChars = INJECTION_SCREEN_USER_ASK_CHARS): string | undefined {
  const injectedUuids = injectedUserUuids(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.payload.type !== 'user' || e.payload.control !== undefined) continue;
    const text = userTextOf(e.payload);
    if (injectedUuids.has(e.uuid)) {
      // A FIELD- or PRINCIPAL-marked entry is authoritatively not a person: there
      // is nothing of theirs in it to recover, whatever it happens to say. Only the
      // byte path can be wrong about whose entry this is, so only the byte path looks.
      if (e.payload.injected !== undefined || e.principal.kind !== 'user') continue;
      const own = userTextAfterRecallFence(text);
      if (!own) continue; // nothing of the user's in it — keep looking back
      return own.slice(0, maxChars);
    }
    return text.slice(0, maxChars);
  }
  return undefined;
}
