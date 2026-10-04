/**
 * Engine constants the relocated policy modules reference (ring 4b-2).
 *
 * These two static values moved into the SDK with the security/permission engine
 * so the moved modules import only SDK siblings. Their product-side home files
 * (`apps/sandbox/src/utils/composio.ts`, `apps/sandbox/src/capability/deny-copy.ts`)
 * now re-export these from `@vestra/agent-sdk` and keep all their other exports.
 */

/** The prefix Composio MCP tool names carry (e.g. `mcp__composio__GMAIL_…`). */
export const COMPOSIO_TOOL_PREFIX = 'mcp__composio__';

/**
 * Composio's connection-management meta tool. Its `execute` does not ACT on a
 * connector — it MINTS a connect link — so it is the one Composio tool a resolved
 * auth pause must never re-execute (continue-interaction.ts settles it instead).
 */
export const COMPOSIO_MANAGE_CONNECTIONS_TOOL = `${COMPOSIO_TOOL_PREFIX}COMPOSIO_MANAGE_CONNECTIONS`;

// TODO(oss): BROWSER_CONTROL_DENY_MESSAGE is a Vestra-flavored string; generalize/inject before any OSS cut.
/**
 * Model-visible deny message when a browser-control tool is used without the
 * `browser.control` capability granted. MUST stay byte-identical across the
 * capability hook and decideToolGate.
 *
 * No longer a PLAN message. Founder ruling 2026-07-29 removed the browser plan
 * gate forever — `browser.control` is granted on every plan including free, so
 * "upgrade to Pro" is now always the wrong thing to tell a user. The gate code
 * itself stays: an empty manifest can still reach here when minting fails
 * (the server forwards `capabilities: []` fail-closed on a DB outage) or before
 * the first per-turn manifest lands. Those are transient errors, and the copy
 * now says so.
 */
export const BROWSER_CONTROL_DENY_MESSAGE =
  'Browser control is unavailable for this turn: it was not in the capability manifest. This is a transient error, not a plan limit; try again on the next message.';
