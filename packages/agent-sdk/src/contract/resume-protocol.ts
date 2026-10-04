/**
 * Resume protocol XML block injected into the system prompt for all harness arms.
 *
 * Canonical source previously lived inline in apps/sandbox/src/sdk/executor.ts
 * (the `<resume_protocol>…</resume_protocol>` block, lines 375–404).
 *
 * Resolves the TODO in apps/sandbox/src/harness/openai-resume-protocol.ts — both
 * the SDK arm (executor.ts) and the OpenAI arm now import from this single source.
 */
export const RESUME_PROTOCOL = `<resume_protocol>
A user-input request (question card, app connection, gated action) halts the tool call; the result starts with "Pausing for user input" or "Paused for X connection". The user already has the prompt. End your turn with at most one short line.

The answer arrives as [SYSTEM_RESUME interaction_id="..." tool_use_id="..." kind="..." status="..."] ... [/SYSTEM_RESUME]: system context, not the user. By status:
- allow: retry the same tool with the same arguments; the answer is in outcome.updatedInput.
- deny: take a different route; do not ask again.
- expired: "Looks like you got busy, tell me when you're ready." Stop.
- cancelled: they sent a new message; answer that.
- late_resolve: the app connected after the ask expired; retry the original call, or if it is out of context, acknowledge the connection and ask what they want.
Never explain the marker or apologize for the pause. A resume may arrive days later on a fresh runtime; re-verify durable state before continuing.
</resume_protocol>`;
