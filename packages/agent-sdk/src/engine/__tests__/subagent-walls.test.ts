import { describe, it, expect } from 'vitest';
import { WEAVE_DISPATCH_GLOBALS } from '../../tools/code-exec/weave-stub-generator.js';
import * as walls from '../subagent-walls.js';
import {
  SUBAGENT_DEPTH_CAP, SUBAGENT_MAX_TURNS_WALLS, SUBAGENT_TREE_CONCURRENCY, SUBAGENT_MESSAGE_CONCURRENCY,
  depthRefusal, LONE_CHILD_REFUSAL, LEAF_REFUSAL, concurrencyRefusal, budgetRefusal, TURN_CAP_DIRECTIVE,
  partialLabel, usageFooter, STILL_CALLING_TOOLS, DELEGATED_HELPER_PREAMBLE, isParallelBatchInput,
  HELPER_LAUNCHED_NOTE, helperLaunchedNote,
  type SubagentAllowKind,
  type SubagentRefusalKind,
} from '../subagent-walls.js';

describe('subagent-walls — the numbers and the words are one source', () => {
  it('pins the spec numbers (4 / 100 / 20 / 10)', () => {
    expect(SUBAGENT_DEPTH_CAP).toBe(4);
    expect(SUBAGENT_MAX_TURNS_WALLS).toBe(100);
    expect(SUBAGENT_TREE_CONCURRENCY).toBe(20);
    expect(SUBAGENT_MESSAGE_CONCURRENCY).toBe(10);
  });
  it('refusals say what to do instead, never "retry"', () => {
    expect(depthRefusal(4, 4)).toBe(
      'Subagent nesting limit reached (depth 4 of 4). Complete this task directly using your tools instead of spawning another agent.',
    );
    expect(LONE_CHILD_REFUSAL).toBe(
      'You are the dedicated agent for this piece. Do it yourself, or split it into two or more independent parts and launch them together in one message.',
    );
    expect(LEAF_REFUSAL).toBe(
      'This helper type does not delegate. Complete this task directly using your tools instead of spawning another agent.',
    );
    expect(concurrencyRefusal(20)).toBe(
      'Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry; complete the remaining work directly with your tools.',
    );
    expect(budgetRefusal(9.5, 10)).toBe(
      'Budget limit reached ($9.50 spent of the $10.00 maximum). New agents cannot be started. Complete the remaining work directly with your tools, or wrap up with the results you already have.',
    );
  });
  it('the refusal taxonomy names every refusal the runtime can return', () => {
    const kinds: SubagentRefusalKind[] = ['depth', 'leaf', 'lone_child', 'concurrency', 'budget', 'serial_root'];
    expect(kinds).toHaveLength(6);
  });
  // Follow-up item 1 — the ROOT wall. The lone-child refusal tells a delegated helper to
  // do the work itself; the root has helpers to spend, so its refusal says the opposite:
  // launch the rest TOGETHER.
  it('the root refusal asks for one message, not for the root to do the work itself', () => {
    expect(walls.SERIAL_ROOT_REFUSAL).toBe(
      'You launched these helpers one after another. Issue every remaining helper together in ONE message so they run in parallel; a lone helper is only for a single piece of work. ' +
      "If a helper needs an earlier helper's result, say so with depends_on and it may run alone. " +
      'No helper was started.',
    );
    // It must not read as the lone-child advice: the root is not the dedicated agent.
    expect(walls.SERIAL_ROOT_REFUSAL).not.toBe(LONE_CHILD_REFUSAL);
  });

  // Follow-up C items 2 and 3 — the exit and the cap. A wall that only ever says no is
  // what the 2026-09-04 rerun routed around, so the refusal now names the way through.
  it('the refusal names depends_on, and the cap has a note that says what happened', () => {
    expect(walls.SERIAL_ROOT_REFUSAL).toContain(
      "If a helper needs an earlier helper's result, say so with depends_on and it may run alone.",
    );
    expect(walls.SERIAL_ROOT_ALLOWED_NOTE).toBe('Allowed after two refusals; the plan is still being drip-fed.');
    // The note and the cap have to agree: "two refusals" is the number, not a word.
    expect(walls.SERIAL_ROOT_REFUSAL_CAP).toBe(2);
    expect(walls.SERIAL_ROOT_ALLOWED_NOTE).toContain('two');
  });

  /**
   * Follow-up D item 2 — a refused spawn SAYS no helper was started.
   *
   * On the 2026-09-04 rerun the model read this refusal and then ended its turn telling the
   * person "Delhi lookup is running". Nothing was. A refusal that only argues about HOW to
   * launch helpers leaves the model free to believe one launched, so every root-wall refusal
   * now closes by saying, in as many words, that none did.
   */
  it('the root refusal ends by saying no helper was started', () => {
    expect(walls.NO_HELPER_STARTED).toBe('No helper was started.');
    expect(walls.SERIAL_ROOT_REFUSAL.endsWith(walls.NO_HELPER_STARTED)).toBe(true);
    // The sentence closes the refusal, it does not replace the advice above it.
    expect(walls.SERIAL_ROOT_REFUSAL).toContain('Issue every remaining helper together in ONE message');
  });

  it('an allow kind is never a refusal kind: the server sums the refusals into one column', () => {
    const allows: SubagentAllowKind[] = ['serial_root_dependent', 'serial_root_allowed'];
    const refusals: string[] = ['depth', 'leaf', 'lone_child', 'concurrency', 'budget', 'serial_root'];
    for (const a of allows) expect(refusals).not.toContain(a);
  });
  it('an in-turn spawn is the one the turn WAITS on, so a background spawn is exempt', () => {
    // Background off: nothing backgrounds, so every spawn is in-turn.
    expect(walls.isInTurnSpawn('Agent', { prompt: 'x' }, false)).toBe(true);
    expect(walls.isInTurnSpawn('Agent', { run_in_background: true }, false)).toBe(true);
    // Background on: omitting the field BACKGROUNDS (the Agent tool's default), so only an
    // explicit false is in-turn. A background spawn returns at once, so serial launches of
    // them already run in parallel and there is nothing to refuse.
    expect(walls.isInTurnSpawn('Agent', { prompt: 'x' }, true)).toBe(false);
    expect(walls.isInTurnSpawn('Agent', { run_in_background: true }, true)).toBe(false);
    expect(walls.isInTurnSpawn('Agent', { run_in_background: false }, true)).toBe(true);
    // The two shapes the Agent tool never backgrounds, whatever the field says.
    expect(walls.isInTurnSpawn('Agent', { children: [{}] }, true)).toBe(true);
    expect(walls.isInTurnSpawn('Agent', { mode: 'teammate' }, true)).toBe(true);
    // A malformed input is not a licence to skip the wall: unreadable reads as IN-TURN,
    // because the other guess would let a bad shape clear the streak and walk past it.
    expect(walls.isInTurnSpawn('Agent', null, true)).toBe(true);
    expect(walls.isInTurnSpawn('Agent', undefined, true)).toBe(true);
    expect(walls.isInTurnSpawn('Agent', null, false)).toBe(true);
  });
  it('the turn-cap directive asks the helper to WRITE its findings so far as its report', () => {
    // Follow-up item 2 — the founder's researcher ran 99 searches and wrote nothing. The
    // old text asked for "a final response summarizing", which a searching model reads as
    // a formality; this one names the report as the deliverable.
    expect(TURN_CAP_DIRECTIVE).toBe(
      'You are near your turn limit. Write up what you have found and accomplished so far as your report now, without calling any more tools. Your report is the deliverable: findings you do not write down reach nobody.',
    );
  });
  // Follow-up item 2 — one cap for every type was sized for an orchestrator, so a
  // researcher got 100 turns of searching before anything made it stop.
  it('the cap table is keyed on the REGISTRY\'s own type names, not hand-copied literals', async () => {
    // A rename in the registry would otherwise leave every researcher on 100 with the
    // suite green, because the table and this file would both still say 'researcher'.
    const reg = await import('../../composition/subagent-type-registry.js');
    expect(walls.subagentMaxTurns(reg.RESEARCHER_TYPE)).toBe(40);
    expect(walls.subagentMaxTurns(reg.EXPLORER_TYPE)).toBe(40);
    expect(walls.subagentMaxTurns(reg.GENERAL_PURPOSE_TYPE)).toBe(SUBAGENT_MAX_TURNS_WALLS);
  });
  it('the turn cap is per TYPE, and an unknown type keeps the 100 default', () => {
    expect(walls.subagentMaxTurns('researcher')).toBe(40);
    expect(walls.subagentMaxTurns('explorer')).toBe(40);
    expect(walls.subagentMaxTurns('general-purpose')).toBe(100);
    expect(walls.subagentMaxTurns('some-installed-ability-agent')).toBe(100);
    expect(walls.subagentMaxTurns(undefined)).toBe(100);
    // The bare constant stays the DEFAULT, not a second opinion on a known type.
    expect(walls.subagentMaxTurns('anything-unknown')).toBe(SUBAGENT_MAX_TURNS_WALLS);
  });
  it('the wrap-up lands at 75% of the type cap, leaving room to actually write', () => {
    expect(walls.wrapUpAtTurn(40)).toBe(30);
    expect(walls.wrapUpAtTurn(100)).toBe(75);
    // Never 0: a tiny cap would otherwise nudge before the run has done anything.
    expect(walls.wrapUpAtTurn(1)).toBe(1);
    expect(walls.wrapUpAtTurn(2)).toBe(1);
  });
  it('labels are partial and name the cause', () => {
    expect(partialLabel('turn_cap', 100)).toBe(
      'NOTE: this helper stopped at its 100-turn limit before finishing. The text below is PARTIAL output; treat it as incomplete.',
    );
    expect(partialLabel('stopped_by_user')).toBe(
      'NOTE: this helper was stopped by the user before finishing. The text below is PARTIAL output; treat it as incomplete.',
    );
    expect(partialLabel('stopped_by_parent')).toBe(
      'NOTE: this helper was stopped by you before finishing. The text below is PARTIAL output; treat it as incomplete.',
    );
    expect(partialLabel('failed')).toBe('NOTE: this helper failed before finishing. Any text below is PARTIAL output; treat it as incomplete.');
    expect(STILL_CALLING_TOOLS).toBe('It was still calling tools and had produced no report.');
  });
  it('a helper the credit kill stopped names the credits, never the person', () => {
    expect(partialLabel('credits_exhausted')).toBe(
      'NOTE: this helper was stopped because the account ran out of credits. The text below is PARTIAL output; treat it as incomplete.',
    );
    // The whole point: the credits label is NOT the person's-Stop label.
    expect(partialLabel('credits_exhausted')).not.toBe(partialLabel('stopped_by_user'));
  });
  it('the usage footer is one block with four lines', () => {
    expect(usageFooter({ subagentTokens: 1234, toolUses: 7, durationMs: 72000, costUsd: 0.0123 })).toBe(
      '<usage>subagent_tokens: 1234\ntool_uses: 7\nduration_ms: 72000\ncost_usd: 0.0123</usage>',
    );
  });
  it('a sub-cent cost never renders in exponent notation', () => {
    // Raw interpolation prints 1e-7, which reads as a token count, not a price.
    expect(usageFooter({ subagentTokens: 1, toolUses: 1, durationMs: 1, costUsd: 1e-7 })).toBe(
      '<usage>subagent_tokens: 1\ntool_uses: 1\nduration_ms: 1\ncost_usd: 0</usage>',
    );
    expect(usageFooter({ subagentTokens: 1, toolUses: 1, durationMs: 1, costUsd: 0.001 })).toContain(
      'cost_usd: 0.001',
    );
  });
  /**
   * Phase 3 (spec 2026-09-05-orchestration-teamwork §4.1) — the note is where a lead first
   * reads its helper's handle, so it is also the only place the three verbs are guaranteed to
   * be taught: a lead that never sees SendMessage/StopHelper/ListHelpers named never reaches
   * for them (Phase 2's first drill: plumbing without doctrine is never used).
   */
  it('the flag-on launch note names the handle and all three verbs', () => {
    expect(helperLaunchedNote('research-competitor-pricing')).toBe(
      'Helper @research-competitor-pricing launched in the background. You will be notified when ' +
        'it finishes; do not report, assume or predict its results before then. Message it with ' +
        'SendMessage, stop it with StopHelper, see every helper with ListHelpers.',
    );
    // The Phase 2 constant is untouched: a flag-off lead reads exactly the old bytes, and
    // the two texts are NOT the same note (the old one has no handle and no verbs).
    expect(HELPER_LAUNCHED_NOTE).toBe(
      'Helper launched in the background. You will be notified when it finishes; do not report, ' +
        'assume or predict its results before then. Continue other work or answer the person.',
    );
    expect(helperLaunchedNote('x')).not.toBe(HELPER_LAUNCHED_NOTE);
    // The one thing both notes must keep saying: do not speak for a result you do not have.
    expect(helperLaunchedNote('x')).toContain('do not report, assume or predict its results before then');
  });

  it('the preamble says "do the work directly" and "never a single helper"', () => {
    expect(DELEGATED_HELPER_PREAMBLE).toContain('do the work directly');
    expect(DELEGATED_HELPER_PREAMBLE).toContain('Do not hand your whole assignment to another single helper');
    expect(DELEGATED_HELPER_PREAMBLE).not.toMatch(/—/);
    expect(DELEGATED_HELPER_PREAMBLE).not.toMatch(/Claude/);
  });
  it('a parallel batch is children[] of two or more', () => {
    expect(isParallelBatchInput('Agent', { children: [{}, {}] })).toBe(true);
    expect(isParallelBatchInput('Agent', { children: [{}] })).toBe(false);
    expect(isParallelBatchInput('Agent', { subagent_type: 'researcher', prompt: 'x' })).toBe(false);
    expect(isParallelBatchInput('Agent', undefined)).toBe(false);
    // Two holes are not two children: entries must be real objects.
    expect(isParallelBatchInput('Agent', { children: [null, null] })).toBe(false);
    expect(isParallelBatchInput('Agent', { children: ['a', 'b'] })).toBe(false);
  });

  /**
   * Follow-up C item 1 — the Weave plan shape. Weave has no declarative plan (weave-tool.ts
   * WEAVE_PARAMS is meta / budget / `script`), so the first layer is whatever the script
   * dispatches first: a bare task() is one node, a fan-out combinator is the batch.
   */
  it('a Weave plan is a batch when it OPENS on a fan-out combinator', () => {
    const weave = (script: string): boolean =>
      isParallelBatchInput('Weave', { meta: { name: 'n', goal: 'g', phases: [] }, budget: { usd: 1 }, script });

    // Driven off the prelude's OWN export, so a fourth combinator added there arrives here
    // as a pin rather than as a silently unrefused door (the constant is held to the
    // generated prelude by a drift pin in weave-stub-generator.test.ts).
    for (const combinator of WEAVE_DISPATCH_GLOBALS.fanOut) {
      expect(weave(`const r = await ${combinator}([() => task({}), () => task({})]);`), combinator).toBe(true);
    }
    for (const dispatcher of WEAVE_DISPATCH_GLOBALS.node) {
      expect(weave(`const r = await ${dispatcher}({ prompt: "one piece" });`), dispatcher).toBe(false);
    }
    expect(weave('const [a, b] = await parallel([() => task({}), () => task({})]);')).toBe(true);
    expect(weave('return pipeline(items, (i) => task({ prompt: i }));')).toBe(true);
    expect(weave('return panel({ prompt: "x", n: 3 });')).toBe(true);

    // One node first is the drip-feed, whatever the script does afterwards.
    expect(weave('const r = await task({ prompt: "one piece" }); return r;')).toBe(false);
    expect(weave('const r = await agent({ prompt: "one piece" });')).toBe(false);
    expect(weave('const a = await task({}); return parallel([() => task({}), () => task({})]);')).toBe(false);
    expect(weave('return 42;')).toBe(false);

    // A name that merely CONTAINS a combinator is not a call to one. The look-alike has to
    // BE CALLED, or the pin passes for want of a call site rather than because of the word
    // boundary it exists to hold.
    expect(weave('const myparallel = () => 1; myparallel(); await task({});')).toBe(false);
    expect(weave('const paralleljobs = () => 1; paralleljobs(); await task({});')).toBe(false);

    // EARLIEST across the whole role, not the first name that happens to match. A script
    // with one combinator before the node call and another after it is still a batch;
    // taking the latest instead would read it as a hand-off.
    expect(weave('await parallel([() => task({})]); await task({}); await panel({ n: 2 });')).toBe(true);
    // And the mirror: a node call before BOTH combinators is a hand-off.
    expect(weave('await task({}); await parallel([]); await panel({ n: 2 });')).toBe(false);

    // Unreadable is not a batch: a shape we cannot read must never switch the wall off.
    expect(isParallelBatchInput('Weave', undefined)).toBe(false);
    expect(isParallelBatchInput('Weave', {})).toBe(false);
    expect(isParallelBatchInput('Weave', { script: 42 })).toBe(false);
    // The Agent shape does not leak across: children[] means nothing on a Weave call.
    expect(isParallelBatchInput('Weave', { children: [{}, {}] })).toBe(false);
  });

  /**
   * R128 (review B1) — the plan is read as CODE, not as text.
   *
   * The scan used to run over the script verbatim, so `// no need to parallel() these` above
   * a lone `task()` read as a fan-out. That is the worst direction the wall can fail in: a
   * batch also CLEARS the streak, so the next round's lone Agent spawn walks through too, and
   * models write comment headers. Comments and string literals are stripped first, and an
   * unbalanced script is not a batch, which is the module's own rule for a shape it cannot
   * read.
   */
  it('a combinator named in a comment or a string is not a call to one', () => {
    const weave = (script: string): boolean => isParallelBatchInput('Weave', { script });

    // Line comments, block comments, and the doc-comment header a model writes by habit.
    expect(weave('// no need to parallel() these\nconst a = await task({});')).toBe(false);
    expect(weave('/* parallel() would be wrong here */ const a = await task({});')).toBe(false);
    expect(weave('/**\n * pipeline() was considered.\n */\nreturn task({});')).toBe(false);

    // String and template literals, including the log line the prelude offers.
    expect(weave('log("using parallel() next"); const a = await task({});')).toBe(false);
    expect(weave("log('parallel() later'); return task({});")).toBe(false);
    expect(weave('log(`parallel() later`); return task({});')).toBe(false);
    // An escaped quote must not end the literal early. Both literals here close on their
    // LAST quote, so the real `parallel(` between them is code and the plan is a batch;
    // stop honouring the escape and the second literal swallows it instead.
    expect(weave('log("a \\" b"); await parallel([() => task({})]); log("c \\" d"); await task({});')).toBe(true);
    expect(weave('log("a \\" parallel() b"); return task({});')).toBe(false);

    // A REAL call still reads as a batch with a comment sitting beside it.
    expect(weave('// fan out\nreturn parallel([() => task({}), () => task({})]);')).toBe(true);
    expect(weave('const a = await parallel([]); // parallel again\n')).toBe(true);

    // Unbalanced is not a batch: an unterminated literal or block comment is a script we
    // cannot read, and a shape we cannot read never switches the wall off.
    expect(weave('log("parallel() and then; return task({});')).toBe(false);
    expect(weave('/* parallel() forever; return task({});')).toBe(false);
    // The cases that separate "unbalanced is not a batch" from "unbalanced blanks the rest":
    // a REAL fan-out sits before the break, so treating the tail as merely commented-out
    // would let the plan through on a script nobody can read.
    expect(weave('await parallel([() => task({}), () => task({})]); /* and then')).toBe(false);
    expect(weave('await parallel([() => task({})]); log("and then')).toBe(false);
    expect(weave("const s = 'unterminated\nreturn parallel([() => task({}), () => task({})]);")).toBe(false);
  });

  it('a Weave call is always IN-TURN: only the Agent tool advertises run_in_background', () => {
    expect(walls.isInTurnSpawn('Weave', { script: 'await task({})' }, true)).toBe(true);
    expect(walls.isInTurnSpawn('Weave', { run_in_background: true }, true)).toBe(true);
    expect(walls.isInTurnSpawn('Weave', null, true)).toBe(true);
  });

  // Every sample-arg set for a string-returning export. Keyed by name so a NEW function
  // export cannot slip past the law silently: the test fails if it has no entry here.
  const SAMPLE_ARGS: Record<string, unknown[][]> = {
    depthRefusal: [[4, 4], [1, 4]],
    concurrencyRefusal: [[20], [1]],
    budgetRefusal: [[9.5, 10], [0, 10]],
    partialLabel: [['turn_cap', 100], ['stopped_by_user'], ['stopped_by_parent'], ['failed'], ['credits_exhausted']],
    usageFooter: [[{ subagentTokens: 1, toolUses: 1, durationMs: 1, costUsd: 0.5 }]],
    helperLaunchedNote: [['research-competitor-pricing'], ['draft-the-email']],
    isParallelBatchInput: [['Agent', { children: [{}, {}] }], ['Weave', { script: 'await parallel([])' }]],
    nestedDrainTimeoutMs: [[5000], [1]],
    subagentMaxTurns: [['researcher'], ['general-purpose'], [undefined]],
    wrapUpAtTurn: [[40], [100], [1]],
    isInTurnSpawn: [['Agent', { prompt: 'x' }, true], ['Agent', { run_in_background: false }, false]],
    weaveOpensParallel: [[{ script: 'await parallel([])' }], [{ script: 'await task({})' }]],
    declaresDependency: [[{ depends_on: 'the pricing researcher' }], [{ prompt: 'x' }]],
  };

  it('no exported string, or string a function returns, carries an em dash or "Claude"', () => {
    const lawful = (text: string, where: string): void => {
      expect(text, `${where} must not contain an em dash`).not.toMatch(/—/);
      expect(text, `${where} must not name Claude`).not.toMatch(/Claude/);
    };
    for (const [name, value] of Object.entries(walls)) {
      if (typeof value === 'string') {
        lawful(value, name);
        continue;
      }
      if (typeof value !== 'function') continue;
      const argSets = SAMPLE_ARGS[name];
      expect(argSets, `${name} is a function export with no SAMPLE_ARGS entry — add one`).toBeDefined();
      for (const args of argSets) {
        const out = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof out === 'string') lawful(out, `${name}(${JSON.stringify(args)})`);
      }
    }
  });
});
