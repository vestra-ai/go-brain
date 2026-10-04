/**
 * gemini-interactions-wire — the Gemini Interactions API wire shape, hand-declared
 * from `@google/genai@2.21.0`'s own type declarations (dist/genai.d.ts, the
 * post-May-2026 `steps` schema). Types only; the transport speaks REST over
 * `fetch` (POST {base}/v1beta/interactions, SSE `data:` lines, `[DONE]`).
 *
 * Verified 2026-09-03 against ai.google.dev/gemini-api/docs/interactions/{streaming,
 * function-calling}, the May-2026 breaking-changes guide, and the thinking guide.
 */

export interface GeminiTextContent {
  type: 'text';
  text: string;
}

export interface GeminiImageContent {
  type: 'image';
  /** base64 bytes. */
  data: string;
  mime_type: string;
  /** Media-refs S1 — INTERNAL projection-only marker (the image's CDN url) so the
   *  request-build pass can edge-fetch bytes for a url-only image. NEVER wire-legal:
   *  materializeGeminiInteractionsBody strips it in every flag state. */
  vestraImageUrl?: string;
}

/**
 * Video, audio or a PDF (VIDEO_UNDERSTANDING_V1, spec §7). Unlike an image these
 * never ride as bytes: the file goes to Google's Files API once and the model call
 * cites the reference, so a 400 MB clip costs the wire a url.
 */
export interface GeminiMediaContent {
  type: 'video' | 'audio' | 'document';
  mime_type: string;
  /** Files API uri once resolved; '' while the INTERNAL marker below is present. */
  uri: string;
  resolution?: 'low' | 'medium' | 'high';
  /** Offsets are Google's duration strings ("12s"), not numbers. */
  processing?: { start_offset?: string; end_offset?: string; fps?: number };
  /** INTERNAL projection→transport marker; materializeGeminiInteractionsBody
   *  resolves it to `uri` and strips it. NEVER wire-legal. */
  vestraMediaRef?: {
    /** `watch` only: an unresolvable file THROWS instead of becoming a placeholder
     *  note — see MediaWatchOptions.strict. Absent on every main-lane block. */
    strict?: true;
    path: string;
    url?: string;
    sha?: string;
    mimeType: string;
    /** The block's HINT (0 = unknown). The upload sizes itself from a stat. */
    sizeBytes: number;
    displayName: string;
  };
}

export type GeminiInteractionsContent = GeminiTextContent | GeminiImageContent | GeminiMediaContent;

export interface GeminiUserInputStep {
  type: 'user_input';
  content: GeminiInteractionsContent[];
}

export interface GeminiModelOutputStep {
  type: 'model_output';
  content: GeminiInteractionsContent[];
  /** google.rpc.Status on a blocked/failed output (safety, recitation). */
  error?: { code?: number | string; message?: string; status?: string };
}

export interface GeminiThoughtStep {
  type: 'thought';
  /** The opaque signature that MUST be resent verbatim in stateless mode. */
  signature?: string;
  summary?: GeminiTextContent[];
}

export interface GeminiFunctionCallStep {
  type: 'function_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GeminiFunctionResultStep {
  type: 'function_result';
  call_id: string;
  name?: string;
  result: GeminiInteractionsContent[];
  is_error?: boolean;
}

export type GeminiInteractionsStep =
  | GeminiUserInputStep
  | GeminiModelOutputStep
  | GeminiThoughtStep
  | GeminiFunctionCallStep
  | GeminiFunctionResultStep;

/** One entry under `tools` — the flat function shape (NOT generateContent's functionDeclarations). */
export interface GeminiFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GeminiInteractionsRequest {
  model: string;
  input: GeminiInteractionsStep[];
  system_instruction?: string;
  tools?: GeminiFunctionTool[];
  /** ALWAYS false: the journal is the source of truth, never Google's store. */
  store: false;
  stream: true;
  generation_config: {
    max_output_tokens: number;
    thinking_level?: GeminiThinkingLevel;
    thinking_summaries?: 'auto' | 'none';
  };
  response_format?: { type: 'text'; mime_type: 'application/json'; schema: unknown };
}

export interface GeminiInteractionsUsage {
  /** INCLUSIVE of the cached portion (normalizeGeminiInteractionsUsage subtracts it). */
  total_input_tokens?: number;
  /** EXCLUSIVE of thought tokens (they bill at the output rate — fold them in). */
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
}

export type GeminiInteractionsStatus =
  | 'in_progress'
  | 'requires_action'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'incomplete'
  | 'budget_exceeded'
  | 'queued'
  | (string & {});

export type GeminiStepDelta =
  | { type: 'text'; text: string }
  | { type: 'thought_summary'; content?: GeminiTextContent }
  | { type: 'thought_signature'; signature?: string }
  /** A JSON STRING fragment — concatenate, then parse once at step.stop. */
  | { type: 'arguments_delta'; arguments?: string }
  | { type: string; [k: string]: unknown };

export interface GeminiInteractionsError {
  code?: string;
  message?: string;
}

/** The SSE event union (`data: {"event_type": …}`). Unknown event types are ignored. */
export type GeminiInteractionsEvent =
  | { event_type: 'interaction.created'; interaction: { id: string; status?: GeminiInteractionsStatus } }
  | { event_type: 'interaction.status_update'; interaction_id: string; status: GeminiInteractionsStatus }
  | { event_type: 'step.start'; index: number; step: GeminiInteractionsStep | { type: string; [k: string]: unknown } }
  | {
      event_type: 'step.delta';
      index: number;
      delta: GeminiStepDelta;
      metadata?: { total_usage?: GeminiInteractionsUsage };
    }
  | { event_type: 'step.stop'; index: number; step_usage?: GeminiInteractionsUsage }
  | {
      event_type: 'interaction.completed';
      interaction: {
        id: string;
        status: GeminiInteractionsStatus;
        usage?: GeminiInteractionsUsage;
        errors?: GeminiInteractionsError[];
      };
    }
  | { event_type: 'error'; error?: GeminiInteractionsError }
  | { event_type: string; [k: string]: unknown };
