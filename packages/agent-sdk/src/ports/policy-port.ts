import type { ToolCall, GateResult } from '../contract/harness.js';
import type { PermissionMode } from '../contract/permission.js';

/** Context the engine hands the policy gate for a single tool call. */
export interface PolicyGateContext {
  taskId: string;
  isTaskStopping: boolean;
  connectedApps: Set<string>;
  grantedCapabilities: Set<string>;
}

/**
 * PolicyPort — the host's tool-gating decision + permission mode. The security
 * ENGINE (danger patterns, ladder) ships in the SDK; this port supplies the
 * host's rule DATA and the final decision.
 */
export interface PolicyPort {
  gate(call: ToolCall, cx: PolicyGateContext): Promise<GateResult>;
  permissionMode(taskId: string): PermissionMode;
  seedModeFromEnv(taskId: string): void;
}

/** SDK default: allow everything (bypass). Hosts override for real gating. */
export class AllowAllPolicyPort implements PolicyPort {
  async gate(_call: ToolCall, _cx: PolicyGateContext): Promise<GateResult> {
    return { decision: 'allow' };
  }
  permissionMode(_taskId: string): PermissionMode {
    return 'bypassPermissions';
  }
  seedModeFromEnv(_taskId: string): void {
    /* no-op default */
  }
}
