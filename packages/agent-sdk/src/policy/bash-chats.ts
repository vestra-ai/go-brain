/**
 * BASH'S OWN CHATS: a task never writes into its own chat with Bash as the owner (2026-10-03).
 *
 * Staging, 3 Oct (task d6cd2177): asked in his Slack DM to "voice message me", the composer started a
 * task, and the task, holding his own Slack login through the app integrations, uploaded the voice note
 * AS HIM into that same DM. Slack handed it back to Bash as his message, and the composer ran a turn on
 * its own task's post. That chat is where Bash delivers the task's result, so a write into it made as the
 * owner is never the task's to make: the gate refuses it (decideToolGate step 1c) whatever the mode, the
 * level or an allow rule says, in words the agent can act on.
 *
 * The chats ride the task's access config (`bashChats`, written by the server at a chat birth): Slack's
 * D… channel of the owner's DM with Bash and Bash's own user, U…. A write is any Composio call that is
 * not a read and whose destination argument names one of them: a direct call, a MULTI_EXECUTE item, or,
 * for a workbench script (whose arguments are code), a proxied tool that is not a read beside a literal
 * mention of one in the code. Reading the chat stays open. Pure + total.
 */
import type { ToolCall } from '../contract/harness.js';
import { COMPOSIO_TOOL_PREFIX } from './engine-constants.js';
import { isComposioExecutorMetaTool, isComposioMetaTool, isComposioWorkbenchMetaTool } from './composio-naming.js';
import {
  classifyMetaExecutorTools,
  classifySideEffect,
  collectComposioSlugs,
  type SideEffectFamily,
} from './side-effect-classifier.js';
import type { ComposioToolHints } from './sensitivity-floor.js';

/** The refusal the agent reads. No em dashes, never "Claude". */
export const BASH_CHAT_DENY_MESSAGE = 'Not sent. Your result reaches this chat through Bash; save it as a file instead.';

/** The argument fields that name where a write lands (the deliver ledger's, messaging-shaped). */
const DESTINATION_FIELDS = ['channel', 'channels', 'channel_id', 'conversation_id', 'to', 'recipient', 'recipients', 'chat_id'] as const;

/** Every id a destination field names, lowercased: Slack's `channels` is one comma-separated string. */
function namedIds(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string') out.push(...v.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()));
    else if (Array.isArray(v)) v.forEach(add);
  };
  for (const field of DESTINATION_FIELDS) add((args as Record<string, unknown>)[field]);
  return out;
}

const writes = (family: SideEffectFamily): boolean => family !== 'readonly';

/** A Composio slug's family, judged as the direct call would be. */
const familyOf = (slug: string, hints?: ComposioToolHints): SideEffectFamily =>
  classifySideEffect({ toolName: COMPOSIO_TOOL_PREFIX + slug, toolInput: {}, toolCallId: '' }, { workspaceRoot: '', composioToolHints: hints });

/**
 * The refusal when `call` writes into one of `chats` (lowercased ids, as compiled), else null. A call
 * that names none of them, or only reads, is never this guard's to decide.
 */
export function bashChatWriteDenial(call: ToolCall, chats: ReadonlySet<string>, hints?: ComposioToolHints): string | null {
  try {
    if (chats.size === 0 || !call || typeof call.toolName !== 'string' || !call.toolName.startsWith(COMPOSIO_TOOL_PREFIX)) return null;
    const hit = (args: unknown): boolean => namedIds(args).some((id) => chats.has(id));
    if (isComposioWorkbenchMetaTool(call.toolName)) {
      const code = JSON.stringify(call.toolInput ?? '').toLowerCase();
      const proxiedWrite = collectComposioSlugs(call).some((slug) => writes(familyOf(slug, hints)));
      return proxiedWrite && [...chats].some((id) => code.includes(id)) ? BASH_CHAT_DENY_MESSAGE : null;
    }
    if (isComposioExecutorMetaTool(call.toolName)) {
      const items = (call.toolInput as { tools?: unknown } | null)?.tools;
      const inner = classifyMetaExecutorTools(call, hints);
      if (!Array.isArray(items) || inner === null) return null;
      return inner.some((t, i) => writes(t.family) && hit((items[i] as { arguments?: unknown } | null)?.arguments)) ? BASH_CHAT_DENY_MESSAGE : null;
    }
    if (isComposioMetaTool(call.toolName)) return null;
    return writes(classifySideEffect(call, { workspaceRoot: '', composioToolHints: hints })) && hit(call.toolInput) ? BASH_CHAT_DENY_MESSAGE : null;
  } catch {
    return null;
  }
}
