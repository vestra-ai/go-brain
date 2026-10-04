/**
 * T10 (durable subagent deep-HITL, Phase B) — scope-tag the journal so a
 * subagent's conversation is durable.
 *
 * PLAN RISK #1 — the highest-risk guard. A journal sequence built with NO
 * `agentPath` (the main agent / flag-off path) MUST serialize to byte-identical
 * JSONL as before this change. The optional `agentPath` header field is added with
 * a CONDITIONAL spread (never `agentPath: undefined`), so an entry that carries no
 * path has no `agentPath` key on disk. The inline snapshot below is the golden: it
 * was captured against the PRE-change code and must not move when the field lands.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext } from '../../contract/harness.js';
import type { NativeConfigLike } from '../native-config-like.js';
import {
  appendUserEntry,
  appendAssistantEntry,
  appendToolUseEntry,
  appendToolResultEntry,
} from '../native-journal.js';

const dir = join(tmpdir(), `native-journal-agentpath-${process.pid}`);
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const file = (taskId: string) => join(dir, `${taskId}.jsonl`);
const make = (taskId = 't') => new Journal({
  taskId,
  workspaceId: 'u',
  jsonl: new JsonlStore(file(taskId)),
  mirror: new InMemorySessionStore(),
  clock: sequentialClock('2026-01-01T00:00:00.000Z'),
});

const ctxFor = (taskId = 't', userId = 'u'): HarnessContext<NativeConfigLike> =>
  ({ taskId, config: { runtimeConfig: { userId } } } as unknown as HarnessContext<NativeConfigLike>);

describe('native journal — no-agentPath sequence is byte-identical (plan risk #1)', () => {
  it('serializes a main-agent user/assistant/tool_use/tool_result sequence to the golden bytes', async () => {
    const j = make('t-golden');
    const ctx = ctxFor('t-golden');
    await appendUserEntry(j, ctx, 'hello');
    await appendAssistantEntry(j, ctx, [{ type: 'text', text: 'on it' }], 'claude-sonnet-4-6');
    await appendToolUseEntry(j, ctx, { id: 'tu1', name: 'Bash', input: { command: 'ls' } });
    await appendToolResultEntry(j, ctx, { toolUseId: 'tu1', text: 'file.txt', isError: false });

    const raw = await fs.readFile(file('t-golden'), 'utf8');
    // None of these main-agent entries may carry an `agentPath` key on disk.
    expect(raw).not.toContain('agentPath');
    expect(raw).toMatchInlineSnapshot(`
      "{"taskId":"t-golden","rootTaskId":"t-golden","spawnDepth":0,"workspaceId":"u","agentId":"native","principal":{"kind":"user","userId":"u"},"timestamp":"2026-01-01T00:00:00.000Z","payload":{"type":"user","blocks":[{"type":"text","text":"hello"}]},"uuid":"entry-0","parentUuid":null,"seq":0}
      {"taskId":"t-golden","rootTaskId":"t-golden","spawnDepth":0,"workspaceId":"u","agentId":"native","principal":{"kind":"agent","agentId":"native"},"timestamp":"2026-01-01T00:00:00.000Z","payload":{"type":"assistant","blocks":[{"type":"text","text":"on it"}],"api":"anthropic_messages","provider":"anthropic","model":"claude-sonnet-4-6"},"uuid":"entry-1","parentUuid":"entry-0","seq":1}
      {"taskId":"t-golden","rootTaskId":"t-golden","spawnDepth":0,"workspaceId":"u","agentId":"native","principal":{"kind":"agent","agentId":"native"},"timestamp":"2026-01-01T00:00:00.000Z","payload":{"type":"tool_use","toolUseId":"tu1","name":"Bash","input":{"command":"ls"}},"uuid":"entry-2","parentUuid":"entry-1","seq":2}
      {"taskId":"t-golden","rootTaskId":"t-golden","spawnDepth":0,"workspaceId":"u","agentId":"native","principal":{"kind":"agent","agentId":"native"},"timestamp":"2026-01-01T00:00:00.000Z","payload":{"type":"tool_result","toolUseId":"tu1","blocks":[{"type":"text","text":"file.txt"}],"isError":false},"uuid":"entry-3","parentUuid":"entry-2","seq":3}
      "
    `);
  });
});
