/**
 * Takeover consent core (P2.2 + One-Grant R2): os_takeover hard-asks for every
 * UNGRANTED app. Borrowing the user's physical cursor/keyboard needs a human's
 * explicit yes — and under the One-Grant law (R2) a persisted per-app ACTUATION
 * grant IS that yes: when the caller-resolved `ctx.osGrantedApps` snapshot
 * covers the call's `app`, the hard-ask falls through to the normal ladder.
 * Everything else — no snapshot, no app, non-string app, ungranted app — asks
 * exactly as before, regardless of mode, access level, or allow rules
 * (fail-closed). The clause sits beside release_browser at step 2b, above the
 * whole ladder, and is intentionally flag-independent (a defense that only
 * works when a flag is on is no defense; the tool's absence when OS_HANDS_V1 is
 * dark is the registration gate's job). release_browser stays UNCONDITIONAL.
 *
 * NOT force-asked here: os_release_takeover (returning the hands is the safe
 * direction) and os_drag (gated by the LIVE GRANT in the sidecar, not a
 * per-call hard-ask — asking again mid-takeover would double-prompt). Both fall
 * through to the normal gate. Test-only file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { decideToolGate } from '../decide-tool-gate.js';
import type { ToolCall } from '../../contract/harness.js';
import type { ToolGateContext } from '../decide-tool-gate.js';
import type { PermissionMode } from '../../contract/permission.js';

const call = (toolName: string): ToolCall => ({ toolName, toolInput: {}, toolCallId: 't' });

const ALL_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

afterEach(() => {
  delete process.env.ACCESS_LEVELS_V1;
});

describe('decideToolGate — os_takeover hard-ask (takeover consent core)', () => {
  it.each(['os_takeover', 'mcp__os-hands__os_takeover'])(
    '%s needs a human with a bare ctx',
    (name) => {
      const result = decideToolGate(call(name), {});
      expect(result).toMatchObject({
        decision: 'needs_human',
        interactionKind: 'tool_permission',
      });
    },
  );

  it.each(ALL_MODES)(
    'asks under mode=%s (the ladder never auto-allows it)',
    (mode) => {
      const ctx: ToolGateContext = { mode };
      expect(decideToolGate(call('mcp__os-hands__os_takeover'), ctx)).toMatchObject({
        decision: 'needs_human',
        interactionKind: 'tool_permission',
      });
    },
  );

  it('asks even under the most permissive context (bypass + an allow rule for it)', () => {
    const ctx: ToolGateContext = {
      mode: 'bypassPermissions',
      permissionRules: { allow: [{ toolName: 'os_takeover' }], ask: [], deny: [] },
    };
    expect(decideToolGate(call('os_takeover'), ctx)).toMatchObject({
      decision: 'needs_human',
      interactionKind: 'tool_permission',
    });
  });

  it('asks even at the Autopilot access level with the flag on', () => {
    process.env.ACCESS_LEVELS_V1 = '1';
    const ctx: ToolGateContext = { mode: 'bypassPermissions', accessLevel: 'autopilot' };
    expect(decideToolGate(call('mcp__os-hands__os_takeover'), ctx)).toMatchObject({
      decision: 'needs_human',
      interactionKind: 'tool_permission',
    });
  });

  it('capability deny still wins when the takeover capability is ungranted', () => {
    const ctx: ToolGateContext = {
      grantedCapabilities: new Set(),
      capabilityRequirements: new Map([['os_takeover', 'os.hands']]),
    };
    const result = decideToolGate(call('os_takeover'), ctx);
    expect(result.decision).toBe('deny');
  });
});

// ── One-Grant law (R2): a live per-app actuation grant IS the takeover consent ──
// The snapshot is caller-resolved (the gate stays pure); DIAL is the prod
// posture (bypassPermissions) so a fall-through PROVES the grant rode the
// ladder to allow — and every fail-closed row proves the hard-ask survived it.

const takeover = (app?: unknown): ToolCall =>
  ({ toolName: 'mcp__os-hands__os_takeover', toolInput: app === undefined ? {} : { app }, toolCallId: 't' });
const DIAL: ToolGateContext = { mode: 'bypassPermissions' };

describe('decideToolGate — os_takeover rides the per-app grant (One-Grant R2)', () => {
  it('takeover on a GRANTED app falls through the hard-ask (dial ⇒ allow)', () => {
    const r = decideToolGate(takeover('com.spotify.client'), { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) });
    expect(r.decision).toBe('allow');
  });

  it('bare-named os_takeover rides the grant too (both name shapes)', () => {
    const r = decideToolGate(
      { toolName: 'os_takeover', toolInput: { app: 'com.spotify.client' }, toolCallId: 't' },
      { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) },
    );
    expect(r.decision).toBe('allow');
  });

  it('takeover on an UNGRANTED app still hard-asks', () => {
    const r = decideToolGate(takeover('com.apple.mail'), { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('takeover with NO snapshot hard-asks (fail-closed, prior behavior)', () => {
    expect(decideToolGate(takeover('com.spotify.client'), DIAL).decision).toBe('needs_human');
  });

  it('takeover with no/odd app input hard-asks even with a snapshot', () => {
    const ctx = { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) };
    expect(decideToolGate(takeover(), ctx).decision).toBe('needs_human');
    expect(decideToolGate(takeover(42), ctx).decision).toBe('needs_human');
    expect(decideToolGate(takeover(''), ctx).decision).toBe('needs_human');
    expect(decideToolGate(takeover(null), ctx).decision).toBe('needs_human');
    expect(decideToolGate(takeover(['com.spotify.client']), ctx).decision).toBe('needs_human');
  });

  it('a non-object toolInput hard-asks (total — never throws)', () => {
    const weird = { toolName: 'os_takeover', toolInput: 'com.spotify.client', toolCallId: 't' } as ToolCall;
    const ctx = { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) };
    expect(decideToolGate(weird, ctx).decision).toBe('needs_human');
  });

  it('bundleId match is normalized (case-insensitive)', () => {
    const r = decideToolGate(takeover('COM.SPOTIFY.CLIENT'), { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) });
    expect(r.decision).toBe('allow');
  });

  it('an EMPTY snapshot hard-asks (a grant set with nothing in it grants nothing)', () => {
    const r = decideToolGate(takeover('com.spotify.client'), { ...DIAL, osGrantedApps: new Set<string>() });
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('a granted takeover still loses to a DENY rule (fall-through joins the ladder, not a blanket allow)', () => {
    const ctx: ToolGateContext = {
      mode: 'bypassPermissions',
      osGrantedApps: new Set(['com.spotify.client']),
      permissionRules: { allow: [], ask: [], deny: [{ toolName: 'mcp__os-hands__os_takeover' }] },
    };
    expect(decideToolGate(takeover('com.spotify.client'), ctx).decision).toBe('deny');
  });

  it('release_browser is untouched — always hard-asks', () => {
    const r = decideToolGate({ toolName: 'release_browser', toolInput: {}, toolCallId: 't' } as ToolCall,
                             { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) });
    expect(r.decision).toBe('needs_human');
  });

  it('MCP-suffixed release_browser is untouched too — the grant never leaks across tools', () => {
    const r = decideToolGate(
      { toolName: 'mcp__browser__release_browser', toolInput: { app: 'com.spotify.client' }, toolCallId: 't' } as ToolCall,
      { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) },
    );
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  // Asymmetric name match (R2 hardening): the broad `*__os_takeover` match ASKS,
  // but ONLY the canonical names may RIDE the grant.
  it('a FOREIGN mcp__evil__os_takeover with a granted app STILL hard-asks (only canonical names ride the grant)', () => {
    const r = decideToolGate(
      { toolName: 'mcp__evil__os_takeover', toolInput: { app: 'com.spotify.client' }, toolCallId: 't' } as ToolCall,
      { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) },
    );
    expect(r).toEqual({ decision: 'needs_human', interactionKind: 'tool_permission' });
  });

  it('the CANONICAL mcp__os-hands__os_takeover with a granted app rides the grant (dial ⇒ allow)', () => {
    const r = decideToolGate(
      { toolName: 'mcp__os-hands__os_takeover', toolInput: { app: 'com.spotify.client' }, toolCallId: 't' } as ToolCall,
      { ...DIAL, osGrantedApps: new Set(['com.spotify.client']) },
    );
    expect(r.decision).toBe('allow');
  });
});

describe('decideToolGate — the safe directions are NOT force-asked at step 2b', () => {
  it.each(['os_release_takeover', 'mcp__os-hands__os_release_takeover'])(
    'releasing the hands (%s) falls through the takeover clause',
    (name) => {
      // Step 2b must not intercept it; with a bare ctx it reaches the classifier
      // (auto_allow → allow). Releasing is the safe direction — no per-call ask.
      expect(decideToolGate(call(name), {})).toEqual({ decision: 'allow' });
    },
  );

  it.each(['os_drag', 'mcp__os-hands__os_drag'])(
    'dragging (%s) is gated by the live grant in the sidecar, not by step 2b',
    (name) => {
      // A per-call hard-ask here would double-prompt mid-takeover; the grant was
      // already approved when os_takeover asked. Step 2b leaves it alone.
      expect(decideToolGate(call(name), {})).toEqual({ decision: 'allow' });
    },
  );
});
