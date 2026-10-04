/**
 * The owner's per-app pins against code in Composio's remote sandbox (staging RCA, 2026-10-03).
 *
 * A per-app pin (`apps.slack.external_send = 'block' | 'ask'`) is held against the app a call
 * reaches. A MULTI_EXECUTE batch names its tools in `tools[].tool_slug`, so the gate holds each
 * item to its own app's pins (decide-tool-gate `resolveConfigPosture`). A remote workbench script
 * names nothing the gate can trust: `run_composio_tool("SLACK_SEND_MESSAGE")` is one spelling of
 * a Slack send, and a slug built at run time, `proxy_execute`, or the remote shell are others. The
 * gate read the call as toolkit 'composio', so no Slack or Gmail pin was ever consulted, and a task
 * could do through the workbench exactly what its owner had forbidden.
 *
 * So the rule keys on the owner's pins, never on the script:
 *   - any app BLOCK pin: the call is refused. A block is a "never", and an ask card would let one
 *     tap undo it (in a clamped config, possibly a tap by someone other than whoever set it).
 *   - otherwise any app ASK pin: the call hard-asks, above mode and allow rules, as the pin itself does.
 *   - no block or ask pin: unchanged.
 *
 * Its own module because decide-tool-gate.ts sits at the file-size ratchet. Pure + total.
 */
import type { AppAction, CompiledAccessConfig } from './access-config.js';
import type { SideEffectFamily } from './side-effect-classifier.js';
import { isComposioRemoteCodeTool } from './composio-naming.js';

/** The pin a remote-code call answers to: the first block when there is one, else the first ask. */
export interface RemoteCodePin {
  toolkit: string;
  family: SideEffectFamily;
  action: 'block' | 'ask';
}

/**
 * The pin that governs this call when it runs code in Composio's remote sandbox, or null when the
 * call is any other tool or the config pins no app to block or ask (allow pins only loosen, so
 * they never count). Order is the config's own, so the deny copy is stable.
 */
export function remoteCodePinOf(cfg: CompiledAccessConfig, toolName: string): RemoteCodePin | null {
  if (!isComposioRemoteCodeTool(toolName)) return null;
  let ask: RemoteCodePin | null = null;
  for (const [toolkit, cells] of cfg.apps) {
    for (const [family, action] of Object.entries(cells) as [SideEffectFamily, AppAction | undefined][]) {
      if (action === 'block') return { toolkit, family, action };
      if (action === 'ask' && ask === null) ask = { toolkit, family, action };
    }
  }
  return ask;
}

/** Follows the config-block sentence when a remote-code call is refused for an app's block. */
export const REMOTE_CODE_BLOCK_TAIL =
  "Code in the remote workbench can reach every app, so it does not run while one is blocked. " +
  "Use the app's own tools, and run code in this workspace.";

/** The permission card for a remote-code call that asks because of an app's ask pin. */
export const REMOTE_CODE_ASK_HEADLINE = 'Run code in the remote workbench';
export const REMOTE_CODE_ASK_REASON =
  'Code there can reach any of your apps, and you asked me to check before some of them act.';
