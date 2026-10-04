// packages/agent-sdk/src/tools/__tests__/terminal-session.extra-env.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupSession, getSession, setTaskExtraEnv } from '../terminal-session.js';
import { egressProxyVars } from '../egress-proxy-env.js';

const SEED = mkdtempSync(join(tmpdir(), 'vt-extra-'));
const owners: string[] = [];
const owner = (n: string) => { const id = `task_extra_${n}_${owners.length}`; owners.push(id); return id; };
afterEach(() => { for (const id of owners.splice(0)) { setTaskExtraEnv(id, undefined); cleanupSession(id); } });

describe('setTaskExtraEnv (Platform API v1, L17)', () => {
  it('reaches this task\'s foreground and background commands, and no other task\'s', () => {
    const a = owner('a');
    const b = owner('b');
    setTaskExtraEnv(a, { IXIGO_KEY: 'k1' });
    expect(getSession(a, SEED).buildExec('true').env.IXIGO_KEY).toBe('k1');
    expect(getSession(a, SEED).childEnv().IXIGO_KEY).toBe('k1');
    expect(getSession(b, SEED).buildExec('true').env.IXIGO_KEY).toBeUndefined();
    expect(process.env.IXIGO_KEY).toBeUndefined();
  });

  it('can never override the wrapper\'s own keys (Review Focus 1)', () => {
    const a = owner('wrap');
    setTaskExtraEnv(a, { VESTRA_CMD: 'rm -rf /', VESTRA_CWDFILE: '/etc/passwd' });
    const { env } = getSession(a, SEED).buildExec('echo safe');
    expect(env.VESTRA_CMD).toBe('echo safe');
    expect(env.VESTRA_CWDFILE).not.toBe('/etc/passwd');
  });

  it('is read live: a new value applies on the next command; undefined removes it', () => {
    const a = owner('live');
    const s = getSession(a, SEED);
    setTaskExtraEnv(a, { REGION: 'in' });
    expect(s.buildExec('true').env.REGION).toBe('in');
    setTaskExtraEnv(a, { REGION: 'sg' });
    expect(s.buildExec('true').env.REGION).toBe('sg');
    setTaskExtraEnv(a, undefined);
    expect(s.buildExec('true').env.REGION).toBeUndefined();
  });

  it('is cleared with the session', () => {
    const a = owner('clean');
    setTaskExtraEnv(a, { REGION: 'in' });
    cleanupSession(a);
    expect(getSession(a, SEED).buildExec('true').env.REGION).toBeUndefined();
  });

  it('a task with no company variables (every person) gets exactly the environment it got before', () => {
    const s = getSession(owner('person'), SEED);
    const { env } = s.buildExec('echo hi');
    const before = {
      ...process.env,
      ...egressProxyVars(),
      VESTRA_CMD: 'echo hi',
      VESTRA_CWD: SEED,
      VESTRA_WORKDIR: SEED,
      VESTRA_CWDFILE: join(s.dir, 'cwd'),
    };
    expect(Object.keys(env)).toEqual(Object.keys(before));
    expect(env).toEqual(before);
    expect(s.childEnv()).toEqual({ ...process.env, ...egressProxyVars() });
  });
});
