/**
 * The race's contract: the tasks and their rubrics (written before any run, answers computed
 * from the tasks' own data), the seeded running order, the blind judge, the tables and the
 * page. No model is called: the judge's HTTP is a fake.
 */
import { describe, expect, it } from 'vitest';
import { compareLower, renderRaceHtml, summarySentences } from '../html.js';
import { assertJudgeModel, blindToolName, blindTranscript, judgeMessages, judgeRun, parseJudgeReply, type RaceVerdict } from '../judge.js';
import { buildPlan, seededRandom, shuffle, RACE_ENGINES } from '../plan.js';
import { judgeAll, mergeRunsFiles, parseRaceArgs } from '../race.js';
import { listPriceUsd, RACE_RUNS_SCHEMA, type RaceRunRecord, type RaceRunsFile } from '../record.js';
import { buildReport, median, pickSpotChecks, type JudgedRun } from '../report.js';
import { checkMustSay, handbook, localizeForSlot, pickRaceTasks, RACE_CATEGORIES, RACE_TASKS, type RaceTask } from '../tasks.js';

const task = (id: string): RaceTask => RACE_TASKS.find((t) => t.id === id)!;

describe('race tasks', () => {
  it('has 30 tasks, five of each kind, unique ids, every one with a rubric of at least two lines', () => {
    expect(RACE_TASKS).toHaveLength(30);
    for (const cat of RACE_CATEGORIES) expect(RACE_TASKS.filter((t) => t.category === cat)).toHaveLength(5);
    expect(new Set(RACE_TASKS.map((t) => t.id)).size).toBe(30);
    for (const t of RACE_TASKS) {
      expect(t.rubric.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.turns.length, t.id).toBeGreaterThanOrEqual(1);
      expect(t.measureTurn ?? 0, t.id).toBeLessThan(t.turns.length);
    }
  });

  it('computes the data answers from the inline data', () => {
    expect(task('data-sales-by-region').mustSay).toEqual(['1980', '1500', '1400', '1130']);
    expect(task('data-ages').mustSay).toEqual(['Gus', '56', 'Fatima', '21']);
    expect(task('data-stats').mustSay).toEqual(['16.90', '16.5', '6.41']);
    expect(task('data-unique-emails').mustSay).toEqual(['5']);
    expect(task('multi-calendar').mustSay).toEqual(['July', 'December']);
    // A birthday later in the year is not yet reached on 1 January.
    expect(task('data-ages').rubric.join(' ')).toContain('Ben is 40');
  });

  it('gives each follow-up a long handbook that holds the fact it asks for, timed on the question', () => {
    const doc = handbook();
    expect(doc.length).toBeGreaterThan(50_000);
    for (const t of RACE_TASKS.filter((x) => x.category === 'followup')) {
      expect(t.turns).toHaveLength(2);
      expect(t.measureTurn).toBe(1);
      expect(t.turns[0]).toContain(doc);
      for (const fact of t.mustSay!) expect(doc, t.id).toContain(fact);
    }
  });

  it('marks the tasks that need the web or the travel server', () => {
    expect(RACE_TASKS.filter((t) => t.needs?.includes('web')).map((t) => t.category)).toEqual(Array(5).fill('research'));
    expect(RACE_TASKS.filter((t) => t.needs?.includes('mock-travel-mcp')).map((t) => t.category)).toEqual(Array(5).fill('app'));
  });

  it('checks facts ignoring case, spacing and thousands separators', () => {
    const t = task('data-sales-by-region');
    expect(checkMustSay(t, 'North 1,980; West 1,500; South 1,400; East 1,130').pass).toBe(true);
    expect(checkMustSay(t, 'North 1980, West 1500, South 1400').missing).toEqual(['1130']);
    expect(checkMustSay(task('app-cheapest'), 'the DECCAN   queen at Rs 540').pass).toBe(true);
  });

  it("moves every files/ path into the slot's own folder", () => {
    expect(localizeForSlot('Create files/calc/add.js and files/calc/add.test.js', 7)).toBe('Create files/race-7/calc/add.js and files/race-7/calc/add.test.js');
    expect(localizeForSlot('counts words in files: fine', 7)).toBe('counts words in files: fine');
  });

  it('refuses an unknown task id rather than skipping it', () => {
    expect(() => pickRaceTasks(['nope'])).toThrow(/no task named nope/);
    expect(pickRaceTasks(['data-stats', 'write-readme']).map((t) => t.id)).toEqual(['write-readme', 'data-stats']);
  });
});

describe('race plan', () => {
  it('runs every task on every engine once per run, numbered in order', () => {
    const plan = buildPlan({ tasks: RACE_TASKS, runs: 2, seed: 7 });
    expect(plan.slots).toHaveLength(30 * 2 * 2);
    expect(plan.slots.map((s) => s.slot)).toEqual(plan.slots.map((_, i) => i + 1));
    const keys = plan.slots.map((s) => `${s.task}/${s.engine}/${s.run}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.model).toBe('claude-sonnet-5-5');
    expect(plan.engines).toEqual([...RACE_ENGINES]);
  });

  it('is the same order for the same seed and a different one for another', () => {
    const a = buildPlan({ tasks: RACE_TASKS, seed: 3 }).slots.map((s) => `${s.task}/${s.engine}`);
    const b = buildPlan({ tasks: RACE_TASKS, seed: 3 }).slots.map((s) => `${s.task}/${s.engine}`);
    const c = buildPlan({ tasks: RACE_TASKS, seed: 4 }).slots.map((s) => `${s.task}/${s.engine}`);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('lets each engine go first on some tasks, and shuffles each run differently', () => {
    const plan = buildPlan({ tasks: RACE_TASKS, seed: 11 });
    const firsts = plan.slots.filter((_, i) => i % 2 === 0).map((s) => s.engine);
    expect(new Set(firsts)).toEqual(new Set(['native', 'claude_code']));
    const order = (run: number) => plan.slots.filter((s) => s.run === run && s.engine === 'native').map((s) => s.task);
    expect(order(1)).not.toEqual(order(2));
  });

  it("writes each slot's prompts against its own folder", () => {
    const plan = buildPlan({ tasks: [task('write-standup')], runs: 2, engines: ['native'] });
    expect(plan.slots.map((s) => s.turns[0]!.slice(0, 32))).toEqual(['Write files/race-1/standup.md: a', 'Write files/race-2/standup.md: a']);
  });

  it('carries the turns, needs and measured turn into each slot', () => {
    const plan = buildPlan({ tasks: [task('followup-wifi')], runs: 1, engines: ['native'] });
    expect(plan.slots[0]).toMatchObject({ task: 'followup-wifi', category: 'followup', measureTurn: 1, needs: [] });
    expect(plan.slots[0]!.turns).toHaveLength(2);
  });

  it('refuses a plan with no runs, tasks or engines', () => {
    expect(() => buildPlan({ tasks: RACE_TASKS, runs: 0 })).toThrow(/runs/);
    expect(() => buildPlan({ tasks: [] })).toThrow(/no tasks/);
    expect(() => buildPlan({ tasks: RACE_TASKS, engines: [] })).toThrow(/no engines/);
  });

  it('shuffles without losing or adding anything', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect([...shuffle(xs, seededRandom(1))].sort()).toEqual(xs);
  });
});

function run(over: Partial<RaceRunRecord> & Pick<RaceRunRecord, 'task' | 'engine'>): JudgedRun {
  const t = task(over.task);
  return {
    slot: 1,
    category: t.category,
    run: 1,
    model: 'claude-sonnet-5-5',
    modelResponded: 'claude-sonnet-5-5',
    ranOn: over.engine,
    taskId: `vestra-${over.task}-${over.engine}`,
    turns: t.turns.map((_, i) => ({ index: i, firstVisibleMs: 1000, firstTextMs: 1000, firstToolMs: 2000, totalMs: 5000, outcome: 'completed', reply: 'done', tools: [], modelCalls: 2 })),
    tokens: { input: 1000, cachedInput: 4000, cacheWrite: 0, output: 500 },
    ledgerUsd: over.engine === 'native' ? 0.01 : null,
    ...over,
  };
}

const verdict = (pass: boolean, met = pass, mustSayPass = true): RaceVerdict => ({
  pass,
  criteria: [{ met, why: '' }],
  mustSay: { pass: mustSayPass, missing: [] },
  judgeModel: 'deepseek-v4.1-flash',
});

describe('race judge', () => {
  it('normalises tool names so neither engine is given away', () => {
    expect(blindToolName('mcp__mock-travel__search')).toBe('search');
    expect(blindToolName('mcp__browser-control__computer_screenshot')).toBe('computer_screenshot');
    expect(blindToolName('Bash')).toBe('bash');
  });

  it('shows the judge the work, never the engine, the model, a time or a cost', () => {
    const r = run({
      task: 'data-stats',
      engine: 'claude_code',
      turns: [{ index: 0, firstVisibleMs: 1234, firstTextMs: 1234, firstToolMs: 2345, totalMs: 9876, outcome: 'completed', reply: 'mean 16.90', tools: [{ name: 'mcp__vestra__Bash', input: '{"cmd":"python3"}', result: '16.9', isError: false }], modelCalls: 3 }],
    });
    const text = judgeMessages(task('data-stats'), r).map((m) => m.content).join('\n');
    expect(text).toContain('TOOL CALL bash');
    expect(text).toContain('mean 16.90');
    for (const leak of ['claude_code', 'Claude Code', 'native', 'sonnet', '1234', '9876', 'vestra-data-stats']) expect(text).not.toContain(leak);
  });

  it("grades against the slot's own folder", () => {
    const r = { ...run({ task: 'write-standup', engine: 'native' }), slot: 12 };
    const text = judgeMessages(task('write-standup'), r).map((m) => m.content).join('\n');
    expect(text).toContain('1. Writes the file files/race-12/standup.md.');
    expect(text).toContain('USER:\nWrite files/race-12/standup.md');
  });

  it('cuts the long handbook out of the transcript', () => {
    const t = task('followup-wifi');
    const text = blindTranscript(t, run({ task: t.id, engine: 'native' }));
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('more characters]');
  });

  it('reads only the rubric JSON it asked for', () => {
    expect(parseJudgeReply('{"criteria":[{"met":true,"why":"ok"},{"met":false}]}', 2)).toEqual([
      { met: true, why: 'ok' },
      { met: false, why: '' },
    ]);
    expect(parseJudgeReply('{"criteria":[{"met":true}]}', 2)).toBeNull();
    expect(parseJudgeReply('{"criteria":[{"met":"yes"}]}', 1)).toBeNull();
    expect(parseJudgeReply('not json', 1)).toBeNull();
  });

  const fakeFetch = (content: unknown, status = 200) =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
  const allMet = (n: number) => JSON.stringify({ criteria: Array.from({ length: n }, () => ({ met: true, why: 'ok' })) });

  it('passes a run only when every criterion is met and every fact is in the reply', async () => {
    const t = task('data-stats');
    const good = run({ task: t.id, engine: 'native', turns: [{ ...run({ task: t.id, engine: 'native' }).turns[0]!, reply: 'Mean 16.90, median 16.50, sd 6.41' }] });
    const v = await judgeRun(t, good, { apiKey: 'k', fetchImpl: fakeFetch(allMet(t.rubric.length)) });
    expect(v.pass).toBe(true);
    const missingFact = run({ task: t.id, engine: 'native', turns: [{ ...good.turns[0]!, reply: 'Mean 16.9' }] });
    const v2 = await judgeRun(t, missingFact, { apiKey: 'k', fetchImpl: fakeFetch(allMet(t.rubric.length)) });
    expect(v2.pass).toBe(false);
    expect(v2.mustSay.missing).toContain('16.90');
  });

  it('leaves a run unjudged, never guessed, when the judge fails', async () => {
    const t = task('write-readme');
    const r = run({ task: t.id, engine: 'native' });
    expect((await judgeRun(t, r, { apiKey: 'k', fetchImpl: fakeFetch('', 500) })).judgeError).toBe('judge HTTP 500');
    expect((await judgeRun(t, r, { apiKey: 'k', fetchImpl: fakeFetch('{"criteria":[]}') })).pass).toBeNull();
  });

  it('never judges on an Anthropic model, and only on the Fireworks lane', () => {
    expect(() => assertJudgeModel('claude-sonnet-5-5')).toThrow(/Anthropic/);
    expect(() => assertJudgeModel('gemini-3.8-flash')).toThrow(/Fireworks/);
    expect(() => assertJudgeModel('deepseek-v4.1-flash')).not.toThrow();
  });
});

function file(runs: JudgedRun[]): RaceRunsFile {
  return { schema: RACE_RUNS_SCHEMA, model: 'claude-sonnet-5-5', seed: 7, startedAt: '2026-10-03T10:00:00Z', where: 'staging, drill account', runs };
}

describe('race report', () => {
  it('prices tokens at list with the shared pricer', () => {
    expect(listPriceUsd('claude-sonnet-5-5', { input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0 })).toBe(2);
    expect(listPriceUsd('claude-sonnet-5-5', { input: 0, cachedInput: 0, cacheWrite: 0, output: 1_000_000 })).toBe(10);
  });

  it('builds one row per task with both engines, the medians and the head-to-head', () => {
    const runs = [
      { ...run({ task: 'data-stats', engine: 'native' }), verdict: verdict(true) },
      { ...run({ task: 'data-stats', engine: 'native', run: 2, turns: [{ ...run({ task: 'data-stats', engine: 'native' }).turns[0]!, totalMs: 7000 }] }), verdict: verdict(true) },
      { ...run({ task: 'data-stats', engine: 'claude_code', turns: [{ ...run({ task: 'data-stats', engine: 'claude_code' }).turns[0]!, totalMs: 9000, firstVisibleMs: 3000 }] }), verdict: verdict(false) },
      { ...run({ task: 'write-readme', engine: 'native' }), verdict: verdict(true) },
      { ...run({ task: 'write-readme', engine: 'claude_code' }), verdict: verdict(true) },
      { ...run({ task: 'app-cheapest', engine: 'claude_code' }), skipped: 'no plan' },
    ];
    const r = buildReport(file(runs), runs, 'deepseek-v4.1-flash');
    expect(r.engines).toEqual(['native', 'claude_code']);
    expect(r.rows.map((x) => x.task)).toEqual(['write-readme', 'data-stats']);
    const stats = r.rows[1]!;
    expect(stats.engines.native).toMatchObject({ runs: 2, totalMs: 6000, passed: 2, judged: 2 });
    expect(stats.engines.claude_code).toMatchObject({ runs: 1, totalMs: 9000, firstVisibleMs: 3000, firstTextMs: 1000, passed: 0, judged: 1 });
    expect(r.headToHead!.totalMs).toEqual({ native: 1, claude_code: 0, tie: 1 });
    expect(r.headToHead!.firstVisibleMs).toEqual({ native: 1, claude_code: 0, tie: 1 });
    expect(r.totals.native).toMatchObject({ runs: 3, passed: 3, judged: 3, skipped: 0, ledgerUsd: 0.03 });
    expect(r.totals.claude_code).toMatchObject({ runs: 2, passed: 1, judged: 2, skipped: 1, ledgerUsd: null });
    expect(r.skipped).toEqual([{ task: 'app-cheapest', engine: 'claude_code', run: 1, reason: 'no plan' }]);
    expect(r.totals.native!.byCategory.data).toEqual({ passed: 2, judged: 2 });
  });

  it('counts a timed-out turn as no time and a failure', () => {
    const timedOut = run({ task: 'data-stats', engine: 'native', turns: [{ index: 0, firstVisibleMs: null, firstTextMs: null, firstToolMs: null, totalMs: null, outcome: 'timeout', reply: '', tools: [], modelCalls: null }] });
    const r = buildReport(file([timedOut]), [{ ...timedOut, verdict: verdict(false) }], null);
    expect(r.rows[0]!.engines.native!.totalMs).toBeNull();
    expect(r.totals.native).toMatchObject({ timedOut: 1, passed: 0 });
  });

  it('asks for the telling checks first, then one per kind, ten at most', () => {
    const runs: JudgedRun[] = RACE_TASKS.flatMap((t) => [
      { ...run({ task: t.id, engine: 'native' }), verdict: verdict(true) },
      { ...run({ task: t.id, engine: 'claude_code' }), verdict: verdict(t.id !== 'data-stats') },
    ]);
    runs.find((r) => r.task === 'write-readme' && r.engine === 'native')!.verdict = verdict(false, true, false);
    const r = buildReport(file(runs), runs, 'deepseek-v4.1-flash');
    expect(r.spotCheck).toHaveLength(10);
    expect(r.spotCheck[0]).toMatchObject({ task: 'write-readme', why: 'the engines disagree: one passed, the other did not' });
    expect(r.spotCheck[1]).toMatchObject({ task: 'data-stats' });
    expect(new Set(r.spotCheck.map((s) => s.category))).toEqual(new Set(RACE_CATEGORIES));
    expect(r.spotCheck[0]!.runs.map((x) => x.taskId)).toEqual(['vestra-write-readme-native', 'vestra-write-readme-claude_code']);
    expect(pickSpotChecks(r.rows.slice(0, 3), runs)).toHaveLength(3);
  });

  it('keeps tool inputs and results out of the report JSON', () => {
    const base = run({ task: 'data-stats', engine: 'native' });
    const r0 = { ...base, turns: [{ ...base.turns[0]!, tools: [{ name: 'bash', input: '{"command":"env"}', result: 'BOX_VALUE=1', isError: false }] }] };
    const r = buildReport(file([r0]), [r0], null);
    expect(JSON.stringify(r)).not.toContain('BOX_VALUE');
    expect(r.runs[0]!.turns[0]!.tools[0]).toEqual({ name: 'bash', input: '[omitted]', result: '[omitted]', isError: false });
  });

  it('takes a median of an even count as the mean of the middle pair', () => {
    expect(median([1, 9])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
});

describe('race page', () => {
  const both = (() => {
    const runs: JudgedRun[] = [
      { ...run({ task: 'data-stats', engine: 'native' }), verdict: verdict(true) },
      { ...run({ task: 'data-stats', engine: 'claude_code', turns: [{ ...run({ task: 'data-stats', engine: 'claude_code' }).turns[0]!, totalMs: 10_000 }] }), verdict: verdict(true) },
    ];
    return buildReport(file(runs), runs, 'deepseek-v4.1-flash');
  })();

  it('writes a whole page with no em or en dash and every dimension', () => {
    const html = renderRaceHtml(both);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/[\u2013\u2014]/);
    for (const h of ['Speed', 'Model calls', 'Tokens', 'Dollars', 'Success', 'Check these ten by hand', 'How it was run']) expect(html).toContain(`<h2>${h}</h2>`);
    expect(html).toContain('<title>Native vs Claude Code on Sonnet 5.5</title>');
    expect(html).not.toContain('<script');
  });

  it('says in plain words who was faster, and that Claude Code ran on the plan', () => {
    const s = summarySentences(both).join(' ');
    expect(s).toContain('median 5.0 s on native and 10.0 s on Claude Code');
    expect(s).toContain('not what was paid');
    expect(compareLower(5000, 10_000)).toBe('2.0x lower');
    expect(compareLower(5000, 5100)).toBe('about the same');
    expect(compareLower(null, 1)).toBe('not comparable yet');
  });

  it('calls a one-engine report a dry run, not the race', () => {
    const one = run({ task: 'data-stats', engine: 'native', model: 'deepseek-v4.1-flash' });
    const r = buildReport({ ...file([one]), model: 'deepseek-v4.1-flash' }, [{ ...one, verdict: verdict(true) }], 'deepseek-v4.1-flash');
    const html = renderRaceHtml(r);
    expect(html).toContain('<title>Race dry run on DeepSeek V4.1 Flash</title>');
    expect(summarySentences(r).join(' ')).toContain('dry run of the race harness, not the race');
  });
});

describe('race CLI', () => {
  it('refuses an unknown command or option, and an option with no value', () => {
    expect(() => parseRaceArgs(['go'])).toThrow(/plan or report/);
    expect(() => parseRaceArgs(['plan', '--outt', 'x'])).toThrow(/unknown argument/);
    expect(() => parseRaceArgs(['report', '--in'])).toThrow(/needs a value/);
    expect(parseRaceArgs(['plan', '--out', 'p.json', '--seed', '3'])).toEqual({ command: 'plan', opts: { out: 'p.json', seed: '3' } });
  });

  it('joins one runs file per engine, and refuses files from different races', () => {
    const a = { ...file([run({ task: 'data-stats', engine: 'native', slot: 2 })]), where: 'native account', startedAt: '2026-10-03T11:00:00Z' };
    const b = { ...file([run({ task: 'data-stats', engine: 'claude_code', slot: 1 })]), where: 'cc account' };
    const m = mergeRunsFiles([a, b]);
    expect(m.runs.map((r) => r.slot)).toEqual([1, 2]);
    expect(m.where).toBe('native account; cc account');
    expect(m.startedAt).toBe('2026-10-03T10:00:00Z');
    expect(() => mergeRunsFiles([a, { ...b, seed: 8 }])).toThrow(/different races/);
  });

  it('judges every run that ran and leaves skipped ones alone', async () => {
    const runs = [run({ task: 'data-stats', engine: 'native' }), { ...run({ task: 'app-cheapest', engine: 'native' }), skipped: 'no travel' }];
    const judged = await judgeAll(file(runs), async () => verdict(true));
    expect(judged[0]!.verdict?.pass).toBe(true);
    expect(judged[1]!.verdict).toBeUndefined();
  });
});
