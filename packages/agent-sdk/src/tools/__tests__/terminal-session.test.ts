import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, chmodSync, readFileSync, readFileSync as rf } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { getSession, cleanupSession, _sessionCount, TerminalSession, parseEnvDump, recordEgressRefusal } from '../terminal-session.js';

const SEED = mkdtempSync(join(tmpdir(), 'vt-seed-'));
const owners: string[] = [];
const newOwner = (n: string) => { const id = `task_${n}_${owners.length}`; owners.push(id); return id; };
afterEach(() => { for (const id of owners.splice(0)) cleanupSession(id); });

describe('TerminalSession Phase A (cwd)', () => {
  it('seeds cwd from the working dir on first getSession', () => {
    const s: TerminalSession = getSession(newOwner('seed'), SEED);
    expect(s.cwd).toBe(SEED);
  });

  it('returns the SAME session instance for the same ownerTaskId', () => {
    const id = newOwner('same');
    const a = getSession(id, SEED);
    const b = getSession(id, '/some/other/dir');
    expect(b).toBe(a);
    expect(b.cwd).toBe(SEED); // seed is ignored on subsequent calls
  });

  it('buildExec passes the command via VESTRA_CMD env, never the args string', () => {
    const s = getSession(newOwner('inj'), SEED);
    const { file, args, env } = s.buildExec('echo "hi; rm -rf /"');
    expect(file).toBe('bash');
    expect(args[0]).toBe('-lc');
    expect(args.join(' ')).not.toContain('rm -rf'); // command is NOT in the wrapper script
    expect(env.VESTRA_CMD).toBe('echo "hi; rm -rf /"');
    expect(env.VESTRA_WORKDIR).toBe(SEED);
  });

  it('captureCwd reads the persisted pwd file and updates cwd', () => {
    const s = getSession(newOwner('cap'), SEED);
    const { env } = s.buildExec('cd whatever');
    writeFileSync(env.VESTRA_CWDFILE as string, `${SEED}/sub\n`);
    s.captureCwd();
    expect(s.cwd).toBe(`${SEED}/sub`);
  });

  it('captureCwd keeps last-good cwd when the file is missing or empty', () => {
    const s = getSession(newOwner('miss'), SEED);
    s.captureCwd(); // no file written yet
    expect(s.cwd).toBe(SEED);
    const { env } = s.buildExec('noop');
    writeFileSync(env.VESTRA_CWDFILE as string, '   \n'); // whitespace only
    s.captureCwd();
    expect(s.cwd).toBe(SEED);
  });

  it('creates and removes the per-task scratch dir', () => {
    const id = newOwner('scratch');
    const s = getSession(id, SEED);
    expect(existsSync(s.dir)).toBe(true);
    cleanupSession(id);
    expect(existsSync(s.dir)).toBe(false);
    expect(_sessionCount()).toBe(0);
  });

  it('childEnv returns process.env (no captured env in Phase A)', () => {
    const s = getSession(newOwner('cenv'), SEED);
    expect(s.childEnv().PATH).toBe(process.env.PATH);
  });
});

describe('session cleanup isolation', () => {
  it('cleanupSession removes only the named task and leaves others intact', () => {
    const a = newOwner('clean_a');
    const b = newOwner('clean_b');
    const sa = getSession(a, SEED);
    const sb = getSession(b, SEED);
    cleanupSession(a);
    expect(existsSync(sa.dir)).toBe(false);
    expect(existsSync(sb.dir)).toBe(true); // b untouched (per-session isolation)
  });

  it('cleanupSession on an unknown task is a no-op (never throws)', () => {
    expect(() => cleanupSession('task_never_existed')).not.toThrow();
  });
});

describe('TerminalSession Phase B (env capture)', () => {
  it('parseEnvDump splits NUL-delimited NAME=VALUE pairs', () => {
    const out = parseEnvDump('FOO=bar\0BAZ=qux\0');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('parseEnvDump keeps values containing = and newlines', () => {
    const out = parseEnvDump('URL=https://x?a=b\0MULTI=line1\nline2\0');
    expect(out.URL).toBe('https://x?a=b');
    expect(out.MULTI).toBe('line1\nline2');
  });

  it('parseEnvDump drops ephemeral and wrapper vars', () => {
    const out = parseEnvDump('PWD=/x\0SHLVL=3\0RANDOM=7\0VESTRA_CMD=ls\0KEEP=1\0');
    expect(out).toEqual({ KEEP: '1' });
  });

  it('parseEnvDump drops secret-looking names', () => {
    const out = parseEnvDump('ANTHROPIC_API_KEY=sk-1\0MY_SECRET=2\0DB_PASSWORD=3\0SAFE=4\0');
    expect(out).toEqual({ SAFE: '4' });
  });

  it('parseEnvDump drops entries with invalid identifiers', () => {
    const out = parseEnvDump('1BAD=x\0GOOD=y\0HAS SPACE=z\0');
    expect(out).toEqual({ GOOD: 'y' });
  });

  it('captureEnv persists a re-sourceable env file and reflects it in childEnv', () => {
    const id = newOwner('envcap');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('export FOO=bar');
    // simulate what the wrapper writes: a raw NUL dump of the post-command env
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'FOO=bar\0PATH=/usr/bin\0', 'latin1');
    s.captureEnv();
    expect(s.childEnv().FOO).toBe('bar');
    // the committed env file is valid bash (single-quote-escaped exports)
    const body = rf(env.VESTRA_ENVFILE as string, 'utf8');
    expect(body).toContain(`export FOO='bar'`);
  });

  it('captureEnv keeps last-good env when the raw dump is missing', () => {
    const id = newOwner('envmiss');
    const s = getSession(id, SEED, { envCapture: true });
    require('node:fs').writeFileSync(s.buildExec('x').env.VESTRA_ENVRAW as string, 'FOO=first\0', 'latin1');
    s.captureEnv();
    expect(s.childEnv().FOO).toBe('first');
    require('node:fs').rmSync(s.buildExec('y').env.VESTRA_ENVRAW as string, { force: true });
    s.captureEnv(); // raw now missing -> keep previous
    expect(s.childEnv().FOO).toBe('first');
  });

  it('captureEnv round-trips a value with single quotes safely', () => {
    const id = newOwner('envquote');
    const s = getSession(id, SEED, { envCapture: true });
    require('node:fs').writeFileSync(s.buildExec('x').env.VESTRA_ENVRAW as string, `MSG=it's "ok" $HOME\0`, 'latin1');
    s.captureEnv();
    expect(s.childEnv().MSG).toBe(`it's "ok" $HOME`);
  });

  it('buildExec is Phase A only when envCapture is off (no env source/capture lines)', () => {
    const s = getSession(newOwner('phaseA'), SEED);
    const { args, env } = s.buildExec('ls');
    expect(args[1]).not.toContain('VESTRA_ENVRAW');
    expect(env.VESTRA_ENVRAW).toBeUndefined();
  });

  it('parseEnvDump drops VESTRA_-prefixed vars that are not in the explicit wrapper list (e.g. VESTRA_SERVER_URL)', () => {
    const out = parseEnvDump('VESTRA_SERVER_URL=https://x\0KEEP=1\0');
    expect(out).toEqual({ KEEP: '1' });
  });

  it('captureEnv unlinks the raw env dump after a successful read', () => {
    const id = newOwner('envunlink');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('export BAR=baz');
    const rawPath = env.VESTRA_ENVRAW as string;
    require('node:fs').writeFileSync(rawPath, 'BAR=baz\0', 'latin1');
    expect(existsSync(rawPath)).toBe(true);
    s.captureEnv();
    expect(existsSync(rawPath)).toBe(false); // raw file must be removed after read
    expect(existsSync(env.VESTRA_ENVFILE as string)).toBe(true); // committed env must exist
  });
});

describe('parseEnvDump — broadened SECRET_RE denylist', () => {
  it('drops AWS access keys, bare *_KEY, and CREDENTIAL names; keeps clearly-non-secret names', () => {
    const out = parseEnvDump(
      'AWS_ACCESS_KEY_ID=x\0STRIPE_KEY=y\0DB_CREDENTIAL=z\0FOO=keep\0MONKEY=keep\0KEYBOARD=keep\0',
    );
    // creds dropped; MONKEY/KEYBOARD must NOT be over-stripped by the bare-KEY token rule
    expect(out).toEqual({ FOO: 'keep', MONKEY: 'keep', KEYBOARD: 'keep' });
  });

  it('drops PRIVATE / SIGNING / BEARER / SESSION_* credential families', () => {
    const out = parseEnvDump(
      'GCP_PRIVATE=a\0JWT_SIGNING=b\0BEARER=c\0SESSION_TOKEN=d\0SESSION_SECRET=e\0SESSION_KEY=f\0OK=g\0',
    );
    expect(out).toEqual({ OK: 'g' });
  });

  it('drops a bare KEY and FOO_KEY but keeps KEY-containing words like KEYBOARD/MONKEY/KEEP', () => {
    const out = parseEnvDump('KEY=1\0FOO_KEY=2\0KEY_PREFIX=3\0KEYBOARD=4\0MONKEY=5\0KEEP=6\0');
    expect(out).toEqual({ KEYBOARD: '4', MONKEY: '5', KEEP: '6' });
  });
});

describe('TerminalSession Phase B — delta capture (persist only changed-vs-baseline)', () => {
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('VT_')) delete process.env[k];
  });

  it('persists ONLY vars that differ from the baseline process.env, not the broad slice', () => {
    process.env.VT_BASE = 'same'; // exists in baseline (snapshotted at construction)
    const id = newOwner('delta_only');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('export FOO=bar');
    // raw dump = an UNCHANGED baseline var + a NEW var the command added
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'VT_BASE=same\0FOO=bar\0', 'latin1');
    s.captureEnv();
    const body = rf(env.VESTRA_ENVFILE as string, 'utf8');
    expect(body).toContain(`export FOO='bar'`);
    expect(body).not.toContain('VT_BASE'); // unchanged baseline var is NOT persisted
    expect(s.childEnv().FOO).toBe('bar');
  });

  it('empty delta (dump matches baseline) writes NOTHING and runs no validate', () => {
    process.env.VT_E1 = 'one';
    process.env.VT_E2 = 'two';
    const id = newOwner('delta_empty');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('noop');
    // every var in the dump equals its baseline value → zero delta
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'VT_E1=one\0VT_E2=two\0', 'latin1');
    s.captureEnv();
    expect(existsSync(env.VESTRA_ENVFILE as string)).toBe(false); // fast no-op: no env file written
    expect(existsSync(env.VESTRA_ENVRAW as string)).toBe(false); // raw still unlinked on the no-op path
    expect(s.childEnv().VT_E1).toBe('one'); // childEnv falls through to process.env, unchanged
  });

  it('excludes profile-managed PATH from the delta even when it differs from baseline', () => {
    const id = newOwner('delta_path');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('export VT_APP=1');
    // dump = a profile-shifted PATH (differs from baseline) + a real export
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'PATH=/profile/bin:/usr/bin\0VT_APP=1\0', 'latin1');
    s.captureEnv();
    const body = rf(env.VESTRA_ENVFILE as string, 'utf8');
    expect(body).toContain(`export VT_APP='1'`);
    expect(body).not.toContain('PATH='); // profile-managed → excluded from the persisted delta
    expect(s.childEnv().PATH).toBe(process.env.PATH); // not overridden by a persisted PATH
  });

  it('is a no-op when ONLY profile-managed vars (PATH) changed', () => {
    const id = newOwner('delta_pathonly');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('noop');
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'PATH=/profile/bin:/usr/bin\0', 'latin1');
    s.captureEnv();
    expect(existsSync(env.VESTRA_ENVFILE as string)).toBe(false); // PATH excluded → empty delta → no write
  });

  it('persists a var whose value CHANGED from the baseline', () => {
    process.env.VT_CHG = 'orig';
    const id = newOwner('delta_chg');
    const s = getSession(id, SEED, { envCapture: true });
    const { env } = s.buildExec('export VT_CHG=updated');
    require('node:fs').writeFileSync(env.VESTRA_ENVRAW as string, 'VT_CHG=updated\0', 'latin1');
    s.captureEnv();
    expect(s.childEnv().VT_CHG).toBe('updated');
    expect(rf(env.VESTRA_ENVFILE as string, 'utf8')).toContain(`export VT_CHG='updated'`);
  });
});

describe('TerminalSession scratch root — portable, container byte-identical', () => {
  it('SCRATCH_ROOT defaults to /tmp/vestra-term when VESTRA_TERM_SCRATCH_ROOT is unset', () => {
    // Env var is unset in this suite, so the module-load default holds — the per-task
    // scratch dir must live directly under /tmp/vestra-term (container behavior, unchanged).
    expect(process.env.VESTRA_TERM_SCRATCH_ROOT).toBeUndefined();
    const s = getSession(newOwner('scratch_default'), SEED);
    expect(dirname(s.dir)).toBe('/tmp/vestra-term');
  });

  it('SCRATCH_ROOT follows VESTRA_TERM_SCRATCH_ROOT when set (native runner home)', async () => {
    // The override is read at module load, so re-import with the env var set. Proves the
    // native runner lands scratch under its own home instead of the shared /tmp.
    const customRoot = mkdtempSync(join(tmpdir(), 'vt-custom-root-'));
    const prev = process.env.VESTRA_TERM_SCRATCH_ROOT;
    process.env.VESTRA_TERM_SCRATCH_ROOT = customRoot;
    vi.resetModules();
    try {
      const mod = await import('../terminal-session.js');
      const s = mod.getSession('task_custom_root', SEED);
      expect(dirname(s.dir)).toBe(customRoot);
      mod.cleanupSession('task_custom_root');
    } finally {
      if (prev === undefined) delete process.env.VESTRA_TERM_SCRATCH_ROOT;
      else process.env.VESTRA_TERM_SCRATCH_ROOT = prev;
      vi.resetModules();
    }
  });
});

describe('TerminalSession Phase B — portable env dump (env -0 fallback)', () => {
  it('phase-B dump falls back to the node dump and parseEnvDump reads it identically', () => {
    // Extract the ACTUAL dump line the wrapper runs (keeps this honest to PHASE_B_SCRIPT),
    // then force the `env -0 || node …` fallback by shadowing `env` with a stub that always
    // fails — standing in for a BSD env that rejects `-0`. Run under non-login `sh -c` so no
    // profile reshuffles PATH; the node fallback must yield the same NUL format env -0 would.
    const s = getSession(newOwner('phaseB_fallback'), SEED, { envCapture: true });
    const script = s.buildExec('true').args[1];
    const dumpLine = script.split('\n').find((l) => l.includes('env -0') && l.includes('VESTRA_ENVRAW'));
    expect(dumpLine).toBeTruthy();

    const bin = mkdtempSync(join(tmpdir(), 'vt-fakebin-'));
    writeFileSync(join(bin, 'env'), '#!/bin/sh\nexit 1\n'); // BSD-env stand-in: rejects `-0`
    chmodSync(join(bin, 'env'), 0o755);
    const rawPath = join(bin, 'out.raw');

    execFileSync('sh', ['-c', dumpLine as string], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, // fake env wins; node/bash still resolve past it
        VESTRA_ENVRAW: rawPath,
        PHASEB_FALLBACK_MARK: 'fallback-value',
      },
    });

    const raw = readFileSync(rawPath, 'latin1');
    expect(raw).toContain('\0'); // real NUL-delimited pairs (not empty)
    const parsed = parseEnvDump(raw);
    expect(parsed.PHASEB_FALLBACK_MARK).toBe('fallback-value'); // fallback captured the env
  });
});

describe('egress enforce refusal notes (kept on the live terminal session)', () => {
  const NOTE = (what: string, hosts: string) => `\nNote: ${what} blocked by policy (${hosts})`;

  it('a live task gets its refusals back once as one plain note, then nothing; tasks never mix', () => {
    const a = getSession(newOwner('note_a'), SEED);
    const b = getSession(newOwner('note_b'), SEED);
    expect(a.takeEgressRefusalNote()).toBe('');
    recordEgressRefusal(a.ownerTaskId, '10.0.0.1');
    expect(a.takeEgressRefusalNote()).toBe(NOTE('1 connection to a private network address was', '10.0.0.1'));
    expect(a.takeEgressRefusalNote()).toBe('');
    for (const host of ['10.0.0.1', '169.254.169.254', '10.0.0.1']) recordEgressRefusal(a.ownerTaskId, host);
    recordEgressRefusal(b.ownerTaskId, '192.168.1.1');
    expect(a.takeEgressRefusalNote()).toBe(NOTE('3 connections to private network addresses were', '10.0.0.1, 169.254.169.254'));
    expect(b.takeEgressRefusalNote()).toBe(NOTE('1 connection to a private network address was', '192.168.1.1'));
  });

  it('a task id with no live terminal session records nothing (a forged proxy credential cannot grow memory)', () => {
    for (let i = 0; i < 1000; i++) recordEgressRefusal(`task_forged_${i}`, '10.0.0.1');
    const later = getSession(newOwner('note_forged'), SEED);
    recordEgressRefusal('task_forged_0', '10.0.0.2');
    expect(later.takeEgressRefusalNote()).toBe('');
    expect(getSession('task_forged_0', SEED).takeEgressRefusalNote()).toBe(''); // nothing was kept for it
    cleanupSession('task_forged_0');
  });

  it('the count saturates at 20 and says so', () => {
    const s = getSession(newOwner('note_many'), SEED);
    for (let i = 0; i < 25; i++) recordEgressRefusal(s.ownerTaskId, '10.0.0.1');
    expect(s.takeEgressRefusalNote()).toBe(NOTE('20 or more connections to private network addresses were', '10.0.0.1'));
  });
});

describe('TerminalSession egress-shadow child-env injection (SHELL_EGRESS_V1)', () => {
  const PROXY = 'http://127.0.0.1:59999';
  const saved: Record<string, string | undefined> = {};
  const setEnv = (flag?: string, url?: string) => {
    saved.flag = process.env.SHELL_EGRESS_V1;
    saved.url = process.env.VESTRA_EGRESS_PROXY_URL;
    if (flag === undefined) delete process.env.SHELL_EGRESS_V1; else process.env.SHELL_EGRESS_V1 = flag;
    if (url === undefined) delete process.env.VESTRA_EGRESS_PROXY_URL; else process.env.VESTRA_EGRESS_PROXY_URL = url;
  };
  afterEach(() => {
    if (saved.flag === undefined) delete process.env.SHELL_EGRESS_V1; else process.env.SHELL_EGRESS_V1 = saved.flag;
    if (saved.url === undefined) delete process.env.VESTRA_EGRESS_PROXY_URL; else process.env.VESTRA_EGRESS_PROXY_URL = saved.url;
  });

  it('OFF: buildExec env carries NO proxy vars (byte-identical)', () => {
    setEnv(undefined, undefined);
    const { env } = getSession(newOwner('egr_off_fg'), SEED).buildExec('echo hi');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
  });

  it('OFF: childEnv carries NO proxy vars (byte-identical)', () => {
    setEnv(undefined, undefined);
    const env = getSession(newOwner('egr_off_bg'), SEED).childEnv();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it('SHADOW: buildExec env routes the foreground command through the proxy (both cases)', () => {
    setEnv('shadow', PROXY);
    const { env } = getSession(newOwner('egr_on_fg'), SEED).buildExec('curl https://x');
    expect(env.HTTPS_PROXY).toBe(PROXY);
    expect(env.HTTP_PROXY).toBe(PROXY);
    expect(env.https_proxy).toBe(PROXY);
    expect(env.http_proxy).toBe(PROXY);
    expect(env.VESTRA_CMD).toBe('curl https://x'); // still the real command wrapper
  });

  it('SHADOW: childEnv routes background processes through the proxy', () => {
    setEnv('shadow', PROXY);
    const env = getSession(newOwner('egr_on_bg'), SEED).childEnv();
    expect(env.HTTPS_PROXY).toBe(PROXY);
    expect(env.HTTP_PROXY).toBe(PROXY);
  });

  it('ENFORCE: foreground and background egress carry the owning task to the proxy', () => {
    setEnv('enforce', PROXY);
    const owner = newOwner('egr_enf');
    const session = getSession(owner, SEED);
    const expected = `http://task:${encodeURIComponent(owner)}@127.0.0.1:59999`;
    expect(session.buildExec('curl http://10.0.0.1').env.HTTP_PROXY).toBe(expected);
    expect(session.childEnv().HTTPS_PROXY).toBe(expected);
  });

  it('SHADOW but proxy down (no URL): no injection — never points a child at a dead port', () => {
    setEnv('shadow', undefined);
    const { env } = getSession(newOwner('egr_nourl'), SEED).buildExec('echo hi');
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});
