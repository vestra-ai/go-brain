/**
 * openai-tool-schema — the OpenAI Responses lane's tool-schema entry point: convert
 * a tool's Zod `parameters` into the JSON Schema the API actually needs, and decide
 * (per-tool) whether the converted schema is OpenAI-strict-compatible so `strict:true`
 * is 400-safe. Both pieces now live elsewhere and are re-exported at the bottom; this
 * header is where the reasoning behind them is written down.
 *
 * WHY THIS EXISTS (the founder-reproduced bug)
 * --------------------------------------------
 * `RawToolOptions.parameters` is a Zod schema OBJECT at runtime. The old transport
 * passed it straight through as the Responses `parameters` — so OpenAI received a
 * Zod-internal blob (`{def:...}`) with NO `properties`/`required`. With no real
 * schema the model invents argument keys (it called `Skill` with `{skill}` for a
 * tool whose only param is `name` → a local TypeError → the skill showed "Failed").
 * Claude tolerates the malformed schema; OpenAI does not. Converting to JSON Schema
 * fixes that for EVERY function tool, even at strict:false.
 *
 * THE 400 TRAP (why we gate strict per-tool)
 * ------------------------------------------
 * OpenAI returns a 400 for the WHOLE request if ANY tool sent with `strict:true`
 * has a schema that is not strict-compatible. OpenAI strict requires, at EVERY
 * object level: `additionalProperties:false` AND every key in `properties` also in
 * `required`. Our tools use `.nullable().optional()` for optional fields, which
 * `z.toJSONSchema` correctly drops from `required` (and `z.record(...)` emits
 * `additionalProperties:{}`). So most core tools convert to a schema that is NOT
 * strict-compatible. Blindly honoring `strict` would 400 every gpt turn.
 *
 * So: we ALWAYS send the real converted schema (fixes the wrong-key bug), and we
 * set `strict:true` ONLY when the converted schema passes `isOpenAIStrictCompatible`.
 * A tool that isn't strict-safe is sent with `strict:false` + its real schema — the
 * model still sees the right keys, and the request can never 400.
 *
 * Scope of the CONVERSION: no longer OpenAI-only. The Anthropic lane converts too —
 * its raw-Zod passthrough cost the same `def` wrappers and dropped the same
 * `.describe()` docs Claude was merely tolerating. What stays OpenAI-specific is
 * the per-tool strict gate described above.
 */

// Both halves of this module have been RELOCATED; they are re-exported here so
// existing callers keep their import path.
//   - `isOpenAIStrictCompatible` → contract/openai-strict-schema.ts (pure, zero-zod),
//     so the engine could reuse it without an engine→transports import.
//   - the zod converter → contract/tool-json-schema.ts, because it is provider-neutral
//     and every other lane now shares it. A sibling lane importing something named
//     `toOpenAIToolJsonSchema` would read as a lie; the name follows the scope. Same
//     function either way, so this lane's bytes are unchanged.
export { isOpenAIStrictCompatible } from '../contract/openai-strict-schema.js';
export { toToolJsonSchema as toOpenAIToolJsonSchema, type JsonSchema } from '../contract/tool-json-schema.js';
