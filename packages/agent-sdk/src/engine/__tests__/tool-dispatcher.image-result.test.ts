/**
 * tool-dispatcher.image-result.test.ts — Task 1 (ROOT) of native-arm browser control.
 *
 * The native tool dispatcher (`gateAndDispatchTool`) used to flatten EVERY tool
 * result to text via `JSON.stringify`, destroying screenshots returned by the
 * browser-control tools as the `{ content: [{type:'text'}|{type:'image'}], isError? }`
 * envelope (the exact shape from apps/sandbox/src/mcp/computer-use-tools.ts).
 *
 * Task 1 adds an OPT-IN `blocks?: ContentBlock[]` carrier on the SUCCESS return:
 * the `{content:[...]}` envelope with ≥1 VALID image is destructured into ordered
 * text+image ContentBlocks; everything else stays byte-identical to today.
 *
 * This is also the FIRST test file for tool-dispatcher.ts — so it covers the
 * pre-existing string / JSON.stringify / catch-error / deny / ask / pausedHalt /
 * PostToolUse-rewrite branches too, to hold the 85% line+function coverage floor.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateAndDispatchTool, dispatchTool } from '../tool-dispatcher.js';
import { BROWSER_CONTROL_DENY_MESSAGE } from '../../policy/index.js';
import type { RawToolOptions } from '../../tools/tool-types.js';
import type { ToolCall, GateResult } from '../../contract/harness.js';
import { BINARY_REFUSAL } from '../tool-output-guard.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A gate that always returns the supplied verdict. */
const gateOf = (verdict: GateResult) => ({ gateTool: vi.fn(async (_call: ToolCall) => verdict) });
const allowGate = () => gateOf({ decision: 'allow' });
const NOOP_PAUSE = async () => 'PAUSED_HALT';

/** Build a RawToolOptions whose execute returns `result` (NO content-block opt-in:
 * the Composio/built-in path — results flatten to text exactly as before). */
function toolReturning(result: unknown, name = 'computer_screenshot'): RawToolOptions {
  return {
    name,
    description: 'browser control',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => result),
  };
}

/** Build a browser-control RawToolOptions that OPTS IN to `{content:[...]}` envelope
 * unwrapping via `returnsContentBlocks` — only the in-process browser tools do this. */
function browserToolReturning(result: unknown, name = 'computer_screenshot'): RawToolOptions {
  return { ...toolReturning(result, name), returnsContentBlocks: true };
}

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Image envelope: text + image → ordered blocks, joined text, mimeType→mediaType
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — image-result extraction (Task 1)', () => {
  it('1. text+image envelope → ordered blocks (mimeType→mediaType), joined text, isError:false', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'Navigated to https://x' },
        { type: 'image', data: 'B64', mimeType: 'image/jpeg' },
      ],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu1', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toEqual([
      { type: 'text', text: 'Navigated to https://x' },
      { type: 'image', data: 'B64', mediaType: 'image/jpeg' },
    ]);
    // NOT JSON.stringify of the envelope — the joined text item.
    expect(r.text).toBe('Navigated to https://x');
    expect(r.isError).toBe(false);
  });

  it('2. envelope isError:true → result isError:true AND blocks still carried', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'partial' },
        { type: 'image', data: 'B64', mimeType: 'image/png' },
      ],
      isError: true,
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu2', allowGate() as never, NOOP_PAUSE);

    expect(r.isError).toBe(true);
    expect(r.blocks).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'image', data: 'B64', mediaType: 'image/png' },
    ]);
    expect(r.text).toBe('partial');
  });

  it('3. screenshot-only envelope → text === "[screenshot]" (non-empty), blocks carries the image', async () => {
    const tool = browserToolReturning({
      content: [{ type: 'image', data: PNG_1x1, mimeType: 'image/png' }],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu3', allowGate() as never, NOOP_PAUSE);

    expect(r.text).toBe('[screenshot]');
    expect(r.text).not.toBe('');
    expect(r.blocks).toEqual([{ type: 'image', data: PNG_1x1, mediaType: 'image/png' }]);
    expect(r.isError).toBe(false);
  });

  it('4. text-only error envelope → blocks undefined, isError OR-ed true, joined text', async () => {
    const tool = browserToolReturning({
      content: [{ type: 'text', text: 'computer_screenshot: no browser session' }],
      isError: true,
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu4', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    expect(r.isError).toBe(true);
    expect(r.text).toBe('computer_screenshot: no browser session');
  });

  it('6. non-allowlisted/empty mimeType degrades to a TextBlock placeholder; valid jpeg passes through', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'image', data: 'BAD', mimeType: 'image/svg+xml' }, // not allowlisted
        { type: 'image', data: 'EMPTY', mimeType: '' }, // empty
        { type: 'image', data: 'OK', mimeType: 'image/jpeg' }, // valid
      ],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu6', allowGate() as never, NOOP_PAUSE);

    // The two bad images degrade to TextBlock placeholders (NEVER an ImageBlock with
    // an undefined/empty mediaType); the valid jpeg passes through as an ImageBlock.
    expect(r.blocks).toEqual([
      { type: 'text', text: '[image]' },
      { type: 'text', text: '[image]' },
      { type: 'image', data: 'OK', mediaType: 'image/jpeg' },
    ]);
    // No ImageBlock ever carries an undefined/empty mediaType.
    for (const b of r.blocks ?? []) {
      if (b.type === 'image') {
        expect(b.mediaType).toBeTruthy();
      }
    }
    expect(r.isError).toBe(false);
  });

  it('6b. image with MISSING mimeType degrades to a TextBlock placeholder (never an ImageBlock)', async () => {
    const tool = browserToolReturning({
      content: [{ type: 'image', data: 'NO_MIME' }],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu6b', allowGate() as never, NOOP_PAUSE);

    // No VALID image present → blocks stays undefined (the text path).
    expect(r.blocks).toBeUndefined();
    // The placeholder still produces non-empty text via the fallback.
    expect(r.text).toBe('[image]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Byte-identical invariants — plain string + plain non-content object.
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — byte-identical text path (no image channel)', () => {
  it('5a. plain string result → blocks undefined, text === the string (verbatim)', async () => {
    const tool = toolReturning('ran the bash command\nline 2', 'Bash');
    const r = await gateAndDispatchTool(tool, {}, 'tu5a', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe('ran the bash command\nline 2');
    expect(r.isError).toBe(false);
  });

  it('5b. plain non-content object → blocks undefined, text === JSON.stringify(obj)', async () => {
    const obj = { ok: true, rows: [1, 2, 3], nested: { a: 'b' } };
    const tool = toolReturning(obj, 'SomeTool');
    const r = await gateAndDispatchTool(tool, {}, 'tu5b', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe(JSON.stringify(obj));
    expect(r.isError).toBe(false);
  });

  it('5c. Composio byte-identity: flagless {content:[text]} → text === JSON.stringify(result), blocks undefined', async () => {
    // Composio MCP results are ALSO {content:[...]}-shaped (server.callTool returns the
    // raw MCP envelope). Without the opt-in flag they MUST flatten exactly as before
    // (JSON.stringify) — the live Composio shipping path is untouched by this feature.
    const composioResult = { content: [{ type: 'text', text: 'email sent' }] };
    const tool = toolReturning(composioResult, 'mcp__composio__GMAIL_SEND');
    const r = await gateAndDispatchTool(tool, {}, 'tu5c', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe(JSON.stringify(composioResult));
    expect(r.isError).toBe(false);
  });

  it('5d. Composio byte-identity: flagless {content:[image]} → JSON.stringify, image NOT extracted', async () => {
    const composioResult = { content: [{ type: 'image', data: 'B64', mimeType: 'image/jpeg' }] };
    const tool = toolReturning(composioResult, 'mcp__composio__SOME_IMAGE_TOOL');
    const r = await gateAndDispatchTool(tool, {}, 'tu5d', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe(JSON.stringify(composioResult));
  });

  it('5e. flagged {content:[text,text]} (no image) → joined text, blocks undefined', async () => {
    const tool = browserToolReturning({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    const r = await gateAndDispatchTool(tool, {}, 'tu5e', allowGate() as never, NOOP_PAUSE);

    expect(r.blocks).toBeUndefined();
    // Multiple text items are joined with newlines (the flagged no-image branch).
    expect(r.text).toBe('first\nsecond');
    expect(r.isError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-9. Sentinel returns stay text-only (NEVER carry blocks).
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — sentinel returns never carry blocks', () => {
  it('7. deny verdict on a browser-control tool → execute NOT called, deny copy, isError, blocks undefined', async () => {
    const tool = toolReturning({ content: [{ type: 'image', data: 'X', mimeType: 'image/jpeg' }] }, 'computer_screenshot');
    const gate = gateOf({ decision: 'deny', message: BROWSER_CONTROL_DENY_MESSAGE });
    const r = await gateAndDispatchTool(tool, {}, 'tu7', gate as never, NOOP_PAUSE);

    expect(tool.execute).not.toHaveBeenCalled();
    expect(r.text).toBe(BROWSER_CONTROL_DENY_MESSAGE);
    expect(r.isError).toBe(true);
    expect(r.blocks).toBeUndefined();
  });

  it('8a. ask/needs_human → onPause called, blocks undefined, pausedHalt:true', async () => {
    const tool = toolReturning({ content: [{ type: 'image', data: 'X', mimeType: 'image/jpeg' }] });
    const gate = gateOf({ decision: 'needs_human', interactionKind: 'credit_approval' });
    const onPause = vi.fn(async () => 'PAUSED_HALT');
    const r = await gateAndDispatchTool(tool, {}, 'tu8a', gate as never, onPause);

    expect(onPause).toHaveBeenCalledOnce();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(r.pausedHalt).toBe(true);
    // A HITL pause is a TYPED outcome now — the pause rides pausedHalt, not isError.
    expect(r.isError).toBe(false);
    expect(r.blocks).toBeUndefined();
    expect(r.text).toBe('PAUSED_HALT');
  });

  it('8b. PreToolUse hook halt → blocks undefined, pausedHalt:true', async () => {
    const tool = toolReturning({ content: [{ type: 'image', data: 'X', mimeType: 'image/jpeg' }] });
    const dispatcher = {
      dispatch: vi.fn(async () => ({ decision: 'halt' as const, stopReason: 'Stopped by hook.' })),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu8b', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );

    expect(r.pausedHalt).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Stopped by hook.');
    expect(r.blocks).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('9. markPausedHalt on an image-bearing tool → blocks undefined, pausedHalt:true (image dropped)', async () => {
    // A tool that emits an image envelope AND signals a parent-turn pause.
    const tool: RawToolOptions = {
      name: 'Agent',
      description: 'subagent',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async (_args, ctx) => {
        ctx.markPausedHalt?.();
        return { content: [{ type: 'image', data: 'SHOT', mimeType: 'image/jpeg' }] };
      }),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu9', allowGate() as never, NOOP_PAUSE, undefined,
      { markPausedHalt: () => {} },
    );

    expect(r.pausedHalt).toBe(true);
    // A subagent markPausedHalt is a TYPED pause — isError:false (rides pausedHalt).
    expect(r.isError).toBe(false);
    // The paused tool's screenshot is intentionally dropped (documented accepted risk).
    expect(r.blocks).toBeUndefined();
  });

  it('9b. Composio auth-halt verdict on an image-bearing result → blocks undefined, pausedHalt:true', async () => {
    // A composio tool that returns an auth-url AND (hypothetically) an image envelope.
    // The auth post-scan fires FIRST and returns the text-only pausedHalt sentinel,
    // so the image is never extracted.
    const tool = toolReturning(
      { toolkit: 'gmail', authUrl: 'https://platform.composio.dev/link/abc123' },
      'mcp__composio__GMAIL_FETCH_EMAILS',
    );
    const onAuthHalt = vi.fn(async () => {});
    const r = await gateAndDispatchTool(
      tool, {}, 'tu9b', allowGate() as never, NOOP_PAUSE, onAuthHalt,
    );

    expect(r.pausedHalt).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.blocks).toBeUndefined();
    expect(onAuthHalt).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Coverage backfill — pre-existing dispatcher branches (no existing test file).
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — pre-existing branch coverage backfill', () => {
  it('dispatchTool is an alias for gateAndDispatchTool', () => {
    expect(dispatchTool).toBe(gateAndDispatchTool);
  });

  it('execute throws → isError:true text result, blocks undefined (catch path)', async () => {
    const tool: RawToolOptions = {
      name: 'Bash',
      description: 'run',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => { throw new Error('exec boom'); }),
    };
    const r = await gateAndDispatchTool(tool, {}, 'tu-throw', allowGate() as never, NOOP_PAUSE);

    expect(r.isError).toBe(true);
    expect(r.text).toContain('exec boom');
    expect(r.blocks).toBeUndefined();
  });

  it('execute throws a non-Error → text === String(err)', async () => {
    const tool: RawToolOptions = {
      name: 'Bash',
      description: 'run',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => { throw 'plain string error'; }),
    };
    const r = await gateAndDispatchTool(tool, {}, 'tu-throw2', allowGate() as never, NOOP_PAUSE);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('plain string error');
  });

  it('honors updatedInput from the gate allow branch', async () => {
    const tool = toolReturning('ran', 'Bash');
    const gate = gateOf({ decision: 'allow', updatedInput: { command: 'ls' } });
    await gateAndDispatchTool(tool, { command: 'original' }, 'tu-upd', gate as never, NOOP_PAUSE);
    expect(tool.execute).toHaveBeenCalledWith({ command: 'ls' }, { toolCallId: 'tu-upd' });
  });

  // This frame's parse against the shared PERMISSION_DENIED schema is pinned in @bash/shared
  // (event-payloads.schema.test.ts, "the native arm's refusal frame"): this package cannot import it.
  it('emits PERMISSION_DENIED through pushEvent on a deny (carries reasonType)', async () => {
    const tool = toolReturning('ran', 'Bash');
    const gate = gateOf({ decision: 'deny', message: 'Denied by rule.', reasonType: 'rule' });
    const pushEvent = vi.fn();
    const r = await gateAndDispatchTool(
      tool, { command: 'curl x' }, 'tu-deny', gate as never, NOOP_PAUSE, undefined,
      { pushEvent, taskId: 'task-9' },
    );

    expect(r.isError).toBe(true);
    expect(r.text).toBe('Denied by rule.');
    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent.mock.calls[0][0]).toMatchObject({
      kind: 'raw',
      engine: 'native',
      event: 'permission:denied',
      data: { taskId: 'task-9', toolName: 'Bash', toolUseId: 'tu-deny', reason: 'Denied by rule.', reasonType: 'rule' },
    });
  });

  it('deny with no message → text === "Denied."', async () => {
    const tool = toolReturning('ran', 'Bash');
    // A deny GateResult requires `message`; simulate the dispatcher's `?? 'Denied.'`
    // fallback by routing through a dispatcher whose hook deny carries no reason.
    const dispatcher = {
      dispatch: vi.fn(async () => ({ decision: 'continue' as const, permissionDecision: 'deny' as const })),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-deny2', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Denied.');
  });

  it('PostToolUse rewrite replaces the text only (blocks untouched / undefined for text path)', async () => {
    const tool = toolReturning('raw output', 'Bash');
    const dispatcher = {
      dispatch: vi.fn(async (event: string) => {
        if (event === 'PreToolUse') {
          return { decision: 'continue' as const, permissionDecision: 'allow' as const };
        }
        // PostToolUse rewrite
        return { decision: 'continue' as const, updatedToolOutput: 'REWRITTEN' };
      }),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-post', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    expect(r.text).toBe('REWRITTEN');
    expect(r.isError).toBe(false);
    expect(r.blocks).toBeUndefined();
  });

  it('PostToolUse rewrite stringifies a non-string updatedToolOutput', async () => {
    const tool = toolReturning('raw output', 'Bash');
    const dispatcher = {
      dispatch: vi.fn(async (event: string) => {
        if (event === 'PreToolUse') return { decision: 'continue' as const, permissionDecision: 'allow' as const };
        return { decision: 'continue' as const, updatedToolOutput: { rewritten: true } };
      }),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-post2', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    expect(r.text).toBe(JSON.stringify({ rewritten: true }));
  });

  it('dispatcher PreToolUse with absent permissionDecision → falls back to the direct gate', async () => {
    const tool = toolReturning('ran', 'Bash');
    const gate = gateOf({ decision: 'allow' });
    const dispatcher = {
      // continue, but no permissionDecision → defensive fallback to harness.gateTool
      dispatch: vi.fn(async () => ({ decision: 'continue' as const })),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-fallback', gate as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    expect(gate.gateTool).toHaveBeenCalledOnce();
    expect(r.text).toBe('ran');
    expect(r.isError).toBe(false);
  });

  it('execute throws WITH a dispatcher → PostToolUseFailure is dispatched, result still isError', async () => {
    const tool: RawToolOptions = {
      name: 'Bash',
      description: 'run',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async () => { throw new Error('failed call'); }),
    };
    const dispatcher = {
      dispatch: vi.fn(async (event: string) => {
        if (event === 'PreToolUse') return { decision: 'continue' as const, permissionDecision: 'allow' as const };
        return { decision: 'continue' as const };
      }),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-fail-hook', allowGate() as never, NOOP_PAUSE, undefined,
      { dispatcher: dispatcher as never },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain('failed call');
    // PostToolUseFailure was dispatched (PreToolUse + PostToolUseFailure = 2 calls).
    const dispatchedEvents = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    expect(dispatchedEvents).toContain('PostToolUseFailure');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Aborted signal → clean text error result, blocks undefined (no partial image).
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — aborted-signal dispatch', () => {
  it('11. already-aborted signal: execute throws on abort → text error result, blocks undefined', async () => {
    const controller = new AbortController();
    controller.abort();
    // computer-use fns ignore the signal (they take only taskId/args), so the
    // realistic post-abort outcome is a text-only error from the tool itself.
    const tool: RawToolOptions = {
      name: 'computer_screenshot',
      description: 'shot',
      parameters: { type: 'object', properties: {} },
      execute: vi.fn(async (_args, ctx) => {
        if (ctx.signal?.aborted) throw new Error('aborted: no browser session');
        return { content: [{ type: 'image', data: 'X', mimeType: 'image/jpeg' }] };
      }),
    };
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-abort', allowGate() as never, NOOP_PAUSE, undefined,
      { signal: controller.signal },
    );

    expect(r.isError).toBe(true);
    expect(r.text).toContain('aborted');
    // No partial / empty image block leaked.
    expect(r.blocks).toBeUndefined();
  });

  it('11b. aborted signal but tool ignores it and returns an image → blocks still extracted (no signal coupling)', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = browserToolReturning({ content: [{ type: 'image', data: 'IGN', mimeType: 'image/jpeg' }] });
    const r = await gateAndDispatchTool(
      tool, {}, 'tu-abort2', allowGate() as never, NOOP_PAUSE, undefined,
      { signal: controller.signal },
    );
    // The dispatcher does NOT short-circuit on the signal — extraction is purely
    // result-shape-driven, so a returned image is still carried.
    expect(r.blocks).toEqual([{ type: 'image', data: 'IGN', mediaType: 'image/jpeg' }]);
    expect(r.text).toBe('[screenshot]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Slice-0 safety net — binary/oversized tool output guarded at the boundary.
// ─────────────────────────────────────────────────────────────────────────────

describe('gateAndDispatchTool — Slice-0 binary/oversized output guard', () => {
  it('refuses a binary (NUL-laced) tool result at the dispatch boundary — e.g. Read of a .docx', async () => {
    const NUL = String.fromCharCode(0);
    const tool = toolReturning('PK' + NUL + NUL + 'word/document.xml' + NUL + 'junk', 'Read');
    const r = await gateAndDispatchTool(tool, {}, 'tu-bin', allowGate() as never, NOOP_PAUSE);
    expect(r.text).toBe(BINARY_REFUSAL);
    expect(r.text).not.toContain(NUL);
    // A guarded output is not a tool *error* — the tool ran fine; its bytes were unusable.
    expect(r.isError).toBe(false);
  });

  it('passes plain text tool output through the guard unchanged', async () => {
    const tool = toolReturning('     1\thello\n     2\tworld', 'Read');
    const r = await gateAndDispatchTool(tool, {}, 'tu-txt', allowGate() as never, NOOP_PAUSE);
    expect(r.text).toBe('     1\thello\n     2\tworld');
    expect(r.isError).toBe(false);
  });
});
