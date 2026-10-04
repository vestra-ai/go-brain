/**
 * tool-output-budget.test.ts — C2 (TOOL_OUTPUT_TOKEN_BUDGET_V1): tool output budgets in
 * tokens, per model. Driven through the REAL `gateAndDispatchTool` chokepoint and the REAL
 * Bash tool against a temp filesystem, so a pass proves what the model is sent and what
 * lands on disk, not what a stub says.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import { activeToolOutputTokenBudget, DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET } from '../context-offload.js';
import { guardToolOutput, TOOL_OUTPUT_MAX_CHARS } from '../tool-output-guard.js';
import { truncateOutput, truncateToTokenBudget } from '../../tools/output-limits.js';
import { makeBashTool } from '../../tools/bash-tool.js';
import { makeReadTool } from '../../tools/read-tool.js';
import { estimateTokens } from '../../kernel/journal/token-ledger.js';
import type { RawToolOptions } from '../../tools/tool-types.js';

// A model row carrying its own budget. The real registry seeds none yet (every row takes
// the 10,000 default), so the per-model path is proven against one synthetic row that
// otherwise IS claude-sonnet-5-5.
const PROBE = 'budget-probe-model';
vi.mock('../../contract/model-capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contract/model-capabilities.js')>();
  return {
    ...actual,
    resolveCapabilities: (id: string) =>
      id === 'budget-probe-model'
        ? { ...actual.resolveCapabilities('claude-sonnet-5-5'), id, toolOutputTokenBudget: 2_000 }
        : actual.resolveCapabilities(id),
  };
});

const FLAG = 'TOOL_OUTPUT_TOKEN_BUDGET_V1';
const MODEL = 'claude-sonnet-5-5'; // 1M window: the char offload threshold is 80,000 chars
const workingDir = join(tmpdir(), `tool-output-budget-test-${process.pid}`);
const gate = { gateTool: vi.fn(async () => ({ decision: 'allow' as const })) };
const onPause = async () => 'PAUSED_HALT';

// ~2.1 MB of command output with a marker at each end.
const ROWS = 55_000;
function expectedOutput(): string {
  let s = 'HEAD-MARK\n';
  for (let i = 0; i < ROWS; i++) s += `row ${i} lorem ipsum dolor sit amet\n`;
  return `${s}TAIL-MARK\n`;
}
const FULL = expectedOutput();

beforeAll(async () => {
  await fs.mkdir(workingDir, { recursive: true });
  await fs.writeFile(
    join(workingDir, 'gen.js'),
    `let s='HEAD-MARK\\n';for(let i=0;i<${ROWS};i++)s+='row '+i+' lorem ipsum dolor sit amet\\n';process.stdout.write(s+'TAIL-MARK\\n');`,
  );
  await fs.writeFile(
    join(workingDir, 'gen5.js'),
    `process.stdout.write('HEAD-MARK\\n'+'row lorem ipsum dolor sit amet\\n'.repeat(170000)+'TAIL-MARK\\n');`,
  );
});
afterAll(async () => { await fs.rm(workingDir, { recursive: true, force: true }); });
afterEach(async () => { await fs.rm(join(workingDir, '.kernel-offload'), { recursive: true, force: true }); });

const textTool = (text: string): RawToolOptions => ({
  name: 'BigTool', description: 'test', parameters: { type: 'object', properties: {} } as any, execute: async () => text,
});
const bash = (taskId: string) => makeBashTool(() => workingDir, taskId);
const spillOf = (taskId: string, callId: string) => `.kernel-offload/${taskId}/${callId}.txt`;
// ~7,500 tokens of prose: under the 10,000 default, over the probe row's 2,000.
const MID = 'lorem ipsum dolor sit amet\n'.repeat(1_111);

describe('C2 — flag ON', () => {
  beforeEach(() => { process.env[FLAG] = '1'; });
  afterEach(() => { delete process.env[FLAG]; });

  it('budget: 2 MB command output costs at most the model budget', async () => {
    expect(FULL.length).toBeGreaterThan(2_000_000);
    const r = await gateAndDispatchTool(bash('task-c2'), { command: 'node gen.js' }, 'call-2mb', gate as any, onPause, undefined,
      { taskId: 'task-c2', workingDir, model: MODEL });
    expect(r.isError).toBe(false);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(estimateTokens(r.text)).toBeGreaterThan(0.7 * DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET); // filled, not a 3K stub
    expect(r.text.startsWith('HEAD-MARK')).toBe(true);
    expect(r.text).toContain('TAIL-MARK');
    expect(r.text).toContain(spillOf('task-c2', 'call-2mb'));
    // The spill holds the FULL output: nothing was thrown away before it was written.
    expect(await fs.readFile(join(workingDir, spillOf('task-c2', 'call-2mb')), 'utf8')).toBe(FULL);
  }, 30_000);

  it("budget: a failing command's 2 MB output is spilled too, the error stamp intact", async () => {
    const r = await gateAndDispatchTool(bash('task-c2f'), { command: 'node gen.js; exit 3' }, 'call-fail', gate as any, onPause, undefined,
      { taskId: 'task-c2f', workingDir, model: MODEL, toolErrorTaxonomy: true });
    expect(r.isError).toBe(true);
    expect(r.text.endsWith(' [error:exec_failed]')).toBe(true);
    // Guard-then-stamp precedent: the budget binds the body, the stamp rides outside it.
    expect(estimateTokens(r.text.slice(0, -' [error:exec_failed]'.length))).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(r.text).toContain(spillOf('task-c2f', 'call-fail'));
    const onDisk = await fs.readFile(join(workingDir, spillOf('task-c2f', 'call-fail')), 'utf8');
    expect(onDisk).toContain(FULL);
  }, 30_000);

  it('budget: with no sandbox filesystem the result is still held to the budget, head and tail kept', async () => {
    const r = await gateAndDispatchTool(textTool(FULL), {}, 'call-nofs', gate as any, onPause, undefined, { model: MODEL });
    const tokens = estimateTokens(r.text);
    expect(tokens).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(tokens).toBeGreaterThan(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET * 0.9); // fills it: no file to read the rest from
    expect(r.text.startsWith('HEAD-MARK')).toBe(true);
    expect(r.text.endsWith('TAIL-MARK\n')).toBe(true);
    expect(r.text).toContain('redirect to a file');
  });

  it('budget: a result between the budget and the char threshold is spilled (it rode whole before)', async () => {
    const mid = 'lorem ipsum dolor sit amet\n'.repeat(2_300); // ~62K chars, ~15.5K tokens, under 80K chars
    const r = await gateAndDispatchTool(textTool(mid), {}, 'call-mid', gate as any, onPause, undefined,
      { taskId: 'task-mid', workingDir, model: MODEL });
    expect(r.text).toContain(spillOf('task-mid', 'call-mid'));
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(estimateTokens(r.text)).toBeGreaterThan(0.7 * DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
  });

  it('budget: a 5 MB command output hands the spill at most 2 MB, head and tail, with the redirect marker', async () => {
    const r = await gateAndDispatchTool(bash('task-5mb'), { command: 'node gen5.js' }, 'call-5mb', gate as any, onPause, undefined,
      { taskId: 'task-5mb', workingDir, model: MODEL });
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(estimateTokens(r.text)).toBeGreaterThan(0.7 * DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(r.text.startsWith('HEAD-MARK')).toBe(true);
    expect(r.text).toContain('TAIL-MARK');
    expect(r.text).toContain(spillOf('task-5mb', 'call-5mb'));
    expect(r.text).not.toContain('full output'); // the file is Bash's 2 MB cut, not the whole output
    const onDisk = await fs.readFile(join(workingDir, spillOf('task-5mb', 'call-5mb')), 'utf8');
    expect(Buffer.byteLength(onDisk)).toBeLessThanOrEqual(2 * 1024 * 1024 + 1_000);
    expect(onDisk.startsWith('HEAD-MARK')).toBe(true);
    expect(onDisk).toContain('TAIL-MARK');
    expect(onDisk).toContain('> out.txt 2>&1'); // the byte cap's own marker: the whole thing is one redirect away
  }, 30_000);

  it('budget: on a 200K-window model a result under the budget rides whole (the old 20K-char threshold spilled it)', async () => {
    const HAIKU = 'claude-haiku-4-5';
    const on = await gateAndDispatchTool(textTool(MID), {}, 'call-haiku-on', gate as any, onPause, undefined,
      { taskId: 'task-haiku', workingDir, model: HAIKU });
    expect(on.text).toBe(MID);
    await expect(fs.access(join(workingDir, spillOf('task-haiku', 'call-haiku-on')))).rejects.toThrow();

    delete process.env[FLAG];
    const off = await gateAndDispatchTool(textTool(MID), {}, 'call-haiku-off', gate as any, onPause, undefined,
      { taskId: 'task-haiku', workingDir, model: HAIKU });
    expect(off.text).toContain(spillOf('task-haiku', 'call-haiku-off'));
    expect(await fs.readFile(join(workingDir, spillOf('task-haiku', 'call-haiku-off')), 'utf8')).toBe(MID);
  });

  it('budget: the spill notice names the absolute path, and Read opens the file there', async () => {
    const mid = 'lorem ipsum dolor sit amet\n'.repeat(2_300);
    const r = await gateAndDispatchTool(textTool(mid), {}, 'call-abs', gate as any, onPause, undefined,
      { taskId: 'task-abs', workingDir, model: MODEL });
    const abs = join(workingDir, spillOf('task-abs', 'call-abs'));
    expect(abs.startsWith('/')).toBe(true);
    // Absolute, so it does not depend on where the shell's cwd has drifted (drill f5c905bd).
    expect(r.text).toContain(`The output is in ${abs}; Read it with offset/limit.`);
    const read = await makeReadTool(() => workingDir).execute({ file_path: abs, offset: 2_299, limit: 5 }, {});
    expect(read).toContain('2299\tlorem ipsum dolor sit amet');
    expect(read).toContain('2300\tlorem ipsum dolor sit amet');

    // Flag off: the preview still names the relative path, byte-identical.
    delete process.env[FLAG];
    const off = await gateAndDispatchTool(textTool(FULL), {}, 'call-rel', gate as any, onPause, undefined,
      { taskId: 'task-abs', workingDir, model: MODEL });
    expect(off.text).toContain(`Full content: ${spillOf('task-abs', 'call-rel')} — use Read to page through it.`);
    expect(off.text).not.toContain(workingDir);
  });

  it("budget: a spilled Bash output carries no trailing screen clear from the shell's logout, in the result or the file", async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'budget-logout-home-'));
    await fs.writeFile(join(home, '.bash_logout'), "printf '\\033[3J\\033[H\\033[J'\n");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await gateAndDispatchTool(bash('task-clear'), { command: 'node gen.js' }, 'call-clear', gate as any, onPause, undefined,
        { taskId: 'task-clear', workingDir, model: MODEL });
      expect(r.text.endsWith('TAIL-MARK\n')).toBe(true);
      expect(await fs.readFile(join(workingDir, spillOf('task-clear', 'call-clear')), 'utf8')).toBe(FULL);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('budget: per-model override', async () => {
    expect(activeToolOutputTokenBudget(PROBE)).toBe(2_000);
    expect(activeToolOutputTokenBudget(MODEL)).toBe(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(activeToolOutputTokenBudget('some-unknown-model')).toBe(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);
    expect(activeToolOutputTokenBudget(undefined)).toBe(DEFAULT_TOOL_OUTPUT_TOKEN_BUDGET);

    const dispatch = (model: string, callId: string, withFs: boolean) =>
      gateAndDispatchTool(textTool(MID), {}, callId, gate as any, onPause, undefined,
        { model, ...(withFs && { taskId: 'task-pm', workingDir }) });
    // The same ~7,500-token result: whole on the default row, spilled on the 2,000-token row.
    expect((await dispatch(MODEL, 'call-default', true)).text).toBe(MID);
    const probe = await dispatch(PROBE, 'call-probe', true);
    expect(probe.text).toContain(spillOf('task-pm', 'call-probe'));
    expect(estimateTokens(probe.text)).toBeLessThanOrEqual(2_000);
    expect(estimateTokens(probe.text)).toBeGreaterThan(0.7 * 2_000);
    const noFs = await dispatch(PROBE, 'call-probe-nofs', false);
    expect(estimateTokens(noFs.text)).toBeLessThanOrEqual(2_000);
    expect(estimateTokens(noFs.text)).toBeGreaterThan(1_800);
  });
});

describe('C2 — flag OFF (byte-identical)', () => {
  beforeEach(() => { delete process.env[FLAG]; });

  it('budget off: byte-identical (the 50 KB and 262,144-character limits unchanged)', async () => {
    expect(activeToolOutputTokenBudget(MODEL)).toBeUndefined();
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(262_144);

    // Bash still cuts at 50 KB, and 50 KB is under this model's 80K-char offload bar.
    const r = await gateAndDispatchTool(bash('task-off'), { command: 'node gen.js' }, 'call-off', gate as any, onPause, undefined,
      { taskId: 'task-off', workingDir, model: MODEL });
    expect(r.text).toBe(truncateOutput(FULL, 50_000).text);
    await expect(fs.access(join(workingDir, '.kernel-offload'))).rejects.toThrow();

    // The dispatch-boundary hard cap, untouched with no sandbox filesystem.
    const huge = 'q'.repeat(TOOL_OUTPUT_MAX_CHARS + 5_000);
    const capped = await gateAndDispatchTool(textTool(huge), {}, 'call-cap', gate as any, onPause, undefined, { model: MODEL });
    expect(capped.text).toBe(guardToolOutput(huge));

    // Between the budget and the char threshold a result still rides whole.
    const mid = 'lorem ipsum dolor sit amet\n'.repeat(2_300);
    const whole = await gateAndDispatchTool(textTool(mid), {}, 'call-mid-off', gate as any, onPause, undefined,
      { taskId: 'task-off', workingDir, model: MODEL });
    expect(whole.text).toBe(mid);
  }, 30_000);
});

describe('truncateToTokenBudget', () => {
  it('leaves an in-budget text untouched', () => {
    expect(truncateToTokenBudget('small', 100)).toEqual({ text: 'small', truncated: false });
  });

  it('holds word-dense text to the budget (the word estimate, not chars, decides)', () => {
    const out = truncateToTokenBudget('a '.repeat(50_000), 1_000);
    expect(out.truncated).toBe(true);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(1_000);
  });

  it('names the spill path when there is one, and never splits a surrogate pair', () => {
    const out = truncateToTokenBudget('\u{1F600}'.repeat(40_000), 1_000, '.kernel-offload/t/c.txt');
    expect(out.text).toContain('.kernel-offload/t/c.txt');
    expect(out.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
