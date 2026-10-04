import { describe, it, expect } from 'vitest';
import { egressProxyVars, egressEnforced, shellEgressMode, EGRESS_PROXY_URL_ENV } from '../egress-proxy-env.js';

const URL = 'http://127.0.0.1:54321';

describe('egressProxyVars — SHELL_EGRESS_V1 shadow child-env injection', () => {
  it('returns nothing when the flag is unset (OFF ⇒ byte-identical child env)', () => {
    expect(egressProxyVars({})).toBeUndefined();
  });

  it('returns nothing when the flag is explicitly off', () => {
    expect(egressProxyVars({ SHELL_EGRESS_V1: 'off', [EGRESS_PROXY_URL_ENV]: URL })).toBeUndefined();
  });

  it('returns nothing in shadow when the proxy URL is absent (fail-open: proxy down ⇒ no inject, never blocks)', () => {
    expect(egressProxyVars({ SHELL_EGRESS_V1: 'shadow' })).toBeUndefined();
  });

  it('returns nothing when the URL is present but the flag is not shadow (URL alone never routes)', () => {
    expect(egressProxyVars({ [EGRESS_PROXY_URL_ENV]: URL })).toBeUndefined();
  });

  it('injects HTTP(S)_PROXY (both cases) at the proxy URL when shadow + proxy up', () => {
    const vars = egressProxyVars({ SHELL_EGRESS_V1: 'shadow', [EGRESS_PROXY_URL_ENV]: URL });
    expect(vars).toEqual({
      HTTP_PROXY: URL,
      HTTPS_PROXY: URL,
      http_proxy: URL,
      https_proxy: URL,
    });
  });

  it('egress shadow: unchanged. A task id adds no credential in shadow (byte-identical to today)', () => {
    const env = { SHELL_EGRESS_V1: 'shadow', [EGRESS_PROXY_URL_ENV]: URL };
    expect(egressProxyVars(env, 'task-1')).toEqual(egressProxyVars(env));
  });

  it('egress off: a task id injects nothing', () => {
    expect(egressProxyVars({ [EGRESS_PROXY_URL_ENV]: URL }, 'task-1')).toBeUndefined();
  });

  it('egress enforce: routes through the proxy, carrying the task as the proxy credential', () => {
    const vars = egressProxyVars({ SHELL_EGRESS_V1: 'enforce', [EGRESS_PROXY_URL_ENV]: URL }, 'task-1');
    const withTask = 'http://task:task-1@127.0.0.1:54321';
    expect(vars).toEqual({ HTTP_PROXY: withTask, HTTPS_PROXY: withTask, http_proxy: withTask, https_proxy: withTask });
  });

  it('egress enforce: no task id, plain proxy URL; proxy down, nothing injected (fail-open)', () => {
    expect(egressProxyVars({ SHELL_EGRESS_V1: 'enforce', [EGRESS_PROXY_URL_ENV]: URL })?.HTTPS_PROXY).toBe(URL);
    expect(egressProxyVars({ SHELL_EGRESS_V1: 'enforce' }, 'task-1')).toBeUndefined();
  });

  it("egress enforce on a desktop runner (dial) is shadow: the person's own network is theirs, no credential", () => {
    const env = { SHELL_EGRESS_V1: 'enforce', VESTRA_RUNNER_MODE: 'dial', [EGRESS_PROXY_URL_ENV]: URL };
    expect(shellEgressMode(env)).toBe('shadow');
    expect(egressEnforced(env)).toBe(false);
    expect(egressProxyVars(env, 'task-1')).toEqual(egressProxyVars({ SHELL_EGRESS_V1: 'shadow', [EGRESS_PROXY_URL_ENV]: URL }));
  });

  it.each([
    [{}, 'off'], [{ SHELL_EGRESS_V1: 'shadow' }, 'shadow'], [{ SHELL_EGRESS_V1: 'enforce' }, 'enforce'],
    [{ SHELL_EGRESS_V1: 'ENFORCE' }, 'off'], [{ SHELL_EGRESS_V1: 'on' }, 'off'],
  ] as const)('shellEgressMode(%o) is %s (unknown => off, fail-safe)', (env, mode) => {
    expect(shellEgressMode(env)).toBe(mode);
  });

  it('reads process.env by default', () => {
    const prev = { flag: process.env.SHELL_EGRESS_V1, url: process.env[EGRESS_PROXY_URL_ENV] };
    try {
      process.env.SHELL_EGRESS_V1 = 'shadow';
      process.env[EGRESS_PROXY_URL_ENV] = URL;
      expect(egressProxyVars()?.HTTPS_PROXY).toBe(URL);
    } finally {
      if (prev.flag === undefined) delete process.env.SHELL_EGRESS_V1; else process.env.SHELL_EGRESS_V1 = prev.flag;
      if (prev.url === undefined) delete process.env[EGRESS_PROXY_URL_ENV]; else process.env[EGRESS_PROXY_URL_ENV] = prev.url;
    }
  });
});
