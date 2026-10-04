import { z } from 'zod';
import type { RawToolOptions, ToolExecuteContext } from './tool-types.js';
import { softFail } from './result-shape.js';
import { TOOL_DESCRIPTIONS } from './descriptions/index.js';
import { resolveProviderChain, searchWithChain, AllProvidersUnconfigured, AllProvidersBillingDead, type WebToolConfig } from './web-providers.js';

/** Metadata kept for any tool-listing UI. */
export const WEB_SEARCH_TOOL = { name: 'WebSearch' as const, description: TOOL_DESCRIPTIONS.WebSearch };

/**
 * Terminal directive returned once the billing-dead breaker has tripped. A
 * plain "WebSearch error:" string reads as transient and the model retries
 * forever (the 2026-08-20 livelock: ~5 searches/sec for 45+ minutes against
 * two 402ing vendors) — this must instead end the retrying and route an honest
 * heads-up to the user through the model. The 08-20 loop ran INSIDE a
 * Researcher subagent, whose only user-reaching surface is its report to the
 * parent — so the directive addresses that audience explicitly: wrap up and
 * report the outage upward rather than grinding on a dead tool.
 */
const BILLING_DEAD_DIRECTIVE =
  'Web search is unavailable for this task: the search provider account is out of credits. ' +
  'Do not retry WebSearch in this task; every retry will fail the same way, and do not use WebFetch to run searches. ' +
  'If you are a subagent, finish your remaining work now and state in your report that web search is unavailable, so the main agent can inform the user. ' +
  'Otherwise, tell the user that web search is temporarily unavailable and continue the task without it. ' +
  'Fetching a specific page URL you already have with WebFetch may still work.';

/**
 * WebSearch as OUR OWN tool (provider-agnostic), driven by the provider chain
 * (exa) via web-providers.ts. Returns JSON in the
 * shape the FE parseSearchResult accepts so the WebSearchCard renders
 * identically on every arm. Never throws into the loop.
 *
 * The web-tool config is injected via getConfig (resolved from env by the
 * sandbox shim at call time): serverUrl/apiToken for the credential proxy plus
 * the provider order + per-provider tuning. The logger coupling is inverted to
 * an optional warn callback.
 */
export function makeWebSearchTool(
  taskId: string,
  getConfig: () => WebToolConfig,
  warn: (msg: string) => void = () => {},
): RawToolOptions {
  // Per-task billing-dead breaker. Instance state (tools are minted per task) —
  // NEVER module state: one sandbox process runs many sessions in parallel.
  let billingDead = false;
  return {
    name: 'WebSearch',
    description: TOOL_DESCRIPTIONS.WebSearch,
    strict: true,
    // W3-2: provider-backed search, no workspace writes. The billing-dead breaker
    // is a monotonic latch (once dead, stays dead) — concurrent siblings may each
    // pay one provider probe in the already-exhausted edge, never a wrong result.
    concurrencySafe: true,
    concurrency: 'shared', // L2 (TOOL_CONCURRENCY_CLASSES_V1)
    // W4-1: search results are third-party bytes (titles/excerpts an indexed page
    // controls) — the dispatcher fences the result and taints the journal entry.
    untrustedContent: true,
    parameters: z.object({
      query: z.string().describe('The search query.'),
      allowed_domains: z.array(z.string()).nullable().optional().describe('Only include results from these domains.'),
      blocked_domains: z.array(z.string()).nullable().optional().describe('Exclude results from these domains.'),
    }),
    execute: async (args: unknown, ctx?: ToolExecuteContext) => {
      if (billingDead) return BILLING_DEAD_DIRECTIVE;
      const a = (args ?? {}) as { query?: string; allowed_domains?: string[] | null; blocked_domains?: string[] | null };
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      // T5: every failure in the one error shape (softFail, behind TOOL_RESULT_SHAPE_V1). The billing-dead
      // directive stays as it is: it is an instruction to stop, not a retryable failure.
      if (!query) return softFail('invalid_input', 'WebSearch error: no query provided.');
      const searchArgs: { query: string; allowed_domains?: string[] | null; blocked_domains?: string[] | null } = { query };
      if (a.allowed_domains !== undefined) searchArgs.allowed_domains = a.allowed_domains;
      if (a.blocked_domains !== undefined) searchArgs.blocked_domains = a.blocked_domains;
      const cfg = getConfig();
      try {
        // L1: the call's own signal reaches the provider request (a Stop, an early start cancelled).
        const out = await searchWithChain(resolveProviderChain(cfg.providerOrder), searchArgs, taskId, cfg, warn, ctx?.signal);
        return JSON.stringify(out);
      } catch (err) {
        if (err instanceof AllProvidersUnconfigured) return softFail('unavailable', 'WebSearch error: search is temporarily unavailable.');
        if (err instanceof AllProvidersBillingDead) {
          billingDead = true;
          warn(`[WebSearch] breaker tripped for task ${taskId}: providers out of credits (402): ${err.providers.join(', ')}`);
          return BILLING_DEAD_DIRECTIVE;
        }
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[WebSearch] ${query} failed: ${msg}`);
        // A Stop or a cancelled early start aborted the request: say so, never a plain failure.
        if (ctx?.signal?.aborted) return softFail('aborted', `WebSearch error: ${msg}`);
        return softFail('exec_failed', `WebSearch error: ${msg}`);
      }
    },
  };
}
