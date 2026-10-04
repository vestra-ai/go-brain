/**
 * X1 — Claude Code hook event fixtures (harness to nine, contract item X1).
 *
 * DOC VERSION: transcribed from the Claude Code hooks reference,
 * https://code.claude.com/docs/en/hooks.md, first fetched 2026-09-30 (sha256 prefix
 * 5129d58370ed4d79, 248,570 bytes) and re-fetched 2026-10-02 (sha256 prefix ccb6f0da88f4159a,
 * 248,534 bytes; the payloads below are unchanged, the matcher table and the Notification
 * types are transcribed from this fetch; the newest version it cites is Claude Code v2.1.274).
 * A re-fetch that changes a payload or a rule below is a fixture update, never a test edit.
 *
 * For each of the twelve events the program targets: the documented stdin payload, the
 * documented fields the native arm does not send (each with its reason), what exit code 2
 * does per the reference's per-event table, and every documented BEHAVIOUR the native arm
 * does not match on purpose, as a named exception with its reason. Nothing is skipped
 * silently: `claude-code-parity.test.ts` fails if an event lacks a verdict, and since the X1
 * gaps closed (2 Oct) it fails if any exception is still a `nextSlice` (a gap to close)
 * rather than a permanent, explained design choice.
 *
 * Data only. Read by kernel/hooks/__tests__/claude-code-parity.test.ts,
 * engine/__tests__/tool-dispatcher.hook-parity.test.ts and
 * apps/sandbox/src/harness/__tests__/hook-parity.claude-code-fixtures.test.ts.
 */

export const CLAUDE_CODE_HOOKS_DOC = {
  url: 'https://code.claude.com/docs/en/hooks.md',
  fetched: '2026-10-02',
  sha256Prefix: 'ccb6f0da88f4159a',
  newestCitedVersion: 'v2.1.274',
} as const;

/** A documented behaviour the native arm differs from on purpose. */
export interface NamedException {
  id: string;
  reason: string;
  /** Listed under the PR's "Next slices" (a gap to close), vs a permanent design choice. */
  nextSlice?: true;
}

export interface HookEventFixture {
  /** The documented stdin payload, as the reference prints it. */
  stdin: Record<string, unknown>;
  /** Documented fields the native arm does not send, each with why. */
  notCarried: Readonly<Record<string, string>>;
  /** Exit 2 per the reference: 'blocks' the action, 'feedback' (stderr reaches the model;
   *  the action already happened), or 'ignored' (the flow proceeds unchanged). */
  exit2: 'blocks' | 'feedback' | 'ignored';
  /** When the native arm dispatches this event. */
  fires: 'always' | 'HOOK_PARITY_V1';
  /** Documented behaviours the native arm does not match, by name. */
  exceptions: readonly NamedException[];
}

const base = {
  session_id: 'abc123',
  transcript_path: '/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/...',
};

/** Field reasons shared by several events. */
const WHY = {
  prompt_id: 'no per-prompt UUID reaches the hook input yet',
  scratchpad_dir: 'the native arm has no session scratchpad directory',
  permission_mode:
    'Vestra access levels are not Claude Code permission modes; a mapped value would mislead a hook',
  background_tasks: 'no task-registry snapshot is taken at Stop',
  session_crons: 'no task-registry snapshot is taken at Stop',
} as const;

export const CLAUDE_CODE_HOOK_EVENTS = {
  PreToolUse: {
    stdin: {
      ...base, prompt_id: '550e8400-e29b-41d4-a716-446655440000',
      scratchpad_dir: '/tmp/claude-1000/-home-user-my-project/abc123/scratchpad', permission_mode: 'default',
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run test suite', timeout: 120000, run_in_background: false },
      tool_use_id: 'toolu_01ABC123...',
    },
    notCarried: { prompt_id: WHY.prompt_id, scratchpad_dir: WHY.scratchpad_dir, permission_mode: WHY.permission_mode },
    exit2: 'blocks',
    fires: 'always',
    exceptions: [
      {
        id: 'PRE_TOOL_USE_ASK_REWRITE_NOT_SHOWN',
        reason: 'a rewrite is never shown on a card (with "ask", or an "allow" whose re-gated rewrite needs a card): the card and its approval re-run the journaled call, so updatedInput applies only with "allow" (the X1 contract rule)',
      },
      {
        id: 'CALLBACK_TIMEOUT_FALLS_THROUGH',
        reason: 'an in-process callback that times out falls through where an Agent SDK callback would block; the security floor is itself the first PreToolUse hook, so a verdict always exists',
      },
    ],
  },
  PermissionRequest: {
    stdin: {
      ...base, permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules directory' },
      permission_suggestions: [{
        type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
        behavior: 'allow', destination: 'localSettings',
      }],
    },
    notCarried: {
      permission_mode: WHY.permission_mode,
      permission_suggestions: 'the "Always allow" offer is minted by the server when the card is raised, after this hook',
    },
    exit2: 'ignored', // "Exit code 2 isn't honored for this event and the permission flow proceeds unchanged"
    fires: 'HOOK_PARITY_V1',
    exceptions: [
      {
        id: 'PERMISSION_REQUEST_TOOL_PERMISSION_ONLY',
        reason: 'fires for tool_permission cards only; question, connect, credit, plan and hands cards are the person\'s to answer',
      },
      {
        id: 'PERMISSION_REQUEST_NEVER_FOR_PAYMENTS_DELETES_OR_ASK_RULES',
        reason: 'a hook may silence a card only where a standing allow rule could: never a payment or a dangerous delete (the hard floor), a card the person\'s own ask rule raised, or release_browser / os_takeover; those cards show and the Notification fires',
      },
      {
        id: 'PERMISSION_REQUEST_REWRITE_KEEPS_CARD',
        reason: 'an allow whose rewrite still needs a card shows the ORIGINAL card, since the approval re-runs the journaled call',
      },
      {
        id: 'PERMISSION_REQUEST_UPDATED_PERMISSIONS_NOT_APPLIED',
        reason: 'updatedPermissions is accepted and never applied: its destinations are settings files on the person\'s own machine and a session permission mode; on a cloud box the person\'s standing rules live on the server and are written only when the person answers a card, so a hook answers one card and is asked again at the next (interrupt is honored: a deny with interrupt:true refuses the call and ends the turn as hook_blocked, the hook\'s message as its reason)',
      },
      {
        id: 'PERMISSION_REQUEST_INTERRUPT_IN_A_HELPER_IS_A_DENY',
        reason: 'inside a helper (an Agent tool child) a deny with interrupt:true refuses the call like any deny and the helper reads the reason; the stop applies to the person\'s turn, which only the parent\'s own calls can end',
      },
      {
        id: 'PERMISSION_REQUEST_HALT_IGNORED',
        reason: 'continue:false is not an answer; the card shows so a person still decides',
      },
    ],
  },
  PostToolUse: {
    stdin: {
      ...base, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: '/path/to/file.txt', content: 'file content' },
      tool_response: { filePath: '/path/to/file.txt', type: 'create' },
      tool_use_id: 'toolu_01ABC123...', duration_ms: 12,
    },
    notCarried: { permission_mode: WHY.permission_mode, duration_ms: 'the dispatcher does not time the tool yet (documented as optional)' },
    exit2: 'feedback', // "Shows stderr to Claude; the tool already ran"
    fires: 'always',
    exceptions: [
      {
        id: 'POST_TOOL_USE_RESPONSE_SHAPE',
        reason: 'tool_response is the native tool\'s own result (a string for most built-ins), not Claude Code\'s structured Output object; the reference says the schema depends on the tool',
      },
    ],
  },
  UserPromptSubmit: {
    stdin: {
      ...base, permission_mode: 'default', hook_event_name: 'UserPromptSubmit',
      prompt: 'Write a function to calculate the factorial of a number',
    },
    notCarried: { permission_mode: WHY.permission_mode },
    exit2: 'blocks',
    fires: 'always',
    exceptions: [],
  },
  Stop: {
    stdin: {
      ...base, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: true,
      last_assistant_message: "I've completed the refactoring. Here's a summary...",
      background_tasks: [{ id: 'task-001', type: 'shell', status: 'running', description: 'tail logs', command: 'tail -f /var/log/syslog' }],
      session_crons: [{ id: 'cron-001', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' }],
    },
    notCarried: { permission_mode: WHY.permission_mode, background_tasks: WHY.background_tasks, session_crons: WHY.session_crons },
    exit2: 'blocks', // prevents stopping: the reason becomes the next instruction (HOOK_PARITY_V1)
    fires: 'always',
    exceptions: [
      {
        id: 'STOP_CONTINUATION_CAP_3',
        reason: 'the loop guard is three consecutive continuations (Claude Code: eight); each one is a paid model call',
      },
    ],
  },
  SubagentStart: {
    stdin: { ...base, hook_event_name: 'SubagentStart', agent_id: 'agent-abc123', agent_type: 'Explore' },
    notCarried: {},
    exit2: 'ignored',
    fires: 'always',
    exceptions: [
      {
        id: 'SUBAGENT_HOOKS_NOT_DECLARABLE_BY_ABILITIES',
        reason: 'an ability may not declare SubagentStart or SubagentStop (contract/ability-hooks.ts ABILITY_HOOK_EVENTS, a K6-P2 B6 product choice), where Claude Code lets a skill\'s frontmatter; every SubagentStart/SubagentStop callback the product registers gets the documented answers (context seeds the helper, a block keeps it running), so opening the declaration is a policy call, not an engine gap',
      },
    ],
  },
  SubagentStop: {
    stdin: {
      ...base, permission_mode: 'default', hook_event_name: 'SubagentStop', stop_hook_active: false,
      agent_id: 'def456', agent_type: 'Explore',
      agent_transcript_path: '~/.claude/projects/.../abc123/subagents/agent-def456.jsonl',
      last_assistant_message: 'Analysis complete. Found 3 potential issues...',
      background_tasks: [], session_crons: [],
    },
    notCarried: {
      permission_mode: WHY.permission_mode,
      agent_transcript_path: 'a helper\'s history is a journal scope, not a file',
      background_tasks: WHY.background_tasks,
      session_crons: WHY.session_crons,
    },
    exit2: 'blocks',
    fires: 'always',
    exceptions: [
      {
        id: 'SUBAGENT_STOP_CONTINUATION_CAP_3',
        reason: 'a block keeps one helper running at most three times (the Stop cap; Claude Code: eight), each continuation a turn out of the helper\'s own max turns and journaled into its scope; the hook is not asked on a round that cannot go on (the context ceiling emptied the tools, a runaway or wrap-up directive, no turn left); the stop the hooks then allow is the helper\'s one SubagentStop',
      },
      {
        id: 'SUBAGENT_STOP_HOOK_ACTIVE_IS_THE_HELPERS_OWN',
        reason: 'stop_hook_active is true when SubagentStop asks the same helper again after a block (the loop guard a hook needs); the reference means "a Stop hook is running in the parent conversation", which the helper\'s path cannot see',
      },
    ],
  },
  PreCompact: {
    stdin: { ...base, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null },
    notCarried: {},
    exit2: 'blocks',
    fires: 'always',
    exceptions: [
      {
        id: 'PRE_COMPACT_COLD_COMPACT_NOTICE',
        reason: 'a block is honored on the proactive trigger (it skips, the conversation goes on uncompacted, and the hook is asked again on the retry bound\'s clock) and a warm /compact (it shows the hook\'s reason), but a /compact on a box with no live run shows the usual notice: the cold path returns no refusal to its caller; the block and its reason are journaled (compaction_failed, hook_blocked)',
      },
      {
        id: 'PRE_COMPACT_NEVER_BLOCKS_A_RECOVERY',
        reason: 'on a context-limit recovery (the provider already refused the request) a block is logged and the compaction proceeds: Claude Code falls back to a smaller model or the person\'s /delete there, a box has neither, and an honored block would end every later turn at the context limit',
      },
      {
        id: 'PRE_COMPACT_CONTINUE_FALSE_COMPACTS',
        reason: 'continue:false ("abort compaction, but that stops Claude entirely") is not honored: the compaction proceeds and the turn is not stopped; only a block (decision:"block" or exit 2) refuses it',
      },
    ],
  },
  PostCompact: {
    stdin: { ...base, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'Summary of the compacted conversation...' },
    notCarried: {},
    exit2: 'ignored',
    fires: 'always',
    exceptions: [],
  },
  SessionStart: {
    stdin: {
      ...base, hook_event_name: 'SessionStart', source: 'resume', model: 'claude-opus-5',
      seconds_since_last_response: 5400, context_tokens: 182340,
      prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396,
    },
    notCarried: {
      model: 'documented as sometimes omitted; the native run does not pass it',
      seconds_since_last_response: 'resume metrics are not computed (documented only for resume/fork)',
      context_tokens: 'resume metrics are not computed (documented only for resume/fork)',
      prompt_cache_likely_expired: 'resume metrics are not computed (documented only for resume/fork)',
      estimated_cache_write_usd: 'resume metrics are not computed (documented only for resume/fork)',
    },
    exit2: 'ignored',
    fires: 'always',
    exceptions: [
      {
        id: 'SESSION_START_NO_CLEAR_OR_FORK',
        reason: 'sources are "startup", "resume" (the run opens on a conversation that already holds a reply) and "compact" (after every compaction; its context rides as a hook entry where a turn resumes, and is not kept after a /compact, where it would merge into the person\'s next message); the native arm has no /clear (a fresh conversation is a new task, so "startup") and no fork yet (R3), so "clear" and "fork" never occur',
      },
      {
        id: 'SESSION_START_OUTPUT_FIELDS_NOT_READ',
        reason: 'sessionTitle, initialUserMessage, watchPaths and reloadSkills are not read: a task\'s title is the product\'s, every run has the person\'s message, there is no FileChanged event, and abilities are in place before the run opens',
      },
    ],
  },
  SessionEnd: {
    stdin: { ...base, hook_event_name: 'SessionEnd', reason: 'other' },
    notCarried: {},
    exit2: 'ignored',
    fires: 'always',
    exceptions: [
      {
        id: 'SESSION_END_REASON_OTHER_ONLY',
        reason: 'the native run always ends "other" (its input drained; "input_exhausted" with the flag off): clear, resume, logout and prompt_input_exit name a terminal the person quits, which a cloud box has not',
      },
    ],
  },
  Notification: {
    stdin: {
      ...base, hook_event_name: 'Notification', message: 'Claude needs your permission',
      title: 'Permission needed', notification_type: 'permission_prompt',
    },
    notCarried: {},
    exit2: 'ignored',
    fires: 'HOOK_PARITY_V1',
    exceptions: [
      {
        id: 'NOTIFICATION_TYPES_NOT_ON_A_CLOUD_BOX',
        reason: 'permission_prompt, elicitation_dialog and elicitation_response are sourced; every other documented type is named in NOTIFICATION_TYPES_NOT_SOURCED with why a cloud box has no source for it',
      },
      {
        id: 'NOTIFICATION_NO_SIX_SECOND_WAIT',
        reason: 'permission_prompt fires when the card is raised, not after ~6 s: the turn ends on the pause, so no live process waits to count',
      },
    ],
  },
} satisfies Record<string, HookEventFixture>;

export type ClaudeCodeHookEventName = keyof typeof CLAUDE_CODE_HOOK_EVENTS;

/** The Notification types the reference documents (its matcher table), in its order. */
export const DOCUMENTED_NOTIFICATION_TYPES = [
  'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
  'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed',
  'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
] as const;

/** The types the native arm fires: the permission card's and the MCP question card's (X5). */
export const NATIVE_NOTIFICATION_TYPES = ['permission_prompt', 'elicitation_dialog', 'elicitation_response'] as const;

/** Every documented type the native arm does not fire, each with why. */
export const NOTIFICATION_TYPES_NOT_SOURCED: Readonly<Record<string, string>> = {
  idle_prompt: 'the turn ends and the box may sleep: no live process counts a minute of quiet after a reply',
  auth_success: 'Claude Code\'s own sign-in; a box never signs in, the server mints its credentials',
  elicitation_url_dialog: 'URL-mode elicitation is declined (mcp-client.ts: form mode only), so no URL request is ever shown',
  elicitation_complete: 'reports a URL-mode elicitation finishing, and URL mode is declined',
  agent_needs_input: 'agent view in a terminal; a waiting task is the question card, which fires elicitation_dialog or permission_prompt',
  agent_completed: 'agent view in a terminal; a finished task ends its turn on the server',
  quota_auto_resume_fired: 'a claude.ai usage-limit wait; credit on a box is the product\'s own card',
  quota_auto_resume_stale: 'a claude.ai usage-limit wait; credit on a box is the product\'s own card',
  quota_auto_resume_disabled: 'a claude.ai usage-limit wait; credit on a box is the product\'s own card',
};

/**
 * The field each event's matcher filters on, per the reference's matcher table; null where
 * the event has no matcher support (a matcher there is ignored, so the group always runs).
 */
export const CLAUDE_CODE_MATCHER_FIELDS: Readonly<Record<ClaudeCodeHookEventName, string | null>> = {
  PreToolUse: 'tool_name', PostToolUse: 'tool_name', PermissionRequest: 'tool_name',
  SessionStart: 'source', SessionEnd: 'reason', Notification: 'notification_type',
  SubagentStart: 'agent_type', SubagentStop: 'agent_type', PreCompact: 'trigger', PostCompact: 'trigger',
  UserPromptSubmit: null, Stop: null,
};

/** The documented outputs, verbatim in shape. */
export const CLAUDE_CODE_HOOK_OUTPUTS = {
  preToolUseDeny: {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Database writes are not allowed' },
  },
  preToolUseAllowRewrite: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'My reason here',
      updatedInput: { field_to_modify: 'new value' },
    },
  },
  permissionRequestAllowRewrite: {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'npm run lint' } } },
  },
  permissionRequestDeny: {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on this box' } },
  },
  topLevelBlock: { decision: 'block', reason: 'Test suite must pass before proceeding' },
  stopEverything: { continue: false, stopReason: 'Build failed, fix errors before continuing' },
} as const;

/** The keys of a documented payload the native arm is expected to send. */
export function carriedKeys(event: ClaudeCodeHookEventName): string[] {
  const f: HookEventFixture = CLAUDE_CODE_HOOK_EVENTS[event];
  return Object.keys(f.stdin).filter((k) => !(k in f.notCarried));
}

/**
 * Every carried key is present on `actual` with the documented JSON type (null counts
 * as its own type). `tool_response` is presence-only (POST_TOOL_USE_RESPONSE_SHAPE).
 */
export function shapeMismatches(event: ClaudeCodeHookEventName, actual: Record<string, unknown>): string[] {
  const doc: Record<string, unknown> = CLAUDE_CODE_HOOK_EVENTS[event].stdin;
  const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  return carriedKeys(event)
    .filter((k) => !(k in actual) || (k !== 'tool_response' && kind(actual[k]) !== kind(doc[k])))
    .map((k) => `${k}: documented ${kind(doc[k])}, got ${k in actual ? kind(actual[k]) : 'missing'}`);
}
