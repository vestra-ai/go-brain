import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../journal.js';
import { JsonlStore } from '../jsonl-store.js';
import { InMemorySessionStore } from '../session-store.js';
import { sequentialClock } from '../clock.js';
import { mayHaveRunSideEffect } from '../side-effect-classifier.js';
import type { JournalEntry, NewEntry } from '../../../contract/journal.js';

/**
 * Weave Phase 2b — F1 fail-closed "may-have-run" (design §6.2 / §8-F1). A process that
 * crashes MID a side-effecting tool (a `curl -X POST`, a Composio send) leaves an orphan
 * tool_use with no result. On resume the crash-heal previously sealed a NEUTRAL empty error
 * stub — which reads to the model as "it just failed", inviting a blind retry that re-fires
 * the side effect (at-least-once). F1: for a DANGEROUSLY side-effecting orphan we instead
 * seal a fail-closed "this MAY HAVE run — verify before retrying" result, so the side effect
 * is never silently re-sent. A benign orphan (read-only tool, idempotent write) keeps the
 * neutral stub; a user INTERRUPT keeps "Interrupted by user." (a mid-tool interrupt lets the
 * tool finish — 2b-a — so it rarely orphans).
 */
describe('mayHaveRunSideEffect — the crash-orphan classifier', () => {
  it('flags network egress via Bash (the re_execute-bound at-least-once hazard)', () => {
    expect(mayHaveRunSideEffect('Bash', { command: 'curl -X POST https://api.example.com/webhook -d @body' })).toBe(true);
    expect(mayHaveRunSideEffect('Bash', { command: 'wget https://x/y -O out' })).toBe(true);
    expect(mayHaveRunSideEffect('Bash', { command: 'gh release create v1.2.3' })).toBe(true);
  });
  it('flags an external Composio send', () => {
    expect(mayHaveRunSideEffect('mcp__composio__GMAIL_SEND_EMAIL', { to: 'x@y.com' })).toBe(true);
  });
  it('flags a user-connected MCP server call and a pull request (continue anywhere §6.3)', () => {
    // mcp_invoke is the native arm's only route to a user-connected MCP server, so it is
    // send-shaped wholesale, exactly like an mcp__* tool; github_pull_request opens or edits a PR.
    expect(mayHaveRunSideEffect('mcp_invoke', { server: 'stripe', tool: 'create_refund', args: {} })).toBe(true);
    expect(mayHaveRunSideEffect('github_pull_request', { repository: 'acme/site', action: 'create' })).toBe(true);
    // mcp_search only finds tools: still benign.
    expect(mayHaveRunSideEffect('mcp_search', { query: 'refund' })).toBe(false);
  });
  it('flags execute_code that makes a network request, but not pure compute', () => {
    expect(mayHaveRunSideEffect('execute_code', { code: 'await fetch("https://h/w", { method: "POST" })' })).toBe(true);
    expect(mayHaveRunSideEffect('execute_code', { code: 'const x = 1 + 2; console.log(x)' })).toBe(false);
  });
  it('does NOT flag read-only / idempotent tools (no false alarms on safe orphans)', () => {
    expect(mayHaveRunSideEffect('Bash', { command: 'ls -la && cat file.txt' })).toBe(false);
    expect(mayHaveRunSideEffect('Read', { file_path: '/x' })).toBe(false);
    expect(mayHaveRunSideEffect('Write', { file_path: '/x', content: 'y' })).toBe(false);
    expect(mayHaveRunSideEffect('Grep', { pattern: 'x' })).toBe(false);
  });
  it('NEVER throws on a hostile / malformed input (a throw on the heal path would break resume)', () => {
    // Runs on the crash-heal path where any throw is catastrophic — must degrade to `false`.
    for (const input of [null, undefined, 42, 'str', [], { command: 42 }, { command: null }, { code: {} }]) {
      expect(() => mayHaveRunSideEffect('Bash', input)).not.toThrow();
      expect(mayHaveRunSideEffect('Bash', input)).toBe(false);
      expect(() => mayHaveRunSideEffect('execute_code', input)).not.toThrow();
    }
  });
});

describe('Journal crash-heal — F1 fail-closed may-have-run card', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vestra-f1-')); });
  const make = (taskId: string): Journal =>
    new Journal({
      taskId, workspaceId: 'w',
      jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-01-01T00:00:00.000Z'),
    });
  const base = (): Omit<NewEntry, 'payload'> => ({
    taskId: 't', rootTaskId: 't', spawnDepth: 0, workspaceId: 'w', agentId: 'g',
    principal: { kind: 'system' }, timestamp: '',
  });
  const resultFor = async (j: Journal, id: string): Promise<{ blocks: { type: string; text?: string }[]; isError?: boolean } | undefined> => {
    const all: JournalEntry[] = [];
    for await (const e of j.read()) all.push(e);
    const r = all.find((e) => e.payload.type === 'tool_result' && (e.payload as { toolUseId: string }).toolUseId === id);
    return r?.payload as { blocks: { type: string; text?: string }[]; isError?: boolean } | undefined;
  };

  it('a CRASH orphan of a side-effecting tool seals a "may-have-run — verify" result, not a neutral stub', async () => {
    const j = make('t-curl');
    await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'curl -X POST https://h/w -d x' } } });
    await j.healOrphanedToolUse(); // crash (interrupted=false)
    const p = await resultFor(j, 'tu1');
    expect(p?.isError).toBe(true);
    const text = p?.blocks.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toMatch(/may have run|verify/i);
    expect(p?.blocks.length).toBeGreaterThan(0); // NON-empty (the model is warned, not fed a bare error)
  });

  it.each(['mcp_invoke', 'github_pull_request'])('a CRASH orphan of %s seals the may-have-run card (it used to get the neutral stub)', async (name) => {
    const j = make(`t-${name}`);
    await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name, input: {} } });
    await j.healOrphanedToolUse();
    const p = await resultFor(j, 'tu1');
    expect(p?.blocks.find((b) => b.type === 'text')?.text ?? '').toMatch(/may have run|verify/i);
  });

  it('a CRASH orphan of a benign tool keeps the NEUTRAL empty-blocks stub (unchanged)', async () => {
    const j = make('t-ls');
    await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls -la' } } });
    await j.healOrphanedToolUse();
    const p = await resultFor(j, 'tu1');
    expect(p?.isError).toBe(true);
    expect(p?.blocks).toEqual([]);
  });

  it('a user INTERRUPT of a side-effecting orphan keeps "Interrupted by user." (not the crash card)', async () => {
    const j = make('t-int');
    await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
    await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'curl https://h' } } });
    await j.healOrphanedToolUse(true); // interrupt
    const p = await resultFor(j, 'tu1');
    expect(p?.blocks).toEqual([{ type: 'text', text: 'Interrupted by user.' }]);
  });

  describe('L6 crash resume: a crashSealText in place of the empty stub', () => {
    const RESTART = 'Interrupted: the computer restarted while this step was running.';

    it('a CRASH orphan of a benign tool is sealed with the crash text when one is given', async () => {
      const j = make('t-ls-l6');
      await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
      await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'find /usr -type f | wc -l' } } });
      await j.healOrphanedToolUse(false, RESTART);
      const p = await resultFor(j, 'tu1');
      expect(p?.isError).toBe(true);
      expect(p?.blocks).toEqual([{ type: 'text', text: RESTART }]);
    });

    it('a side-effecting CRASH orphan keeps the stronger may-have-run card over the crash text', async () => {
      const j = make('t-curl-l6');
      await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
      await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'curl -X POST https://h/w' } } });
      await j.healOrphanedToolUse(false, RESTART);
      const text = (await resultFor(j, 'tu1'))?.blocks[0]?.text ?? '';
      expect(text).toMatch(/MAY HAVE run/);
      expect(text).not.toContain(RESTART);
    });

    it('a user INTERRUPT keeps "Interrupted by user." whatever crash text is passed', async () => {
      const j = make('t-int-l6');
      await j.append({ ...base(), payload: { type: 'user', blocks: [{ type: 'text', text: 'go' } as never] } });
      await j.append({ ...base(), payload: { type: 'tool_use', toolUseId: 'tu1', name: 'Read', input: { file_path: '/x' } } });
      await j.healOrphanedToolUse(true, RESTART);
      expect((await resultFor(j, 'tu1'))?.blocks).toEqual([{ type: 'text', text: 'Interrupted by user.' }]);
    });
  });
});
