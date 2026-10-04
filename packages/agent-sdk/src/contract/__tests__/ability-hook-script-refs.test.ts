/**
 * `abilityHookScriptRefs` — the ONE definition of "which files does this declared
 * command reference". Two consumers must agree byte-for-byte: the sandbox registrar
 * (which refuses to register a hook whose script is missing, because a missing
 * script exits 2 under dash and DENIES the tool) and the CI guard over the
 * committed seed. A drift between them would silently disable a working hook or
 * ship a broken one, so the extraction is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { abilityHookScriptRefs } from '../ability-hooks.js';

describe('abilityHookScriptRefs', () => {
  it('extracts the path from the canonical declaration shape', () => {
    expect(abilityHookScriptRefs('node ${ABILITY_ROOT}/skills/x/hooks/g.mjs')).toEqual([
      '/skills/x/hooks/g.mjs',
    ]);
  });

  it('stops at shell metacharacters — the command is a SHELL string, not a path', () => {
    // Getting this wrong yields '/x.mjs;' which exists nowhere, so a WORKING hook
    // would be refused registration. Hence the explicit cases.
    expect(abilityHookScriptRefs('node ${ABILITY_ROOT}/x.mjs; echo hi')).toEqual(['/x.mjs']);
    expect(abilityHookScriptRefs('sh ${ABILITY_ROOT}/x.sh | head')).toEqual(['/x.sh']);
    expect(abilityHookScriptRefs('sh ${ABILITY_ROOT}/x.sh && true')).toEqual(['/x.sh']);
    expect(abilityHookScriptRefs('sh ${ABILITY_ROOT}/x.sh 2>/dev/null')).toEqual(['/x.sh']);
    expect(abilityHookScriptRefs("sh '${ABILITY_ROOT}/x.sh'")).toEqual(['/x.sh']);
  });

  it('finds every reference, not just the first', () => {
    expect(abilityHookScriptRefs('${ABILITY_ROOT}/a.sh && ${ABILITY_ROOT}/b.sh')).toEqual([
      '/a.sh',
      '/b.sh',
    ]);
  });

  it('returns [] when there is nothing to vouch for', () => {
    // A command with no ${ABILITY_ROOT} reference registers unchanged — we only
    // check the files WE materialize, never a system binary or an inline snippet.
    expect(abilityHookScriptRefs('exit 0')).toEqual([]);
    expect(abilityHookScriptRefs('grep -q ABILITY_ROOT /etc/hosts')).toEqual([]);
    expect(abilityHookScriptRefs('')).toEqual([]);
    expect(abilityHookScriptRefs(undefined as unknown as string)).toEqual([]);
  });

  it('ignores a bare ${ABILITY_ROOT} with no path after it', () => {
    expect(abilityHookScriptRefs('cd ${ABILITY_ROOT} && ls')).toEqual([]);
  });
});
