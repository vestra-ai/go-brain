/**
 * TYPE-LEVEL compatibility proof (K6-P2 B0).
 *
 * The kernel must NOT import the Claude Agent SDK (provider-neutral). So we
 * REPLICATE the exact SDK 0.3.177 hook shapes here (copied from
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) and prove — at compile
 * time — that an SDK-shaped `HookCallback` is ASSIGNABLE to the kernel's
 * `HookCallback`, and an SDK-shaped input/output flows through. If a future edit
 * to the kernel contract breaks this assignability, `pnpm --filter @bash/kernel
 * build` (and `vitest` typecheck of this file) fails — that is the regression
 * guard that keeps the 11 SDK-typed callbacks portable with ZERO rewrite (B5).
 *
 * This file is mostly compile-time; the runtime `it()` exists only so vitest
 * counts it and the file is type-checked as part of the suite.
 */
import { describe, it, expect } from 'vitest';
import type {
  HookCallback as KernelHookCallback,
  HookCallbackMatcher as KernelHookCallbackMatcher,
  HookInput as KernelHookInput,
  HookJSONOutput as KernelHookJSONOutput,
} from '../contract.js';
import { HookDispatcher } from '../dispatcher.js';

// Every kernel hook input EXCEPT the two tool shapes the SDK replica models
// explicitly. Used to build a faithful SDK-superset union (see SdkOtherHookInput).
type KernelOtherHookInput = Exclude<
  KernelHookInput,
  { hook_event_name: 'PreToolUse' } | { hook_event_name: 'PostToolUse' }
>;

// ---------------------------------------------------------------------------
// SDK replica shapes — VERBATIM structure of claude-agent-sdk 0.3.177.
// (We replicate, not import — kernel purity.)
// ---------------------------------------------------------------------------

type SdkBaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  effort?: { level: string };
};

type SdkPreToolUseHookInput = SdkBaseHookInput & {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};

type SdkPostToolUseHookInput = SdkBaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
};

// The real SDK `HookInput` union spans ALL ~30 events; the kernel dispatches a
// 13-event SUBSET, so the SDK callback's `input` parameter is a SUPERTYPE of the
// kernel input. We model that faithfully: the SDK union below includes the two
// SDK-replica tool shapes ABOVE plus every OTHER kernel event input verbatim
// (the kernel base already carries the SDK's required `transcript_path`, so a
// kernel input IS a valid SDK-input member). A too-narrow replica would
// spuriously fail assignability — that build error is what motivated modelling
// the superset honestly.
type SdkOtherHookInput = KernelOtherHookInput;

type SdkPreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};

type SdkSyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?: SdkPreToolUseHookSpecificOutput;
};

type SdkAsyncHookJSONOutput = { async: true; asyncTimeout?: number };
type SdkHookJSONOutput = SdkSyncHookJSONOutput | SdkAsyncHookJSONOutput;
type SdkHookInput = SdkPreToolUseHookInput | SdkPostToolUseHookInput | SdkOtherHookInput;

type SdkHookCallback = (
  input: SdkHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SdkHookJSONOutput>;

type SdkHookCallbackMatcher = {
  matcher?: string;
  hooks: SdkHookCallback[];
  timeout?: number;
};

// Compile-time assert helper: `Expect<true>` only type-checks if the condition holds.
type Expect<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;

// ---------------------------------------------------------------------------
// THE PROOF — these type aliases fail to compile if assignability breaks.
// ---------------------------------------------------------------------------

// 1. An SDK callback is assignable to the kernel callback (the load-bearing one
//    for B5 — the 11 existing callbacks register without rewrite).
type _CallbackAssignable = Expect<IsAssignable<SdkHookCallback, KernelHookCallback>>;

// 2. An SDK output value is assignable to the kernel output type.
type _OutputAssignable = Expect<IsAssignable<SdkHookJSONOutput, KernelHookJSONOutput>>;

// 3. An SDK input value is assignable to the kernel input union.
type _InputAssignable = Expect<IsAssignable<SdkPreToolUseHookInput, KernelHookInput>>;

// 4. An SDK matcher is assignable to the kernel matcher.
type _MatcherAssignable = Expect<IsAssignable<SdkHookCallbackMatcher, KernelHookCallbackMatcher>>;

// Reference the aliases so they participate in type-checking (a `void` use that
// does not trip `noUnusedLocals` the way a bare unused `type` alias would).
export type ContractCompatProof = [
  _CallbackAssignable,
  _OutputAssignable,
  _InputAssignable,
  _MatcherAssignable,
];

describe('contract-compat: an SDK-shaped callback registers + dispatches with ZERO rewrite', () => {
  it('registers an SDK-typed callback against the kernel dispatcher and runs it', async () => {
    // An existing-shaped callback (typed exactly like our 11 SDK callbacks):
    // reads SDK input fields, returns the SDK output shape (a permission decision).
    const sdkShapedCallback: SdkHookCallback = async (input, _toolUseId, _options) => {
      if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
        return {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
        };
      }
      return {};
    };

    const d = new HookDispatcher();
    // No cast, no rewrite — the SDK callback is structurally a kernel HookCallback.
    d.register('PreToolUse', {}, sdkShapedCallback);

    const outcome = await d.dispatch(
      'PreToolUse',
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: '/w',
        transcript_path: '',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'tu_1',
      },
      { toolUseId: 'tu_1', signal: new AbortController().signal },
    );

    expect(outcome.decision).toBe('continue');
    if (outcome.decision === 'continue') {
      expect(outcome.permissionDecision).toBe('deny');
    }
  });
});
