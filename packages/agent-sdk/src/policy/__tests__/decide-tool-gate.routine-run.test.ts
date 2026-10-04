/**
 * Routine-run guard (automations v2 §4.3) — step 2c.
 *
 * A turn started by a routine FIRE (ctx.routineRun set) must never write the
 * routine endpoints: POST/PUT/PATCH/DELETE on /api/routines (incl. /execute)
 * and firing /api/webhooks/routine — the 2026-08-04 Thread Chaser self-clone
 * loop (execute → new run → same task cloned every ~40s) and the adarsh
 * create-clone both rode exactly these calls. The guard is MODE-INDEPENDENT
 * (sits above the C2 ladder beside the takeover clause): bypassPermissions and
 * allow rules can never re-enable it. GET/list stays allowed, and an UNSET
 * flag makes the step a no-op (byte-identical gate).
 */
import { describe, it, expect } from 'vitest';
import { decideToolGate, ROUTINE_RUN_DENY_MESSAGE } from '../decide-tool-gate.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { PermissionMode } from '../../contract/permission.js';

const FIRED: ToolGateContext = { routineRun: { routineId: 'rt-123' } };

const bash = (command: string): ToolCall => ({ toolName: 'Bash', toolInput: { command }, toolCallId: 't' });
const call = (toolName: string, toolInput: unknown): ToolCall => ({ toolName, toolInput, toolCallId: 't' });

const URL = 'https://server.example.com/api/routines';
const WEBHOOK = 'https://server.example.com/api/webhooks/routine/wh-1';

function expectDeny(result: ReturnType<typeof decideToolGate>): void {
  expect(result.decision).toBe('deny');
  if (result.decision === 'deny') expect(result.message).toBe(ROUTINE_RUN_DENY_MESSAGE);
}

describe('decideToolGate — routine-run guard (step 2c)', () => {
  // ── The deny matrix: Bash single commands ──────────────────────────────────
  it.each([
    ['create via -X POST', `curl -s -X POST -H "Authorization: Bearer $VESTRA_API_TOKEN" ${URL}`],
    ['create via -XPOST (no space)', `curl -XPOST ${URL}`],
    ['create via --request=POST', `curl --request=POST ${URL}`],
    ['create via implied POST (-d body)', `curl -s -d '{"name":"x","prompt":"y"}' ${URL}`],
    ['create via implied POST (--json)', `curl --json '{"name":"x"}' ${URL}`],
    ['create via implied POST (--data-raw)', `curl --data-raw '{}' ${URL}`],
    ['update via -X PUT', `curl -X PUT ${URL}/rt-1 -d '{"enabled":false}'`],
    ['update via -X PATCH', `curl -X PATCH ${URL}/rt-1`],
    ['delete via -X DELETE', `curl -X DELETE ${URL}/rt-1`],
    ['execute — ANY method (the fork-bomb surface)', `curl ${URL}/rt-1/execute`],
    ['execute via -X POST', `curl -X POST ${URL}/rt-1/execute`],
    ['webhook self-fire via POST', `curl -X POST ${WEBHOOK} -d '{"ping":1}'`],
    ['webhook self-fire via implied POST', `curl -d '{}' ${WEBHOOK}`],
    ['webhook-alias fire (web-rendered URL)', `curl -X POST https://s.example.com/api/routines/webhook/wh-1 -d '{}'`],
    ['httpie-style bare verb', `http POST ${URL} name=x`],
    ['wget post-data', `wget --post-data='{"name":"x"}' ${URL}`],
  ])('denies %s with the instructive copy', (_label, command) => {
    expectDeny(decideToolGate(bash(command), FIRED));
  });

  // ── Compound + unparseable commands (segment machinery reuse) ─────────────
  it('denies when ANY segment of a compound command targets a routine write', () => {
    expectDeny(decideToolGate(bash(`echo checking && curl -X POST ${URL} | cat`), FIRED));
    expectDeny(decideToolGate(bash(`ls; curl -d @routine.json ${URL}`), FIRED));
  });

  it('denies an UNPARSEABLE command via the whole-string fallback (unbalanced quote cannot hide the write)', () => {
    expectDeny(decideToolGate(bash(`curl -X POST ${URL} "unbalanced`), FIRED));
  });

  it('denies a routine write inside a subshell or a substitution (read since 2026-09-25)', () => {
    expectDeny(decideToolGate(bash(`(cd /tmp && curl -X POST ${URL})`), FIRED));
    expectDeny(decideToolGate(bash(`out=$(curl -s -X POST ${URL}); echo "$out"`), FIRED));
    expectDeny(decideToolGate(bash(`echo "$(curl -d '{}' ${WEBHOOK})"`), FIRED));
  });

  it('PowerShell rides the same segment machinery', () => {
    expectDeny(decideToolGate(call('PowerShell', { command: `curl -X POST ${URL}` }), FIRED));
  });

  // ── GET / list / unrelated stay allowed ───────────────────────────────────
  it.each([
    ['list routines', `curl -s -H "Authorization: Bearer $T" ${URL}`],
    ['get details', `curl ${URL}/rt-1`],
    ['explicit GET', `curl -X GET ${URL}/rt-1`],
    ['run history', `curl ${URL}/rt-1/runs`],
    ['unrelated POST elsewhere', `curl -X POST https://api.example.com/things -d '{}'`],
    ['plain command', 'git status'],
    ['prose mention, lowercase verb', `echo "you can post updates about routines later"`],
  ])('allows %s (reads and unrelated writes pass through)', (_label, command) => {
    expect(decideToolGate(bash(command), FIRED)).toEqual({ decision: 'allow' });
  });

  // ── Non-Bash HTTP-capable tools (url-keyed input scan) ────────────────────
  it.each([
    ['fetch-style POST', { url: URL, method: 'POST', body: '{"name":"x"}' }],
    ['DELETE by method field', { url: `${URL}/rt-1`, method: 'delete' }],
    ['implied write: body with no method', { url: URL, body: '{"name":"x"}' }],
    ['execute URL with no method (fire-only endpoint)', { url: `${URL}/rt-1/execute` }],
    ['webhook URL with no method (fire-only endpoint)', { url: WEBHOOK }],
    ['webhook URL, POST', { url: WEBHOOK, method: 'POST' }],
    ['nested meta-executor payload', { tools: [{ arguments: { url: URL, method: 'PUT' } }] }],
  ])('denies a non-Bash HTTP tool call: %s', (_label, toolInput) => {
    expectDeny(decideToolGate(call('mcp__composio__HTTP_REQUEST', toolInput), FIRED));
  });

  // WebFetch here: a composio-named tool would fall through to the composio-auth
  // classifier (unconnected toolkit → needs_human), hiding the guard's verdict.
  // The GUARD's pass-through is what these pin; the deny cases above already
  // prove the guard fires before that classifier on composio-named tools.
  it.each([
    ['plain GET read', { url: URL, method: 'GET' }],
    ['bare url, no method, no body (read shape)', { url: `${URL}/rt-1` }],
    ['explicit GET on the execute URL (positively a read)', { url: `${URL}/rt-1/execute`, method: 'GET' }],
    ['unrelated url with POST', { url: 'https://api.example.com/x', method: 'POST' }],
  ])('allows a non-Bash HTTP tool call: %s', (_label, toolInput) => {
    expect(decideToolGate(call('WebFetch', toolInput), FIRED)).toEqual({ decision: 'allow' });
  });

  it('a Write whose CONTENT merely mentions the endpoint is NOT denied (url-keyed scan, not text scan)', () => {
    const r = decideToolGate(
      call('Write', { file_path: '/tmp/notes.md', content: `POST ${URL} creates a routine` }),
      FIRED,
    );
    expect(r.decision).toBe('allow');
  });

  // ── Mode-independence: above the ladder, nothing re-enables it ────────────
  const ALL_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
  it.each(ALL_MODES)('denies under mode=%s (the ladder never auto-allows it)', (mode) => {
    expectDeny(decideToolGate(bash(`curl -X POST ${URL}`), { ...FIRED, mode }));
  });

  it('denies even under bypassPermissions + an allow rule covering the exact call', () => {
    const ctx: ToolGateContext = {
      ...FIRED,
      mode: 'bypassPermissions',
      permissionRules: { allow: [{ toolName: 'Bash' }], ask: [], deny: [] },
    };
    expectDeny(decideToolGate(bash(`curl -X POST ${URL}`), ctx));
  });

  // ── Unset flag → no-op (byte-identical gate) ──────────────────────────────
  it('with NO routineRun flag the exact same write calls pass through', () => {
    expect(decideToolGate(bash(`curl -X POST ${URL}`), {})).toEqual({ decision: 'allow' });
    expect(decideToolGate(bash(`curl ${URL}/rt-1/execute`), {})).toEqual({ decision: 'allow' });
    expect(
      decideToolGate(call('WebFetch', { url: WEBHOOK, method: 'POST' }), {}),
    ).toEqual({ decision: 'allow' });
  });

  // ── Precedence: security still wins; capability still wins ────────────────
  it('security (step 1) still beats the routine-run guard', () => {
    const r = decideToolGate(bash('rm -rf /'), FIRED);
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') expect(r.message).toMatch(/security/i);
  });

  // ── Deny-copy register rules (ported from arrival/fire-framing) ───────────
  it('deny copy: instructive, no em dashes, no vendor name, no retry bait', () => {
    expect(ROUTINE_RUN_DENY_MESSAGE).not.toMatch(/—/);
    expect(ROUTINE_RUN_DENY_MESSAGE.toLowerCase()).not.toContain('claude');
    expect(ROUTINE_RUN_DENY_MESSAGE.toLowerCase()).not.toContain('transient');
    expect(ROUTINE_RUN_DENY_MESSAGE).toMatch(/already fired/i);
    expect(ROUTINE_RUN_DENY_MESSAGE).toMatch(/never call routine endpoints/i);
  });
});
