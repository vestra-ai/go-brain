/**
 * System prompt for the native next-prompt suggestion (K6-P5 D8). The harness
 * fires a ONE-shot side model call after a completed turn with a trimmed history
 * (last user + last assistant) and this prompt; the streamed text becomes the
 * PROMPT_SUGGESTION chip. Parity intent: match the Claude SDK's promptSuggestions
 * (a single, likely next user message — not a list, not commentary).
 *
 * Single source of truth — do NOT duplicate. Lives in the contract dir so the
 * engine reads no @bash/* product code (cf. COMPACTION_SYSTEM).
 */
export const SUGGESTION_SYSTEM = `You predict the user's single most likely NEXT message in this conversation, given the latest exchange. Output ONLY that one message as the user would phrase it — a short, natural follow-up request or question. Do not add a preamble, options, quotes, or any commentary. If no plausible follow-up exists, output nothing.`;
