/**
 * subagent-walls.ts — the ONE source for the orchestration walls (spec
 * docs/superpowers/specs/2026-09-02-orchestration-design.md, §2 D1–D8, §4.3–§4.4).
 *
 * Every number, refusal text, label, preamble and footer the runtime enforces lives
 * here so the Agent tool, the round tool-batch, the subagent runner, the tool
 * description and the tests never drift from each other. Prose steers; these walls
 * enforce. All strings are user-facing model text: no em dashes, never "Claude".
 */

import { EXPLORER_TYPE, GENERAL_PURPOSE_TYPE, RESEARCHER_TYPE } from '../composition/subagent-type-registry.js';
import { REEXECUTE_BOUND_TOOLS, WEAVE_REEXECUTE_TOOL } from '../kernel/index.js';
import { WEAVE_DISPATCH_GLOBALS } from '../tools/code-exec/weave-globals.js';

/** Main turn = depth 0. A helper at this depth is a leaf: no Agent tool, a call is refused. */
export const SUBAGENT_DEPTH_CAP = 4;
/** Turns per child under the walls, for a type with no entry below. At the cap the child
 *  is told to wrap up. 100 was sized for an ORCHESTRATOR: three rounds of fan-out. */
export const SUBAGENT_MAX_TURNS_WALLS = 100;

/**
 * The per-TYPE turn cap. One number for every type let a researcher run 100 rounds of
 * search before anything made it stop (the founder's staging run: 99 searches, no report).
 * A searching type is bounded by what it can usefully read, not by an orchestrator's
 * fan-out budget, so it gets a tighter cap; a general-purpose child keeps 100 because it
 * may itself be orchestrating. An unregistered type (an installed ability's agent, an
 * on-the-fly agent) is unknown work, so it keeps the wider default rather than a guess.
 */
const MAX_TURNS_BY_TYPE: Readonly<Record<string, number>> = {
  [RESEARCHER_TYPE]: 40,
  [EXPLORER_TYPE]: 40,
  [GENERAL_PURPOSE_TYPE]: SUBAGENT_MAX_TURNS_WALLS,
};

export function subagentMaxTurns(subagentType: string | undefined): number {
  return (subagentType !== undefined ? MAX_TURNS_BY_TYPE[subagentType] : undefined) ?? SUBAGENT_MAX_TURNS_WALLS;
}

/**
 * Where the wrap-up directive lands: 75% of the type's own cap (30 of a researcher's 40).
 * The remaining quarter is not spare capacity, it is ROOM TO WRITE. Asking for the report
 * in the last round left a child that had spent every turn on tools one shot at composing
 * one; asking at 75% leaves it turns to finish the report, and the cap stays as the hard
 * backstop for a child that ignores the directive. Never 0, or a tiny cap would nudge a
 * child that has not done anything yet.
 */
export const WRAP_UP_FRACTION = 0.75;
export function wrapUpAtTurn(maxTurns: number): number {
  return Math.max(1, Math.floor(maxTurns * WRAP_UP_FRACTION));
}
/** Running children per task tree, every depth counted. Over it: refusal, never a queue. */
export const SUBAGENT_TREE_CONCURRENCY = 20;
/** Agent calls dispatched at once from one assistant message (the `:turnbatch` pool). */
export const SUBAGENT_MESSAGE_CONCURRENCY = 10;

/** Nested drain grace: a child must settle before its parent's grace ends, at every depth. */
export const NESTED_DRAIN_FRACTION = 0.6;
export const NESTED_DRAIN_MIN_MS = 500;
export function nestedDrainTimeoutMs(parentMs: number): number {
  return Math.max(NESTED_DRAIN_MIN_MS, Math.floor(parentMs * NESTED_DRAIN_FRACTION));
}

export type SubagentStopReason =
  | 'completed'
  | 'turn_cap'
  | 'stopped_by_user'
  | 'stopped_by_parent'
  // The account ran out of credits and the runner stopped every live task. Held
  // APART from 'stopped_by_user' because they are not the same event: labelling a
  // credit kill as the person's Stop tells the lead a helper was called off when
  // nobody touched it (founder 2026-09-05, "from my stop -> out of credits").
  | 'credits_exhausted'
  | 'refused'
  | 'failed';

export type SubagentRefusalKind = 'depth' | 'leaf' | 'lone_child' | 'concurrency' | 'budget' | 'serial_root';

/**
 * Follow-up C — the root wall's two ALLOW readings, counted apart from the refusals.
 *
 * They are deliberately NOT members of {@link SubagentRefusalKind}: the server sums the
 * whole refusal record into one `spawn_refused` column (agent-trace.service.ts), so a
 * spawn the wall let THROUGH would read there as a spawn it stopped.
 */
export type SubagentAllowKind = 'serial_root_dependent' | 'serial_root_allowed';

/**
 * Follow-up C item 1 — the tools whose call is SPAWN-SHAPED for the ROOT wall: one of them
 * alone in a round launches helpers and does nothing else, which is the plan being
 * drip-fed one helper at a time (round-tool-batch).
 *
 * Weave belongs because a depth-0 Weave call launches helpers exactly as an Agent call
 * does. On the serial-fg rerun (staging 2026-09-04, lead a3376767) the root wall refused
 * three Agent hand-offs and the model finished the SAME one-at-a-time plan through Weave
 * instead: a wall on one door is a signpost to the other.
 *
 * DERIVED from the kernel's two sets rather than written out a third time, so a tool added
 * to either can never go missing here. Deliberately NOT a widening of
 * REEXECUTE_BOUND_TOOLS: that set also drives interaction re-execution and the
 * concurrent-batch trigger, and Weave must stay out of both (pinned invariant).
 */
export const SPAWN_SHAPED_TOOLS: ReadonlySet<string> = new Set([...REEXECUTE_BOUND_TOOLS, WEAVE_REEXECUTE_TOOL]);

/**
 * And what the second of those two doors is read WITH: the interpreter prelude's own
 * dispatch vocabulary, imported from the module that defines it rather than retyped here
 * (a drift pin in weave-stub-generator.test.ts holds the constant and the GENERATED prelude
 * together in both directions). It is imported from a zero-import leaf, not from the
 * generator, so the walls never pull the UDS bridge and node:net into their graph.
 * `node` starts one helper, `fanOut` starts a whole layer; {@link weaveOpensParallel} needs
 * both to say which came first.
 */
const WEAVE_DISPATCH = WEAVE_DISPATCH_GLOBALS;

export function depthRefusal(depth: number, cap: number): string {
  return (
    `Subagent nesting limit reached (depth ${depth} of ${cap}). ` +
    'Complete this task directly using your tools instead of spawning another agent.'
  );
}

/** D2 — a helper whose TYPE does not delegate. The schema wall already hides the tool;
 *  this is what a call that arrives anyway (a stale schema, a replayed call) gets back. */
export const LEAF_REFUSAL =
  'This helper type does not delegate. Complete this task directly using your tools ' +
  'instead of spawning another agent.';

/**
 * Follow-up D item 2 — how every root-wall refusal ends.
 *
 * A wall that only argues about HOW to launch helpers leaves the model free to believe one
 * launched. On the serial-fg rerun (staging 2026-09-04) the model read the root refusal for
 * a spawn that never started and closed its turn with "Delhi lookup is running": the wall
 * stopped the work and the turn reported it as running. So the refusal says the one fact the
 * model cannot infer from advice, in as many words, and last, where a skimmed result ends.
 */
export const NO_HELPER_STARTED = 'No helper was started.';

export const LONE_CHILD_REFUSAL =
  'You are the dedicated agent for this piece. Do it yourself, or split it into two or more ' +
  'independent parts and launch them together in one message.';

/**
 * Follow-up item 1 — the ROOT wall (spec §0: parallel over depth). The main turn spawned
 * ONE helper, waited for it, then spawned ONE again: the founder's staging run, where the
 * lone researcher then ran 99 searches while everything else waited on it. The FIRST lone
 * spawn is legitimate (a single piece of work is a single helper); the second in a row,
 * with nothing else done between them, is a plan being drip-fed one helper at a time.
 *
 * Deliberately NOT the lone-child text: a delegated helper is told to do the work itself,
 * because it IS the dedicated agent for its piece. The root is not, and has helpers to
 * spend, so it is told to issue the rest together.
 */
export const SERIAL_ROOT_REFUSAL =
  'You launched these helpers one after another. Issue every remaining helper together in ' +
  'ONE message so they run in parallel; a lone helper is only for a single piece of work. ' +
  "If a helper needs an earlier helper's result, say so with depends_on and it may run alone. " +
  NO_HELPER_STARTED;

/**
 * Follow-up C item 3 — how many times ONE turn says the sentence above. Twice is a wall;
 * a third identical refusal to a model that has already declined the advice twice is a
 * loop that spends the turn instead of the plan, and the 2026-09-04 rerun is what a model
 * does when the door it is at stays shut: it finds another one. So the third lone spawn
 * runs, with the reading below prepended so the record still says what happened.
 */
export const SERIAL_ROOT_REFUSAL_CAP = 2;

/**
 * R129 — how many DECLARED hand-offs one turn may make. `depends_on` is an exit, not a key:
 * it costs the model one non-blank string, so left unbounded it is the cheapest bypass this
 * wall now has. Three in a turn is a chain the model may well need; a fourth is a pipeline it
 * should have written as one plan. Past the budget a declaration simply stops excusing
 * anything and the spawn is judged as the bare lone spawn it now is, which keeps this rule
 * and the refusal cap from contradicting each other.
 */
export const SERIAL_ROOT_DEPENDENT_CAP = 3;

export const SERIAL_ROOT_ALLOWED_NOTE = 'Allowed after two refusals; the plan is still being drip-fed.';

/**
 * Follow-up C item 2 — the escape hatch. Sequential work is sometimes real: the second
 * helper needs the first one's answer, and refusing it teaches the model to route around
 * the wall rather than to parallelise. A lone spawn that NAMES what it is waiting for runs.
 *
 * It must be SAID: a blank string is what a model produces when it is pattern-matching the
 * field rather than naming a dependency, and it excuses nothing. Read off the call's own
 * input, so the same field on any other spawn-shaped tool works the moment that tool
 * advertises it.
 */
export function declaresDependency(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const on = (input as { depends_on?: unknown }).depends_on;
  return typeof on === 'string' && on.trim().length > 0;
}

/**
 * Follow-up B item 1 — the tools that are PLAN BOOKKEEPING, not work.
 *
 * The root wall reads a round's SHAPE, and every non-Agent call cleared the streak. So on
 * staging task 406e56a9 the main turn spawned three lone researchers in a row (journal seqs
 * 26, 47, 68) with only TodoUpdate calls between them, and serial_root stayed 0: writing the
 * plan down defeated the wall that exists to stop the plan being drip-fed. Ticking a todo
 * between two hand-offs is exactly what a model does WHILE it drip-feeds.
 *
 * A call listed here neither arms the streak nor clears it: the round is judged on what is
 * left after they are set aside. It stays a tight list of the tools that change nothing
 * outside the model's own plan, copied from the sandbox catalog (harness/tools/task-tools.ts
 * TODO_TOOL_NAMES) minus the retired Task* aliases, which are no longer offered. Everything
 * else in that catalog does real work: announce_preview posts to the server, ExitPlanMode
 * halts the turn on a person, present_output and TaskOutput deliver.
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'TodoCreate', 'TodoUpdate', 'TodoGet', 'TodoList',
]);

/**
 * Is this Agent call an IN-TURN spawn, the kind the turn blocks on? Only those can be
 * launched serially: a background spawn returns at once, so a run of them is already
 * running in parallel and there is nothing for the root wall to refuse.
 *
 * Mirrors the Agent tool's own `backgroundMode` inverted, from the call's own input rather
 * than a hand list: with the background flag on, OMITTING the field backgrounds (the tool's
 * default), so only an explicit `false` is in-turn; a `children[]` batch and a teammate
 * spawn never background, whatever the field says. Flag off, nothing backgrounds at all.
 */
export function isInTurnSpawn(toolName: string, input: unknown, backgroundEnabled: boolean): boolean {
  // Follow-up C item 1 — only the Agent tool ever advertises `run_in_background`, so every
  // OTHER spawn-shaped call blocks the turn it was issued in. Read off the set rather than
  // named: reading `run_in_background !== false` on a Weave input would call it a background
  // spawn and switch the root wall off for the whole Weave door, which is the bypass itself.
  if (!REEXECUTE_BOUND_TOOLS.has(toolName)) return true;
  if (!backgroundEnabled) return true;
  // A shape we cannot read is treated as IN-TURN, the module's stated default. Reading it
  // as background would let a malformed call clear the streak and skip the wall, which is
  // the one direction a guess must never take.
  if (typeof input !== 'object' || input === null) return true;
  const i = input as { run_in_background?: unknown; children?: unknown; mode?: unknown };
  if (i.mode === 'teammate') return true;
  if (Array.isArray(i.children) && i.children.length > 0) return true;
  return i.run_in_background === false;
}

export function concurrencyRefusal(cap: number): string {
  return (
    `Concurrent subagent limit reached. You can run ${cap} subagents at once. ` +
    'Do not retry; complete the remaining work directly with your tools.'
  );
}

export function budgetRefusal(spentUsd: number, maxUsd: number): string {
  return (
    `Budget limit reached ($${spentUsd.toFixed(2)} spent of the $${maxUsd.toFixed(2)} maximum). ` +
    'New agents cannot be started. Complete the remaining work directly with your tools, ' +
    'or wrap up with the results you already have.'
  );
}

/** R20 — the per-TURN spend ceiling, told the same way the budget wall is: what stopped,
 *  and what to do instead. Distinct from `budgetRefusal` (the task ran out of money);
 *  this one says THIS TURN ran away, so no figure is quoted. */
export const TURN_CEILING_REFUSAL =
  'This turn has reached its spending ceiling. New agents cannot be started. ' +
  'Complete the remaining work directly with your tools, or wrap up with the results you already have.';

/**
 * The wrap-up directive, pushed at `wrapUpAtTurn` and again at the cap. The old text asked
 * for "a final response summarizing", which a child mid-search reads as a formality it can
 * defer; this one says the report IS the deliverable, because the failure it exists to stop
 * is a helper that worked hard and wrote nothing.
 */
export const TURN_CAP_DIRECTIVE =
  'You are near your turn limit. Write up what you have found and accomplished so far as ' +
  'your report now, without calling any more tools. Your report is the deliverable: ' +
  'findings you do not write down reach nobody.';

export const STILL_CALLING_TOOLS = 'It was still calling tools and had produced no report.';

export function partialLabel(
  reason: Exclude<SubagentStopReason, 'completed' | 'refused'>,
  turns?: number,
): string {
  const tail = 'The text below is PARTIAL output; treat it as incomplete.';
  switch (reason) {
    case 'turn_cap':
      return `NOTE: this helper stopped at its ${turns ?? SUBAGENT_MAX_TURNS_WALLS}-turn limit before finishing. ${tail}`;
    case 'stopped_by_user':
      return `NOTE: this helper was stopped by the user before finishing. ${tail}`;
    case 'stopped_by_parent':
      return `NOTE: this helper was stopped by you before finishing. ${tail}`;
    case 'credits_exhausted':
      return `NOTE: this helper was stopped because the account ran out of credits. ${tail}`;
    case 'failed':
      return 'NOTE: this helper failed before finishing. Any text below is PARTIAL output; treat it as incomplete.';
  }
}

export interface UsageFooterInput {
  subagentTokens: number;
  toolUses: number;
  durationMs: number;
  costUsd: number;
}

export function usageFooter(u: UsageFooterInput): string {
  // Round to 6dp before interpolating: raw `${1e-7}` prints "1e-7", which reads as a
  // token count rather than a price. Number() drops the trailing zeros toFixed adds,
  // so 0.0123 and 0.001 still print exactly as they did.
  const costUsd = Number(u.costUsd.toFixed(6));
  return (
    `<usage>subagent_tokens: ${u.subagentTokens}\n` +
    `tool_uses: ${u.toolUses}\n` +
    `duration_ms: ${u.durationMs}\n` +
    `cost_usd: ${costUsd}</usage>`
  );
}

/**
 * Phase 2 (§4.7, D9) — what the LEAD's tool slot settles with the moment a helper goes to
 * the background. The whole failure mode of an immediate return is a model that answers as
 * though the result were already in, so the note says in as many words that it is not.
 */
export const HELPER_LAUNCHED_NOTE =
  'Helper launched in the background. You will be notified when it finishes; do not report, ' +
  'assume or predict its results before then. Continue other work or answer the person.';

/**
 * Phase 3 (spec 2026-09-05-orchestration-teamwork §4.1) — the same note once the helper has a
 * HANDLE the lead can type. The note is the first and often only place a lead reads that
 * handle, so it is also where the three verbs are taught: Phase 2's first drill showed a lead
 * that is given plumbing and no doctrine never reaches for it. Flag off keeps the constant
 * above, byte for byte.
 */
export function helperLaunchedNote(handle: string): string {
  return (
    `Helper @${handle} launched in the background. You will be notified when it finishes; do ` +
    'not report, assume or predict its results before then. Message it with SendMessage, stop ' +
    'it with StopHelper, see every helper with ListHelpers.'
  );
}

export const DELEGATED_HELPER_PREAMBLE =
  'You are a delegated helper working on one specific piece of a larger task. You are already ' +
  'the dedicated agent for this piece: do the work directly. Do not hand your whole assignment ' +
  'to another single helper. If a piece genuinely splits into independent parts, launch them ' +
  'together in one message so they run at the same time. Report back with outcomes first, under ' +
  'the length your caller asked for; do not replay your process. Your response is returned to ' +
  'the agent that launched you, not shown to the person.';

/**
 * `children[]` of two or more REAL entries is a parallel batch; anything else is a single
 * spawn. Each entry must be a non-null object: `[null, null]` is two holes, not two
 * children, and admitting it would let a malformed call take the batch path.
 */
export function isParallelBatchInput(toolName: string, input: unknown): boolean {
  if (toolName === WEAVE_REEXECUTE_TOOL) return weaveOpensParallel(input);
  if (typeof input !== 'object' || input === null) return false;
  const children = (input as { children?: unknown }).children;
  return (
    Array.isArray(children) &&
    children.length >= 2 &&
    children.every((c) => typeof c === 'object' && c !== null)
  );
}

/**
 * R128 (review B1) — blank out everything in `script` that is not code: line comments, block
 * comments, and string/template literals. Returns `undefined` when one of them never closes.
 *
 * Without this the scan ran over the raw text, so `// no need to parallel() these` above a
 * lone `task()` read as a fan-out. That is the worst direction this wall can fail in, because
 * a batch also CLEARS the streak: the next round's lone spawn walks through as well. And a
 * comment header above a hand-off is a thing models write.
 *
 * Blanked to spaces rather than deleted so every surviving index still points at the byte it
 * came from; only the ORDER of two call sites is ever compared, but keeping the offsets true
 * costs nothing and makes the result readable in a debugger. Not a JS parser and not trying to
 * be one: a regex literal holding an odd quote (`/'/`) reads as a string start and usually
 * ends the scan unbalanced, which lands on `undefined` and therefore on the wall.
 */
function stripNonCode(script: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    const next = script[i + 1];
    if (c === '/' && next === '/') {
      while (i < script.length && script[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let closed = false;
      out += ' ';
      i += 1;
      while (i < script.length) {
        // An escape consumes the next character, so a `\"` never ends the literal early.
        if (script[i] === '\\') { out += '  '; i += 2; continue; }
        if (script[i] === quote) { out += ' '; i += 1; closed = true; break; }
        // Only a template literal spans lines; a newline inside the other two is unbalanced.
        if (quote !== '`' && script[i] === '\n') break;
        out += ' ';
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The index of the earliest call to any of `names` in `script`, or -1. */
function firstCallSite(script: string, names: readonly string[]): number {
  let earliest = -1;
  for (const n of names) {
    const at = script.search(new RegExp(`\\b${n}\\s*\\(`));
    if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * Follow-up C item 1 — does a Weave call's PLAN open on a parallel layer?
 *
 * Weave has no declarative plan. Its whole input is meta / budget / `script`
 * (weave-tool.ts, WEAVE_PARAMS), and the script is JavaScript the interpreter only turns
 * into nodes at RUN time, over a socket, long after this decision is made. So the plan is
 * text, and reading the text is the only reading there is; this is not a hand list of
 * tools, it is the call's own input.
 *
 * Whichever comes FIRST is the first layer: a bare `task()` opens on one node, which is
 * the same drip-feed a lone Agent call is whatever the script does afterwards, while a
 * fan-out combinator opens on the batch the wall is asking for.
 *
 * The plan is read as CODE: comments and string literals are blanked first (stripNonCode),
 * so a combinator NAMED in prose is not a call to one, and a script whose literal or block
 * comment never closes is not a batch.
 *
 * KNOWN AND ACCEPTED: a combinator's arity is runtime data (`parallel(items.map(...))`),
 * so the shape is read, never the count — `parallel([oneThunk])` reads as a batch. That
 * is a plan the model deliberately wrote as a fan-out, and this wall steers rather than
 * secures. An UNREADABLE input is not a batch, the direction `isInTurnSpawn` already
 * takes: a shape we cannot read must never be the one that switches the wall off.
 */
export function weaveOpensParallel(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const raw = (input as { script?: unknown }).script;
  if (typeof raw !== 'string') return false;
  const script = stripNonCode(raw);
  if (script === undefined) return false;
  const fanOut = firstCallSite(script, WEAVE_DISPATCH.fanOut);
  if (fanOut < 0) return false;
  const node = firstCallSite(script, WEAVE_DISPATCH.node);
  return node < 0 || fanOut < node;
}
