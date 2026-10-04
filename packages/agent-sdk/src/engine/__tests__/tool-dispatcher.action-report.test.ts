/**
 * tool-dispatcher.action-report.test.ts — Task 5 (S2a) of native-arm computer use.
 *
 * The sandbox's browser tools mint a BrowserActionReport and attach it to the
 * ToolResult envelope as a SIBLING of `content`
 * (`{ content: [...], isError?, report? }` — apps/sandbox/src/mcp/computer-use-tools.ts).
 * Task 5 plumbs that report through the native arm: dispatcher lift → engine
 * yield → journal persist → contract types.
 *
 * DEPENDENCY NOTE: @vestra/agent-sdk deliberately does NOT depend on
 * @bash/shared, so the field is `report?: unknown` at the contract layer and the
 * dispatcher applies only a MINIMAL structural check (object with `v === 1` and a
 * string `tool`). The full `isBrowserActionReport` guard runs at the sandbox
 * boundary (apps/sandbox imports both packages).
 *
 * Pins:
 *  1. An envelope carrying a report lifts it VERBATIM — text/blocks/isError stay
 *     EXACTLY the Task-1 image-result expectations (asserted verbatim here).
 *  2. Junk on the `report` field (fails the structural check) is DROPPED.
 *  3. The journal appenders persist the field verbatim (and it survives a
 *     recycle re-projection).
 *  4. A result WITHOUT a report round-trips byte-identical to today — no
 *     `report` key ever appears (regression pin).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAndDispatchTool } from '../tool-dispatcher.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult, HarnessContext } from '../../contract/harness.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { NativeConfigLike } from '../native-config-like.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import { appendToolResultEntry, appendToolResultByTaskId } from '../native-journal.js';

// ── Helpers (mirrors tool-dispatcher.image-result.test.ts) ──────────────────

const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

function toolReturning(result: unknown, name = 'computer_click'): RawToolOptions {
  return {
    name,
    description: 'browser control',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => result),
  };
}

function browserToolReturning(result: unknown, name = 'computer_click'): RawToolOptions {
  return { ...toolReturning(result, name), returnsContentBlocks: true };
}

/** A fully-populated, wire-real BrowserActionReport (shape from
 *  packages/shared/src/computer-use/action-report.ts — structurally typed here
 *  because agent-sdk has no @bash/shared dependency). */
const REPORT = {
  v: 1,
  tool: 'computer_click',
  mode: 'ref',
  target: { ref: '42', role: 'button', label: 'Submit order' },
  url: 'https://shop.example/checkout',
  verified: true,
  effect: 'confirmed',
  risk: 'low',
  riskReasons: [],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Lift — text/blocks byte-identical to the Task-1 expectations, report rides.
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — action-report lift (Task 5)', () => {
  it('1. text+image envelope WITH report → report lifted verbatim; text/blocks/isError EXACTLY the Task-1 expectations', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mimeType: 'image/jpeg' },
      ],
      report: REPORT,
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu1', allowGate() as never, NOOP_PAUSE);

    // Task-1 image-result expectations, verbatim — the report is a pure ADD.
    expect(r.blocks).toEqual([
      { type: 'text', text: 'Navigated to https://x' },
      { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
    ]);
    expect(r.text).toBe('Navigated to https://x');
    expect(r.isError).toBe(false);
    // The report rides verbatim (same reference — never cloned/normalized).
    expect(r.report).toBe(REPORT);
  });

  it('2. text-only ERROR envelope WITH report → report still lifted (blocks undefined, isError true — the errorResult path)', async () => {
    // Real shape: finishWithReport() attaches a report to errorResult()'s
    // text-only envelope — risk reporting on failures must not be dropped.
    const tool = browserToolReturning({
      content: [{ type: 'text', text: 'computer_click: no browser session' }],
      isError: true,
      report: { ...REPORT, verified: false, effect: 'unverifiable' },
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu2', allowGate() as never, NOOP_PAUSE);

    // Task-1 text-only-error expectations, verbatim.
    expect(r.blocks).toBeUndefined();
    expect(r.isError).toBe(true);
    expect(r.text).toBe('computer_click: no browser session');
    expect(r.report).toEqual({ ...REPORT, verified: false, effect: 'unverifiable' });
  });

  it('3. junk report shapes are DROPPED (fail the minimal structural check)', async () => {
    const junkShapes: unknown[] = [
      { v: 2, tool: 'computer_click' }, // wrong version
      { tool: 'computer_click' }, // missing v
      { v: 1 }, // missing tool
      { v: 1, tool: 42 }, // tool not a string
      'v1:computer_click', // not an object
      42,
      null,
      [{ v: 1, tool: 'computer_click' }], // array, not a record
    ];
    for (const junk of junkShapes) {
      const tool = browserToolReturning({
        content: [
          { type: 'text', text: 'Navigated to https://x' },
          { type: 'image', data: 'B64', mimeType: 'image/jpeg' },
        ],
        report: junk,
      });
      const r = await gateAndDispatchTool(tool, {}, 'tu3', allowGate() as never, NOOP_PAUSE);

      expect(r.report, `junk shape not dropped: ${JSON.stringify(junk)}`).toBeUndefined();
      expect('report' in r, `junk shape leaked a report key: ${JSON.stringify(junk)}`).toBe(false);
      // The content channel is untouched by a dropped report.
      expect(r.blocks).toEqual([
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
      ]);
      expect(r.text).toBe('Navigated to https://x');
    }
  });

  it('4. REGRESSION PIN — envelope without report → result carries NO report key (byte-identical to Task 1)', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mimeType: 'image/jpeg' },
      ],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu4', allowGate() as never, NOOP_PAUSE);

    // The FULL result object is byte-identical to today's shape — key-for-key.
    expect(r).toStrictEqual({
      toolUseId: 'tu4',
      text: 'Navigated to https://x',
      isError: false,
      blocks: [
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
      ],
    });
    expect('report' in r).toBe(false);
  });

  it('5. flagless (Composio-path) envelope WITH report → JSON.stringify flatten, NO lift (byte-identical)', async () => {
    // Without returnsContentBlocks the envelope is never unwrapped — the report
    // must not leak onto the Composio/built-in path.
    const envelope = { content: [{ type: 'text', text: 'email sent' }], report: REPORT };
    const tool = toolReturning(envelope, 'mcp__composio__GMAIL_SEND');
    const r = await gateAndDispatchTool(tool, {}, 'tu5', allowGate() as never, NOOP_PAUSE);

    expect('report' in r).toBe(false);
    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe(JSON.stringify(envelope));
  });

  // Hard cap on the lifted report's JSON size — mirrors ACTION_REPORT_MAX_JSON_CHARS
  // in tool-dispatcher.ts. Above it the report is DROPPED whole (a truncated
  // structured object is worse than an absent one), the content channel untouched.
  const REPORT_CAP = 16_384;

  it('6. OVERSIZED report (stringified JSON > 16KB) is DROPPED whole — text/blocks/isError unchanged', async () => {
    // Structurally valid (v:1 + string tool) but ballooned — the probe shape:
    // a hostile page can only reach the report through minted fields, but the
    // lift guard must hold regardless of mint bugs (defense in depth).
    const oversized = { v: 1, tool: 'computer_click', riskReasons: ['x'.repeat(REPORT_CAP)] };
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mimeType: 'image/jpeg' },
      ],
      report: oversized,
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu6', allowGate() as never, NOOP_PAUSE);

    expect(r.report).toBeUndefined();
    expect('report' in r).toBe(false);
    // The content channel is untouched by the drop.
    expect(r.blocks).toEqual([
      { type: 'text', text: 'Navigated to https://x' },
      { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
    ]);
    expect(r.text).toBe('Navigated to https://x');
    expect(r.isError).toBe(false);
  });

  it('7. report exactly AT the 16KB cap still lifts (boundary is >, not >=) — normal reports unaffected', async () => {
    const base = { v: 1, tool: 'computer_click', pad: '' };
    const atCap = { ...base, pad: 'x'.repeat(REPORT_CAP - JSON.stringify(base).length) };
    expect(JSON.stringify(atCap)).toHaveLength(REPORT_CAP);
    const tool = browserToolReturning({
      content: [{ type: 'text', text: 'Clicked' }],
      report: atCap,
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu7', allowGate() as never, NOOP_PAUSE);

    expect(r.report).toBe(atCap); // lifted verbatim, same reference
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Journal — persists the report verbatim; no-report path byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

const dir = join(tmpdir(), `tool-dispatcher-action-report-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const make = (taskId = 't') =>
  new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });

const ctxFor = (taskId = 't', userId = 'u'): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId } } }) as unknown as HarnessContext<NativeConfigLike>;

const readAll = async (j: Journal): Promise<JournalEntry[]> => {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
};

const toolResultPayload = (e: JournalEntry) =>
  e.payload as Extract<JournalEntry['payload'], { type: 'tool_result' }>;

describe('native-journal — persists the action report verbatim (Task 5)', () => {
  it('appendToolResultEntry writes r.report verbatim alongside blocks', async () => {
    const j = make();
    await appendToolResultEntry(j, ctxFor(), {
      toolUseId: 'tu-j1',
      text: 'Clicked Submit order',
      isError: false,
      blocks: [{ type: 'text', text: 'Clicked Submit order' }],
      report: REPORT,
    });
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(toolResultPayload(tr!).report).toEqual(REPORT);
    expect(toolResultPayload(tr!).blocks).toEqual([{ type: 'text', text: 'Clicked Submit order' }]);
  });

  it('appendToolResultByTaskId writes r.report verbatim', async () => {
    const j = make();
    await appendToolResultByTaskId(
      j,
      't',
      { toolUseId: 'tu-j2', text: 'Clicked', isError: false, report: REPORT },
      'u',
    );
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    expect(toolResultPayload(tr!).report).toEqual(REPORT);
  });

  it('REGRESSION PIN — no report on the result → the persisted payload has NO report key (byte-identical to today)', async () => {
    const j = make();
    await appendToolResultEntry(j, ctxFor(), {
      toolUseId: 'tu-j3',
      text: 'plain result',
      isError: false,
    });
    const tr = (await readAll(j)).find((e) => e.payload.type === 'tool_result');
    // Key-for-key strict equality: today's exact payload shape, nothing added.
    expect(tr!.payload).toStrictEqual({
      type: 'tool_result',
      toolUseId: 'tu-j3',
      blocks: [{ type: 'text', text: 'plain result' }],
      isError: false,
    });
    expect('report' in tr!.payload).toBe(false);
  });

  it('recycle round-trip — a fresh Journal over the same files still carries the report verbatim', async () => {
    const j1 = make('t-resume');
    await j1.append({
      taskId: 't-resume', rootTaskId: 't-resume', spawnDepth: 0, workspaceId: 'w', agentId: 'native',
      principal: { kind: 'user', userId: 'u' }, timestamp: '',
      payload: { type: 'user', blocks: [{ type: 'text', text: 'click submit' }] },
    });
    await j1.append({
      taskId: 't-resume', rootTaskId: 't-resume', spawnDepth: 0, workspaceId: 'w', agentId: 'native',
      principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
      payload: { type: 'tool_use', toolUseId: 'tu-click', name: 'computer_click', input: { ref: '42' } },
    });
    await appendToolResultEntry(j1, ctxFor('t-resume'), {
      toolUseId: 'tu-click',
      text: 'Clicked Submit order',
      isError: false,
      report: REPORT,
    });

    // Simulate a recycle: fresh Journal over the same on-disk files, re-project.
    const j2 = make('t-resume');
    const { messages } = await j2.project();
    const tr = messages.find((m) => m.payload.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(toolResultPayload(tr!).report).toEqual(REPORT);
  });
});
