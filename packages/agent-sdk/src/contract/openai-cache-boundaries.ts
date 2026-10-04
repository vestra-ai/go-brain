/**
 * OpenAI builds whose prompt cache is read only at lookup boundaries (GPT-5.6 and later):
 * the registry's `cache.readsAtBoundaries` (model-capabilities.ts OPENAI_BOUNDARY_CACHE_POLICY).
 *
 * On these a request reads a cached prefix only where one of its boundaries matches a write:
 * "the implicit breakpoint, up to 20 earlier eligible message endings, and the endpoint of the
 * initial consecutive block of developer messages" (developers.openai.com prompt-caching guide).
 * The developer block is our `instructions`, and it held the memory block, which differs per
 * task, so a person's new task matched no boundary and read nothing (staging: 189 of 222
 * new-task first rounds on GPT-6.1 Sol cached 0). With the memory sent as the first user input
 * item, the developer block ends on bytes their tasks share, and a new task reads it
 * (RESPONSES_MEMORY_INPUT_V1). A developer-role input item would join the developer block and
 * read nothing either.
 *
 * Live-probed 2026-10-04 (a 16.3k-token request, its memory swapped for a new task's): 0 cached
 * with the memory in `instructions`, 0 as a developer item, 15.5k as a user item, on each of
 * gpt-6.1-sol, gpt-6-luna and gpt-6-astra. Give a row the field only after the same probe.
 */
import { resolveCapabilities } from './model-capabilities.js';

/** Does this model read OpenAI's prompt cache only at lookup boundaries (the registry field)? */
export function readsCacheAtBoundaries(model: string): boolean {
  return resolveCapabilities(model).cache.readsAtBoundaries === true;
}
