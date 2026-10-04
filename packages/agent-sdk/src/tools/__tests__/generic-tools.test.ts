import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confinePath,
  resolveInWorkspace,
  WorkspaceEscapeError,
  TOOL_DESCRIPTIONS,
  spawnBackground,
  getOutput,
  getOutputBlocking,
  stopProcess,
} from '../index.js';
import {
  makeReadTool,
  makeWriteTool,
  makeBashTool,
  makeGlobTool,
} from '../index.js';
import { isToolError } from '../tool-types.js';
import { taskOutputToolOptions, taskStopToolOptions } from '../index.js';
import { makeWebSearchTool, makeWebFetchTool, makeRawWebFetchTool, WEB_SEARCH_TOOL } from '../index.js';

describe('fs-util (relocated, workingDir injected)', () => {
  it('resolves a relative path inside the injected workspace and rejects escapes', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-fs-'));
    try {
      expect(resolveInWorkspace('a/b.txt', ws)).toBe(join(ws, 'a/b.txt'));
      expect(() => resolveInWorkspace('../../etc/passwd', ws)).toThrow(WorkspaceEscapeError);
      expect(() => resolveInWorkspace('/etc/passwd', ws)).toThrow(WorkspaceEscapeError);
      const { abs, rel } = confinePath('f.txt', ws);
      expect(abs).toBe(join(ws, 'f.txt'));
      expect(rel).toBe('f.txt');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('TOOL_DESCRIPTIONS (relocated)', () => {
  it('carries entries for the core tools', () => {
    expect(typeof TOOL_DESCRIPTIONS.Read).toBe('string');
    expect(typeof TOOL_DESCRIPTIONS.Bash).toBe('string');
    expect(TOOL_DESCRIPTIONS.Read.length).toBeGreaterThan(0);
  });
});

describe('process-registry (relocated, workingDir injected)', () => {
  it('spawns a bg command in the injected cwd and captures its output', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-pr-'));
    writeFileSync(join(ws, 'marker.txt'), 'hi');
    try {
      const id = spawnBackground('ls', 'task-sdk', ws);
      const snap = await getOutputBlocking(id, 5000);
      expect(snap.output).toContain('marker.txt');
      expect(stopProcess(id)).toContain(id);
      expect(getOutput('nope').status).toBe('unknown');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('file tool factories (relocated, workingDir thunk)', () => {
  it('read/write round-trip confined to the injected workspace, and reads the thunk live', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-tools-'));
    try {
      const get = () => ws;
      const write = makeWriteTool(get);
      const read = makeReadTool(get);
      const w = await write.execute({ file_path: 'note.txt', content: 'alpha\nbeta\n' }, {}) as string;
      expect(w).toMatch(/Wrote \d+ bytes/);
      const r = await read.execute({ file_path: 'note.txt' }, {}) as string;
      expect(r).toMatch(/1\talpha/);
      expect(r).toMatch(/2\tbeta/);
      // Glob factory is well-formed and confines its search path off the same
      // thunk — assert the pre-spawn escape branch (no dependency on the `rg`
      // binary, which isn't on PATH in local dev).
      const glob = makeGlobTool(get);
      expect(glob.name).toBe('Glob');
      const gEscape = await glob.execute({ pattern: '*', path: '../../etc' }, {}) as string;
      expect(gEscape.toLowerCase()).toMatch(/escape|blocked|bad path/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('write blocks a sensitive file and read blocks a traversal escape', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-tools2-'));
    try {
      const get = () => ws;
      const write = makeWriteTool(get);
      const read = makeReadTool(get);
      const blocked = await write.execute({ file_path: '.ssh/id_rsa', content: 'x' }, {}) as string;
      expect(blocked.toLowerCase()).toContain('blocked');
      // Hardening-G: Read's workspace-escape path now returns an invalid_input sentinel;
      // its message is the same string the dispatcher's flag-OFF path unwraps back to.
      const escape = (await read.execute({ file_path: '../../etc/passwd' }, {})) as unknown;
      expect(isToolError(escape)).toBe(true);
      if (!isToolError(escape)) throw new Error('unreachable');
      expect(escape.__toolError.code).toBe('invalid_input');
      expect(escape.__toolError.message.toLowerCase()).toMatch(/escape|blocked|bad path/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('bash factory blocks a dangerous command before executing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sdk-bash-'));
    try {
      const bash = makeBashTool(() => ws, 'task-sdk');
      expect(bash.name).toBe('Bash');
      const out = await bash.execute({ command: 'rm -rf /' }, {}) as string;
      expect(out.toLowerCase()).toContain('block');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('task-output / task-stop tools (relocated consts)', () => {
  it('expose their tool names and return model-visible strings for unknown ids', async () => {
    expect(taskOutputToolOptions.name).toBe('TaskOutput');
    expect(taskStopToolOptions.name).toBe('TaskStop');
    const out = await taskOutputToolOptions.execute({ task_id: 'bg_missing' }, {}) as string;
    expect(out.toLowerCase()).toContain('unknown');
    const stop = await taskStopToolOptions.execute({ task_id: 'bg_missing' }, {}) as string;
    expect(stop.toLowerCase()).toContain('unknown');
  });
});

describe('web tools (relocated, proxy-config + warn injected)', () => {
  const cfg = () => ({ serverUrl: 'https://srv.test', apiToken: 'tok' });
  it('WebSearch returns a graceful error string when the proxy is unconfigured (no throw into the loop)', async () => {
    const t = makeWebSearchTool('task-1', () => ({})); // empty cfg → ExaUnconfigured inside → "temporarily unavailable"
    const out = await t.execute({ query: 'hi' }, {}) as string;
    expect(out.toLowerCase()).toContain('temporarily unavailable');
  });
  it('WebSearch rejects an empty query without calling the proxy', async () => {
    const t = makeWebSearchTool('task-1', cfg);
    expect(await t.execute({ query: '   ' }, {})).toMatch(/no query/i);
    expect(WEB_SEARCH_TOOL.name).toBe('WebSearch');
  });
  it('makeRawWebFetchTool validates the URL scheme and never throws', async () => {
    const t = makeRawWebFetchTool();
    expect(await t.execute({ url: 'ftp://x' }, {})).toMatch(/only http\(s\)/i);
    expect(await t.execute({}, {})).toMatch(/no url/i);
  });
  it('WebFetch factory exposes the WebFetch name + schema', () => {
    const t = makeWebFetchTool('task-1', cfg);
    expect(t.name).toBe('WebFetch');
  });
});
